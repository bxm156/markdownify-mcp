import fs from "node:fs/promises";
import path from "node:path";
import { validatePrincipal } from "./identity.js";

export interface AuditEvent {
  event: string;
  tenant_id: string;
  agent_id: string;
  job_id?: string;
  status?: string;
  reason?: string;
  /** read_markdown_repeat only: how many reads of the completed result followed the first recorded one. */
  repeat_count?: number;
}

/**
 * The record itself was rejected before any storage was touched (invalid metadata, oversized record). It says nothing
 * about whether the sink can write, so callers must fail the operation without treating the sink as unavailable.
 * Messages are fixed strings and never contain metadata values.
 */
export class AuditRecordError extends Error {
  override name = "AuditRecordError";
}

/**
 * A sink accepts one metadata record per call. The optional probe checks, without writing a record, whether a write
 * could currently succeed; readiness calls it only while the last write failed, so a drained replica can recover.
 * The probe cannot see write-time failures (EIO, quotas), so readiness backs it off and requires repeated passes.
 * A rejected record throws AuditRecordError before storage is touched; any other error is a storage failure.
 */
export type AuditLogger = ((event: AuditEvent) => Promise<void>) & { probe: () => Promise<void> };

/** Metadata only. Serialize writes and cap local history with bounded rotation. */
export async function createAuditLogger(directory: string, options: { maxBytes?: number; archives?: number } = {}): Promise<AuditLogger> {
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const archives = options.archives ?? 3;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || !Number.isSafeInteger(archives) || archives < 1 || archives > 10) throw new Error("Invalid audit limits");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, "audit.jsonl");
  const created = await fs.open(target, "a", 0o600);
  await created.close();
  await fs.chmod(target, 0o600);
  let size = (await fs.stat(target)).size;
  let pending: Promise<void> = Promise.resolve();
  const write = (event: AuditEvent) => {
    const operation = pending.catch(() => undefined).then(async () => {
      let principal: ReturnType<typeof validatePrincipal>;
      try { principal = validatePrincipal({ tenantId: event.tenant_id, agentId: event.agent_id }); } catch { throw new AuditRecordError("Invalid audit metadata"); }
      const code = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
      if (!code(event.event) || (event.status !== undefined && !code(event.status)) || (event.reason !== undefined && !code(event.reason)) || (event.job_id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.job_id))
        || (event.repeat_count !== undefined && (!Number.isSafeInteger(event.repeat_count) || event.repeat_count < 1))) throw new AuditRecordError("Invalid audit metadata");
      // Construct the record explicitly: unknown fields cannot leak into logs.
      const record = { timestamp: new Date().toISOString(), event: event.event, tenant_id: principal.tenantId, agent_id: principal.agentId,
        ...(event.job_id !== undefined ? { job_id: event.job_id } : {}),
        ...(event.status !== undefined ? { status: event.status } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
        ...(event.repeat_count !== undefined ? { repeat_count: event.repeat_count } : {}),
      };
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line);
      if (bytes > maxBytes) throw new AuditRecordError("Audit record exceeds capacity");
      if (size + bytes > maxBytes) {
        await fs.rm(`${target}.${archives}`, { force: true });
        for (let index = archives - 1; index >= 1; index--) {
          try { await fs.rename(`${target}.${index}`, `${target}.${index + 1}`); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        await fs.rename(target, `${target}.1`);
        size = 0;
      }
      await fs.appendFile(target, line, { mode: 0o600 });
      size += bytes;
    });
    pending = operation;
    return operation;
  };
  // Opens the active file for append (creating it as a write would) and closes it without writing a byte, then requires
  // free space. Detects a missing/replaced directory, permissions and read-only mounts; a full disk only via statfs.
  const probe = async () => {
    const handle = await fs.open(target, "a", 0o600);
    await handle.close();
    const stat = await fs.statfs(directory);
    if (stat.bavail * stat.bsize <= 0) throw new Error("Audit storage full");
  };
  return Object.assign(write, { probe });
}
