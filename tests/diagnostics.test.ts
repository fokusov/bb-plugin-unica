import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

test("diagnostics probe only reads the selected worktree and distinguishes MCP from source readiness", async (t) => {
  let sourceRoot: string | null = "/source/feature/src";
  let runtime: "ready" | "missing" = "ready";
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-unica",
    experimental_callHostRpc: ({ method, input }) => {
      assert.equal(method, "execute");
      const request = input as { operation: { kind: string }; policy: string; approved: boolean };
      assert.equal(request.policy, "read");
      assert.equal(request.approved, false);
      switch (request.operation.kind) {
        case "status":
          return {
            packageRoot: "/package", packageVersion: "0.16.0",
            runtime: { status: runtime, packageVersion: "0.16.0", cacheDir: "/cache", artifacts: [], error: "", checkedAt: null },
            running: false, initialized: false, toolCount: 0, lastError: "", logTail: "not included in diagnostics",
          };
        case "tools":
          return {
            ok: true, error: "", tools: [
              { name: "unica.view", description: "", access: "read", inputSchema: {} },
              { name: "unica.apply", description: "", access: "write", inputSchema: {} },
            ],
          };
        case "call":
          assert.deepEqual(request.operation, { kind: "call", tool: "unica.view", arguments: {}, waitMs: 0 });
          return {
            ok: true, error: "", truncated: false, task: null,
            text: JSON.stringify({ data: { workspaceRoot: "/source/feature", effectiveSourceRoot: sourceRoot } }),
          };
        default:
          assert.fail("Unexpected diagnostic action");
      }
    },
  });
  t.after(() => harness.lifecycle.dispose());
  harness.sdk.stub("plugins.list", async () => ({ plugins: [] }));
  harness.sdk.stub("projects.get", async () => ({
    id: "p", name: "test", sources: [{ path: "/source/main", hostId: "main-host", isDefault: true }],
  }));
  harness.sdk.stub("environments.get", async () => ({
    id: "e", projectId: "p", path: "/source/feature", hostId: "feature-host",
    status: "ready", lifecycle: { phase: "active" },
  }));
  await plugin(bb);
  const diagnose = (probe: boolean) => harness.callRpc("diagnose", { projectId: "p", environmentId: "e", probe });
  const idle = await diagnose(false);
  assert.match(JSON.stringify(idle), /"catalog":null/);
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 1);

  const result = JSON.stringify(await diagnose(true));
  assert.match(result, /"workspaceRoot":"\/source\/feature"/);
  assert.match(result, /"name":"unica.apply"/);
  assert.doesNotMatch(result, /logTail|inputSchema/);
  const calls = harness.inspection.experimental_hostRpcCalls;
  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => call.hostId === "feature-host"));
  assert.ok(calls.every(({ input }) => (input as { path: string }).path === "/source/feature"));

  sourceRoot = null;
  const unresolved = JSON.stringify(await diagnose(true));
  assert.match(unresolved, /"catalog":\{"ok":true/);
  assert.match(unresolved, /"source":\{"ok":false/);
  runtime = "missing";
  const before = harness.inspection.experimental_hostRpcCalls.length;
  assert.match(JSON.stringify(await diagnose(true)), /"catalog":null/);
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, before + 1);
});
