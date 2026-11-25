import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { unicaRuntimeStateSchema, unicaToolSchema } from "./contract.js";

const option = z.object({ id: z.string().min(1), name: z.string() });
const tool = z.object({ name: z.string(), description: z.string() });
const report = z.object({
  path: z.string(),
  runtime: unicaRuntimeStateSchema.pick({ status: true, packageVersion: true, error: true }),
  running: z.boolean(),
  initialized: z.boolean(),
  catalog: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), tools: z.array(unicaToolSchema.omit({ inputSchema: true })) }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]).nullable(),
  source: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), workspaceRoot: z.string() }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]).nullable(),
  checkedAt: z.number(),
});

export type DiagnosticReport = z.infer<typeof report>;
export const diagnosticsContract = defineRpcContract({
  diagnosticProjects: {
    input: z.null(),
    output: z.object({ issue: z.string().nullable(), agentTools: z.array(tool), projects: z.array(option) }),
  },
  diagnosticEnvironments: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.array(option.extend({ path: z.string() })),
  },
  diagnose: {
    input: z.object({
      projectId: z.string().min(1),
      environmentId: z.string().min(1).optional(),
      probe: z.boolean(),
    }).strict(),
    output: report,
  },
});
