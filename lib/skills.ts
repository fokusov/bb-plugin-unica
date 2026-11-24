import { copyFileSync, constants, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";

const manifestSchema = z.object({ schema: z.literal(1), copied: z.array(z.string()) });

export function installSkills(workspace: string, packageRoot: string) {
  if (!packageRoot) throw new Error("Выполните bb unica prepare перед подключением навыков");
  const copied: string[] = [];
  const preserved: string[] = [];
  const candidates = new Set<string>();
  const root = realpathSync(workspace);
  const check = (absolute: string) => {
    const local = relative(root, realpathSync(absolute));
    if (!local.startsWith(`.bb${sep}`) && local !== ".bb")
      throw new Error("Путь назначения Unica выходит за пределы .bb");
  };
  const ensure = (folder: string) => {
    try { check(folder); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      if (folder !== join(root, ".bb")) ensure(dirname(folder));
      try { mkdirSync(folder); }
      catch (write) { if ((write as NodeJS.ErrnoException).code !== "EEXIST") throw write; }
      check(folder);
    }
    if (!statSync(folder).isDirectory()) throw new Error("Путь назначения Unica не является каталогом");
  };
  const visit = (from: string, to: string) => {
    ensure(to);
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const source = join(from, entry.name);
      const dest = join(to, entry.name);
      if (entry.isDirectory()) { visit(source, dest); continue; }
      if (!entry.isFile()) continue;
      const location = relative(root, dest).split(sep).join("/");
      try {
        copyFileSync(source, dest, constants.COPYFILE_EXCL);
        copied.push(location);
        candidates.add(location);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        preserved.push(location);
      }
    }
  };
  const file = join(root, ".bb", "unica-skills.json");
  try {
    check(file);
    for (const path of manifestSchema.parse(JSON.parse(readFileSync(file, "utf8"))).copied) candidates.add(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const sourceSkills = join(packageRoot, "skills");
  for (const entry of readdirSync(sourceSkills, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = join(sourceSkills, entry.name);
    if (!readdirSync(source).includes("SKILL.md")) continue;
    const dest = join(root, ".bb", "skills", entry.name);
    try {
      statSync(dest);
      preserved.push(relative(root, dest).split(sep).join("/"));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      visit(source, dest);
    }
  }
  visit(join(packageRoot, "references"), join(root, ".bb", "references"));
  if (copied.length) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ schema: 1, copied: [...candidates].sort() }, null, 2) + "\n", { flag: "wx" });
      renameSync(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
  }
  return { copied, preserved };
}
