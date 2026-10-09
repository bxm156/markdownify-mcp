#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validatePrincipal, type Principal } from "./identity.js";

export type OwnerJob = { job_id: string; status: string; bytes: number };
/**
 * Privileged operator maintenance for one data volume while the service is STOPPED: list (default) or remove every job
 * directory whose manifest names this tenant/agent. Reads manifests and file sizes only, never document contents or credentials.
 */
export async function purgeOwnerJobs(dataDir: string, owner: Principal, apply = false) {
  validatePrincipal(owner);
  const jobs: OwnerJob[] = [], unreadable: string[] = [];
  for (const entry of await fs.readdir(dataDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
    const directory = path.join(dataDir, entry.name);
    let job: { id?: unknown; tenant_id?: unknown; agent_id?: unknown; status?: unknown };
    // The service refuses to start on an unreadable manifest, so report it for manual review rather than guessing ownership.
    try { job = JSON.parse(await fs.readFile(path.join(directory, "job.json"), "utf8")); } catch { unreadable.push(entry.name); continue; }
    if (job.id !== entry.name || job.tenant_id !== owner.tenantId || job.agent_id !== owner.agentId) continue;
    let bytes = 0;
    for (const name of await fs.readdir(directory)) bytes += (await fs.lstat(path.join(directory, name))).size;
    jobs.push({ job_id: entry.name, status: typeof job.status === "string" && /^[a-z_]{1,32}$/.test(job.status) ? job.status : "unknown", bytes });
    if (apply) await fs.rm(directory, { recursive: true, force: true });
  }
  return { applied: apply, tenant_id: owner.tenantId, agent_id: owner.agentId, jobs, unreadable };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [dataDir, tenantId, agentId, flag, ...rest] = process.argv.slice(2);
  if (!dataDir || !tenantId || !agentId || (flag !== undefined && flag !== "--apply") || rest.length) {
    console.error("Usage: node dist/remote/purge-owner.js <data-dir> <tenant_id> <agent_id> [--apply]  (stop the service first; dry run by default)");
    process.exitCode = 2;
  } else {
    purgeOwnerJobs(path.resolve(dataDir), { tenantId, agentId }, flag === "--apply").then(result => { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); },
      error => { console.error(error instanceof Error && error.message === "Invalid principal" ? "Invalid tenant_id or agent_id" : `Purge failed: ${(error as NodeJS.ErrnoException).code ?? "UNKNOWN"}`); process.exitCode = 1; });
  }
}
