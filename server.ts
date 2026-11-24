import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { BbPluginApi, PluginAgentToolContext, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, operationSchema, unicaPolicySchema, type Operation } from "./contract.js";

type Sdk = BbPluginApi["sdk"];
type Selection = { projectId?: string; environmentId?: string; threadId?: string };
const confirmationRenderer = "unica-confirm";
const conflict = "Unica встроена в активный 1c-properties. Для перехода остановите встроенную интеграцию и перезагрузите bb-unica.";
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export async function resolveTarget(sdk: Sdk, selection: Selection) {
  const thread = selection.threadId ? await sdk.threads.get({ threadId: selection.threadId }) : undefined;
  const projectId = selection.projectId ?? thread?.projectId;
  const fromThread = thread && projectId === thread.projectId;
  if (fromThread && !thread.environmentId) throw new Error("У потока нет рабочего окружения Unica");
  const environmentId = selection.environmentId ?? (fromThread ? thread.environmentId : undefined);
  const environment = environmentId ? await sdk.environments.get({ environmentId }) : undefined;
  if (environment && (environment.status !== "ready" || environment.lifecycle.phase !== "active" || !environment.path ||
      (projectId && projectId !== environment.projectId))) throw new Error("Рабочее окружение Unica недоступно");
  const id = projectId ?? environment?.projectId;
  if (!id) throw new Error("Укажите --project или --environment либо вызывайте Unica из потока проекта.");
  const project = await sdk.projects.get({ projectId: id });
  const policySource = project.sources.find((source) => source.isDefault) ?? project.sources[0];
  if (!policySource) throw new Error("У проекта нет источника для настроек Unica");
  const target = environment ?? policySource;
  if (!target.path) throw new Error("Рабочая папка Unica недоступна");
  return {
    projectId: project.id, projectName: project.name,
    environmentId: environment?.id, path: target.path, hostId: target.hostId,
    policyPath: policySource.path, policyHostId: policySource.hostId,
  };
}

export async function legacyOwnerActive(sdk: Sdk) {
  const { plugins } = await sdk.plugins.list();
  return plugins.some((plugin) => plugin.id === "1c-properties" && plugin.enabled);
}

const commonProperties = { projectId: { type: "string" } };
const string = { type: "string" };
const integer = { type: "integer" };
const record = { type: "object" };
const tools = [
  { name: "unica_status", kind: "status", description: "Состояние официального пакета и MCP Unica" },
  { name: "unica_tools", kind: "tools", description: "Получить инструменты и схемы текущей Unica" },
  { name: "unica_call", kind: "call", description: "Вызвать инструмент unica.* в рабочем окружении потока",
    properties: { tool: string, arguments: record, waitMs: integer }, required: ["tool"] },
  { name: "unica_debug_start", kind: "debug-start", description: "Подключить DAP к локальному серверу отладки 1С",
    properties: { port: integer, infoBaseAlias: string } },
  { name: "unica_debug_launch", kind: "debug-launch", description: "Запустить тестовый контур 1С и подключить DAP",
    properties: { port: integer, clientMode: { type: "string", enum: ["thin", "thick"] } } },
  { name: "unica_debug_request", kind: "debug-request", description: "Выполнить DAP-запрос выбранной сессии",
    properties: { command: string, arguments: record, timeoutMs: integer }, required: ["command"] },
  { name: "unica_debug_events", kind: "debug-events", description: "Прочитать события DAP",
    properties: { waitMs: integer } },
  { name: "unica_debug_stop", kind: "debug-stop", description: "Остановить выбранную сессию DAP" },
] as const;

