import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareRuntime } from "../lib/tools.js";
import host from "../host.js";
import { unicaCallResultSchema, unicaToolsResultSchema, type Operation, type UnicaPolicy } from "../contract.js";
import type { ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";

const base = await mkdtemp(path.join(tmpdir(), "bbu-"));
console.log(`Smoke fixture: ${base}`);
const repo = path.join(base, "repo");
await mkdir(repo);
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
git("init", "-b", "main", "-q");
const xml = (kind: string, body: string, id: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><${kind} uuid="${id}">${body}</${kind}></MetaDataObject>`;
const moduleDir = path.join("CommonModules", "Probe", "Ext");
await mkdir(path.join(repo, moduleDir), { recursive: true });
await writeFile(path.join(repo, "Configuration.xml"), xml("Configuration",
  "<Properties><Name>Smoke</Name></Properties><ChildObjects><CommonModule>Probe</CommonModule></ChildObjects>",
  "77777777-7777-4777-8777-777777777777"));
await writeFile(path.join(repo, "CommonModules", "Probe.xml"), xml("CommonModule",
  "<Properties><Name>Probe</Name><Server>true</Server></Properties>", "88888888-8888-4888-8888-888888888888"));
const moduleFile = path.join(moduleDir, "Module.bsl");
await writeFile(path.join(repo, moduleFile), 'Function Probe() Export\n    Return "MAIN";\nEndFunction\n');
git("add", ".");
git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
const paths = ["left", "right"].map((branch) => {
  const directory = path.join(base, branch);
  git("worktree", "add", "-q", "-b", branch, directory);
  return directory;
});
for (const [idx, directory] of paths.entries())
  await writeFile(path.join(directory, moduleFile), `Function Probe() Export\n    Return "${idx === 0 ? "LEFT" : "RIGHT"}";\nEndFunction\n`);
const data = path.join(base, "data");
await prepareRuntime(data, AbortSignal.timeout(840_000));
const ctx = {
  experimental_paths: { dataDir: data },
  signal: AbortSignal.timeout(120_000),
  experimental_retainWorker: () => ({ dispose: async () => {} }),
} as unknown as ExperimentalHostRpcContext;
const execute = (workspace: string, operation: Operation, policy: UnicaPolicy = "read", approved = false) =>
  host.handlers.execute({ path: workspace, operation, policy, approved }, ctx);
const call = async (workspace: string, tool: string, args: Record<string, unknown> = {}) =>
  unicaCallResultSchema.parse(await execute(workspace, { kind: "call", tool, arguments: args, waitMs: 0 }));
try {
  const tools = unicaToolsResultSchema.parse(await execute(paths[0], { kind: "tools" }));
  assert.ok(tools.ok, tools.error);
  assert.ok(tools.tools.some(({ name }) => name === "unica.view"));
  for (const [idx, directory] of paths.entries()) {
    const marker = idx === 0 ? "LEFT" : "RIGHT";
    const view = await call(directory, "unica.view");
    assert.ok(view.ok, view.error);
    const module = await call(directory, "unica.search", { query: marker, scope: "main:CommonModule.Probe" });
    assert.ok(module.ok, module.error);
    assert.ok(module.text.includes(marker), module.text.slice(0, 1000));
    assert.ok((await readFile(path.join(directory, moduleFile), "utf8")).includes(marker));
    console.log(`PASS ${marker}: Unica opens the module from the selected worktree`);
  }
  const [left, right] = paths;
  const replace = "Function Probe() Export\n    Return \"AFTER\";\nEndFunction\n";
  const plan = await call(left, "unica.apply", {
    at: "main:CommonModule.Probe.Body", ops: [{ op: "code.replace", args: { text: replace } }],
  });
  assert.ok(plan.ok, plan.error);
  const executionToken = JSON.parse(plan.text).data?.executionToken;
  assert.equal(typeof executionToken, "string");
  const apply = { kind: "call", tool: "unica.apply", arguments: { executionToken }, waitMs: 15_000 } as const;
  await assert.rejects(async () => execute(right, apply, "allow", true), /не принадлежит/);
  await assert.rejects(async () => execute(left, apply, "read", true), /Политика read/);
  await assert.rejects(async () => execute(left, apply, "ask"), /подтверждение/);
  const applied = unicaCallResultSchema.parse(await execute(left, apply, "ask", true));
  assert.ok(applied.ok, applied.error);
  assert.ok((await readFile(path.join(left, moduleFile), "utf8")).includes("AFTER"));
  assert.ok((await readFile(path.join(right, moduleFile), "utf8")).includes("RIGHT"));
  console.log("PASS confirmed edit is restricted to its worktree; read and unconfirmed attempts are blocked");
} finally { await host.dispose?.(); }
