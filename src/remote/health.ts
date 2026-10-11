/**
 * Runtime readiness checks (storage and converter) and the converter resolution rules shared with converter.ts.
 *
 * Converter resolution: resolveMarkitdownPath picks MARKITDOWN_PATH when set, else <cwd>/.venv/bin/markitdown when it
 * exists, else the bare name "markitdown". A name containing a slash is used as given; a bare name is searched on PATH
 * (DEFAULT_PATH when PATH is unset; empty entries are skipped). The first regular file with execute permission wins.
 * Readiness reports the converter available exactly when this finds a file, and the converter spawns that same file.
 *
 * Checks never expose paths or error details and settle within their timeout. The only filesystem writes are one small
 * `.health-<uuid>` probe file in the data directory, created exclusively and deleted at once; no audit record is written.
 */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveMarkitdownPath } from "../utils.js";

/** Result of checkRuntime. free_bytes is null when statfs failed; check "custom" means an injected converter, always available. */
export type RuntimeHealth = { checked_at: string; storage: { writable: boolean; free_bytes: number | null }; converter: { available: boolean; check: "custom" | "executable" } };
/** Default deadline for one readiness check, and for waiting on the audit recovery probe (jobs.ts). */
export const HEALTH_TIMEOUT_MS = 5000;
/** Largest delay setTimeout honours; Node clamps anything above it to 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;
/** The search list used when PATH is unset (not when it is empty), close to what libc's execvp falls back to.
 * A container started without PATH therefore still finds /usr/bin/markitdown. */
export const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";
/** Paths probed for the converter executable, in order. A path is used as given; a bare name is looked up on PATH
 * (`defaultPath` when PATH is unset), and empty PATH entries are skipped so the working directory is never searched.
 * The remote server runs on POSIX only (it refuses to start on Windows), so these are POSIX rules. */
export function converterCandidates(exe: string, env: NodeJS.ProcessEnv = process.env, defaultPath: string = DEFAULT_PATH): string[] {
  if (path.isAbsolute(exe) || /[\\/]/.test(exe)) return [exe];
  return (env.PATH ?? defaultPath).split(path.delimiter).filter(Boolean).map(dir => path.join(dir, exe));
}
/** The first candidate that is a regular file with execute permission (X_OK), or undefined. Health reports the converter
 * available exactly when this finds one, and the converter spawns the path it returns, so both name the same file.
 * `stop` is checked before each candidate so an abandoned health check stops touching the filesystem. */
export async function resolveConverterExecutable(exe: string, env: NodeJS.ProcessEnv = process.env, stop: () => boolean = () => false, defaultPath: string = DEFAULT_PATH): Promise<string | undefined> {
  for (const candidate of converterCandidates(exe, env, defaultPath)) {
    if (stop()) return undefined;
    try { if (!(await fs.stat(candidate)).isFile()) continue; await fs.access(candidate, constants.X_OK); return candidate; } catch {}
  }
  return undefined;
}
/** In-flight runs keyed by data directory and converter mode; an entry is deleted only when its filesystem work finishes. */
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
    if (await resolveConverterExecutable(resolveMarkitdownPath(process.cwd()), process.env, () => abandoned) !== undefined) result.converter.available = true;
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
