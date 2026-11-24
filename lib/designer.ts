import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ResolvedPlatform {
  exe: string;
  cwd: string;
}
export interface ResolvedBase {
  arg: string;
}

function failure(message: string): { error: string } {
  return { error: message };
}

/** Platform path → the executable and its working directory. Accepts a file or a folder. */
export function resolvePlatform(raw: string): ResolvedPlatform | { error: string } {
  const value = String(raw || "").trim();
  if (value === "") {
    return failure("не задан путь к платформе 1С — заполни его в проекте или в общих настройках");
  }
  let stat;
  try {
    stat = statSync(value);
  } catch {
    return failure(`путь к платформе не найден: ${value}`);
  }
  if (stat.isFile()) return { exe: value, cwd: dirname(value) };
  if (!stat.isDirectory()) return failure(`путь к платформе не файл и не каталог: ${value}`);

  // 1cv8.exe is the full client and works in a user session; the server agent
  // and the thin client keep their batch commands but behave differently.
  for (const dir of [value, join(value, "bin")]) {
    for (const name of ["1cv8.exe", "1cv8s.exe", "1cv8c.exe"]) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return { exe: candidate, cwd: dir };
    }
  }
  return failure(`в каталоге нет 1cv8.exe: ${value}`);
}

/** Infobase path or connection string → `/F` or `/S` argument. */
export function resolveBase(raw: string): ResolvedBase | { error: string } {
  const value = String(raw || "").trim();
  if (value === "") return failure("не задан путь к базе 1С");
  if (!/^(?:File|Srvr|Ref|Usr|Pwd)\s*=/i.test(value)) return { arg: `/F${value}` };

  const pick = (key: string): string => {
    const match = value.match(new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*"?([^";]+)"?`, "i"));
    return match ? match[1].trim() : "";
  };
  const file = pick("File");
  if (file !== "") return { arg: `/F${file}` };
  const server = pick("Srvr");
  const ref = pick("Ref");
  if (server !== "" && ref !== "") return { arg: `/S${server}\\${ref}` };
  return failure(`в строке соединения нет File либо Srvr/Ref: ${value}`);
}
