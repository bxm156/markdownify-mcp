/**
 * Data-directory lock: one process per data volume, either the server or a running purge-owner --apply.
 *
 * File: `<realpath(dataDir)>/.lock`, mode 0o600, "<pid>\n<uuid token>\nheartbeat=<epoch ms>\n" (two-line files from
 * older versions are still read). The PID and heartbeat value are informational; the token identifies an acquisition.
 *
 * Acquire: the file is created exclusively ("wx"). If it exists and its mtime (fs time, never the heartbeat text, so a
 * skewed clock on the previous host cannot fake freshness) is older than staleAfterMs (MD_LOCK_STALE_AFTER_MS, default
 * DEFAULT_LOCK_STALE_AFTER_MS; 0 never reclaims), its holder is presumed dead and the lock is reclaimed: the stale file
 * is renamed to a unique `.lock.<uuid>.stale` name, which only one contender can do with that file. The mover then
 * checks that it moved the same file it judged stale (inode and mtime); if another contender had already replaced it, the
 * fresh lock is linked back (link never overwrites) and acquisition fails. The winner creates a fresh lock with "wx",
 * logs one stale_lock_reclaimed event and deletes the moved file. Any other existing lock fails with LockHeldError.
 *
 * Heartbeat (fencing): every heartbeatMs the holder re-reads the file. While the token is still its own it rewrites the
 * file (temp + rename) so its mtime stays fresh. A foreign or missing token means another process took over: the holder
 * logs lock_lost, forgets the lock (it never removes a file it does not own) and calls onLost once. The timer is unref'd.
 *
 * Release (releaseLock, or the exit hook for anything still held) stops the heartbeat and unlinks the file only while it
 * still carries this acquisition's token. SIGKILL, an OOM kill or a host crash leave the file behind; it is reclaimed once
 * stale, or removed by an operator after stopping every user of the volume (LOCK_REMOVAL_HINT).
 */
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/** How often a holder refreshes its lock file. */
export const HEARTBEAT_MS = 5000;
/** Default MD_LOCK_STALE_AFTER_MS: twelve missed heartbeats. */
export const DEFAULT_LOCK_STALE_AFTER_MS = 60_000;
/** Smallest nonzero MD_LOCK_STALE_AFTER_MS, so a live holder that missed a beat or two is never taken for a dead one. */
export const MIN_LOCK_STALE_AFTER_MS = 3 * HEARTBEAT_MS;
/** acquireLock settings. `log` receives single-line JSON operator events (default stderr); `now` is the clock for ages and heartbeats. */
export type LockOptions = { staleAfterMs?: number; heartbeatMs?: number; log?: (line: string) => void; now?: () => number; onLost?: () => void };
/** A lock this process holds: its token, the heartbeat timer and the beat in flight, if any. */
type Held = { token: string; timer?: ReturnType<typeof setInterval>; beat?: Promise<void>; stopped: boolean };
// Directories whose lock this process holds, by real path. A lock is only ever unlinked while it still carries the
// token of this acquisition, so a lock replaced by an operator or reclaimed by another process is never removed by this one.
const held = new Map<string, Held>();
/** Whether the process "exit" listener that releases held locks is installed (at most once per process). */
let exitHook = false;
/** Operator guidance appended to lock errors. */
export const LOCK_REMOVAL_HINT = "If no markdownify process is using this volume (for example after a crash or SIGKILL), remove MD_DATA_DIR/.lock and restart; see docs/MULTITENANT.md";
/** How an existing lock will be treated, for error messages. */
export const reclaimHint = (staleAfterMs: number) => staleAfterMs > 0 ? `A lock that is no longer refreshed is reclaimed automatically once it is older than ${staleAfterMs} ms (MD_LOCK_STALE_AFTER_MS) unless MD_LOCK_STALE_AFTER_MS=0.` : "Automatic reclaim is disabled (MD_LOCK_STALE_AFTER_MS=0).";
/** The data directory's lock file already exists (and is not stale), or another contender reclaimed it first. */
export class LockHeldError extends Error {}
const lockError = (staleAfterMs: number) => new LockHeldError(`Data directory is in use: MD_DATA_DIR/.lock exists. Run one process per data volume; a running purge-owner --apply also holds this lock. ${reclaimHint(staleAfterMs)} ${LOCK_REMOVAL_HINT}`);
const errnoCode = (error: unknown) => { const code = (error as NodeJS.ErrnoException | null)?.code; return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "UNKNOWN"; };
const tokenOf = (text: string) => { const token = (text.split("\n")[1] ?? "").trim(); return /^[0-9a-f-]{36}$/.test(token) ? token : null; };
const defaultLog = (line: string) => { console.error(line); };

/**
 * Parses MD_LOCK_STALE_AFTER_MS: unset gives DEFAULT_LOCK_STALE_AFTER_MS, 0 disables reclaim, anything else must be a
 * safe integer of at least MIN_LOCK_STALE_AFTER_MS. Throws an Error naming the variable.
 */
