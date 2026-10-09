#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validatePrincipal, type Principal } from "./identity.js";
import { liveLockOwner } from "./lock.js";

export type PurgedJob = { job_id: string; status: string; bytes: number | null; result: "listed" | "deleted" | "failed"; code?: string };
export type PurgeReport = { applied: boolean; tenant_id: string; agent_id: string; jobs: PurgedJob[]; skipped: { job_id: string; reason: "missing_manifest" | "legacy_unowned" | "id_mismatch" }[]; unreadable: string[] };
/** A precondition failed; nothing was read or removed. */
export class PurgeRefused extends Error {}
const errorCode = (error: unknown) => { const code = (error as NodeJS.ErrnoException | null)?.code; return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "UNKNOWN"; };
async function directoryBytes(directory: string) { let bytes = 0; for (const name of await fs.readdir(directory)) bytes += (await fs.lstat(path.join(directory, name))).size; return bytes; }

/**
 * Privileged operator maintenance for one data volume while the service is STOPPED: list (default) or remove every job
 * directory whose manifest names this tenant/agent. Reads manifests and file sizes only, never document contents or credentials.
 * Each job is handled independently, so the report always says which jobs were deleted, which failed and which were skipped.
 */
export async function purgeOwnerJobs(dataDir: string, owner: Principal, apply = false): Promise<PurgeReport> {
  try { validatePrincipal(owner); } catch { throw new PurgeRefused("Invalid tenant_id or agent_id"); }
  let root: string;
  try { root = await fs.realpath(dataDir); if (!(await fs.stat(root)).isDirectory()) throw new Error(); } catch { throw new PurgeRefused("Data directory not found"); }
  if (await liveLockOwner(root) !== undefined) throw new PurgeRefused("The service is running on this data directory; stop it first (one process per data volume)");
  const entries = await fs.readdir(root, { withFileTypes: true });
  const candidates = entries.filter(entry => entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name)).map(entry => entry.name);
  const manifests = await Promise.all(candidates.map(name => fs.lstat(path.join(root, name, "job.json")).then(stat => stat.isFile(), () => false)));
  if (!entries.some(entry => entry.isFile() && entry.name === "audit.jsonl") && !manifests.some(Boolean)) throw new PurgeRefused("Not a markdownify data directory (no job manifests or audit.jsonl)");
  const report: PurgeReport = { applied: apply, tenant_id: owner.tenantId, agent_id: owner.agentId, jobs: [], skipped: [], unreadable: [] };
  for (const name of candidates) {
    const directory = path.join(root, name);
    let job: { id?: unknown; tenant_id?: unknown; agent_id?: unknown; status?: unknown };
    try { job = JSON.parse(await fs.readFile(path.join(directory, "job.json"), "utf8")); }
    catch (error) {
      // The service removes manifest-less directories at startup but refuses unreadable manifests, so report those for review.
      if (errorCode(error) === "ENOENT") report.skipped.push({ job_id: name, reason: "missing_manifest" }); else report.unreadable.push(name);
      continue;
    }
    if (!job || typeof job !== "object") { report.unreadable.push(name); continue; }
    if (job.id !== name) { report.skipped.push({ job_id: name, reason: "id_mismatch" }); continue; }
    if (job.tenant_id === undefined && job.agent_id === undefined) { report.skipped.push({ job_id: name, reason: "legacy_unowned" }); continue; }
    if (job.tenant_id !== owner.tenantId || job.agent_id !== owner.agentId) continue;
    const entry: PurgedJob = { job_id: name, status: typeof job.status === "string" && /^[a-z_]{1,32}$/.test(job.status) ? job.status : "unknown", bytes: await directoryBytes(directory).catch(() => null), result: apply ? "deleted" : "listed" };
    if (apply) try { await fs.rm(directory, { recursive: true, force: true }); } catch (error) { entry.result = "failed"; entry.code = errorCode(error); }
    report.jobs.push(entry);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [dataDir, tenantId, agentId, flag, ...rest] = process.argv.slice(2);
  if (!dataDir || !tenantId || !agentId || (flag !== undefined && flag !== "--apply") || rest.length) {
    console.error("Usage: node dist/remote/purge-owner.js <data-dir> <tenant_id> <agent_id> [--apply]  (stop the service first; dry run by default)");
    process.exitCode = 2;
  } else {
    purgeOwnerJobs(dataDir, { tenantId, agentId }, flag === "--apply").then(report => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      // Non-zero whenever the run is incomplete, so scripts never mistake a partial purge for success.
      if (report.unreadable.length || report.jobs.some(job => job.result === "failed")) process.exitCode = 1;
    }, error => { console.error(error instanceof PurgeRefused ? error.message : `Purge failed: ${errorCode(error)}`); process.exitCode = 1; });
  }
}
