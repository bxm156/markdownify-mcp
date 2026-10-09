import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveMarkitdownPath } from "../utils.js";

export type RuntimeHealth = { checked_at: string; storage: { writable: boolean; free_bytes: number | null }; converter: { available: boolean; check: "custom" | "executable" } };
export const HEALTH_TIMEOUT_MS = 5000;
/** Bounded-size write/delete probe; executable presence, not a sample conversion. No paths/diagnostics leave this function.
 * Settles within timeoutMs: a hung mount reports storage unwritable while the abandoned probe cleans up whenever it finishes. */
export async function checkRuntime(dataDir: string, customConverter: boolean, timeoutMs = HEALTH_TIMEOUT_MS): Promise<RuntimeHealth> {
  const result: RuntimeHealth = { checked_at: new Date().toISOString(), storage: { writable: false, free_bytes: null }, converter: { available: customConverter, check: customConverter ? "custom" : "executable" } };
  const probe = path.join(dataDir, ".health-" + randomUUID());
  let abandoned = false, timer: ReturnType<typeof setTimeout> | undefined;
  const storage = (async () => {
    try {
      const stat = await fs.statfs(dataDir);
      result.storage.free_bytes = stat.bavail * stat.bsize;
      if (abandoned) return;
      await fs.writeFile(probe, "health", { flag: "wx", mode: 0o600 });
      await fs.rm(probe);
      result.storage.writable = result.storage.free_bytes > 0;
    } catch { await fs.rm(probe, { force: true }).catch(() => undefined); }
  })();
  const converter = (async () => {
    if (customConverter) return;
    const exe = resolveMarkitdownPath(process.cwd());
    const candidates = path.isAbsolute(exe) || /[\\/]/.test(exe) ? [exe] : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).flatMap(dir => {
      const suffixes = process.platform === "win32" && !path.extname(exe) ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
      return suffixes.map(suffix => path.join(dir, exe + suffix));
    });
    for (const candidate of candidates) {
      if (abandoned) return;
      try { if (!(await fs.stat(candidate)).isFile()) continue; await fs.access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK); result.converter.available = true; break; } catch {}
    }
  })();
  const done = await Promise.race([Promise.all([storage, converter]).then(() => true), new Promise<false>(resolve => { timer = setTimeout(resolve, timeoutMs, false); })]);
  clearTimeout(timer);
  if (done) return result;
  abandoned = true;
  // Snapshot so late completions cannot flip a reported verdict; converter stays false unless already found.
  return { checked_at: result.checked_at, storage: { writable: false, free_bytes: result.storage.free_bytes }, converter: { ...result.converter } };
}
