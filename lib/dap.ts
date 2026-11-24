// Unica DAP bridge and 1C debug contour.
//
// `unica dap` is a DAP client for the 1C debug server `dbgs.exe`, not a debug
// server itself. The contour is: dbgs.exe (from the 1C platform bin) -> 1C
// client with /DEBUG -http /DEBUGGERURL -> unica.exe dap -> DAP requests.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import type { UnicaDebugEventsResult, UnicaDebugRequestResult, UnicaDebugState } from "../contract.js";
import { resolveBase, resolvePlatform } from "./designer.js";
import { readParams } from "./params-store.js";
import { unicaLaunchInfo, unicaRuntimeExecutable } from "./tools.js";

const START_TIMEOUT_MS = 30_000;
const ATTACH_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 60_000;
const PORT_WAIT_MS = 30_000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_TAIL_BYTES = 8_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface EventWaiter {
  resolve(): void;
  timer: NodeJS.Timeout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(800);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const no = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("timeout", no);
    socket.once("error", no);
  });
}

async function waitPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(400);
  }
  return false;
}

function chooseFreePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => {
      const fallback = createServer();
      fallback.once("error", () => resolve(0));
      fallback.listen(0, "127.0.0.1", () => {
        const address = fallback.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        fallback.close(() => resolve(port));
      });
    });
    probe.listen(preferred, "127.0.0.1", () => {
      probe.close(() => resolve(preferred));
    });
  });
}

export class UnicaDebugRunner {
  private readonly dataDir: string;
  private readonly dir: string;
  private readonly logFile: string;
  private dapChild: ReturnType<typeof spawn> | null = null;
  private dbgsChild: ReturnType<typeof spawn> | null = null;
  private clientChild: ReturnType<typeof spawn> | null = null;
  private launchedByPlugin = false;
  private buffer = Buffer.alloc(0);
  private nextSeq = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventsBuffer: unknown[] = [];
  private readonly eventWaiters = new Set<EventWaiter>();
  private initialized = false;
  private port = 0;
  private infoBaseAlias = "DefAlias";
  private projectPath = "";
  private clientMode = "thin";
  private lastError = "";

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.dir = join(dataDir, "unica");
    this.logFile = join(this.dir, "logs", "debug.log");
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
      // Logging must not break the bridge.
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

  private send(message: Record<string, unknown>): void {
    const child = this.dapChild;
    if (child === null || child.stdin === null) throw new Error("DAP-процесс не запущен");
    const body = Buffer.from(JSON.stringify(message), "utf-8");
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  }