export function parseLockStaleAfterMs(raw: string | undefined) {
  if (raw === undefined) return DEFAULT_LOCK_STALE_AFTER_MS;
  const value = Number(raw);
  if (!raw.trim() || !Number.isSafeInteger(value) || (value !== 0 && value < MIN_LOCK_STALE_AFTER_MS)) throw new Error(`MD_LOCK_STALE_AFTER_MS must be 0 (never reclaim) or an integer of at least ${MIN_LOCK_STALE_AFTER_MS}`);
  return value;
}
/** The contents of an existing lock, or undefined when the data directory is unlocked. The PID is informational only. */
export async function readLock(dataDir: string) {
  const real = await fs.realpath(dataDir);
  let text: string;
  try { text = await fs.readFile(path.join(real, ".lock"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const pid = Number((text.split("\n")[0] ?? "").trim());
  return { pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null, token: tokenOf(text) };
}
/**
 * Moves a stale lock out of the way (module comment) and returns its age and temporary name, or throws LockHeldError
 * when the lock is fresh, reclaim is disabled, or another contender got there first.
 */
async function claimStale(target: string, staleAfterMs: number, now: () => number) {
  if (staleAfterMs <= 0) throw lockError(staleAfterMs);
  const missing = (error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw lockError(staleAfterMs); throw error; };
  const before = await fs.lstat(target).catch(missing), age = Math.floor(now() - before.mtimeMs);
  if (age <= staleAfterMs) throw lockError(staleAfterMs);
  const moved = `${target}.${randomUUID()}.stale`;
  await fs.rename(target, moved).catch(missing);
  const after = await fs.lstat(moved);
  if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) {
    // Another contender replaced the stale file between our lstat and rename: restore its fresh lock and give up.
    await fs.link(moved, target).catch(() => undefined);
    await fs.rm(moved, { force: true });
    throw lockError(staleAfterMs);
  }
  return { age, moved };
}
const stop = (state: Held) => { state.stopped = true; if (state.timer) clearInterval(state.timer); };

/**
 * Takes the data-directory lock (module comment) and starts its heartbeat. Returns the real path, which releaseLock
 * takes. Throws LockHeldError while another process holds a fresh lock.
 */
export async function acquireLock(dataDir: string, options: LockOptions = {}) {
  const { staleAfterMs = DEFAULT_LOCK_STALE_AFTER_MS, heartbeatMs = HEARTBEAT_MS, log = defaultLog, now = Date.now, onLost } = options;
  const real = await fs.realpath(dataDir), target = path.join(real, ".lock"), token = randomUUID();
  const contents = () => `${process.pid}\n${token}\nheartbeat=${now()}\n`;
  const create = () => fs.writeFile(target, contents(), { flag: "wx", mode: 0o600 });
  try { await create(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const { age, moved } = await claimStale(target, staleAfterMs, now);
    // The moved file is deleted only after our lock exists, so its inode cannot be reused for the new lock.
    try { await create(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw lockError(staleAfterMs); throw error; } finally { await fs.rm(moved, { force: true }).catch(() => undefined); }
    log(JSON.stringify({ event: "stale_lock_reclaimed", age_ms: age }));
  }
  const state: Held = { token, stopped: false };
  let failing = false;
  const failed = (error: unknown) => { if (!failing) { failing = true; log(JSON.stringify({ event: "lock_heartbeat_failed", code: errnoCode(error) })); } };
  const beat = async () => {
    let text = "";
    try { text = await fs.readFile(target, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return failed(error); }
    if (state.stopped) return;
    if (tokenOf(text) !== token) {
      // Fenced: another process owns the volume now. Forget the lock without touching the file.
      stop(state); if (held.get(real) === state) held.delete(real);
      log(JSON.stringify({ event: "lock_lost" }));
      onLost?.();
      return;
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, contents(), { mode: 0o600 }); if (!state.stopped) await fs.rename(temporary, target); failing = false; }
    catch (error) { failed(error); }
    finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  };
  state.timer = setInterval(() => { if (!state.beat && !state.stopped) state.beat = beat().finally(() => { state.beat = undefined; }); }, heartbeatMs);
  state.timer.unref();
  held.set(real, state);
  // process.exit() (including the shutdown deadline), uncaught exceptions and normal exits release held locks.
  // SIGKILL, OOM kills and host crashes cannot run this; those leftovers are reclaimed once stale (or removed by an operator).
  if (!exitHook) { exitHook = true; process.on("exit", () => { for (const [directory, mine] of held) { stop(mine); try { const file = path.join(directory, ".lock"); if (tokenOf(readFileSync(file, "utf8")) === mine.token) rmSync(file, { force: true }); } catch {} } held.clear(); }); }
  return real;
}
/**
 * Releases a lock this process acquired, given the real path acquireLock returned; a no-op for any other path or a lost
 * lock. Stops the heartbeat and waits for a beat in flight first. A lock whose token changed is left in place and
 * forgotten. A read failure other than ENOENT keeps it held for the exit hook to retry.
 */
export async function releaseLock(real: string) {
  const state = held.get(real), target = path.join(real, ".lock");
  if (state === undefined) return;
  stop(state);
  await state.beat;
  try { if (tokenOf(await fs.readFile(target, "utf8")) === state.token) await fs.rm(target, { force: true }); held.delete(real); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") held.delete(real); /* otherwise the exit hook retries */ }
}
