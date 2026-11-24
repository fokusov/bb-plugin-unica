// Unica MCP lifecycle and native proxy.
//
// One stdio `unica-bootstrap run` process per host. The project is passed per
// call through `_meta["codex/sandbox-state-meta"].sandboxCwd`, exactly as the
// rlm runner passes its project context. The stdio process is owned by the
// plugin; the long-lived Unica user daemon in provider-state is not.
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  UnicaCallResult,
  UnicaClassification,
  UnicaStatus,
  UnicaTask,
  UnicaTool,
  UnicaToolsResult,
} from "../contract.js";
import { unicaLaunchInfo, unicaRuntimeStatus } from "./tools.js";

const START_TIMEOUT_MS = 120_000;
const CALL_TIMEOUT_MS = 300_000;
const WAIT_MAX_MS = 55_000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_TAIL_BYTES = 8_000;
const RESTART_DELAYS_MS = [0, 3_000, 8_000, 20_000];

const ACCESS: Record<string, UnicaTool["access"]> = {
  "unica.view": "read",
  "unica.resolve": "read",
  "unica.search": "read",
  "unica.check": "read",
  "unica.diff": "read",
  "unica.docs": "read",
  "unica.apply": "write",
  "unica.run": "write",
  "unica.task.get": "read",
  "unica.task.result": "read",
  "unica.task.cancel": "control",
};

interface WorkerLease {
  dispose(): void;
}

interface RpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

interface RpcResponse {
  id?: number | string | null;
  result?: {
    tools?: unknown;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
    serverInfo?: { version?: string };
    protocolVersion?: string;
  };
  error?: RpcError;
  method?: string;
  params?: unknown;
}

