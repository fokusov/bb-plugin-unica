import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { DiagnosticReport, diagnosticsContract } from "../diagnostics.js";

type Rpc = ReturnType<typeof useRpc<typeof diagnosticsContract>>;
type ProjectInventory = {
  issue: string | null;
  agentTools: Array<{ name: string; description: string }>;
  projects: Array<{ id: string; name: string }>;
};
type Environment = { id: string; name: string; path: string };

const runtimeLabels = { missing: "Требуется подготовка", preparing: "Подготавливается", ready: "Готов", error: "Ошибка" };
const accessLabels = { read: "Чтение", plan: "План", write: "Запись", session: "Сессия", control: "Управление" };
const selectClass = "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground";
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function CheckResult({ report, projectId, environmentId }: { report: DiagnosticReport; projectId: string; environmentId?: string }) {
  const { path, runtime, running, initialized, catalog, source } = report;
  const scope = environmentId ? `--environment ${environmentId}` : `--project ${projectId}`;
  return (
    <div className="space-y-3">
      <dl className="grid gap-2 rounded-md border border-border p-3 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
        <dt className="text-muted-foreground">Рабочий каталог</dt><dd className="break-all font-mono text-xs">{path}</dd>
        <dt className="text-muted-foreground">Пакет Unica</dt><dd>{runtime.packageVersion || "Не найден"}</dd>
        <dt className="text-muted-foreground">Рантайм</dt><dd>{runtimeLabels[runtime.status]}</dd>
        <dt className="text-muted-foreground">MCP-процесс</dt>
        <dd>{running ? initialized ? "Запущен и инициализирован" : "Запущен, инициализируется" : "Остановлен, запускается по запросу"}</dd>
        <dt className="text-muted-foreground">Проверено</dt><dd>{new Date(report.checkedAt).toLocaleTimeString("ru-RU")}</dd>
      </dl>
      {runtime.error ? <p role="alert" className="break-words text-sm text-destructive">{runtime.error}</p> : null}
      {runtime.status === "missing" || runtime.status === "error" ? (
        <p className="text-sm">Для подготовки рантайма выполни <code className="break-all font-mono">bb unica prepare {scope}</code>.</p>
      ) : null}
      {catalog?.ok === false ? <p role="alert" className="text-sm text-destructive">Каталог MCP · {catalog.error}</p> : null}
      {source ? (
        <p className={source.ok ? "text-sm" : "text-sm text-destructive"} role={source.ok ? "status" : "alert"}>
          <code>unica.view</code> · {source.ok ? <>Исходники доступны в <code className="break-all">{source.workspaceRoot}</code></> : source.error}
        </p>
      ) : null}
      {catalog?.ok ? (
        <details open className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">Каталог MCP · {catalog.tools.length}</summary>
          <p className="mt-2 text-xs text-muted-foreground">Проверка запускает только чтение исходников через <code>unica.view</code>. Остальные инструменты перечислены по ответу MCP.</p>
          <ul className="mt-2 divide-y divide-border text-sm">
            {catalog.tools.map(({ name, description, access }) => (
              <li key={name} className="space-y-0.5 py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <code className="break-all">{name}</code>
                  <span className="text-xs text-muted-foreground">{accessLabels[access]}</span>
                </div>
                {description ? <p className="break-words text-xs text-muted-foreground">{description}</p> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function WorkspaceDiagnostics({ projectId, environmentId, rpc }: { projectId: string; environmentId?: string; rpc: Rpc }) {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let current = true;
    void rpc.call("diagnose", { projectId, environmentId, probe: false }).then(
      (response) => { if (current) setReport(response); },
      (cause) => { if (current) setError(errorText(cause)); },
    ).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [rpc, projectId, environmentId]);

  async function check() {
    setBusy(true);
    setError("");
    try {
      setReport(await rpc.call("diagnose", { projectId, environmentId, probe: true }));
    } catch (cause) {
      setReport(null);
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3" aria-busy={busy}>
      <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60" onClick={() => void check()} disabled={busy}>
        {busy ? "Проверяется…" : "Проверить MCP"}
      </button>
      {error ? <p role="alert" className="break-words text-sm text-destructive">{error}</p> : null}
      {report ? <CheckResult report={report} projectId={projectId} environmentId={environmentId} /> : null}
    </div>
  );
}

function ProjectDiagnostics({ projectId, rpc }: { projectId: string; rpc: Rpc }) {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentId, setEnvironmentId] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void rpc.call("diagnosticEnvironments", { projectId }).then(
      (response) => { if (current) setEnvironments(response); },
      (cause) => { if (current) setError(errorText(cause)); },
    );
    return () => { current = false; };
  }, [rpc, projectId]);

  return (
    <>
      <label className="block space-y-1 text-sm">
        <span>Рабочее окружение</span>
        <select className={selectClass} value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)}>
          <option value="">Основной каталог проекта</option>
          {environments.map(({ id, name, path }) => <option key={id} value={id}>{name} · {path}</option>)}
        </select>
      </label>
      {error ? <p role="alert" className="text-sm text-destructive">Окружения · {error}</p> : null}
      <WorkspaceDiagnostics key={environmentId} projectId={projectId} environmentId={environmentId || undefined} rpc={rpc} />
    </>
  );
}

export function DiagnosticsSection() {
  const rpc = useRpc<typeof diagnosticsContract>();
  const [inventory, setInventory] = useState<ProjectInventory | null>(null);
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void rpc.call("diagnosticProjects", null).then(
      (response) => { if (current) setInventory(response); },
      (cause) => { if (current) setError(errorText(cause)); },
    );
    return () => { current = false; };
  }, [rpc]);

  if (error) return <p role="alert" className="break-words text-sm text-destructive">{error}</p>;
  if (!inventory) return <p role="status" className="text-sm text-muted-foreground">Загружается состояние Unica…</p>;
  if (inventory.issue) return <p role="alert" className="text-sm text-destructive">{inventory.issue}</p>;
  return (
    <div className="space-y-3">
      <details className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Зарегистрированные инструменты BB · {inventory.agentTools.length}</summary>
        <dl className="mt-2 space-y-2 text-sm">
          {inventory.agentTools.map(({ name, description }) => (
            <div key={name}><dt><code>{name}</code></dt><dd className="text-xs text-muted-foreground">{description}</dd></div>
          ))}
        </dl>
      </details>
      {inventory.projects.length ? (
        <label className="block space-y-1 text-sm">
          <span>Проект</span>
          <select className={selectClass} value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">Выбери проект 1С</option>
            {inventory.projects.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
      ) : <p className="text-sm text-muted-foreground">Добавь в BB проект с рабочим каталогом для проверки.</p>}
      {projectId ? <ProjectDiagnostics key={projectId} projectId={projectId} rpc={rpc} /> : null}
    </div>
  );
}
