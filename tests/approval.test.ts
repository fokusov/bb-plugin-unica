import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

test("agent confirmation is scoped to the approved workspace and command", async (t) => {
  let path = "/source/left";
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-unica",
    agentSkillIds: ["unica-bb"],
    experimental_callHostRpc: ({ method }) => {
      if (method === "policy") return "ask";
      if (method === "classify") return {
        danger: true, destructive: true, tool: "unica.apply", op: "apply",
        label: "Выполнение плана", effects: ["workspaceFiles"], detail: "", error: "",
      };
      if (method === "execute") return { ok: true };
      throw new Error(`Unexpected host method: ${method}`);
    },
  });
  t.after(() => harness.lifecycle.dispose());
  harness.sdk.stub("plugins.list", async () => ({ plugins: [] }));
  harness.sdk.stub("threads.get", async () => ({ projectId: "p", environmentId: "e" }));
  harness.sdk.stub("environments.get", async () => ({ id: "e", path, hostId: "h", projectId: "p",
    status: "ready", lifecycle: { phase: "active" } }));
  harness.sdk.stub("projects.get", async () => ({ id: "p", name: "test",
    sources: [{ path: "/source/main", hostId: "h", isDefault: true }] }));
  await plugin(bb);
  const run = () => harness.behavior.callAgentTool("unica_call",
    { tool: "unica.apply", arguments: { executionToken: "fixture-plan" } }, { threadId: "t", projectId: "p" });
  const waitForForm = async () => {
    for (let i = 0; i < 100; i++) {
      const form = harness.inspection.pendingInteractions[0];
      if (form) return form;
      await delay(10);
    }
    assert.fail("The approval interaction did not appear");
  };
  const executions = () => harness.inspection.experimental_hostRpcCalls.filter(({ method }) => method === "execute");

  const invalidated = run();
  const first = await waitForForm();
  path = "/source/right";
  harness.behavior.submitInteraction(first.id, "execute");
  const failure = await invalidated;
  assert.match(JSON.stringify(failure), /Окружение изменилось/);
  assert.equal(executions().length, 0);

  const accepted = run();
  const second = await waitForForm();
  harness.behavior.submitInteraction(second.id, "execute");
  assert.doesNotMatch(JSON.stringify(await accepted), /"isError":true/);
  assert.equal(executions().length, 1);
  assert.deepEqual(executions()[0].input, {
    path: "/source/right", operation: { kind: "call", tool: "unica.apply", arguments: { executionToken: "fixture-plan" }, waitMs: 0 },
    policy: "ask", approved: true,
  });
});