interface RpcPending {
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function accessFor(name: string): UnicaTool["access"] {
  return ACCESS[name] ?? "write";
}

function taskOf(structured: unknown): UnicaTask | null {
  if (structured === null || typeof structured !== "object") return null;
  const data = (structured as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return null;
  const task = (data as { task?: unknown }).task;
  if (task === null || typeof task !== "object") return null;
  const value = task as Record<string, unknown>;
  if (typeof value.taskId !== "string" || typeof value.status !== "string") return null;
  return {
    taskId: value.taskId,
    status: value.status,
    createdAtEpochMs: typeof value.createdAtEpochMs === "number" ? value.createdAtEpochMs : 0,
    updatedAtEpochMs: typeof value.updatedAtEpochMs === "number" ? value.updatedAtEpochMs : 0,
    ttlMs: typeof value.ttlMs === "number" ? value.ttlMs : 0,
    pollIntervalMs: typeof value.pollIntervalMs === "number" ? value.pollIntervalMs : 0,
  };
}

function failure(error: string): UnicaCallResult {
  return { ok: false, text: "", error, truncated: false, task: null };
}

export class UnicaRunner {
  private readonly dataDir: string;
  private readonly dir: string;
  private readonly logFile: string;
  private child: ReturnType<typeof spawn> | null = null;
  private lease: WorkerLease | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, RpcPending>();
  private initialized = false;
  private starting: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private toolsCache: UnicaTool[] | null = null;
  private runOperations: Map<string, string[]> | null = null;
  private runOperationsError = "";
  private readonly knownTasks = new Map<string, { path: string; expires: number }>();
  private readonly plans = new Map<string, { path: string; expires: number }>();
  private lastError = "";
  private version = "";
  private generation = 0;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.dir = join(dataDir, "unica");
    this.logFile = join(this.dir, "logs", "mcp.log");
  }

  private logLine(text: string): void {
    try {
      mkdirSync(join(this.dir, "logs"), { recursive: true });
      if (existsSync(this.logFile) && statSync(this.logFile).size > LOG_MAX_BYTES) {
        const raw = readFileSync(this.logFile);
        writeFileSync(this.logFile, raw.subarray(Math.max(0, raw.length - LOG_TAIL_BYTES)));
      }
      appendFileSync(this.logFile, `${new Date().toISOString()} ${text}\n`, "utf-8");
    } catch {
      // Logging must never break the proxy.
    }
  }

  private tail(): string {
    try {
      const raw = readFileSync(this.logFile);
      return raw.subarray(Math.max(0, raw.length - LOG_TAIL_BYTES)).toString("utf-8").trim();
    } catch {
      return "";
    }
  }

  private withLock<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<RpcResponse> {
    const child = this.child;
    if (child === null || child.exitCode !== null) {
      return Promise.reject(new Error(this.lastError || "Unica MCP не запущена"));
    }
    const stdin = child.stdin;
    if (stdin === null) return Promise.reject(new Error("Unica MCP: stdin недоступен"));

    const id = this.nextId++;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Unica MCP: нет ответа на ${method} за ${timeoutMs} мс`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Unica MCP: ${errorText(error)}`));
      }
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.buffer = "";
      this.rejectPending(new Error("Ответ MCP превышает лимит"));
      return;
    }
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (line === "") continue;
      let message: RpcResponse;
      try {
        message = JSON.parse(line) as RpcResponse;
      } catch {
        this.logLine("Получен некорректный ответ MCP");
        continue;
      }
      if (typeof message.id !== "number") {
        if (message.method !== undefined) this.logLine(`notification ${message.method}`);
        continue;
      }
      const pending = this.pending.get(message.id);
      if (pending === undefined) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message);
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private handleExit(
    child: ReturnType<typeof spawn>,
    code: number | null,
    signal: string | null,
    reason = "",
  ): void {
    if (this.child !== child) return;
    this.child = null;
    this.initialized = false;
    this.toolsCache = null;
    this.runOperations = null;
    this.runOperationsError = "";
    this.knownTasks.clear();
    this.plans.clear();
    if (reason !== "") {
      this.lastError = `Unica MCP: ${reason}`;
    } else if (code !== 0 || signal !== null) {
      this.lastError = `Unica MCP завершилась (код ${code ?? "?"}${signal ? `, ${signal}` : ""})`;
    }
    this.logLine(this.lastError || "Unica MCP остановлена");
    this.rejectPending(new Error(this.lastError || "Unica MCP остановлена"));
    const lease = this.lease;
    this.lease = null;
    lease?.dispose();
  }

  private async start(): Promise<void> {
    const launch = unicaLaunchInfo(this.dataDir);
    if (launch.error !== "") throw new Error(launch.error);

    this.logLine(`start ${launch.bootstrap} --plugin-root ${launch.root}`);
    const child = spawn(launch.bootstrap, ["run", "--plugin-root", launch.root], {
      cwd: launch.root,
      env: {
        ...process.env,
        UNICA_RUNTIME_CACHE_DIR: launch.runtimeCache,
        UNICA_PROVIDER_STATE_DIR: launch.providerState,
        UNICA_HOST_CONTEXT_REQUIRED: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.buffer = "";

    child.stdout?.setEncoding("utf8").on("data", (data: string) => this.consume(data));
    child.stderr?.resume();
    child.stdin?.on("error", () => {
      if (this.child === child) this.rejectPending(new Error("Канал MCP закрылся"));
    });
    child.on("error", (error) => {
      this.handleExit(child, null, null, errorText(error));
    });
    child.on("exit", (code, signal) => this.handleExit(child, code, signal));

    const response = await this.request(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "bb-unica", version: "0.1.0" },
      },
      START_TIMEOUT_MS,
    );
    if (response.error !== undefined) {
      throw new Error(response.error.message ?? JSON.stringify(response.error));
    }
    this.version = String(response.result?.serverInfo?.version ?? "");
    this.initialized = true;
    this.lastError = "";
    try {
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
      );
    } catch {
      // The initialize response is what matters; the notification is best effort.
    }
    this.logLine(`initialized Unica ${this.version}`);
  }

  private stopChild(): void {
    const child = this.child;
    this.child = null;
    this.initialized = false;
    this.toolsCache = null;
    this.runOperations = null;
    this.runOperationsError = "";
    this.knownTasks.clear();
    this.plans.clear();
    this.rejectPending(new Error("Unica MCP остановлена"));
    if (child !== null && child.exitCode === null) {
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
            timeout: 15_000,
          });
          else child.kill();
        } catch {
          // Already gone.
        }
      }
    }
  }

  private async ensure(leaseFactory: () => WorkerLease): Promise<void> {
    if (this.child !== null && this.child.exitCode === null && this.initialized) return;
    if (this.starting !== null) return this.starting;

    const launch = unicaLaunchInfo(this.dataDir);
    if (launch.error !== "") {
      this.lastError = launch.error;
      throw new Error(launch.error);
    }

    this.starting = (async () => {
      const generation = this.generation;
      for (let attempt = 0; attempt < RESTART_DELAYS_MS.length; attempt += 1) {
        if (RESTART_DELAYS_MS[attempt] > 0) await sleep(RESTART_DELAYS_MS[attempt]);
        if (this.generation !== generation) throw new Error("Unica MCP остановлена");
        try {
          if (this.child === null || this.child.exitCode !== null) {
            this.lease ??= leaseFactory();
            await this.start();
          }
          if (this.generation !== generation) {
            this.stopChild();
            throw new Error("Unica MCP остановлена");
          }
          if (this.initialized) return;
        } catch (error) {
          if (this.generation !== generation) break;
          this.lastError = errorText(error);
          this.logLine(`start failed: ${this.lastError}`);
          this.stopChild();
        }
      }
      const lease = this.lease;
      this.lease = null;
      lease?.dispose();
      throw new Error(this.lastError || "Unica MCP не запустилась");
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private normalize(response: RpcResponse): UnicaCallResult {
    if (response.error !== undefined) {
      return failure(response.error.message ?? JSON.stringify(response.error));
    }
    if (response.result === undefined) return failure("Unica MCP вернула пустой ответ");

    const result = response.result;
    const content = Array.isArray(result.content)
      ? result.content
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("\n")
      : "";
    const structured = result.structuredContent;
    const hasStructured = structured !== undefined && structured !== null;
    let text = hasStructured ? JSON.stringify(structured, null, 2) : content;
    let truncated = false;
    if (text.length > 100_000) {
      truncated = true;
      text = `${text.slice(0, 100_000)}\n\n[ответ обрезан: ${text.length - 100_000} символов; используй limit/cursor]`;
    }
    const task = taskOf(hasStructured ? structured : null);
    if (result.isError === true) {
      return { ok: false, text, error: text || "Unica MCP вернула ошибку", truncated, task };
    }
    return { ok: true, text, error: "", truncated, task };
  }

  private async callToolRaw(
    tool: string,
    args: Record<string, unknown>,
    projectPath: string,
  ): Promise<{ result: UnicaCallResult; structured: unknown }> {
    const params: Record<string, unknown> = { name: tool, arguments: args };
    if (projectPath !== "") {
      params._meta = { "codex/sandbox-state-meta": { sandboxCwd: projectPath } };
    }
    const response = await this.request("tools/call", params, CALL_TIMEOUT_MS);
    const result = this.normalize(response);
    if (tool === "unica.apply" && result.ok) {
      const prepared = response.result?.structuredContent as { data?: { executionToken?: unknown } } | undefined;
      const token = prepared?.data?.executionToken;
      if (typeof token === "string" && token.length) {
        const now = Date.now();
        for (const [id, entry] of this.plans)
          if (entry.expires <= now) this.plans.delete(id);
        this.plans.set(token, { path: projectPath, expires: now + 3_600_000 });
      }
    }
    if (result.ok && result.task && !tool.startsWith("unica.task.")) {
      const now = Date.now();
      for (const [id, entry] of this.knownTasks)
        if (entry.expires <= now) this.knownTasks.delete(id);
      this.knownTasks.set(result.task.taskId, {
        path: projectPath,
        expires: now + (result.task.ttlMs > 0 ? result.task.ttlMs : 3_600_000),
      });
    }
    return {
      result,
      structured: response.result?.structuredContent,
    };
  }

  private async callTool(
    tool: string,
    args: Record<string, unknown>,
    projectPath: string,
  ): Promise<UnicaCallResult> {
    return (await this.callToolRaw(tool, args, projectPath)).result;
  }

  private readClassification(
    tool: string,
    op: string,
    detail: string,
    effects: string[] = [],
  ): UnicaClassification {
    return {
      danger: false,
      destructive: false,
      tool,
      op,
      label: op === "" ? tool : `${tool}: ${op}`,
      effects,
      detail,
      error: "",
    };
  }

  private isDestructiveRun(op: string, args: Record<string, unknown>): boolean {
    if (op === "infobase.restore" || op === "source.reexport" || op === "extensions.set") {
      return true;
    }
    if (op === "push") return args.force === true || typeof args.delete === "string";
    if (op === "pull") return args.force === true;
    return false;
  }

  private async runEffects(
    op: string,
    projectPath: string,
    leaseFactory: () => WorkerLease,
  ): Promise<{ effects: string[]; error: string }> {
    if (this.runOperations === null) {
      try {
        await this.ensure(leaseFactory);
        const raw = await this.callToolRaw("unica.run", {}, projectPath);
        const structured = raw.structured;
        const data =
          structured !== null && typeof structured === "object"
            ? (structured as { data?: unknown }).data
            : null;
        const operations =
          data !== null && typeof data === "object"
            ? (data as { operations?: unknown }).operations
            : null;
        const map = new Map<string, string[]>();
        if (Array.isArray(operations)) {
          for (const entry of operations) {
            if (entry === null || typeof entry !== "object") continue;
            const value = entry as { op?: unknown; effects?: unknown };
            if (typeof value.op !== "string") continue;
            map.set(
              value.op,
              Array.isArray(value.effects)
                ? value.effects.filter((item): item is string => typeof item === "string")
                : [],
            );
          }
        }
        this.runOperations = map;
        this.runOperationsError = raw.result.ok ? "" : raw.result.error;
      } catch (error) {
        this.runOperations = new Map();
        this.runOperationsError = errorText(error);
      }
    }
    const effects = this.runOperations.get(op);
    if (effects === undefined) {
      return {
        effects: ["unknown"],
        error: this.runOperationsError || `операция ${op} не найдена в словаре Unica`,
      };
    }
    return { effects, error: "" };
  }

  async classify(
    tool: string,
    args: Record<string, unknown>,
    projectPath: string,
    leaseFactory: () => WorkerLease,
  ): Promise<UnicaClassification> {
    return this.withLock(async () => {
      if (tool === "unica.apply") {
        const token = typeof args.executionToken === "string" ? args.executionToken.trim() : "";
        if (token === "") {
          return this.readClassification("unica.apply", "plan", "план без записи в источники");
        }
        const plan = this.plans.get(token);
        if (!plan || plan.path !== projectPath || plan.expires <= Date.now())
          throw new Error("План Unica не принадлежит выбранной рабочей копии или истёк. Получите новый план.");
        return {
          danger: true,
          destructive: true,
          tool,
          op: "apply",
          label: "unica.apply: исполнение плана",
          effects: ["workspaceFiles"],
          detail: "запись плана в источники проекта",
          error: "",
        };
      }

      if (tool === "unica.run") {
        const op = typeof args.op === "string" ? args.op.trim() : "";
        if (op === "") {
          return this.readClassification("unica.run", "", "словарь операций и контрактов");
        }
        if (args.dryRun === true) {
          return this.readClassification("unica.run", op, "preview без изменения базы и файлов");
        }
        const { effects, error } = await this.runEffects(op, projectPath, leaseFactory);
        const mutating = effects.some(
          (effect) =>
            effect === "infobase" || effect === "workspaceFiles" || effect === "clientSession",
        );
        const knownRead = op === "extensions.list";
        const danger = !knownRead && (mutating || effects.length === 0 || error !== "");
        return {
          danger,
          destructive: danger && this.isDestructiveRun(op, args),
          tool,
          op,
          label: `unica.run: ${op}`,
          effects,
          detail:
            effects.length > 0
              ? `эффекты: ${effects.join(", ")}`
              : "эффекты не определены",
          error,
        };
      }

      if (tool.startsWith("unica.task.")) {
        const taskId = typeof args.taskId === "string" ? args.taskId : "";
        const known = this.knownTasks.get(taskId);
        if (!Object.hasOwn(ACCESS, tool) || known?.path !== projectPath || known.expires <= Date.now())
          throw new Error("Задача не принадлежит выбранной рабочей копии или истекла");
        return this.readClassification(tool, "", "Операция над задачей выбранной рабочей копии");
      }

      if (tool === "unica_debug_start" || tool === "unica_debug_launch") {
        return {
          danger: true,
          destructive: false,
          tool,
          op: "",
          label: tool === "unica_debug_launch" ? "отладка: запуск контура" : "отладка: attach",
          effects: ["clientSession"],
          detail: "запуск или подключение отладочной сессии 1С",
          error: "",
        };
      }

      if (tool === "unica_debug_request") {
        const command = typeof args.command === "string" ? args.command : "";
        const risky = command === "evaluate" || command === "setExpression" || command === "setVariable";
        return {
          danger: risky,
          destructive: risky,
          tool,
          op: command,
          label: command === "" ? "DAP-запрос" : `DAP: ${command}`,
          effects: risky ? ["runtimeState"] : [],
          detail: risky
            ? "изменение состояния отлаживаемой программы"
            : "чтение состояния отладки",
          error: "",
        };
      }

      if (tool === "unica_debug_events" || tool === "unica_debug_stop") {
        return this.readClassification(tool, "", "чтение событий или остановка сессии");
      }

      if (!Object.hasOwn(ACCESS, tool)) throw new Error(`Неподдерживаемый инструмент Unica: ${tool}`);
      return this.readClassification(tool, "", "чтение или план без записи");
    });
  }

  async listTools(leaseFactory: () => WorkerLease): Promise<UnicaToolsResult> {
    return this.withLock(async () => {
      try {
        await this.ensure(leaseFactory);
      } catch (error) {
        this.lastError = errorText(error);
        return { ok: false, tools: [], error: errorText(error) };
      }
      try {
        const response = await this.request("tools/list", {}, START_TIMEOUT_MS);
        if (response.error !== undefined) {
          return {
            ok: false,
            tools: [],
            error: response.error.message ?? JSON.stringify(response.error),
          };
        }
        const raw = response.result?.tools;
        if (!Array.isArray(raw)) {
          return { ok: false, tools: [], error: "Unica MCP не вернула tools/list" };
        }
        const tools: UnicaTool[] = raw.map((entry) => {
          const value = entry as {
            name?: unknown;
            description?: unknown;
            inputSchema?: unknown;
          };
          const name = typeof value.name === "string" ? value.name : "";
          return {
            name,
            description: typeof value.description === "string" ? value.description : "",
            access: accessFor(name),
            inputSchema:
              value.inputSchema !== null && typeof value.inputSchema === "object"
                ? (value.inputSchema as Record<string, unknown>)
                : { type: "object" },
          };
        });
        this.toolsCache = tools;
        return { ok: true, tools, error: "" };
      } catch (error) {
        const message = errorText(error);
        this.lastError = message;
        return { ok: false, tools: [], error: message };
      }
    });
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    projectPath: string,
    waitMs: number,
    leaseFactory: () => WorkerLease,
  ): Promise<UnicaCallResult> {
    return this.withLock(async () => {
      try {
        await this.ensure(leaseFactory);
      } catch (error) {
        const message = errorText(error);
        this.lastError = message;
        return failure(message);
      }

      try {
        let result = await this.callTool(tool, args, projectPath);
        if (!result.ok) this.lastError = result.error;
        if (result.task?.status !== "working" || tool === "unica.task.result") {
          return result;
        }
        const deadline = Date.now() + Math.min(WAIT_MAX_MS, Math.max(0, Math.trunc(waitMs)));
        while (Date.now() < deadline) {
          const remaining = deadline - Date.now();
          const poll = await this.callTool(
            "unica.task.result",
            { taskId: result.task.taskId, waitMs: Math.min(7000, Math.max(0, remaining)) },
            projectPath,
          );
          if (!poll.ok) return poll;
          result = poll;
          if (result.task?.status !== "working") break;
        }
        return result;
      } catch (error) {
        const message = errorText(error);
        this.lastError = message;
        return failure(message);
      }
    });
  }

  status(): UnicaStatus {
    const launch = unicaLaunchInfo(this.dataDir);
    const runtime = unicaRuntimeStatus(this.dataDir);
    return {
      packageRoot: launch.root,
      packageVersion: runtime.packageVersion,
      runtime,
      running: this.child !== null && this.child.exitCode === null,
      initialized: this.initialized,
      toolCount: this.toolsCache?.length ?? 0,
      lastError: this.lastError,
      logTail: this.tail(),
    };
  }

  stop(): void {
    this.generation += 1;
    this.logLine("stop");
    this.stopChild();
    const lease = this.lease;
    this.lease = null;
    lease?.dispose();
  }

  dispose(): void {
    this.stop();
  }
}
