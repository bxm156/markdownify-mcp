import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Converter, createConverter } from "./converter.js";

export class ServiceError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export type JobStatus = "awaiting_upload" | "uploaded" | "queued" | "running" | "completed" | "failed" | "expired";
type Job = { id: string; filename: string; extension: string; size_bytes: number; token_hash?: string; status: JobStatus; created_at: string; expires_at: string; error?: string };
export type JobServiceOptions = { dataDir: string; maxUploadBytes: number; maxStorageBytes: number; maxJobs: number; retentionMs: number; uploadTtlMs: number; conversionTimeoutMs: number; maxOutputBytes: number; concurrency: number; converter?: Converter };
const extensions = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".md", ".csv", ".html", ".json"]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** One process owns this directory. Atomic manifests preserve jobs across restarts. */
export class JobService {
  private jobs = new Map<string, Job>();
  private locks = new Map<string, Promise<unknown>>();
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private uploading = new Map<string, AbortController>();
  private closing = false;
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
    for (const entry of await fs.readdir(this.options.dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
      let job: Job;
      try { job = JSON.parse(await fs.readFile(path.join(this.dir(entry.name), "job.json"), "utf8")); }
      catch (error) {
        // A crash between mkdir and first atomic manifest commit cannot have
        // produced a client-visible upload ID, so discard that orphan directory.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { await fs.rm(this.dir(entry.name), { recursive: true, force: true }); continue; }
        throw new Error(`Unreadable job manifest: ${entry.name}`);
      }
      if (job.id !== entry.name || !extensions.has(job.extension) || !Number.isSafeInteger(job.size_bytes) || job.size_bytes < 0 || !Number.isFinite(Date.parse(job.expires_at)) || !Number.isFinite(Date.parse(job.created_at)) || (job.status === "awaiting_upload" && !/^[a-f0-9]{64}$/.test(job.token_hash ?? "")) || !["awaiting_upload", "uploaded", "queued", "running", "completed", "failed", "expired"].includes(job.status)) throw new Error("Invalid job manifest");
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
    await this.cleanup();
    this.timer = setInterval(() => { void this.cleanup().catch(() => undefined); }, Math.min(this.options.retentionMs, this.options.uploadTtlMs, 60_000));
    this.timer.unref();
    this.pump();
  }
  async createUpload({ filename, size_bytes }: { filename: string; size_bytes: number }) {
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
      if (live.length >= this.options.maxJobs || reserved + size_bytes + this.options.maxOutputBytes > this.options.maxStorageBytes) throw new ServiceError(507, "Temporary storage capacity exhausted");
      const id = randomUUID(), token = randomBytes(32).toString("base64url");
      const job: Job = { id, filename, extension, size_bytes, token_hash: hash(token), status: "awaiting_upload", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + this.options.uploadTtlMs).toISOString() };
      await fs.mkdir(this.dir(id), { mode: 0o700 });
      try { await this.save(job); } catch (error) { await fs.rm(this.dir(id), { recursive: true, force: true }); throw error; }
      this.jobs.set(id, job);
      return { upload_id: id, upload_token: token, expires_at: job.expires_at };
    });
  }
  async upload(id: string, token: string, source: Readable) {
    if (this.uploading.has(id)) throw new ServiceError(409, "Upload already in progress");
    const controller = new AbortController();
    this.uploading.set(id, controller);
    try { return await this.locked(id, async () => {
      const job = this.job(id); this.available(job);
      if (this.closing) throw new ServiceError(503, "Service closing");
      if (job.status !== "awaiting_upload") throw new ServiceError(409, "Upload already consumed");
      if (typeof token !== "string" || !job.token_hash || !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(job.token_hash))) throw new ServiceError(401, "Invalid upload token");
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
        return { upload_id: id, status: uploaded.status };
      } catch (error) {
        await fs.rm(part, { force: true });
        if (controller.signal.aborted) throw new ServiceError(408, "Upload cancelled or timed out");
        throw error;
      } finally { clearTimeout(timeout); controller.signal.removeEventListener("abort", abortSource); }
    }); } finally { this.uploading.delete(id); }
  }
  async startConversion(id: string) {
    const result = await this.locked(id, async () => {
      if (this.closing) throw new ServiceError(503, "Service closing");
      const job = this.job(id); this.available(job);
      if (job.status === "awaiting_upload") throw new ServiceError(409, "File upload is incomplete");
      if (job.status === "uploaded") {
        const queued: Job = { ...job, status: "queued" }; await this.save(queued); this.jobs.set(id, queued);
        return { job_id: id, status: queued.status };
      }
      return { job_id: id, status: job.status };
    });
    this.pump(); return result;
  }
  async getStatus(id: string) {
    return this.locked(id, async () => {
      const job = this.job(id); this.available(job);
      return { job_id: id, filename: job.filename, status: job.status, created_at: job.created_at, expires_at: job.expires_at, ...(job.error ? { error: job.error } : {}) };
    });
  }
  async getMarkdown(id: string, { offset = 0, max_chars = 16_000 }: { offset?: number; max_chars?: number } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(max_chars) || max_chars < 1 || max_chars > 100_000) throw new ServiceError(400, "Invalid pagination parameters");
    return this.locked(id, async () => {
      const job = this.job(id); this.available(job);
      if (job.status !== "completed") throw new ServiceError(409, "Markdown is not ready");
      const text = await fs.readFile(path.join(this.dir(id), "output.md"), "utf8");
      // Code-point pagination avoids splitting surrogate pairs between pages.
      const chars = Array.from(text);
      if (offset > chars.length) throw new ServiceError(400, "Offset exceeds Markdown length");
      const end = Math.min(offset + max_chars, chars.length);
      return { markdown: chars.slice(offset, end).join(""), next_offset: end < chars.length ? end : null, total_chars: chars.length };
    });
  }
  private pump() {
    if (this.closing) return;
    for (const job of this.jobs.values()) {
      if (this.active.size >= this.options.concurrency) break;
      if (job.status !== "queued" || this.active.has(job.id) || Date.parse(job.expires_at) <= Date.now()) continue;
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
        const completed: Job = { ...job!, status: "completed", expires_at: new Date(Date.now() + this.options.retentionMs).toISOString() };
        await this.save(completed); this.jobs.set(id, completed);
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
        await this.save(failed); this.jobs.set(id, failed);
      });
    } finally { if (timeout) clearTimeout(timeout); }
  }
  async deleteJob(id: string) {
    this.job(id);
    this.uploading.get(id)?.abort();
    const worker = this.active.get(id);
    if (worker) { worker.controller.abort(); await worker.promise; }
    return this.locked(id, async () => {
      this.job(id);
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
        const expired: Job = { ...job, status: "expired", expires_at: new Date(Date.now() + this.options.retentionMs).toISOString() }; delete expired.token_hash;
        await this.save(expired); this.jobs.set(id, expired);
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
