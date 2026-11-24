import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { legacyOwnerActive, resolveTarget } from "../server.js";
import { readUnicaPolicy, saveUnicaPolicy } from "../lib/params-store.js";
import { installSkills } from "../lib/skills.js";

test("thread target and policy source stay independent, with no fallback for broken environments", async () => {
  const sdk = {
    threads: { get: async ({ threadId }: { threadId: string }) => ({ projectId: "project", environmentId: threadId }) },
    environments: { get: async ({ environmentId }: { environmentId: string }) => ({
      id: environmentId, projectId: "project", path: `/work/${environmentId}`,
      hostId: "worker", status: environmentId === "invalid" ? "error" : "ready",
      lifecycle: { phase: "active" },
    }) },
    projects: { get: async () => ({ id: "project", name: "Fixture",
      sources: [{ path: "/work/main", hostId: "main", isDefault: true }] }) },
    plugins: { list: async () => ({ plugins: [{ id: "1c-properties", enabled: true }] }) },
  } as unknown as BbPluginApi["sdk"];
  assert.equal(await legacyOwnerActive(sdk), true);
  assert.equal((await resolveTarget(sdk, { threadId: "left" })).path, "/work/left");
  const right = await resolveTarget(sdk, { threadId: "right" });
  assert.equal(right.path, "/work/right");
  assert.equal(right.policyPath, "/work/main");
  assert.equal(right.policyHostId, "main");
  await assert.rejects(resolveTarget(sdk, { threadId: "invalid" }), /недоступно/);
});

test("policy migration reads legacy values and only writes the new settings file", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bb-unica-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".bb"));
  const legacy = path.join(root, ".bb", "1c-project.json");
  await writeFile(legacy, '{"unicaPolicy":"read","anotherSetting":true}');
  assert.equal(readUnicaPolicy(root), "read");
  saveUnicaPolicy(root, "allow");
  assert.equal(readUnicaPolicy(root), "allow");
  assert.equal(await readFile(legacy, "utf8"), '{"unicaPolicy":"read","anotherSetting":true}');
  await writeFile(path.join(root, ".bb", "unica.json"), "{ broken");
  assert.throws(() => readUnicaPolicy(root), /JSON/);
});

test("official skills and references are installed without replacing local skills", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bb-unica-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "package");
  const destination = path.join(root, "project");
  await mkdir(path.join(destination, ".bb", "skills", "user"), { recursive: true });
  await mkdir(path.join(source, "references"), { recursive: true });
  for (const name of ["official","user"]) {
    const dir = path.join(source, "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "# Official");
  }
  const owned = path.join(destination, ".bb", "skills", "user", "SKILL.md");
  await writeFile(owned, "# Custom");
  await writeFile(path.join(source, "references", "platform.md"), "# Platform");
  const result = installSkills(destination, source);
  assert.deepEqual(result.copied.sort(), [".bb/references/platform.md", ".bb/skills/official/SKILL.md"]);
  assert.equal(await readFile(owned, "utf8"), "# Custom");
  assert.deepEqual(installSkills(destination, source).copied, []);
});