const success = z.object({ ok: z.boolean(), error: z.string().optional() }).passthrough();
const cliOptions = {
  project: { type: "string" }, environment: { type: "string" }, args: { type: "string" },
  "args-file": { type: "string" }, "wait-ms": { type: "string" }, "timeout-ms": { type: "string" },
  port: { type: "string" }, alias: { type: "string" }, "client-mode": { type: "string" },
  approved: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" },
} as const;
const usage = [
  "bb unica status|prepare|skills|tools|stop [--project ID | --environment ID]",
  "bb unica call <tool> [--args '<JSON>' | --args-file FILE] [--wait-ms N]",
  "bb unica policy [read|ask|allow] [--project ID]",
  "bb unica debug status|start|launch|request|events|stop",
  "Параметры отладки: --port N, --alias NAME, --client-mode thin|thick, --timeout-ms N.",
  "Для подтверждения операции из терминала пользователя передайте --approved. В треде используется форма BB.",
].join("\n");

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const ownsTools = !(await legacyOwnerActive(bb.sdk));
  const ownership = async () => {
    if (await legacyOwnerActive(bb.sdk)) throw new Error(conflict);
    if (!ownsTools) throw new Error("Перезагрузите bb-unica после отключения встроенной Unica.");
  };

  async function dispatch(operation: Operation, selection: Selection, signal?: AbortSignal, terminalApproval = false, interaction?: { detached: boolean }) {
    await ownership();
    const target = await resolveTarget(bb.sdk, selection);
    const opts = { hostId: target.hostId, signal, timeoutMs: 180_000 };
    const classify = () => host.call("classify", { path: target.path, operation }, opts);
    const policyBinding = { path: target.policyPath };
    const policyOptions = { hostId: target.policyHostId, signal };
    const classification = await classify();
    let policy = classification?.danger ? await host.call("policy", policyBinding, policyOptions) : "read" as const;
    let approved = false;
    if (classification?.danger) {
      if (policy === "read") throw new Error(`Политика read запрещает ${classification.label}`);
      if (policy === "ask" || classification.destructive) {
        if (selection.threadId) {
          if (!interaction) throw new Error("Запросите подтверждение через инструмент Unica в треде");
          interaction.detached = true;
          const response = await bb.ui.requestInput({
            threadId: selection.threadId, rendererId: confirmationRenderer, title: classification.label,
            payload: { label: classification.label, path: target.path, project: target.projectName,
              effects: classification.effects, destructive: classification.destructive },
            timeoutMs: 600_000,
            describeSubmission: (value) => ({ title: value === "execute" ? "Unica: подтверждено" : "Unica: отменено" }),
          }, { signal });
          approved = response.outcome === "submitted" && response.value === "execute";
        } else {
          approved = terminalApproval;
        }
        if (!approved) throw new Error(`Операция не подтверждена: ${classification.label}`);
        const current = await resolveTarget(bb.sdk, selection);
        if (JSON.stringify(current) !== JSON.stringify(target)) throw new Error("Окружение изменилось во время подтверждения");
        await ownership();
        const rechecked = await classify();
        if (JSON.stringify(rechecked) !== JSON.stringify(classification)) throw new Error("Классификация операции изменилась");
        policy = await host.call("policy", policyBinding, policyOptions);
      }
    }
    return host.call("execute", { path: target.path, operation, policy, approved }, {
      ...opts, timeoutMs: operation.kind === "prepare" ? 900_000 : 360_000,
    });
  }

  async function executeAgent(kind: string, value: unknown, context: PluginAgentToolContext): Promise<PluginAgentToolResult> {
    const interaction = { detached: false };
    try {
      const input = z.object({ projectId: z.string().optional() }).passthrough().parse(value);
      const operation = operationSchema.parse({ ...input, kind });
      const result = await dispatch(operation, {
        projectId: input.projectId ?? context.projectId, threadId: context.threadId,
      }, context.signal, false, interaction);
      const report = success.safeParse(result);
      if (report.success && !report.data.ok) throw new Error(report.data.error || "Unica вернула ошибку");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (cause) {
      return {
        content: [{ type: "text", text: `Unica: операция не выполнена. ${errorText(cause)}` }],
        isError: !interaction.detached,
      };
    }
  }

  if (ownsTools) {
    for (const tool of tools) {
      bb.agents.registerTool({
        name: tool.name, description: tool.description,
        parameters: { type: "object", properties: { ...commonProperties, ...("properties" in tool ? tool.properties : {}) },
          required: "required" in tool ? [...tool.required] : [] },
        execute: (input, context) => executeAgent(tool.kind, input, context),
      });
    }
  }
  bb.agents.configure(({ project, environment }) => ownsTools && project.kind === "standard" && environment.path
    ? { tools: tools.map(({ name }) => name), skills: ["unica-bb"] } : { tools: [], skills: [] });

  bb.cli.register({
    name: "unica", summary: "Инструменты Unica в окружениях bb",
    commands: ["status", "prepare", "skills", "tools", "call", "policy", "debug", "stop"].map((name) => ({
      name, summary: name, usage: `bb unica ${name} [--project ID | --environment ID]`,
    })),
    async run(argv, context) {
      try {
        const { positionals, values } = parseArgs({ args: argv, options: cliOptions, allowPositionals: true });
        const [command, subcommand, ...rest] = positionals;
        if (values.help || !command || command === "help") return { stdout: usage, exitCode: 0 };
        if (values.args !== undefined && values["args-file"] !== undefined) throw new Error("Укажите один источник аргументов");
        if (rest.length > (command === "debug" && subcommand === "request" ? 1 : 0))
          throw new Error("Лишний позиционный аргумент");
        const selection = {
          projectId: values.project ?? (values.environment ? undefined : context.projectId),
          environmentId: values.environment, threadId: context.threadId,
        };
        if (command === "status" && !ownsTools) return { stdout: JSON.stringify({ active: false, message: conflict }), exitCode: 0 };
        if (command === "skills" && context.threadId) throw new Error("Подключите навыки из терминала пользователя вне треда");
        if (command === "policy") {
          await ownership();
          const target = await resolveTarget(bb.sdk, selection);
          const set = subcommand === undefined ? undefined : unicaPolicySchema.parse(subcommand);
          if (set && context.threadId) throw new Error("Политика меняется из терминала пользователя вне треда");
          const policy = await host.call("policy", { path: target.policyPath, set }, { hostId: target.policyHostId, signal: context.signal });
          return { stdout: JSON.stringify({ policy }), exitCode: 0 };
        }
        const payload = values["args-file"] ? await readFile(values["args-file"], "utf8") : values.args;
        const numeric = (name: "port" | "wait-ms" | "timeout-ms") => values[name] === undefined ? undefined : Number(values[name]);
        const operation = operationSchema.parse({
          kind: command === "debug" ? `debug-${subcommand}` : command,
          tool: subcommand, command: rest[0], arguments: payload ? JSON.parse(payload) : undefined,
          waitMs: numeric("wait-ms"), port: numeric("port"), timeoutMs: numeric("timeout-ms"),
          infoBaseAlias: values.alias, clientMode: values["client-mode"],
        });
        if (context.threadId && values.approved) throw new Error("Подтвердите операцию в форме Unica");
        const result = await dispatch(operation, selection, context.signal, values.approved);
        const report = success.safeParse(result);
        return { stdout: JSON.stringify(result, null, values.json ? undefined : 2),
          exitCode: report.success && !report.data.ok ? 1 : 0 };
      } catch (cause) { return { stderr: errorText(cause), exitCode: 1 }; }
    },
  });
}
