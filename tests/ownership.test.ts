import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { z } from "zod";
import { legacyOwnerActive } from "../server.js";

test("an enabled 1c-properties must confirm that its current generation has released Unica", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "bb-unica" });
  t.after(() => harness.lifecycle.dispose());
  let enabled = true;
  let mode = "embedded";
  let available = true;
  harness.sdk.stub("plugins.list", async () => ({ plugins: [{ id: "1c-properties", enabled }] }));
  harness.sdk.stub("plugins.callRpc", async ({ pluginId, method, input, outputSchema }) => {
    assert.deepEqual({ pluginId, method, input }, {
      pluginId: "1c-properties", method: "unicaOwnership", input: {},
    });
    if (!available) throw new Error("The previous release has no ownership RPC");
    const result = await (outputSchema as z.ZodType)["~standard"].validate({
      version: 1, mode, configuredMode: "external",
    });
    if (result.issues) throw new Error("Invalid ownership response");
    return result.value;
  });

  assert.equal(await legacyOwnerActive(bb.sdk), true);
  mode = "external";
  assert.equal(await legacyOwnerActive(bb.sdk), false);
  mode = "blocked";
  assert.equal(await legacyOwnerActive(bb.sdk), true);
  mode = "unknown";
  assert.equal(await legacyOwnerActive(bb.sdk), true);
  available = false;
  assert.equal(await legacyOwnerActive(bb.sdk), true);
  enabled = false;
  assert.equal(await legacyOwnerActive(bb.sdk), false);
});