  private requestDap(command: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const seq = this.nextSeq++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`DAP: нет ответа на ${command} за ${timeoutMs} мс`));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
      try {
        this.send({ seq, type: "request", command, arguments: args });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.buffer = Buffer.alloc(0);
      this.rejectPending(new Error("Ответ DAP превышает лимит"));
      return;
    }
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString("utf-8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (match === null) {
        this.buffer = Buffer.alloc(0);
        this.lastError = "DAP: некорректный Content-Length";
        return;
      }
      const length = Number(match[1]);
      if (this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString("utf-8");
      this.buffer = this.buffer.slice(headerEnd + 4 + length);
      let message: { type?: string; request_seq?: number; event?: string; body?: unknown };
      try {
        message = JSON.parse(body) as typeof message;
      } catch {
        this.logLine("Получен некорректный ответ DAP");
        continue;
      }
      if (message.type === "response" && typeof message.request_seq === "number") {
        const pending = this.pending.get(message.request_seq);
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          this.pending.delete(message.request_seq);
          pending.resolve(message);
        }
        continue;
      }
      if (message.type === "event") {
        this.eventsBuffer.push(message);
        for (const waiter of this.eventWaiters) {
          clearTimeout(waiter.timer);
          waiter.resolve();
        }
        this.eventWaiters.clear();
        continue;
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const [seq, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(seq);
      pending.reject(error);
    }
    for (const waiter of this.eventWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.eventWaiters.clear();
  }

  private drainEvents(): unknown[] {
    const events = this.eventsBuffer.splice(0, this.eventsBuffer.length);
    return events;
  }

  private async startDbgs(port: number, platformFallback: string): Promise<void> {
    const params = readParams(this.projectPath).params;
    const platform = resolvePlatform(params.platformPath || platformFallback);
    if ("error" in platform) throw new Error(platform.error);
    const dbgs = join(dirname(platform.exe), "dbgs.exe");
    if (!existsSync(dbgs)) throw new Error(`в bin платформы нет dbgs.exe: ${dbgs}`);
    const notify = join(this.dir, "logs", `dbgs-${port}.notify`);
    this.logLine(`dbgs ${dbgs} -a 127.0.0.1 -p ${port}`);
    const child = spawn(dbgs, ["-a", "127.0.0.1", "-p", String(port), "-n", notify], {
      cwd: dirname(platform.exe),
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", () => { this.lastError = "Не удалось запустить dbgs"; });
    child.on("exit", (code) => {
      if (this.dbgsChild === child) {
        this.dbgsChild = null;
        this.lastError = `dbgs завершился (код ${code ?? "?"})`;
      }
    });
    this.dbgsChild = child;
    if (!(await waitPort(port, PORT_WAIT_MS))) {
      throw new Error(`dbgs не открыл порт ${port} за ${Math.round(PORT_WAIT_MS / 1000)} с`);
    }
  }

  private startClient(port: number, platformFallback: string, mode: string): void {
    const params = readParams(this.projectPath).params;
    const platform = resolvePlatform(params.platformPath || platformFallback);
    if ("error" in platform) throw new Error(platform.error);
    const base = resolveBase(params.infobasePath);
    if ("error" in base) throw new Error(base.error);
    const clientName = mode === "thick" ? "1cv8.exe" : "1cv8c.exe";
    const client = join(dirname(platform.exe), clientName);
    if (!existsSync(client)) throw new Error(`в bin платформы нет ${clientName}: ${client}`);

    const args = [base.arg];
    if (params.user !== "") args.push(`/N${params.user}`);
    if (params.password !== "") args.push(`/P${params.password}`);
    if (params.unlockCode !== "") args.push(`/UC${params.unlockCode}`);
    args.push(
      "/DEBUG",
      "-http",
      "/DEBUGGERURL",
      `http://127.0.0.1:${port}`,
      "/DisableStartupDialogs",
      "/DisableStartupMessages",
    );
    this.logLine(`Запуск клиента 1С в режиме ${mode}`);
    const child = spawn(client, args, {
      cwd: dirname(platform.exe),
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", () => { this.lastError = "Не удалось запустить клиент 1С"; });
    child.on("exit", (code) => {
      if (this.clientChild === child) {
        this.clientChild = null;
        if (code !== 0) this.lastError = `клиент 1С завершился (код ${code ?? "?"})`;
      }
    });
    this.clientChild = child;
    this.clientMode = mode;
  }

  private async startDap(port: number, alias: string, projectPath: string): Promise<void> {
    const launch = unicaLaunchInfo(this.dataDir);
    if (launch.error !== "") throw new Error(launch.error);
    const exe = unicaRuntimeExecutable(this.dataDir);
    if (exe === "" || !existsSync(exe)) {
      throw new Error("не найден исполняемый файл unica для DAP; подготовь рантайм Unica");
    }
    this.logLine(`dap ${exe} (${projectPath})`);
    const child = spawn(exe, ["dap"], {
      cwd: projectPath,
      env: {
        ...process.env,
        UNICA_PROVIDER_STATE_DIR: launch.providerState,
        UNICA_RUNTIME_CACHE_DIR: launch.runtimeCache,
        UNICA_RUNTIME_MANIFEST: join(launch.root, "runtime-manifest.json"),
        UNICA_PLUGIN_ROOT: launch.root,
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.dapChild = child;
    this.buffer = Buffer.alloc(0);
    this.initialized = false;
    this.port = port;
    this.infoBaseAlias = alias;
    this.projectPath = projectPath;
    child.stdout?.on("data", (data: Buffer) => this.consume(data));
    child.stderr?.resume();
    child.stdin?.on("error", () => {
      if (this.dapChild === child) this.rejectPending(new Error("Канал DAP закрылся"));
    });
    child.on("error", () => {
      if (this.dapChild === child) this.rejectPending(new Error("Не удалось запустить DAP"));
    });
    child.on("exit", (code, signal) => {
      if (this.dapChild !== child) return;
      this.dapChild = null;
      this.initialized = false;
      if (code !== 0 && code !== null) {
        this.lastError = `unica dap завершился (код ${code}${signal ? `, ${signal}` : ""})`;
      }
      this.logLine(this.lastError || "unica dap остановлен");
      this.rejectPending(new Error(this.lastError || "unica dap остановлен"));
    });

    const initialized = (await this.requestDap(
      "initialize",
      {
        clientID: "bb-unica",
        adapterID: "unica",
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: "path",
      },
      START_TIMEOUT_MS,
    )) as { success?: boolean; message?: string };
    if (initialized.success !== true) {
      throw new Error(`DAP initialize: ${initialized.message ?? "не удалось"}`);
    }
    const attached = (await this.requestDap(
      "attach",
      { rootProject: projectPath, infoBaseAlias: alias, debugServerPort: port },
      ATTACH_TIMEOUT_MS,
    )) as { success?: boolean; message?: string };
    if (attached.success !== true) {
      throw new Error(`DAP attach: ${attached.message ?? "не удалось"}`);
    }
    this.initialized = true;
    this.lastError = "";
    this.logLine(`dap attached to ${projectPath}:${port} (${alias})`);
  }

  async start(projectPath: string, port: number, alias: string): Promise<UnicaDebugState> {
    if (this.dapChild !== null) throw new Error("отладочная сессия уже запущена");
    this.launchedByPlugin = false;
    try {
      await this.startDap(port, alias, projectPath);
      return this.status();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async launch(
    projectPath: string,
    port: number,
    clientMode: string,
    platformFallback: string,
  ): Promise<UnicaDebugState> {
    if (this.dapChild !== null) throw new Error("отладочная сессия уже запущена");
    this.projectPath = projectPath;
    this.clientMode = clientMode;
    this.launchedByPlugin = true;
    try {
      const actualPort = port > 0 ? port : await chooseFreePort(19550);
      if (actualPort === 0) throw new Error("не удалось выбрать свободный порт для dbgs");
      if (await portOpen(actualPort)) throw new Error("Выбранный порт отладки уже занят");
      this.logLine(`launch debug contour on port ${actualPort}`);
      await this.startDbgs(actualPort, platformFallback);
      this.startClient(actualPort, platformFallback, clientMode);
      await sleep(3000);
      await this.startDap(actualPort, "DefAlias", projectPath);
      return this.status();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async request(
    command: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<UnicaDebugRequestResult> {
    if (this.dapChild === null) {
      return { ok: false, response: null, events: [], error: "отладочная сессия не запущена" };
    }
    try {
      const response = (await this.requestDap(command, args, timeoutMs)) as {
        success?: boolean;
        message?: string;
      };
      return {
        ok: response.success !== false,
        response,
        events: this.drainEvents(),
        error: response.success === false ? (response.message ?? "DAP-запрос не удался") : "",
      };
    } catch (error) {
      return { ok: false, response: null, events: this.drainEvents(), error: errorText(error) };
    }
  }

  async events(waitMs: number): Promise<UnicaDebugEventsResult> {
    if (this.eventsBuffer.length === 0 && waitMs > 0 && this.dapChild !== null) {
      await new Promise<void>((resolve) => {
        const waiter: EventWaiter = {
          resolve,
          timer: setTimeout(() => {
            this.eventWaiters.delete(waiter);
            resolve();
          }, waitMs),
        };
        this.eventWaiters.add(waiter);
      });
    }
    return { events: this.drainEvents() };
  }

  status(): UnicaDebugState {
    return {
      running:
        (this.dapChild !== null && this.dapChild.exitCode === null) ||
        (this.clientChild !== null && this.clientChild.exitCode === null) ||
        (this.dbgsChild !== null && this.dbgsChild.exitCode === null),
      initialized: this.initialized,
      port: this.port,
      infoBaseAlias: this.infoBaseAlias,
      projectPath: this.projectPath,
      clientMode: this.clientMode,
      clientRunning: this.clientChild !== null && this.clientChild.exitCode === null,
      dbgsRunning: this.dbgsChild !== null && this.dbgsChild.exitCode === null,
      clientPid: this.clientChild?.pid ?? null,
      dbgsPid: this.dbgsChild?.pid ?? null,
      dapPid: this.dapChild?.pid ?? null,
      lastError: this.lastError,
      logTail: this.tail(),
    };
  }

  private kill(child: ReturnType<typeof spawn> | null): void {
    if (child === null || child.exitCode !== null) return;
    const pid = child.pid;
    if (pid === undefined) return;
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

  async stop(): Promise<void> {
    if (this.dapChild !== null && this.initialized) {
      try {
        await this.requestDap("disconnect", {}, 3000);
      } catch {
        // Best effort.
      }
    }
    this.logLine("stop debug contour");
    this.kill(this.dapChild);
    this.dapChild = null;
    if (this.launchedByPlugin) {
      this.kill(this.clientChild);
      this.kill(this.dbgsChild);
    }
    this.clientChild = null;
    this.dbgsChild = null;
    this.launchedByPlugin = false;
    this.initialized = false;
    this.port = 0;
    this.infoBaseAlias = "DefAlias";
    this.projectPath = "";
    this.rejectPending(new Error("отладочная сессия остановлена"));
    this.eventsBuffer.length = 0;
  }

  dispose(): Promise<void> {
    return this.stop();
  }
}
