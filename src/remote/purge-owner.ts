#!/usr/bin/env node
/**
 * Operator CLI: list or delete every job of one tenant/agent in a stopped server's data volume (see purgeOwnerJobs).
 * Usage: node dist/remote/purge-owner.js <data-dir> <tenant_id> <agent_id> [--apply]. Prints a JSON PurgeReport and
 * exits 0 when complete, 1 when refused or incomplete (unreadable manifests or failed deletions, a lost lock, an invalid
 * MD_LOCK_STALE_AFTER_MS) and 2 on bad usage. --apply honours MD_LOCK_STALE_AFTER_MS like the server.
 * Linux-only, like the server.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { errnoCode } from "./audit.js";
import { WINDOWS_UNSUPPORTED_MESSAGE } from "./config.js";
import { validatePrincipal, type Principal } from "./identity.js";
import { DEFAULT_LOCK_STALE_AFTER_MS, LOCK_REMOVAL_HINT, LockHeldError, acquireLock, lockAge, parseLockStaleAfterMs, reclaimHint, releaseLock, type LockOptions } from "./lock.js";

/** One owned job. bytes sums its directory's entries (null if unreadable); code is an errno-style code when deletion failed. */
export type PurgedJob = { job_id: string; status: string; bytes: number | null; result: "listed" | "deleted" | "failed"; code?: string };
/** Result of purgeOwnerJobs. Skipped and unreadable directories are reported for review and never touched. */
export type PurgeReport = { applied: boolean; tenant_id: string; agent_id: string; jobs: PurgedJob[]; skipped: { job_id: string; reason: "missing_manifest" | "legacy_unowned" | "malformed_owner" | "id_mismatch" }[]; unreadable: string[] };
/** A precondition failed (nothing was read or removed), or the lock was lost mid-run (LOCK_LOST_MESSAGE). */
export class PurgeRefused extends Error {}
/** Why an --apply run stopped early: another process reclaimed the lock (lock.ts fencing), so it no longer owns the volume. */
export const LOCK_LOST_MESSAGE = "Purge aborted: another process took over MD_DATA_DIR/.lock while the purge was running, so some of the owner's jobs may remain. Stop every other user of the volume, then repeat the dry run and --apply.";
/** Sum of the lstat sizes of a job directory's direct entries (job directories are flat; symlinks are not followed). */
async function directoryBytes(directory: string) { let bytes = 0; for (const name of await fs.readdir(directory)) bytes += (await fs.lstat(path.join(directory, name))).size; return bytes; }

/**
 * Privileged operator maintenance for one data volume while the service is STOPPED: list (default) or remove every job
 * directory whose manifest names this tenant/agent. Reads manifests and file sizes only, never document contents or credentials.
 * Each job is handled independently, so the report always says which jobs were deleted, which failed and which were skipped.
 * A dry run is read-only and never creates a lock. It refuses while a fresh lock exists; a lock older than
 * `lock.staleAfterMs` (the reclaim threshold; 0 never counts as stale) is a dead holder's leftover, so the dry run proceeds
 * and writes one plain-text note to `lock.log` (default stderr). --apply needs write access and holds the
 * service's lock for the whole run, so the service cannot start and load half-deleted directories meanwhile. `lock` is
 * passed to acquireLock (stale reclaim, heartbeat); if the lock is lost, the run stops before the next deletion and
 * throws PurgeRefused(LOCK_LOST_MESSAGE) after calling `lock.onLost`.
 */
