import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveMarkitdownPath } from "../utils.js";

export type RuntimeHealth = { checked_at: string; storage: { writable: boolean; free_bytes: number | null }; converter: { available: boolean; check: "custom" | "executable" } };
export const HEALTH_TIMEOUT_MS = 5000;
/** Largest delay setTimeout honours; Node clamps anything above it to 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;
/** Extensions Windows can start directly with CreateProcess. `spawn` without a shell refuses `.cmd`/`.bat` (EINVAL) and
 * cannot run anything else, so these are the only converter files that count on win32. */
const WIN32_RUNNABLE = new Set([".com", ".exe"]);
/** Windows' own order when PATHEXT is unset, restricted to directly runnable extensions. */
const WIN32_DEFAULT_PATHEXT = ".COM;.EXE";
/** Paths probed for the converter executable, in order. POSIX: a path is used as given; a bare name is looked up on PATH.
 * win32: only `.com`/`.exe` files qualify. A name without an extension gets each runnable PATHEXT suffix (empty and
 * shell-only entries such as `.CMD`/`.BAT` are dropped), a name with another extension has no candidates, and a bare name
 * is looked up on PATH. `env` and `platform` are parameters so both platforms' rules are testable anywhere. */
export function converterCandidates(exe: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const paths = platform === "win32" ? path.win32 : path.posix;
  let names = [exe];
  if (platform === "win32") {
    const extension = paths.extname(exe);
    names = extension ? (WIN32_RUNNABLE.has(extension.toLowerCase()) ? [exe] : [])
      : (env.PATHEXT ?? WIN32_DEFAULT_PATHEXT).split(";").filter(suffix => WIN32_RUNNABLE.has(suffix.toLowerCase())).map(suffix => exe + suffix);
  }
  if (paths.isAbsolute(exe) || /[\\/]/.test(exe)) return names;
  return (env.PATH ?? "").split(paths.delimiter).filter(Boolean).flatMap(dir => names.map(name => paths.join(dir, name)));
}
/** The access check a converter candidate must pass: execute permission on POSIX; existence on win32, which has no
 * execute bit (runnability there comes from the extension filter in converterCandidates). */
export function converterAccessMode(platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? constants.F_OK : constants.X_OK;
}
/** The first candidate that is a regular file passing converterAccessMode, or undefined. Health reports the converter
 * available exactly when this finds one, and the converter spawns the path it returns, so both name the same file.
 * `stop` is checked before each candidate so an abandoned health check stops touching the filesystem. */
export async function resolveConverterExecutable(exe: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, stop: () => boolean = () => false): Promise<string | undefined> {
  const mode = converterAccessMode(platform);
  for (const candidate of converterCandidates(exe, env, platform)) {
    if (stop()) return undefined;
    try { if (!(await fs.stat(candidate)).isFile()) continue; await fs.access(candidate, mode); return candidate; } catch {}
  }
  return undefined;
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
    if (await resolveConverterExecutable(resolveMarkitdownPath(process.cwd()), process.env, process.platform, () => abandoned) !== undefined) result.converter.available = true;
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
