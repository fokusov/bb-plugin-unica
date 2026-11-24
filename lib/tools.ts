import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { UnicaRuntimeState } from "../contract.js";

const exec = promisify(execFile);
const minimum = "0.16.0";
const repository = "https://github.com/IngvarConsulting/unica-marketplace.git";
const target = process.platform === "win32" && process.arch === "x64" ? "win-x64"
  : process.platform === "linux" && process.arch === "x64" ? "linux-x64"
  : process.platform === "darwin" && process.arch === "arm64" ? "darwin-arm64" : "";
const bootstrapName = process.platform === "win32" ? "unica-bootstrap.exe" : "unica-bootstrap";
const releaseVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const manifestSchema = z.object({
  schemaVersion: z.literal(2),
  pluginVersion: z.string().regex(releaseVersion),
  development: z.literal(false),
  release: z.object({ tag: z.string() }),
  artifacts: z.record(z.string(), z.object({
    version: z.string().regex(/^[a-zA-Z0-9._-]+$/),
    targets: z.record(z.string(), z.object({
      asset: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
      entrypoint: z.string().optional(),
    })),
  })),
});

function supportedVersion(version: string) {
  if (!releaseVersion.test(version) || version.trim() !== version) return false;
  const [major, minor] = version.split(".").map(Number);
  return major > 0 || minor >= 16;
}

function inspectPackage(root: string) {
  const bootstrap = join(root, "bootstrap", "bin", target, bootstrapName);
  if (!target || !existsSync(bootstrap)) return null;
  try {
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(root, "runtime-manifest.json"), "utf8")));
    if (!supportedVersion(manifest.pluginVersion) || manifest.release.tag !== `v${manifest.pluginVersion}`) return null;
    return { root, bootstrap, manifest };
  } catch { return null; }
}

function cacheRoots() {
  const codex = process.env.CODEX_HOME || join(homedir(), ".codex");
  return [join(codex, "plugins", "cache", "unica", "unica"), join(codex, "plugins", "cache", "unica-local", "unica")];
}

function installedPackage(dataDir: string) {
  let selected: ReturnType<typeof inspectPackage> = null;
  for (const parent of [join(dataDir, "packages"), ...cacheRoots()]) {
    let versions: string[];
    try { versions = readdirSync(parent).filter(supportedVersion); }
    catch { continue; }
    for (const version of versions) {
      const candidate = inspectPackage(join(parent, version));
      if (candidate && candidate.manifest.pluginVersion === version &&
          (!selected || version.localeCompare(selected.manifest.pluginVersion, "en", { numeric: true }) > 0)) selected = candidate;
    }
  }
  return selected;
}

function artifactDirs(pkg: NonNullable<ReturnType<typeof inspectPackage>>, cache: string) {
  return Object.entries(pkg.manifest.artifacts).flatMap(([name, artifact]) => {
    const spec = artifact.targets[target];
    if (!spec || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) return [];
    return [{ name, version: artifact.version, directory: join(cache, name, `${artifact.version}--${spec.asset.sha256}`, target), entrypoint: spec.entrypoint }];
  });
}

export function unicaLaunchInfo(dataDir: string) {
  const pkg = installedPackage(dataDir);
  const ownCache = join(dataDir, "runtimes");
  const sharedCache = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "unica", "runtimes");
  const shared = pkg ? artifactDirs(pkg, sharedCache) : [];
  const runtimeCache = shared.length && shared.every((item) => existsSync(item.directory)) ? sharedCache : ownCache;
  const error = !target ? "Unica не поддерживает эту комбинацию ОС и архитектуры"
    : !pkg ? "Официальный пакет Unica отсутствует. Выполните bb unica prepare" : "";
  return {
    root: pkg?.root ?? "", bootstrap: pkg?.bootstrap ?? "", version: pkg?.manifest.pluginVersion ?? "",
    runtimeCache, providerState: join(dataDir, "provider-state"), error,
  };
}

export function unicaRuntimeStatus(dataDir: string): UnicaRuntimeState {
  const launch = unicaLaunchInfo(dataDir);
  const pkg = launch.root && inspectPackage(launch.root);
  const artifacts = pkg ? artifactDirs(pkg, launch.runtimeCache).map(({ name, version, directory }) => ({
    name, version, present: existsSync(directory),
  })) : [];
  return {
    status: artifacts.length && artifacts.every((item) => item.present) ? "ready" : "missing",
    packageVersion: launch.version, cacheDir: launch.runtimeCache, artifacts,
    error: launch.error, checkedAt: Date.now(),
  };
}

export function unicaRuntimeExecutable(dataDir: string) {
  const launch = unicaLaunchInfo(dataDir);
  const pkg = launch.root && inspectPackage(launch.root);
  const binary = pkg && artifactDirs(pkg, launch.runtimeCache).find((item) => item.name === "unica");
  if (!binary || !binary.entrypoint || isAbsolute(binary.entrypoint)) return "";
  const executable = resolve(binary.directory, binary.entrypoint);
  const local = relative(binary.directory, executable);
  return local && !local.startsWith("..") && existsSync(executable) ? executable : "";
}

const preparations = new Map<string, Promise<UnicaRuntimeState>>();
export async function prepareRuntime(dataDir: string, signal: AbortSignal) {
  const running = preparations.get(dataDir);
  if (running) return running;
  const preparation = (async () => {
    if (!target) throw new Error(unicaLaunchInfo(dataDir).error);
    if (!installedPackage(dataDir)) {
      const parent = join(dataDir, "packages");
      mkdirSync(parent, { recursive: true });
      const staging = mkdtempSync(join(parent, "download-"));
      try {
        await exec("git", ["-c", "core.longpaths=true", "clone", "--depth", "1", "--branch", `v${minimum}`, repository, staging], {
          signal, windowsHide: true, timeout: 180_000,
        });
        const pkg = join(staging, "plugins", "unica");
        if (inspectPackage(pkg)?.manifest.pluginVersion !== minimum) throw new Error("Неполный официальный пакет Unica");
        signal.throwIfAborted();
        renameSync(pkg, join(parent, minimum));
      } finally { rmSync(staging, { recursive: true, force: true }); }
    }
    const launch = unicaLaunchInfo(dataDir);
    if (unicaRuntimeStatus(dataDir).status !== "ready") {
      await exec(launch.bootstrap, ["prefetch", "--plugin-root", launch.root], {
        signal, windowsHide: true, timeout: 840_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, UNICA_RUNTIME_CACHE_DIR: launch.runtimeCache, UNICA_PROVIDER_STATE_DIR: launch.providerState },
      });
    }
    const status = unicaRuntimeStatus(dataDir);
    if (status.status !== "ready") throw new Error("Bootstrap не подготовил все артефакты Unica для этого хоста");
    return status;
  })();
  preparations.set(dataDir, preparation);
  try { return await preparation; } finally { preparations.delete(dataDir); }
}
