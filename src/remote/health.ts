import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveMarkitdownPath } from "../utils.js";

export type RuntimeHealth = { checked_at: string; storage: { writable: boolean; free_bytes: number | null }; converter: { available: boolean; check: "custom" | "executable" } };
export const HEALTH_TIMEOUT_MS = 5000;
/** Largest delay setTimeout honours; Node clamps anything above it to 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;
/** Paths probed for the converter executable: a path is used as given; a bare name is looked up on PATH,
 * with PATHEXT suffixes on Windows. `env` and `platform` are parameters so both platforms' rules are testable anywhere. */
export function converterCandidates(exe: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (paths.isAbsolute(exe) || /[\\/]/.test(exe)) return [exe];
  const suffixes = platform === "win32" && !paths.extname(exe) ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  return (env.PATH ?? "").split(paths.delimiter).filter(Boolean).flatMap(dir => suffixes.map(suffix => paths.join(dir, exe + suffix)));
}
const inFlight = new Map<string, Promise<RuntimeHealth>>();
/** Keep the underlying filesystem work single-flight even after its response deadline. */
export function checkRuntime(dataDir: string, customConverter: boolean, timeoutMs = HEALTH_TIMEOUT_MS): Promise<RuntimeHealth> {
  const key = JSON.stringify([path.resolve(dataDir), customConverter]);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const result = runRuntime(dataDir, customConverter, timeoutMs, () => { inFlight.delete(key); });
  inFlight.set(key, result);
  return result;
}
/** Bounded-size write/delete probe; executable presence, not a sample conversion. No paths/diagnostics leave this function.
 * Settles within timeoutMs: whichever check is still pending reports unavailable while the abandoned probe cleans up whenever it finishes. */
async function runRuntime(dataDir: string, customConverter: boolean, timeoutMs: number, settled: () => void): Promise<RuntimeHealth> {
  const result: RuntimeHealth = { checked_at: new Date().toISOString(), storage: { writable: false, free_bytes: null }, converter: { available: customConverter, check: customConverter ? "custom" : "executable" } };
  const probe = path.join(dataDir, ".health-" + randomUUID());
  let abandoned = false, storageDone = false, timer: ReturnType<typeof setTimeout> | undefined;
  const storage = (async () => {
    try {
      const stat = await fs.statfs(dataDir);
      result.storage.free_bytes = stat.bavail * stat.bsize;
      if (abandoned) return;
      await fs.writeFile(probe, "health", { flag: "wx", mode: 0o600 });
      await fs.rm(probe);
      result.storage.writable = result.storage.free_bytes > 0;
    } catch { await fs.rm(probe, { force: true }).catch(() => undefined); }
    storageDone = true;
  })();
  const converter = (async () => {
    if (customConverter) return;
    for (const candidate of converterCandidates(resolveMarkitdownPath(process.cwd()))) {
      if (abandoned) return;
      try { if (!(await fs.stat(candidate)).isFile()) continue; await fs.access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK); result.converter.available = true; break; } catch {}
    }
  })();
  const work = Promise.all([storage, converter]).finally(settled);
  const done = await Promise.race([work.then(() => true), new Promise<false>(resolve => { timer = setTimeout(resolve, timeoutMs, false); })]);
  clearTimeout(timer);
  if (done) return result;
  abandoned = true;
  // Snapshot so late completions cannot flip a reported verdict. A settled storage check keeps its result;
  // pending storage reports unwritable, and the converter stays false unless already found.
  return { checked_at: result.checked_at, storage: { writable: storageDone && result.storage.writable, free_bytes: result.storage.free_bytes }, converter: { ...result.converter } };
}
