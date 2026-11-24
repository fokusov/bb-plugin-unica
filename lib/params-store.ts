import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { unicaPolicySchema, type UnicaPolicy } from "../contract.js";

const debugSchema = z.object({
  platformPath: z.string().refine(isAbsolute),
  infobasePath: z.string().refine(isAbsolute),
});
const configSchema = z.object({ policy: unicaPolicySchema.optional(), debug: debugSchema.optional() }).passthrough();

function objectAt(root: string, file: string) {
  let text: string;
  try {
    const absolute = realpathSync(join(root, file));
    const local = relative(realpathSync(root), absolute);
    if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error(`${file}: путь выходит за пределы проекта`);
    text = readFileSync(absolute, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`${file}: ожидается JSON-объект`);
  }
}

function legacy(root: string) {
  return objectAt(root, ".bb/1c-project.json") ?? objectAt(root, ".dsh/1c-project.json");
}

export function readUnicaPolicy(root: string): UnicaPolicy {
  const cfg = configSchema.parse(objectAt(root, ".bb/unica.json") ?? {});
  const policy = cfg.policy ?? legacy(root)?.unicaPolicy;
  return policy === undefined ? "ask" : unicaPolicySchema.parse(policy);
}

export function saveUnicaPolicy(root: string, policy: UnicaPolicy) {
  const config = configSchema.parse(objectAt(root, ".bb/unica.json") ?? {});
  const file = join(root, ".bb", "unica.json");
  mkdirSync(dirname(file), { recursive: true });
  const parent = relative(realpathSync(root), realpathSync(dirname(file)));
  if (parent !== ".bb") throw new Error("Каталог настроек Unica выходит за пределы проекта");
  const staging = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, JSON.stringify({ ...config, policy }, null, 2) + "\n", { flag: "wx" });
    renameSync(staging, file);
  } finally { rmSync(staging, { force: true }); }
  return policy;
}

export function readParams(root: string) {
  const cfg = configSchema.parse(objectAt(root, ".bb/unica.json") ?? {});
  if (!cfg.debug) throw new Error("Задайте тестовую FILE-базу и платформу в debug в .bb/unica.json выбранной рабочей копии");
  const old = legacy(root);
  const field = (key: string) => old?.infobasePath === cfg.debug?.infobasePath && typeof old?.[key] === "string" ? old[key] : "";
  return { params: { ...cfg.debug, user: field("user"), password: field("password"), unlockCode: field("unlockCode") } };
}
