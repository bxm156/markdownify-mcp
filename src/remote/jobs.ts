import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Converter, createConverter } from "./converter.js";
import { quotaKey, validatePrincipal, type Principal, type QuotaOverride } from "./identity.js";
import { checkRuntime, HEALTH_TIMEOUT_MS, MAX_TIMER_MS, type RuntimeHealth } from "./health.js";
import { prepareMarkdownIndex, readMarkdownPage } from "./markdown.js";
import { acquireLock, releaseLock } from "./lock.js";
import { AuditRecordError } from "./audit.js";

import { ServiceError, errorInfo, lookupError, legacyCode, type ErrorCode, type ErrorDetails } from "./errors.js";
export { ServiceError } from "./errors.js";
export type JobStatus = "awaiting_upload" | "uploaded" | "queued" | "running" | "completed" | "failed" | "expired";
type Job = { tenant_id: string; agent_id: string; id: string; filename: string; extension: string; size_bytes: number; token_hash?: string; upload_auth_hash?: string; status: JobStatus; created_at: string; expires_at: string; error?: string; error_code?: ErrorCode; error_details?: ErrorDetails };
export type AuditEvent = { event: string; tenant_id: string; agent_id: string; job_id?: string; status?: string; reason?: string; repeat_count?: number };
/** An audit callback, optionally with a probe that checks writability without writing a record (see createAuditLogger). */
export type AuditSink = ((event: AuditEvent) => void | Promise<void>) & { probe?: () => Promise<void> };
/**
 * Audit readiness policy (see recoverAudit). The recovery probe cannot see write-time failures (EIO, quotas), so its
 * interval starts at AUDIT_PROBE_BASE_MS and doubles after every probe up to AUDIT_PROBE_MAX_MS, and only
 * AUDIT_PROBE_PASSES consecutive passing probes restore readiness. A successful audit write resets both immediately.
 */
export const AUDIT_PROBE_BASE_MS = 2000;
export const AUDIT_PROBE_MAX_MS = 60_000;
export const AUDIT_PROBE_PASSES = 2;
/** After the first recorded read_markdown of a completed result, every Nth further read writes read_markdown_repeat. */
export const AUDIT_READ_REPEAT_EVERY = 10;
/** Errno-style code for operator logs; never a message, path or stack. */
function errnoCode(error: unknown) {
  const raw = (error as NodeJS.ErrnoException | null)?.code;
  return typeof raw === "string" && /^[A-Z0-9_]{1,32}$/.test(raw) ? raw : "UNKNOWN";
}
export type JobServiceOptions = { dataDir: string; maxUploadBytes: number; maxStorageBytes: number; maxJobs: number; retentionMs: number; uploadTtlMs: number; conversionTimeoutMs: number; maxOutputBytes: number; concurrency: number; converter?: Converter; legacyOwner?: Principal; maxTenantJobs?: number; maxTenantStorageBytes?: number; maxTenantConcurrency?: number; maxAgentJobs?: number; maxAgentStorageBytes?: number; maxAgentConcurrency?: number; healthTimeoutMs?: number; quotaOverrides?: ReadonlyMap<string, QuotaOverride>; audit?: AuditSink };
const extensions = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".md", ".csv", ".html", ".json"]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenHash = (principal: Principal, id: string, tokenDigest: string) => hash(`${principal.tenantId}:${principal.agentId}:${id}:${tokenDigest}`);