export async function purgeOwnerJobs(dataDir: string, owner: Principal, apply = false, lock: LockOptions = {}): Promise<PurgeReport> {
  try { validatePrincipal(owner); } catch { throw new PurgeRefused("Invalid tenant_id or agent_id"); }
  let root: string;
  try { root = await fs.realpath(dataDir); if (!(await fs.stat(root)).isDirectory()) throw new Error(); } catch { throw new PurgeRefused("Data directory not found"); }
  const entries = await fs.readdir(root, { withFileTypes: true });
  const candidates = entries.filter(entry => entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name)).map(entry => entry.name);
  const manifests = await Promise.all(candidates.map(name => fs.lstat(path.join(root, name, "job.json")).then(stat => stat.isFile(), () => false)));
  if (!entries.some(entry => entry.isFile() && entry.name === "audit.jsonl") && !manifests.some(Boolean)) throw new PurgeRefused("Not a markdownify data directory (no job manifests or audit.jsonl)");
  const staleAfterMs = lock.staleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS;
  const locked = () => new PurgeRefused(`A lock file exists (MD_DATA_DIR/.lock). Stop the service if it is running. ${reclaimHint(staleAfterMs)} ${LOCK_REMOVAL_HINT}`);
  if (!apply) {
    const age = await lockAge(root, lock.now);
    if (age !== undefined) {
      if (staleAfterMs <= 0 || age <= staleAfterMs) throw locked();
      (lock.log ?? (line => { console.error(line); }))(`Note: MD_DATA_DIR/.lock was last refreshed ${age} ms ago (older than MD_LOCK_STALE_AFTER_MS=${staleAfterMs}), so its holder is presumed dead; listing read-only. --apply reclaims it.`);
    }
    return scan(root, candidates, owner, false);
  }
  let lost = false;
  try { await acquireLock(root, { ...lock, onLost: () => { lost = true; lock.onLost?.(); } }); }
  catch (error) { if (error instanceof LockHeldError) throw locked(); throw new PurgeRefused(`Cannot create MD_DATA_DIR/.lock (${errnoCode(error)}); --apply needs write access to the data directory`); }
  try { return await scan(root, candidates, owner, true, () => lost); } finally { await releaseLock(root); }
}
/** Reads each candidate manifest and lists, or when applying deletes, the directories owned by `owner`. */
async function scan(root: string, candidates: string[], owner: Principal, apply: boolean, lost = () => false) {
  const report: PurgeReport = { applied: apply, tenant_id: owner.tenantId, agent_id: owner.agentId, jobs: [], skipped: [], unreadable: [] };
  for (const name of candidates) {
    const directory = path.join(root, name);
    let job: { id?: unknown; tenant_id?: unknown; agent_id?: unknown; status?: unknown };
    try { job = JSON.parse(await fs.readFile(path.join(directory, "job.json"), "utf8")); }
    catch (error) {
      // The service removes manifest-less directories at startup but refuses unreadable manifests, so report those for review.
      if (errnoCode(error) === "ENOENT") report.skipped.push({ job_id: name, reason: "missing_manifest" }); else report.unreadable.push(name);
      continue;
    }
    if (!job || typeof job !== "object") { report.unreadable.push(name); continue; }
    if (job.id !== name) { report.skipped.push({ job_id: name, reason: "id_mismatch" }); continue; }
    if (job.tenant_id === undefined && job.agent_id === undefined) { report.skipped.push({ job_id: name, reason: "legacy_unowned" }); continue; }
    if (typeof job.tenant_id !== "string" || typeof job.agent_id !== "string") { report.skipped.push({ job_id: name, reason: "malformed_owner" }); continue; }
    if (job.tenant_id !== owner.tenantId || job.agent_id !== owner.agentId) continue;
    const entry: PurgedJob = { job_id: name, status: typeof job.status === "string" && /^[a-z_]{1,32}$/.test(job.status) ? job.status : "unknown", bytes: await directoryBytes(directory).catch(() => null), result: apply ? "deleted" : "listed" };
    if (lost()) throw new PurgeRefused(LOCK_LOST_MESSAGE);
    if (apply) try { await fs.rm(directory, { recursive: true, force: true }); } catch (error) { entry.result = "failed"; entry.code = errnoCode(error); }
    report.jobs.push(entry);
  }
  if (lost()) throw new PurgeRefused(LOCK_LOST_MESSAGE);
  return report;
}

// Compare real paths so invocation through a symlink behaves like a direct invocation.
const isMain = () => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMain() && process.platform === "win32") {
  // Like the server, this CLI is Linux-only: run it inside the container image (see docs/CONTAINERS.md).
  console.error(WINDOWS_UNSUPPORTED_MESSAGE);
  process.exitCode = 1;
} else if (isMain()) {
  // An interrupted purge exits through process.exit so the lock module's exit hook releases a held lock.
  for (const [signal, number] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]] as const) process.once(signal, () => process.exit(128 + number));
  const [dataDir, tenantId, agentId, flag, ...rest] = process.argv.slice(2);
  let staleAfterMs: number | undefined;
  try { staleAfterMs = parseLockStaleAfterMs(process.env.MD_LOCK_STALE_AFTER_MS); } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
  if (!dataDir || !tenantId || !agentId || (flag !== undefined && flag !== "--apply") || rest.length) {
    console.error("Usage: node dist/remote/purge-owner.js <data-dir> <tenant_id> <agent_id> [--apply]  (stop the service first; dry run by default)");
    process.exitCode = 2;
  } else if (staleAfterMs !== undefined) {
    // Losing the lock (another process reclaimed it) stops at once; the exit hook leaves the other process's lock alone.
    const onLost = () => { console.error(LOCK_LOST_MESSAGE); process.exit(1); };
    purgeOwnerJobs(dataDir, { tenantId, agentId }, flag === "--apply", { staleAfterMs, onLost }).then(report => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      // Non-zero whenever the run is incomplete, so scripts never mistake a partial purge for success.
      if (report.unreadable.length || report.jobs.some(job => job.result === "failed")) process.exitCode = 1;
    }, error => { console.error(error instanceof PurgeRefused ? error.message : `Purge failed: ${errnoCode(error)}`); process.exitCode = 1; });
  }
}
