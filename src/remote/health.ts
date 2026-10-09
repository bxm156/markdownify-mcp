import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveMarkitdownPath } from "../utils.js";

export type RuntimeHealth = { checked_at: string; storage: { writable: boolean; free_bytes: number | null }; converter: { available: boolean; check: "custom" | "executable" } };
/** Bounded-size write/delete probe; executable presence, not a sample conversion. No paths/diagnostics leave this function. */
export async function checkRuntime(dataDir: string, customConverter: boolean): Promise<RuntimeHealth> {
  const result: RuntimeHealth = { checked_at: new Date().toISOString(), storage: { writable: false, free_bytes: null }, converter: { available: customConverter, check: customConverter ? "custom" : "executable" } };
  const probe = path.join(dataDir, ".health-" + randomUUID());
  try {
    const stat = await fs.statfs(dataDir);
    result.storage.free_bytes = stat.bavail * stat.bsize;
    await fs.writeFile(probe, "health", { flag: "wx", mode: 0o600 });
    await fs.rm(probe);
    result.storage.writable = result.storage.free_bytes > 0;
  } catch { await fs.rm(probe, { force: true }).catch(() => undefined); }
  if (!customConverter) {
    const exe = resolveMarkitdownPath(process.cwd());
    const candidates = path.isAbsolute(exe) || /[\\/]/.test(exe) ? [exe] : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).flatMap(dir => {
      const suffixes = process.platform === "win32" && !path.extname(exe) ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
      return suffixes.map(suffix => path.join(dir, exe + suffix));
    });
    for (const candidate of candidates) {
      try { if (!(await fs.stat(candidate)).isFile()) continue; await fs.access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK); result.converter.available = true; break; } catch {}
    }
  }
  return result;
}
