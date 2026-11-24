import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";

export const unicaRuntimeArtifactSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    present: z.boolean(),
  })
  .strict();

export const unicaRuntimeStateSchema = z
  .object({
    status: z.enum(["missing", "preparing", "ready", "error"]),
    packageVersion: z.string(),
    cacheDir: z.string(),
    artifacts: z.array(unicaRuntimeArtifactSchema),
    error: z.string(),
    checkedAt: z.number().nullable(),
  })
  .strict();

export const unicaToolAccessSchema = z.enum(["read", "plan", "write", "session", "control"]);

export const unicaToolSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    access: unicaToolAccessSchema,
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();

export const unicaToolsResultSchema = z
  .object({
    ok: z.boolean(),
    tools: z.array(unicaToolSchema),
    error: z.string(),
  })
  .strict();

export const unicaTaskSchema = z
  .object({
    taskId: z.string(),
    status: z.string(),
    createdAtEpochMs: z.number(),
    updatedAtEpochMs: z.number(),
    ttlMs: z.number(),
    pollIntervalMs: z.number(),
  })
  .strict();

export const unicaCallResultSchema = z
  .object({
    ok: z.boolean(),
    text: z.string(),
    error: z.string(),
    truncated: z.boolean(),
    task: unicaTaskSchema.nullable(),
  })
  .strict();

export const unicaStatusSchema = z
  .object({
    packageRoot: z.string(),
    packageVersion: z.string(),
    runtime: unicaRuntimeStateSchema,
    running: z.boolean(),
    initialized: z.boolean(),
    toolCount: z.number().int(),
    lastError: z.string(),
    logTail: z.string(),
  })
  .strict();

export const unicaPolicySchema = z.enum(["read", "ask", "allow"]);

export const unicaClassificationSchema = z
  .object({
    danger: z.boolean(),
    destructive: z.boolean(),
    tool: z.string(),
    op: z.string(),
    label: z.string(),
    effects: z.array(z.string()),
    detail: z.string(),
    error: z.string(),
  })
  .strict();

export const unicaClassifyResultSchema = z
  .object({
    policy: unicaPolicySchema,
    classification: unicaClassificationSchema,
  })
  .strict();

export const unicaDebugStateSchema = z
  .object({
    running: z.boolean(),
    initialized: z.boolean(),
    port: z.number().int(),
    infoBaseAlias: z.string(),
    projectPath: z.string(),
    clientMode: z.string(),
    clientRunning: z.boolean(),
    dbgsRunning: z.boolean(),
    clientPid: z.number().int().nullable(),
    dbgsPid: z.number().int().nullable(),
    dapPid: z.number().int().nullable(),
    lastError: z.string(),
    logTail: z.string(),
  })
  .strict();

export const unicaDebugRequestResultSchema = z
  .object({
    ok: z.boolean(),
    response: z.unknown(),
    events: z.array(z.unknown()),
    error: z.string(),
  })
  .strict();

export const unicaDebugEventsResultSchema = z
  .object({
    events: z.array(z.unknown()),
  })
  .strict();

export type UnicaRuntimeArtifact = z.infer<typeof unicaRuntimeArtifactSchema>;
export type UnicaRuntimeState = z.infer<typeof unicaRuntimeStateSchema>;
export type UnicaTool = z.infer<typeof unicaToolSchema>;
export type UnicaToolsResult = z.infer<typeof unicaToolsResultSchema>;
export type UnicaTask = z.infer<typeof unicaTaskSchema>;
export type UnicaCallResult = z.infer<typeof unicaCallResultSchema>;
export type UnicaStatus = z.infer<typeof unicaStatusSchema>;
export type UnicaPolicy = z.infer<typeof unicaPolicySchema>;
export type UnicaClassification = z.infer<typeof unicaClassificationSchema>;
export type UnicaClassifyResult = z.infer<typeof unicaClassifyResultSchema>;
export type UnicaDebugState = z.infer<typeof unicaDebugStateSchema>;
export type UnicaDebugRequestResult = z.infer<typeof unicaDebugRequestResultSchema>;
export type UnicaDebugEventsResult = z.infer<typeof unicaDebugEventsResultSchema>;

const args = z.record(z.string(), z.unknown()).default({});
const port = z.number().int().min(1).max(65535);
const waitMs = z.number().int().min(0).max(55_000).default(0);
export const operationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status") }),
  z.object({ kind: z.literal("prepare") }),
  z.object({ kind: z.literal("skills") }),
  z.object({ kind: z.literal("tools") }),
  z.object({ kind: z.literal("stop") }),
  z.object({ kind: z.literal("call"), tool: z.string().min(1).max(160), arguments: args, waitMs }),
  z.object({ kind: z.literal("debug-start"), port: port.default(19550), infoBaseAlias: z.string().max(120).default("DefAlias") }),
  z.object({ kind: z.literal("debug-launch"), port: port.optional(), clientMode: z.enum(["thin","thick"]).default("thin") }),
  z.object({ kind: z.literal("debug-request"), command: z.string().min(1).max(100), arguments: args,
    timeoutMs: z.number().int().min(1).max(60_000).default(30_000) }),
  z.object({ kind: z.literal("debug-events"), waitMs }),
  z.object({ kind: z.literal("debug-status") }),
  z.object({ kind: z.literal("debug-stop") }),
]);
export type Operation = z.infer<typeof operationSchema>;
export const hostContract = defineRpcContract({
  policy: { input: z.object({ path: z.string(), set: unicaPolicySchema.optional() }), output: unicaPolicySchema },
  classify: { input: z.object({ path: z.string(), operation: operationSchema }), output: unicaClassificationSchema.nullable() },
  execute: { input: z.object({ path: z.string(), operation: operationSchema,
    policy: unicaPolicySchema, approved: z.boolean() }), output: z.unknown() },
});