/** One process owns this directory. Atomic manifests preserve jobs across restarts. */
export class JobService {
  private jobs = new Map<string, Job>();
  private locks = new Map<string, Promise<unknown>>();
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private uploading = new Map<string, AbortController>();
  private closing = false;
  private initialized = false;
  private healthCache?: { until: number; result: Promise<RuntimeHealth> };
  private lastTenant?: string;
  private lastAgent = new Map<string, string>();
  private converter: Converter;
  private timer?: ReturnType<typeof setInterval>;
  private lock?: string;
  private sweep?: Promise<void>;
  private sweepAgain = false;
  // Service-wide totals go only to operator logs. Agents see sweep times and counts of their own failed jobs.
  private cleanupStats = { last_started_at: null as string | null, last_finished_at: null as string | null, failures_total: 0, consecutive_failed_sweeps: 0, last_error_code: null as string | null };
  private cleanupPending = new Set<string>();
  private failedLastSweep = new Set<string>();
  /**
   * Audit availability for readiness: failing from the last failed write until the next successful write or until
   * AUDIT_PROBE_PASSES consecutive recovery probes pass. auditSettled counts settled writes so a probe that overlaps a
   * write cannot overwrite the write's newer verdict. A record the logger rejects (AuditRecordError) changes none of this.
   */
  private auditFailing = false;
  private auditSettled = 0;
  private auditProbe?: { until: number; result: Promise<void> };
  /** Wait after the next probe settles; doubles per probe up to AUDIT_PROBE_MAX_MS, reset by a successful write. */
  private auditProbeDelay = AUDIT_PROBE_BASE_MS;
  /** Consecutive passing probes with no failed write in between. */
  private auditProbePasses = 0;
  /** Distinct rejected-record messages already logged; bounded, since messages are fixed strings. */
  private auditRejections = new Set<string>();
  /**
   * Read-audit coalescing. Polling is expected (SKILL.md), so read_status and read_markdown are recorded only on the
   * first successful audit of each (event, job status) pair per job: a poll loop yields at most one record per state it
   * observes. Keyed on job ID, which has exactly one immutable owner checked by owned() first, so this is per (owner, job).
   * The value counts reads after the first record; for read_markdown of a completed result every
   * AUDIT_READ_REPEAT_EVERY-th one writes read_markdown_repeat, so heavy re-reading stays visible.
   * Bounded: at most 2 events x 7 statuses (one counter each) per job, only for jobs in this.jobs, dropped by forget() on
   * deletion and tombstone removal. In memory and per process, so the first read per state after a restart (or on
   * another replica) is recorded again and repeat counts restart from zero.
   * authorization_denied, quota_denied and every mutation/lifecycle event are never coalesced or sampled.
   */
  private auditedReads = new Map<string, Map<string, number>>();
  constructor(private options: JobServiceOptions) {
    for (const [name, value] of Object.entries(options)) {
      if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`Invalid ${name}`);
    }
    if ((options.healthTimeoutMs ?? 0) > MAX_TIMER_MS) throw new Error(`Invalid healthTimeoutMs: must be at most ${MAX_TIMER_MS} ms`);
    for (const value of options.quotaOverrides?.values() ?? []) for (const limit of Object.values(value)) if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Invalid quotaOverrides");
    this.options.dataDir = path.resolve(options.dataDir);
    this.converter = options.converter ?? createConverter({ maxOutputBytes: options.maxOutputBytes });
  }
  private dir(id: string) { return path.join(this.options.dataDir, id); }
  private input(job: Job) { return path.join(this.dir(job.id), `input${job.extension}`); }
  private async locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.locks.set(key, next);
    try { return await next; } finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }
  private job(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new ServiceError(404, "Job not found");
    return job;
  }
  /** Agent-scope caps for one principal: an operator override when configured, otherwise the defaults. */
  private agentLimits(principal: Principal) {
    const override = this.options.quotaOverrides?.get(quotaKey(principal));
    return { jobs: override?.maxJobs ?? this.options.maxAgentJobs ?? this.options.maxJobs, bytes: override?.maxStorageBytes ?? this.options.maxAgentStorageBytes ?? this.options.maxStorageBytes,
      concurrency: override?.maxConcurrency ?? this.options.maxAgentConcurrency ?? this.options.concurrency, overridden: !!override };
  }
  private validPrincipal(principal: Principal) {
    try { validatePrincipal(principal); } catch { throw new ServiceError(401, "Invalid principal"); }
  }
  private async audit(event: string, principal: Principal, id?: string, status?: string, reason?: string, repeatCount?: number) {
    if (!this.options.audit) return;
    try { await this.options.audit({ event, tenant_id: principal.tenantId, agent_id: principal.agentId, ...(id && /^[0-9a-f-]{36}$/.test(id) ? { job_id: id } : {}), ...(status ? { status } : {}), ...(reason ? { reason } : {}), ...(repeatCount !== undefined ? { repeat_count: repeatCount } : {}) }); }
    catch (error) {
      // A rejected record never reached storage: fail this operation, but the sink's availability is unknown, not failed.
      if (error instanceof AuditRecordError) this.auditRejected(error);
      else { this.auditSettled++; this.auditAvailability(false, error); }
      throw new ServiceError(503, "Audit unavailable");
    }
    this.auditSettled++; this.auditProbe = undefined; this.auditProbeDelay = AUDIT_PROBE_BASE_MS; this.auditAvailability(true, "write");
  }
  /** Records a write's or probe's verdict; logs one sanitized event per readiness transition, never per failed write. */
  private auditAvailability(available: boolean, cause: unknown) {
    this.auditProbePasses = 0;
    if (this.auditFailing !== available) return;
    this.auditFailing = !available;
    console.error(JSON.stringify(available ? { event: "audit_sink_recovered", via: cause } : { event: "audit_sink_unavailable", code: errnoCode(cause) }));
  }
  /** Logs each distinct rejection message once (fixed strings from the logger; anything else is replaced). */
  private auditRejected(error: Error) {
    const message = /^[A-Za-z0-9 _.,-]{1,100}$/.test(error.message) ? error.message : "Invalid audit record";
    if (this.auditRejections.has(message) || this.auditRejections.size >= 32) return;
    this.auditRejections.add(message);
    console.error(JSON.stringify({ event: "audit_record_rejected", message }));
  }
  /** Coalesced read audit; see auditedReads. Called under the job lock after owned(), so checks and marks cannot race. */
  private async auditRead(event: "read_status" | "read_markdown", principal: Principal, job: Job) {
    const key = `${event}:${job.status}`;
    const seen = this.auditedReads.get(job.id)?.get(key);
    if (seen === undefined) {
      await this.audit(event, principal, job.id, job.status);
      // Mark only after a successful write, so a read that failed with 503 is recorded on its retry.
      if (!this.jobs.has(job.id)) return;
      const reads = this.auditedReads.get(job.id) ?? new Map<string, number>();
      reads.set(key, 0); this.auditedReads.set(job.id, reads);
      return;
    }
    // Status polling stays coalesced; re-reading a completed result is sampled. The count advances only after a
    // sampled record is written, so a read whose repeat record failed with 503 writes it on its retry.
    if (event !== "read_markdown" || job.status !== "completed") return;
    const count = seen + 1;
    if (count % AUDIT_READ_REPEAT_EVERY === 0) await this.audit("read_markdown_repeat", principal, job.id, job.status, undefined, count);
    this.auditedReads.get(job.id)?.set(key, count);
  }
  /**
   * While the last audit write failed, readiness runs the sink's non-writing probe (shared in flight, bounded by the
   * health timeout) so a replica drained by its own readiness can recover without traffic. The probe cannot see
   * write-time failures, so a sink that passes it but fails real writes would flap: the wait after each probe starts at
   * AUDIT_PROBE_BASE_MS and doubles up to AUDIT_PROBE_MAX_MS (kept across relapses, reset only by a successful write),
   * and readiness returns only after AUDIT_PROBE_PASSES consecutive passes. Without a probe, only a successful write
   * clears the failure.
   */
  private async recoverAudit() {
    const probe = this.options.audit?.probe;
    if (!this.auditFailing || !probe) return;
    if (!this.auditProbe || this.auditProbe.until <= Date.now()) {
      const settled = this.auditSettled;
      const result = Promise.resolve().then(() => probe.call(this.options.audit)).then(
        () => { if (this.auditSettled === settled && this.auditFailing && ++this.auditProbePasses >= AUDIT_PROBE_PASSES) this.auditAvailability(true, "probe"); },
        () => { if (this.auditSettled === settled) this.auditProbePasses = 0; })
        .finally(() => {
          if (this.auditProbe?.result !== result) return;
          this.auditProbe.until = Date.now() + this.auditProbeDelay;
          this.auditProbeDelay = Math.min(this.auditProbeDelay * 2, AUDIT_PROBE_MAX_MS);
        });
      this.auditProbe = { until: Infinity, result };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.auditProbe.result, new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS); })]);
    clearTimeout(timer);
  }
  private async internalAudit(event: string, job: Job) {
    try { await this.audit(event, { tenantId: job.tenant_id, agentId: job.agent_id }, job.id, job.status); }
    catch { console.error("Job audit unavailable", event, job.id); }
  }
  private forget(id: string) { this.jobs.delete(id); this.cleanupPending.delete(id); this.failedLastSweep.delete(id); this.auditedReads.delete(id); }
  private async owned(principal: Principal, id: string) {
    this.validPrincipal(principal);
    const job = this.jobs.get(id);
    if (!job || job.tenant_id !== principal.tenantId || job.agent_id !== principal.agentId) {
      await this.audit("authorization_denied", principal, id, undefined, "job_not_found");
      throw new ServiceError(404, "Job not found");
    }
    return job;
  }
  private available(job: Job) {
    if (job.status === "expired" || (job.status !== "running" && Date.parse(job.expires_at) <= Date.now())) throw new ServiceError(410, "Job expired");
  }
  private async save(job: Job) {
    const target = path.join(this.dir(job.id), "job.json");
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(job), { mode: 0o600 });
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async init() {
    await fs.mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.options.dataDir, 0o700);
    this.lock = await acquireLock(this.options.dataDir);
    try { await this.load(); } catch (error) { await releaseLock(this.lock); this.lock = undefined; throw error; }
    this.initialized = true;
    this.timer = setInterval(() => this.tick(), Math.min(this.options.retentionMs, this.options.uploadTtlMs, 60_000));
    this.timer.unref();
    this.pump();
  }
  // A periodic tick during a long sweep is skipped rather than queued or run concurrently.
  private tick() { if (!this.sweep) void this.cleanup().catch(() => console.error("Job cleanup sweep failed")); }
  private async load() {
    const loaded: { job: Job; legacy: boolean }[] = [];
    const orphans: string[] = [];
    for (const entry of await fs.readdir(this.options.dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
      let job: Job;
      try { job = JSON.parse(await fs.readFile(path.join(this.dir(entry.name), "job.json"), "utf8")); }
      catch (error) {
        // A crash between mkdir and first atomic manifest commit cannot have
        // produced a client-visible upload ID, so discard that orphan directory.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { orphans.push(entry.name); continue; }
        throw new Error(`Unreadable job manifest: ${entry.name}`);
      }
      if (job.id !== entry.name || !extensions.has(job.extension) || !Number.isSafeInteger(job.size_bytes) || job.size_bytes < 0 || !Number.isFinite(Date.parse(job.expires_at)) || !Number.isFinite(Date.parse(job.created_at)) || (job.status === "awaiting_upload" && !/^[a-f0-9]{64}$/.test(job.token_hash ?? "")) || !["awaiting_upload", "uploaded", "queued", "running", "completed", "failed", "expired"].includes(job.status)) throw new Error("Invalid job manifest");
      if (job.upload_auth_hash !== undefined && (typeof job.upload_auth_hash !== "string" || !/^[a-f0-9]{64}$/.test(job.upload_auth_hash))) throw new Error("Invalid upload credential manifest");
      const legacy = job.tenant_id === undefined && job.agent_id === undefined;
      if (legacy) {
        if (!this.options.legacyOwner) throw new Error("Unowned legacy jobs require an explicit legacyOwner");
        this.validPrincipal(this.options.legacyOwner);
        job.tenant_id = this.options.legacyOwner.tenantId; job.agent_id = this.options.legacyOwner.agentId;
        if (job.token_hash) job.token_hash = tokenHash(this.options.legacyOwner, job.id, job.token_hash);
      } else { this.validPrincipal({ tenantId: job.tenant_id, agentId: job.agent_id }); }
      loaded.push({ job, legacy });
    }
    // Full validation precedes migration: invalid manifests never partially assign ownership.
    for (const { job, legacy } of loaded) {
      if (legacy) await this.save(job);
      this.jobs.set(job.id, job);
      for (const filename of await fs.readdir(this.dir(job.id))) {
        if (/^job\.json\.[0-9a-f-]{36}\.tmp$/.test(filename)) await fs.rm(path.join(this.dir(job.id), filename), { force: true });
      }
      // An interrupted upload is retriable; never treat its partial bytes as input.
      await fs.rm(path.join(this.dir(job.id), "input.part"), { force: true });
      await fs.rm(path.join(this.dir(job.id), "output.part"), { force: true });
      if (job.status === "awaiting_upload") await fs.rm(this.input(job), { force: true });
      if (job.status === "running") {
        job.status = "failed";
        job.error = "Conversion interrupted by server restart";
        job.error_code = "CONVERSION_INTERRUPTED";
        delete job.error_details;
        job.expires_at = new Date(Date.now() + this.options.retentionMs).toISOString();
        await this.save(job);
      }
    }
    for (const id of orphans) await fs.rm(this.dir(id), { recursive: true, force: true });
    await this.cleanup();
  }
  async createUpload(principal: Principal, { filename, size_bytes }: { filename: string; size_bytes: number }, issueUploadCredential = false) {
    this.validPrincipal(principal);
    return this.locked("registry", async () => {
      if (this.closing) throw new ServiceError(503, "Service closing");
      // Bound tombstones as well as live jobs during sustained upload traffic.
      // Tombstones hold no reservation, so a failed removal is skipped here; the sweep reports and retries it.
      for (const expired of [...this.jobs.values()].filter(job => job.status === "expired")) {
        await this.locked(expired.id, async () => {
          await fs.rm(this.dir(expired.id), { recursive: true, force: true });
          this.forget(expired.id);
        }).catch(() => undefined);
      }
      if (typeof filename !== "string" || filename.length > 255 || !filename.length || /[\x00-\x1f\x7f/\\]/.test(filename) || filename === "." || filename.includes("..")) throw new ServiceError(400, "Invalid filename");
      const extension = path.extname(filename).toLowerCase();
      if (!extensions.has(extension)) throw new ServiceError(415, "Unsupported file format");
      if (!Number.isSafeInteger(size_bytes) || size_bytes < 0) throw new ServiceError(413, "Invalid or excessive file size");
      if (size_bytes > this.options.maxUploadBytes) throw new ServiceError(413, "File exceeds upload limit", "FILE_TOO_LARGE", { limit_bytes: this.options.maxUploadBytes, requested_bytes: size_bytes });
      const live = [...this.jobs.values()].filter(job => job.status !== "expired");
      const reserved = live.reduce((total, job) => total + job.size_bytes + this.options.maxOutputBytes, 0);
      const tenant = live.filter(job => job.tenant_id === principal.tenantId);
      const agent = tenant.filter(job => job.agent_id === principal.agentId);
      const reservation = size_bytes + this.options.maxOutputBytes;
      const own = this.agentLimits(principal);
      for (const [scope, jobs, maxJobs, maxBytes] of [
        ["global", live, this.options.maxJobs, this.options.maxStorageBytes],
        ["tenant", tenant, this.options.maxTenantJobs ?? this.options.maxJobs, this.options.maxTenantStorageBytes ?? this.options.maxStorageBytes],
        ["agent", agent, own.jobs, own.bytes],
      ] as const) {
        const bytes = scope === "global" ? reserved : jobs.reduce((total, job) => total + job.size_bytes + this.options.maxOutputBytes, 0);
        if (jobs.length >= maxJobs || bytes + reservation > maxBytes) {
          await this.audit("quota_denied", principal, undefined, undefined, "capacity_exhausted");
          // Report configured budgets, never other agents' usage or job IDs.
          if (jobs.length >= maxJobs) throw new ServiceError(507, "Temporary job capacity exhausted", "JOB_LIMIT_EXCEEDED", { scope, limit_jobs: maxJobs });
          throw new ServiceError(507, "Temporary storage capacity exhausted", "STORAGE_LIMIT_EXCEEDED", { scope, limit_bytes: maxBytes, requested_bytes: size_bytes, reserved_bytes: reservation });
        }
      }
      await this.audit("create_upload", principal);
      const id = randomUUID(), token = randomBytes(32).toString("base64url");
      const uploadCredential = issueUploadCredential ? randomBytes(32).toString("base64url") : undefined;
      const job: Job = { tenant_id: principal.tenantId, agent_id: principal.agentId, id, filename, extension, size_bytes, token_hash: tokenHash(principal, id, hash(token)), status: "awaiting_upload", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + (issueUploadCredential ? Math.min(this.options.uploadTtlMs, 300000) : this.options.uploadTtlMs)).toISOString() };
      if (uploadCredential) job.upload_auth_hash = tokenHash(principal, id, hash(uploadCredential));
      await fs.mkdir(this.dir(id), { mode: 0o700 });
      try { await this.save(job); } catch (error) { await fs.rm(this.dir(id), { recursive: true, force: true }); throw error; }
      this.jobs.set(id, job);
      await this.internalAudit("create_upload_completed", job);
      return { upload_id: id, upload_token: token, expires_at: job.expires_at, ...(uploadCredential ? { upload_auth_token: uploadCredential } : {}) };
    });
  }
  async authenticateUpload(id: string, token: string | undefined): Promise<Principal | null> {
    const job = this.jobs.get(id);
    if (!job || job.status !== "awaiting_upload" || Date.parse(job.expires_at) <= Date.now() || !job.upload_auth_hash || !/^[a-f0-9]{64}$/.test(job.upload_auth_hash) || !token || token.length > 4096) return null;
    const principal = { tenantId: job.tenant_id, agentId: job.agent_id };
    const candidate = Buffer.from(tokenHash(principal, id, hash(token)), "hex");
    return timingSafeEqual(candidate, Buffer.from(job.upload_auth_hash, "hex")) ? principal : null;
  }
  async upload(principal: Principal, id: string, token: string, source: Readable) {
    const owner = await this.owned(principal, id);
    if (owner.status === "awaiting_upload" && (typeof token !== "string" || !owner.token_hash || !timingSafeEqual(Buffer.from(tokenHash(principal, id, hash(token))), Buffer.from(owner.token_hash)))) {
      await this.audit("authorization_denied", principal, id, undefined, "job_not_found");
      throw new ServiceError(404, "Job not found");
    }
    if (this.uploading.has(id)) throw new ServiceError(409, "Upload already in progress");
    const controller = new AbortController();
    this.uploading.set(id, controller);
    try { return await this.locked(id, async () => {
      const job = await this.owned(principal, id); this.available(job);
      if (this.closing) throw new ServiceError(503, "Service closing");
      if (job.status !== "awaiting_upload") throw new ServiceError(409, "Upload already consumed");
      await this.audit("upload", principal, id, job.status);
      let bytes = 0;
      const part = path.join(this.dir(id), "input.part");
      const limit = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > job.size_bytes ? new ServiceError(413, "Upload exceeds declared size", "UPLOAD_SIZE_MISMATCH", { limit_bytes: job.size_bytes, requested_bytes: bytes }) : null, chunk);
      } });
      const timeout = setTimeout(() => controller.abort(), Math.max(1, Date.parse(job.expires_at) - Date.now()));
      const abortSource = () => source.destroy(new ServiceError(408, "Upload cancelled or timed out"));
      controller.signal.addEventListener("abort", abortSource, { once: true });
      try {
        controller.signal.throwIfAborted();
        await pipeline(source, limit, createWriteStream(part, { flags: "wx", mode: 0o600 }), { signal: controller.signal });
        if (bytes !== job.size_bytes) throw new ServiceError(400, "Upload size does not match declared size", "UPLOAD_SIZE_MISMATCH", { limit_bytes: job.size_bytes, requested_bytes: bytes });
        this.available(job);
        await fs.rename(part, this.input(job));
        const uploaded: Job = { ...job, status: "uploaded", expires_at: new Date(Date.now() + this.options.retentionMs).toISOString() };
        delete uploaded.token_hash;
        delete uploaded.upload_auth_hash;
        try { await this.save(uploaded); } catch (error) { await fs.rm(this.input(job), { force: true }); throw error; }
        this.jobs.set(id, uploaded);
        await this.internalAudit("upload_completed", uploaded);
        return { upload_id: id, status: uploaded.status };
      } catch (error) {
        await fs.rm(part, { force: true });
        await this.internalAudit("upload_failed", job);
        if (controller.signal.aborted) throw new ServiceError(408, "Upload cancelled or timed out");
        throw error;
      } finally { clearTimeout(timeout); controller.signal.removeEventListener("abort", abortSource); }
    }); } finally { this.uploading.delete(id); }
  }
  async startConversion(principal: Principal, id: string) {
    await this.owned(principal, id);
    const result = await this.locked(id, async () => {
      if (this.closing) throw new ServiceError(503, "Service closing");
      const job = await this.owned(principal, id); this.available(job);
      await this.audit("start_conversion", principal, id, job.status);
      if (job.status === "awaiting_upload") throw new ServiceError(409, "File upload is incomplete");
      if (job.status === "uploaded") {
        const queued: Job = { ...job, status: "queued" }; await this.save(queued); this.jobs.set(id, queued);
        return { job_id: id, status: queued.status };
      }
      return { job_id: id, status: job.status };
    });
    this.pump(); return result;
  }
  async getStatus(principal: Principal, id: string) {
    await this.owned(principal, id);
    return this.locked(id, async () => {
      const job = await this.owned(principal, id); this.available(job);
      await this.auditRead("read_status", principal, job);
      return { job_id: id, filename: job.filename, status: job.status, created_at: job.created_at, expires_at: job.expires_at, ...(job.error ? { error: job.error, error_info: { ...lookupError(job.error_code ?? legacyCode(job.error)), ...(job.error_details ? { details: job.error_details } : {}) } } : {}) };
    });
  }
  async getMarkdown(principal: Principal, id: string, { offset = 0, max_chars = 16_000 }: { offset?: number; max_chars?: number } = {}) {
    await this.owned(principal, id);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(max_chars) || max_chars < 1 || max_chars > 100_000) throw new ServiceError(400, "Invalid pagination parameters");
    return this.locked(id, async () => {
      const job = await this.owned(principal, id); this.available(job);
      await this.auditRead("read_markdown", principal, job);
      if (job.status !== "completed") throw new ServiceError(409, "Markdown is not ready");
      try { return await readMarkdownPage(path.join(this.dir(id), "output.md"), { offset, max_chars }); }
      catch (error) { if (error instanceof RangeError) throw new ServiceError(400, "Offset exceeds Markdown length"); throw error; }
    });
  }
  private pump() {
    if (this.closing) return;
    while (this.active.size < this.options.concurrency) {
      const activeJobs = [...this.active.keys()].map(id => this.jobs.get(id)).filter((job): job is Job => !!job);
      const eligible = [...this.jobs.values()].filter(job => job.status === "queued" && !this.active.has(job.id) && Date.parse(job.expires_at) > Date.now()
        && activeJobs.filter(active => active.tenant_id === job.tenant_id).length < (this.options.maxTenantConcurrency ?? this.options.concurrency)
        && activeJobs.filter(active => active.tenant_id === job.tenant_id && active.agent_id === job.agent_id).length < this.agentLimits({ tenantId: job.tenant_id, agentId: job.agent_id }).concurrency);
      if (!eligible.length) break;
      const tenants = [...new Set(eligible.map(job => job.tenant_id))];
      const tenant = tenants[(tenants.indexOf(this.lastTenant ?? "") + 1) % tenants.length];
      const agents = [...new Set(eligible.filter(job => job.tenant_id === tenant).map(job => job.agent_id))];
      const agent = agents[(agents.indexOf(this.lastAgent.get(tenant) ?? "") + 1) % agents.length];
      const job = eligible.find(job => job.tenant_id === tenant && job.agent_id === agent)!;
      this.lastTenant = tenant; this.lastAgent.set(tenant, agent);
      const controller = new AbortController();
      // Register synchronously so simultaneous calls cannot start duplicate workers.
      const promise = Promise.resolve().then(() => this.run(job.id, controller)).finally(() => { this.active.delete(job.id); this.pump(); });
      this.active.set(job.id, { controller, promise });
      void promise.catch(() => undefined);
    }
  }
  private async run(id: string, controller: AbortController) {
    let job: Job | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const part = path.join(this.dir(id), "output.part");
    try {
      job = await this.locked(id, async () => {
        const value = this.job(id); this.available(value);
        if (value.status !== "queued") throw new Error("Job is no longer queued");
        const running: Job = { ...value, status: "running" }; await this.save(running); this.jobs.set(id, running); return running;
      });
      timeout = setTimeout(() => { if (!controller.signal.aborted) { timedOut = true; controller.abort(); } }, this.options.conversionTimeoutMs);
      await this.converter(this.input(job), part, controller.signal);
      controller.signal.throwIfAborted();
      if ((await fs.stat(part)).size > this.options.maxOutputBytes) throw new ServiceError(413, "Converted Markdown exceeds output limit", "OUTPUT_LIMIT_EXCEEDED", { limit_bytes: this.options.maxOutputBytes });
      await this.locked(id, async () => {
        await fs.rename(part, path.join(this.dir(id), "output.md"));
        await prepareMarkdownIndex(path.join(this.dir(id), "output.md"));
        const completed: Job = { ...job!, status: "completed", expires_at: new Date(Date.now() + this.options.retentionMs).toISOString() };
        await this.save(completed); this.jobs.set(id, completed); await this.internalAudit("conversion_completed", completed);
      });
    } catch (error) {
      if (!job) {
        // A failed running-state commit must not leave a queued job that pump()
        // retries in a tight loop while the filesystem remains unavailable.
        await this.locked(id, async () => {
          const pending = this.jobs.get(id);
          if (pending?.status !== "queued") return;
          const failed: Job = { ...pending, status: "failed", error: "Unable to persist conversion job", error_code: "INTERNAL_ERROR", expires_at: new Date(Date.now() + this.options.retentionMs).toISOString() };
          this.jobs.set(id, failed);
          await this.save(failed).catch(() => undefined);
        });
      }
      if (job) await this.locked(id, async () => {
        await fs.rm(part, { force: true });
        const info = timedOut ? { ...lookupError("CONVERSION_TIMEOUT"), details: { timeout_ms: this.options.conversionTimeoutMs } }
          : controller.signal.aborted ? lookupError("CONVERSION_CANCELLED")
          : error instanceof ServiceError && (error.code === "OUTPUT_LIMIT_EXCEEDED" || error.code === "CONVERSION_FAILED") ? errorInfo(error) : lookupError("INTERNAL_ERROR");
        const failed: Job = { ...job!, status: "failed", error: info.message, error_code: info.code, error_details: info.details, expires_at: new Date(Date.now() + this.options.retentionMs).toISOString() };
        await this.save(failed); this.jobs.set(id, failed); await this.internalAudit("conversion_failed", failed);
      });
    } finally { if (timeout) clearTimeout(timeout); }
  }
  async deleteJob(principal: Principal, id: string) {
    await this.owned(principal, id);
    await this.audit("delete_job", principal, id);
    this.uploading.get(id)?.abort();
    const worker = this.active.get(id);
    if (worker) { worker.controller.abort(); await worker.promise; }
    return this.locked(id, async () => {
      await this.owned(principal, id);
      await fs.rm(this.dir(id), { recursive: true, force: true }); this.forget(id);
      return { job_id: id, deleted: true };
    });
  }
  /** Single-flight: concurrent callers share the in-flight sweep, which then runs one more pass so their expirations are covered. */
  cleanup(): Promise<void> {
    if (this.sweep) { this.sweepAgain = true; return this.sweep; }
    const sweep = (async () => {
      try { do { this.sweepAgain = false; await this.sweepOnce(); } while (this.sweepAgain && !this.closing); }
      finally { this.sweep = undefined; }
    })();
    return this.sweep = sweep;
  }
  private async sweepOnce() {
    const stats = this.cleanupStats, started = performance.now(), failed = new Set<string>();
    stats.last_started_at = new Date().toISOString();
    for (const id of [...this.jobs.keys()]) {
      if (this.closing) break;
      if (this.active.has(id) || this.uploading.has(id)) continue;
      // Each job is isolated. A failure leaves it in its last committed state (a tombstone, or a past-expiry live job that
      // stays inaccessible and reserved) so the next sweep retries it; reservations are released only by the expired commit.
      try { await this.locked(id, async () => {
        const job = this.jobs.get(id);
        if (!job || this.active.has(id) || Date.parse(job.expires_at) > Date.now()) return;
        if (job.status === "expired") { await fs.rm(this.dir(id), { recursive: true, force: true }); this.forget(id); return; }
        await fs.rm(this.input(job), { force: true });
        await fs.rm(path.join(this.dir(id), "output.md"), { force: true });
        await fs.rm(path.join(this.dir(id), "output.md.index.json"), { force: true });
        const expired: Job = { ...job, status: "expired", expires_at: new Date(Date.now() + this.options.retentionMs).toISOString() }; delete expired.token_hash;
        delete expired.upload_auth_hash;
        await this.save(expired); this.jobs.set(id, expired); this.cleanupPending.delete(id); await this.internalAudit("job_expired", expired);
      }); } catch (error) {
        // Sanitized: event, job ID, status and an errno-style code only; never paths, messages or stacks.
        const raw = (error as NodeJS.ErrnoException | null)?.code, code = typeof raw === "string" && /^[A-Z0-9_]{1,32}$/.test(raw) ? raw : "UNKNOWN";
        failed.add(id); this.cleanupPending.add(id); stats.failures_total++; stats.last_error_code = code;
        console.error("Job cleanup failed", { event: "job_cleanup_failed", job_id: id, status: this.jobs.get(id)?.status ?? "unknown", code });
      }
    }
    this.failedLastSweep = failed;
    Object.assign(stats, { last_finished_at: new Date().toISOString(), consecutive_failed_sweeps: failed.size ? stats.consecutive_failed_sweeps + 1 : 0 });
    if (failed.size) console.error("Job cleanup sweep incomplete", { event: "job_cleanup_sweep_failed", jobs_failed: failed.size, failures_total: stats.failures_total, consecutive_failed_sweeps: stats.consecutive_failed_sweeps, last_error_code: stats.last_error_code, duration_ms: Math.round(performance.now() - started) });
  }

  async health(principal?: Principal) {
    if (principal) { this.validPrincipal(principal); }
    if (!this.healthCache || this.healthCache.until <= Date.now()) {
      const result = checkRuntime(this.options.dataDir, !!this.options.converter, this.options.healthTimeoutMs).finally(() => {
        if (this.healthCache?.result === result) this.healthCache.until = Date.now() + 2000;
      });
      this.healthCache = { until: Infinity, result };
    }
    const [runtime] = await Promise.all([this.healthCache.result, this.recoverAudit()]);
    // Read after the probe; never writes an audit record. A service without an audit sink has nothing that can fail.
    const audit = { available: !this.auditFailing };
    const ready = this.initialized && !this.closing && runtime.storage.writable && runtime.converter.available && audit.available;
    const base = { status: ready ? "ok" : "unavailable", ready, checked_at: runtime.checked_at,
      uptime_seconds: Math.floor(process.uptime()), memory_rss_bytes: process.memoryUsage().rss,
      checks: { initialized: this.initialized, accepting_work: !this.closing, storage: runtime.storage, converter: runtime.converter, audit } };
    if (!principal) return base;
    const mine = [...this.jobs.values()].filter(j => j.tenant_id === principal.tenantId && j.agent_id === principal.agentId);
    const states = Object.fromEntries(["awaiting_upload", "uploaded", "queued", "running", "completed", "failed", "expired"].map(s => [s, mine.filter(j => j.status === s).length]));
    const live = mine.filter(j => j.status !== "expired");
    // Only the caller's own cleanup failures; failures do not affect readiness.
    const cleanup = { last_sweep_at: this.cleanupStats.last_finished_at,
      own_jobs_failed_last_sweep: mine.filter(j => this.failedLastSweep.has(j.id)).length, own_jobs_pending_retry: mine.filter(j => this.cleanupPending.has(j.id)).length };
    // agent_* include only this caller's own operator override; effective is the tightest cap admission and scheduling apply.
    const own = this.agentLimits(principal);
    const tenant = { jobs: this.options.maxTenantJobs ?? this.options.maxJobs, bytes: this.options.maxTenantStorageBytes ?? this.options.maxStorageBytes, concurrency: this.options.maxTenantConcurrency ?? this.options.concurrency };
    return { ...base, own_jobs: states, cleanup, own_reserved_bytes: live.reduce((n, j) => n + j.size_bytes + this.options.maxOutputBytes, 0),
      limits: { global_jobs: this.options.maxJobs, global_reserved_bytes: this.options.maxStorageBytes,
        tenant_jobs: tenant.jobs, agent_jobs: own.jobs, tenant_reserved_bytes: tenant.bytes, agent_reserved_bytes: own.bytes,
        global_concurrency: this.options.concurrency, tenant_concurrency: tenant.concurrency, agent_concurrency: own.concurrency,
        max_upload_bytes: this.options.maxUploadBytes, max_output_bytes: this.options.maxOutputBytes, agent_override: own.overridden,
        effective: { jobs: Math.min(this.options.maxJobs, tenant.jobs, own.jobs), reserved_bytes: Math.min(this.options.maxStorageBytes, tenant.bytes, own.bytes), concurrency: Math.min(this.options.concurrency, tenant.concurrency, own.concurrency) } } };
  }

  /** Unauthenticated readiness verdict: booleans only, no capacity/process metrics. */
  async publicHealth() {
    const { status, ready, checks: { initialized, accepting_work, storage, converter, audit } } = await this.health();
    return { status, ready, checks: { initialized, accepting_work, storage: { writable: storage.writable }, converter: { available: converter.available }, audit: { available: audit.available } } };
  }

  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    for (const upload of this.uploading.values()) upload.abort();
    for (const worker of this.active.values()) worker.controller.abort();
    await Promise.allSettled([...this.active.values()].map(worker => worker.promise));
    await this.sweep?.catch(() => undefined);
    await Promise.allSettled([...this.locks.values()]);
    if (this.lock) { await releaseLock(this.lock); this.lock = undefined; }
  }
}
