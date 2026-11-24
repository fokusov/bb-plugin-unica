import { experimental_defineHostEntry, type ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { hostContract, type Operation } from "./contract.js";
import { UnicaRunner } from "./lib/unica.js";
import { UnicaDebugRunner } from "./lib/dap.js";
import { readParams, readUnicaPolicy, saveUnicaPolicy } from "./lib/params-store.js";
import { prepareRuntime, unicaLaunchInfo } from "./lib/tools.js";
import { installSkills } from "./lib/skills.js";

let mcp: UnicaRunner | undefined;
let dap: UnicaDebugRunner | undefined;
let pendingDebug: string | undefined;
let debugLease: ReturnType<ExperimentalHostRpcContext["experimental_retainWorker"]> | undefined;

function directory(path: string) {
  if (!isAbsolute(path)) throw new Error("Требуется абсолютный путь рабочего окружения Unica");
  const resolved = realpathSync.native(path);
  if (!statSync(resolved).isDirectory()) throw new Error("Рабочий каталог Unica недоступен");
  return resolved;
}
function runner(ctx: ExperimentalHostRpcContext) {
  return mcp ??= new UnicaRunner(ctx.experimental_paths.dataDir);
}
async function classify(operation: Operation, path: string, ctx: ExperimentalHostRpcContext) {
  const lease = () => ctx.experimental_retainWorker();
  if (operation.kind === "call")
    return runner(ctx).classify(operation.tool, operation.arguments, path, lease);
  if (operation.kind === "debug-start" || operation.kind === "debug-launch")
    return runner(ctx).classify(operation.kind.replace("-", "_").replace(/^/, "unica_"), {}, path, lease);
  if (operation.kind === "debug-request")
    return runner(ctx).classify("unica_debug_request", { command: operation.command }, path, lease);
  return null;
}

function debugFor(path: string, ctx: ExperimentalHostRpcContext) {
  const debug = dap ??= new UnicaDebugRunner(ctx.experimental_paths.dataDir);
  const owner = pendingDebug ?? debug.status().projectPath;
  if (owner && owner !== path) throw new Error("Сессия DAP принадлежит другой рабочей копии");
  return debug;
}

function releaseDebug() {
  const lease = debugLease;
  debugLease = undefined;
  void lease?.dispose();
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    policy({ path, set }) {
      const root = directory(path);
      return set === undefined ? readUnicaPolicy(root) : saveUnicaPolicy(root, set);
    },
    classify({ path, operation }, ctx) { return classify(operation, directory(path), ctx); },
    async execute({ path, operation, policy, approved }, ctx) {
      const root = directory(path);
      const classification = await classify(operation, root, ctx);
      ctx.signal.throwIfAborted();
      if (classification?.danger && policy === "read")
        throw new Error(`Политика read запрещает ${classification.label}`);
      if (classification?.danger && !approved && (policy !== "allow" || classification.destructive))
        throw new Error(`Требуется подтверждение: ${classification.label}`);
      const lease = () => ctx.experimental_retainWorker();
      switch (operation.kind) {
        case "status": return runner(ctx).status();
        case "prepare": return prepareRuntime(ctx.experimental_paths.dataDir, ctx.signal);
        case "skills": return installSkills(root, unicaLaunchInfo(ctx.experimental_paths.dataDir).root);
        case "tools": return runner(ctx).listTools(lease);
        case "stop": runner(ctx).stop(); return runner(ctx).status();
        case "call": return runner(ctx).call(operation.tool, operation.arguments, root, operation.waitMs, lease);
        case "debug-status": return debugFor(root, ctx).status();
        case "debug-stop": {
          if (pendingDebug) throw new Error("Дождитесь завершения подключения DAP");
          const debug = debugFor(root, ctx);
          pendingDebug = root;
          try {
            await debug.stop();
            releaseDebug();
            return debug.status();
          } finally { pendingDebug = undefined; }
        }
        case "debug-events":
          return debugFor(root, ctx).events(operation.waitMs);
        case "debug-request":
          if (["initialize", "launch", "attach", "terminate", "restart", "disconnect"].includes(operation.command))
            throw new Error("Для управления подключением используйте отдельные команды DAP Unica");
          return debugFor(root, ctx).request(operation.command, operation.arguments, operation.timeoutMs);
        case "debug-start":
        case "debug-launch": {
          if (pendingDebug) throw new Error("Подключение DAP уже выполняется");
          const debug = debugFor(root, ctx);
          pendingDebug = root;
          try {
            if (operation.kind === "debug-launch") readParams(root);
            const state = operation.kind === "debug-start"
              ? await debug.start(root, operation.port, operation.infoBaseAlias)
              : await debug.launch(root, operation.port ?? 0, operation.clientMode, "");
            if (ctx.signal.aborted) {
              await debug.stop();
              releaseDebug();
              ctx.signal.throwIfAborted();
            }
            debugLease ??= lease();
            return state;
          } finally { pendingDebug = undefined; }
        }
      }
    },
  },
  async dispose() {
    mcp?.dispose();
    await dap?.dispose();
    releaseDebug();
  },
});
