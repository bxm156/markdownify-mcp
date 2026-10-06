import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Converter, createConverter } from "./converter.js";
import { validatePrincipal, type Principal } from "./identity.js";
import { prepareMarkdownIndex, readMarkdownPage } from "./markdown.js";

export class ServiceError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export type JobStatus = "awaiting_upload" | "uploaded" | "queued" | "running" | "completed" | "failed" | "expired";
type Job = { tenant_id: string; agent_id: string; id: string; filename: string; extension: string; size_bytes: number; token_hash?: string; status: JobStatus; created_at: string; expires_at: string; error?: string };
export type AuditEvent = { event: string; tenant_id: string; agent_id: string; job_id?: string; status?: string; reason?: string };
export type JobServiceOptions = { dataDir: string; maxUploadBytes: number; maxStorageBytes: number; maxJobs: number; retentionMs: number; uploadTtlMs: number; conversionTimeoutMs: number; maxOutputBytes: number; concurrency: number; converter?: Converter; legacyOwner?: Principal; maxTenantJobs?: number; maxTenantStorageBytes?: number; maxTenantConcurrency?: number; maxAgentJobs?: number; maxAgentStorageBytes?: number; maxAgentConcurrency?: number; audit?: (event: AuditEvent) => void | Promise<void> };
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
  private lastTenant?: string;
  private lastAgent = new Map<string, string>();
  private converter: Converter;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private options: JobServiceOptions) {
    for (const [name, value] of Object.entries(options)) {
      if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`Invalid ${name}`);
    }
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
  private validPrincipal(principal: Principal) {
    try { validatePrincipal(principal); } catch { throw new ServiceError(401, "Invalid principal"); }
  }
  private async audit(event: string, principal: Principal, id?: string, status?: string, reason?: string) {
    try { await this.options.audit?.({ event, tenant_id: principal.tenantId, agent_id: principal.agentId, ...(id && /^[0-9a-f-]{36}$/.test(id) ? { job_id: id } : {}), ...(status ? { status } : {}), ...(reason ? { reason } : {}) }); }
    catch { throw new ServiceError(503, "Audit unavailable"); }
  }
  private async internalAudit(event: string, job: Job) {
    try { await this.audit(event, { tenantId: job.tenant_id, agentId: job.agent_id }, job.id, job.status); }
    catch { console.error("Job audit unavailable", event, job.id); }
  }
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
        job.expires_at = new Date(Date.now() + this.options.retentionMs).toISOString();
        await this.save(job);
      }
    }
    for (const id of orphans) await fs.rm(this.dir(id), { recursive: true, force: true });
    await this.cleanup();
    this.timer = setInterval(() => { void this.cleanup().catch(() => undefined); }, Math.min(this.options.retentionMs, this.options.uploadTtlMs, 60_000));
    this.timer.unref();
    this.pump();
  }
  async createUpload(principal: Principal, { filename, size_bytes }: { filename: string; size_bytes: number }) {
    this.validPrincipal(principal);
    return this.locked("registry", async () => {
      if (this.closing) throw new ServiceError(503, "Service closing");
      // Bound tombstones as well as live jobs during sustained upload traffic.
      for (const expired of [...this.jobs.values()].filter(job => job.status === "expired")) {
        await this.locked(expired.id, async () => {
          await fs.rm(this.dir(expired.id), { recursive: true, force: true });
          this.jobs.delete(expired.id);
        });
      }
      if (typeof filename !== "string" || filename.length > 255 || !filename.length || /[\x00-\x1f\x7f/\\]/.test(filename) || filename === "." || filename.includes("..")) throw new ServiceError(400, "Invalid filename");
      const extension = path.extname(filename).toLowerCase();
      if (!extensions.has(extension)) throw new ServiceError(415, "Unsupported file format");
      if (!Number.isSafeInteger(size_bytes) || size_bytes < 0 || size_bytes > this.options.maxUploadBytes) throw new ServiceError(413, "Invalid or excessive file size");
      const live = [...this.jobs.values()].filter(job => job.status !== "expired");
      const reserved = live.reduce((total, job) => total + job.size_bytes + this.options.maxOutputBytes, 0);
      if (live.length >= this.options.maxJobs || reserved + size_bytes + this.options.maxOutputBytes > this.options.maxStorageBytes) {
        await this.audit("quota_denied", principal, undefined, undefined, "capacity_exhausted");
        throw new ServiceError(507, "Temporary storage capacity exhausted");
      }
      const scoped = (jobs: Job[], maxJobs: number, maxBytes: number) => jobs.length >= maxJobs || jobs.reduce((total, job) => total + job.size_bytes + this.options.maxOutputBytes, 0) + size_bytes + this.options.maxOutputBytes > maxBytes;
      const tenant = live.filter(job => job.tenant_id === principal.tenantId);
      const agent = tenant.filter(job => job.agent_id === principal.agentId);
      if (scoped(tenant, this.options.maxTenantJobs ?? this.options.maxJobs, this.options.maxTenantStorageBytes ?? this.options.maxStorageBytes) || scoped(agent, this.options.maxAgentJobs ?? this.options.maxJobs, this.options.maxAgentStorageBytes ?? this.options.maxStorageBytes)) {
        await this.audit("quota_denied", principal, undefined, undefined, "capacity_exhausted");
        throw new ServiceError(507, "Temporary storage capacity exhausted");
      }
      await this.audit("create_upload", principal);
      const id = randomUUID(), token = randomBytes(32).toString("base64url");
      const job: Job = { tenant_id: principal.tenantId, agent_id: principal.agentId, id, filename, extension, size_bytes, token_hash: tokenHash(principal, id, hash(token)), status: "awaiting_upload", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + this.options.uploadTtlMs).toISOString() };
      await fs.mkdir(this.dir(id), { mode: 0o700 });
      try { await this.save(job); } catch (error) { await fs.rm(this.dir(id), { recursive: true, force: true }); throw error; }
      this.jobs.set(id, job);
      await this.internalAudit("create_upload_completed", job);
      return { upload_id: id, upload_token: token, expires_at: job.expires_at };
    });
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
        callback(bytes > job.size_bytes ? new ServiceError(413, "Upload exceeds declared size") : null, chunk);
      } });
      const timeout = setTimeout(() => controller.abort(), Math.max(1, Date.parse(job.expires_at) - Date.now()));
      const abortSource = () => source.destroy(new ServiceError(408, "Upload cancelled or timed out"));
      controller.signal.addEventListener("abort", abortSource, { once: true });
      try {
        controller.signal.throwIfAborted();
        await pipeline(source, limit, createWriteStream(part, { flags: "wx", mode: 0o600 }), { signal: controller.signal });
        if (bytes !== job.size_bytes) throw new ServiceError(400, "Upload size does not match declared size");
        this.available(job);
        await fs.rename(part, this.input(job));
        const uploaded: Job = { ...job, status: "uploaded", expires_at: new Date(Date.now() + this.options.retentionMs).toISOString() };
        delete uploaded.token_hash;
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
      await this.audit("read_status", principal, id, job.status);
      return { job_id: id, filename: job.filename, status: job.status, created_at: job.created_at, expires_at: job.expires_at, ...(job.error ? { error: job.error } : {}) };
    });
  }
  async getMarkdown(principal: Principal, id: string, { offset = 0, max_chars = 16_000 }: { offset?: number; max_chars?: number } = {}) {
    await this.owned(principal, id);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(max_chars) || max_chars < 1 || max_chars > 100_000) throw new ServiceError(400, "Invalid pagination parameters");
    return this.locked(id, async () => {
      const job = await this.owned(principal, id); this.available(job);
      await this.audit("read_markdown", principal, id, job.status);
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
        && activeJobs.filter(active => active.tenant_id === job.tenant_id && active.agent_id === job.agent_id).length < (this.options.maxAgentConcurrency ?? this.options.concurrency));
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
    const part = path.join(this.dir(id), "output.part");
    try {
      job = await this.locked(id, async () => {
        const value = this.job(id); this.available(value);
        if (value.status !== "queued") throw new Error("Job is no longer queued");
        const running: Job = { ...value, status: "running" }; await this.save(running); this.jobs.set(id, running); return running;
      });
      timeout = setTimeout(() => controller.abort(new Error("Conversion timeout")), this.options.conversionTimeoutMs);
      await this.converter(this.input(job), part, controller.signal);
      controller.signal.throwIfAborted();
      if ((await fs.stat(part)).size > this.options.maxOutputBytes) throw new Error("Output limit exceeded");
      await this.locked(id, async () => {
        await fs.rename(part, path.join(this.dir(id), "output.md"));
        await prepareMarkdownIndex(path.join(this.dir(id), "output.md"));
        const completed: Job = { ...job!, status: "completed", expires_at: new Date(Date.now() + this.options.retentionMs).toISOString() };
        await this.save(completed); this.jobs.set(id, completed); await this.internalAudit("conversion_completed", completed);
      });
    } catch {
      if (!job) {
        // A failed running-state commit must not leave a queued job that pump()
        // retries in a tight loop while the filesystem remains unavailable.
        await this.locked(id, async () => {
          const pending = this.jobs.get(id);
          if (pending?.status !== "queued") return;
          const failed: Job = { ...pending, status: "failed", error: "Unable to persist conversion job", expires_at: new Date(Date.now() + this.options.retentionMs).toISOString() };
          this.jobs.set(id, failed);
          await this.save(failed).catch(() => undefined);
        });
      }
      if (job) await this.locked(id, async () => {
        await fs.rm(part, { force: true });
        const failed: Job = { ...job!, status: "failed", error: controller.signal.aborted ? "Conversion cancelled or timed out" : "Document conversion failed", expires_at: new Date(Date.now() + this.options.retentionMs).toISOString() };
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
      await fs.rm(this.dir(id), { recursive: true, force: true }); this.jobs.delete(id);
      return { job_id: id, deleted: true };
    });
  }
  async cleanup() {
    for (const id of [...this.jobs.keys()]) {
      if (this.active.has(id) || this.uploading.has(id)) continue;
      await this.locked(id, async () => {
        const job = this.jobs.get(id);
        if (!job || this.active.has(id) || Date.parse(job.expires_at) > Date.now()) return;
        if (job.status === "expired") { await fs.rm(this.dir(id), { recursive: true, force: true }); this.jobs.delete(id); return; }
        await fs.rm(this.input(job), { force: true });
        await fs.rm(path.join(this.dir(id), "output.md"), { force: true });
        await fs.rm(path.join(this.dir(id), "output.md.index.json"), { force: true });
        const expired: Job = { ...job, status: "expired", expires_at: new Date(Date.now() + this.options.retentionMs).toISOString() }; delete expired.token_hash;
        await this.save(expired); this.jobs.set(id, expired); await this.internalAudit("job_expired", expired);
      });
    }
  }
  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    for (const upload of this.uploading.values()) upload.abort();
    for (const worker of this.active.values()) worker.controller.abort();
    await Promise.allSettled([...this.active.values()].map(worker => worker.promise));
    await Promise.allSettled([...this.locks.values()]);
  }
}
