import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { AUDIT_PROBE_BASE_MS, AUDIT_PROBE_MAX_MS, AUDIT_READ_REPEAT_EVERY, JobService, type AuditEvent, type AuditSink, type JobServiceOptions } from "./jobs.js";
import { AuditRecordError, createAuditLogger } from "./audit.js";
import { createHttpServer } from "./http.js";
import { createAuthenticator, hashToken } from "./auth.js";

const alice = { tenantId: "tenant-a", agentId: "agent-a" };
const mallory = { tenantId: "tenant-a", agentId: "agent-m" };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { setSystemTime(); while (cleanup.length) await cleanup.pop()!(); });

async function service(overrides: Partial<JobServiceOptions> = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-audit-policy-"));
  const instance = new JobService({ dataDir, maxUploadBytes: 100, maxStorageBytes: 10_000, maxJobs: 10, retentionMs: 60_000, uploadTtlMs: 60_000, conversionTimeoutMs: 5000, maxOutputBytes: 1000, concurrency: 1,
    converter: async (input, output) => { await fs.writeFile(output, `# Converted\n${await fs.readFile(input, "utf8")}`); }, ...overrides });
  cleanup.push(async () => { await instance.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await instance.init();
  return { instance, dataDir };
}
/** A sink that records events and throws while `fail` is set. */
function recorder() {
  const state = { fail: false, events: [] as AuditEvent[] };
  const sink: AuditSink = event => { if (state.fail) throw new Error("audit disk failure"); state.events.push(event); };
  return { state, sink };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function uploaded(instance: JobService, owner = alice, body = "test") {
  const created = await instance.createUpload(owner, { filename: "notes.txt", size_bytes: body.length });
  await instance.upload(owner, created.upload_id, created.upload_token, Readable.from([body]));
  return created.upload_id;
}
/** Condition-based wait: polls status (yielding to the event loop, no fixed delay) until it reaches `status`. */
async function until(instance: JobService, id: string, status: string) {
  for (let tries = 0; tries < 10_000; tries++) {
    if ((await instance.getStatus(alice, id)).status === status) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Job never became ${status}`);
}
const reads = (events: AuditEvent[], event: string, id?: string) => events.filter(e => e.event === event && (id === undefined || e.job_id === id)).map(e => e.status);
/** Captures console.error; `events()` returns the single-line JSON operator events (other log lines are ignored). */
function stderr() {
  const spy = spyOn(console, "error").mockImplementation(() => undefined);
  cleanup.push(async () => spy.mockRestore());
  const lines = () => spy.mock.calls.filter(call => call.length === 1 && typeof call[0] === "string" && call[0].startsWith("{")).map(call => call[0] as string);
  return { spy, lines, events: () => lines().map(line => JSON.parse(line)) };
}

describe("readiness reflects audit sink availability", () => {
  test("a failed audit write makes readiness false until the next successful write, and health probes write nothing", async () => {
    const { state, sink } = recorder();
    const { instance } = await service({ audit: sink });
    const registry = createAuthenticator({ credentials: [{ tenant_id: alice.tenantId, agent_id: alice.agentId, token_sha256: hashToken("a") }] });
    const server = createHttpServer(instance, { authenticator: registry, publicBaseUrl: "http://127.0.0.1", allowedHosts: ["127.0.0.1"] });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const readyz = () => fetch(`http://127.0.0.1:${(server.address() as any).port}/readyz`, { headers: { Host: "127.0.0.1" } });

    const id = await uploaded(instance);
    expect((await instance.health(alice)).checks.audit).toEqual({ available: true });
    expect((await readyz()).status).toBe(200);

    state.fail = true;
    await expect(instance.createUpload(alice, { filename: "b.txt", size_bytes: 1 })).rejects.toMatchObject({ statusCode: 503, code: "AUDIT_UNAVAILABLE" });
    const recorded = state.events.length;
    state.fail = false; // The sink works again, but nothing has written to it yet: readiness keeps reporting the failure.
    const degraded = await instance.health(alice);
    expect(degraded.ready).toBe(false); expect(degraded.status).toBe("unavailable");
    expect(degraded.checks.audit).toEqual({ available: false });
    expect(degraded.checks.storage.writable).toBe(true); expect(degraded.checks.converter.available).toBe(true);
    expect(await instance.publicHealth()).toEqual({ status: "unavailable", ready: false, checks: { initialized: true, accepting_work: true, storage: { writable: true }, converter: { available: true }, audit: { available: false } } });
    const response = await readyz();
    expect(response.status).toBe(503); expect((await response.json()).checks.audit).toEqual({ available: false });
    expect(state.events.length).toBe(recorded); // Neither health() nor /readyz wrote an audit record.

    expect((await instance.getStatus(alice, id)).status).toBe("uploaded"); // A successful audited operation clears the failure.
    expect(state.events.length).toBe(recorded + 1);
    const recovered = await instance.health(alice);
    expect(recovered.ready).toBe(true); expect(recovered.checks.audit).toEqual({ available: true });
    expect((await readyz()).status).toBe(200);
    for (let i = 0; i < 3; i++) { await instance.health(alice); await instance.publicHealth(); await readyz(); }
    expect(state.events.length).toBe(recorded + 1);
  });

  test("background audit failures (conversion completion) also fail readiness", async () => {
    const { state, sink } = recorder();
    const gate = deferred();
    const { instance } = await service({ audit: event => { if (event.event === "conversion_completed") state.fail = true; return sink(event); }, converter: async (_input, output) => { await gate.promise; await fs.writeFile(output, "done"); } });
    const id = await uploaded(instance);
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    cleanup.push(async () => logged.mockRestore());
    await instance.startConversion(alice, id);
    gate.resolve();
    // Wait on the readiness verdict itself; the conversion still completes although its audit record failed.
    for (let tries = 0; (await instance.health()).checks.audit.available; tries++) { if (tries > 10_000) throw new Error("audit never failed"); await new Promise(resolve => setImmediate(resolve)); }
    expect((await instance.health()).ready).toBe(false);
    expect(logged).toHaveBeenCalledWith("Job audit unavailable", "conversion_completed", id);
    state.fail = false;
    expect((await instance.getStatus(alice, id)).status).toBe("completed");
    expect((await instance.health()).ready).toBe(true);
  });

  test("the file logger's probe restores readiness without writing a record, after two passes with backoff", async () => {
    setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const log = stderr();
    const auditDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-audit-policy-log-"));
    cleanup.push(() => fs.rm(auditDir, { recursive: true, force: true }));
    const audit = await createAuditLogger(auditDir);
    const { instance } = await service({ audit });
    await instance.createUpload(alice, { filename: "a.txt", size_bytes: 1 });
    const target = path.join(auditDir, "audit.jsonl"), saved = path.join(auditDir, "saved.jsonl");
    // A directory at the log path makes appends fail with EISDIR, without mocking the filesystem.
    await fs.rename(target, saved); await fs.mkdir(target);
    await expect(instance.createUpload(alice, { filename: "b.txt", size_bytes: 1 })).rejects.toMatchObject({ statusCode: 503 });
    expect((await instance.publicHealth()).checks.audit.available).toBe(false); // The first probe ran at once and also failed.
    await fs.rmdir(target); await fs.rename(saved, target);
    const before = await fs.readFile(target, "utf8");
    expect((await instance.publicHealth()).checks.audit.available).toBe(false); // Within two seconds of the last probe: not re-run.
    setSystemTime(new Date(Date.now() + 2100));
    expect((await instance.health(alice)).checks.audit).toEqual({ available: false }); // First pass: one more is required.
    setSystemTime(new Date(Date.now() + 2 * AUDIT_PROBE_BASE_MS - 100));
    expect((await instance.publicHealth()).checks.audit.available).toBe(false); // The wait doubled to four seconds.
    setSystemTime(new Date(Date.now() + 200));
    const health = await instance.health(alice);
    expect(health.checks.audit).toEqual({ available: true }); expect(health.ready).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe(before); // The probes wrote nothing.
    expect(before.trim().split("\n").map(line => JSON.parse(line).event)).toEqual(["create_upload", "create_upload_completed"]);
    // One event per transition, carrying only an errno-style code: never the log path.
    expect(log.events()).toEqual([{ event: "audit_sink_unavailable", code: expect.stringMatching(/^(EISDIR|EPERM|EACCES)$/) }, { event: "audit_sink_recovered", via: "probe" }]);
    expect(log.lines().some(line => line.includes(auditDir))).toBe(false);
  });

  test("probe backoff doubles to the cap, survives relapses, and only a successful write resets it", async () => {
    setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const log = stderr();
    const state = { write: false, probe: false, probes: [] as number[] };
    const sink: AuditSink = Object.assign((_event: AuditEvent) => { if (!state.write) throw Object.assign(new Error("/var/audit/audit.jsonl: I/O error"), { code: "EIO" }); },
      { probe: async () => { state.probes.push(Date.now()); if (!state.probe) throw new Error("down"); } });
    const { instance } = await service({ audit: sink });
    const start = Date.now();
    const at = async (ms: number) => { setSystemTime(new Date(start + ms)); return (await instance.health()).checks.audit.available; };
    const probed = () => state.probes.map(time => time - start);
    for (let i = 0; i < 3; i++) await expect(instance.createUpload(alice, { filename: "a.txt", size_bytes: 1 })).rejects.toMatchObject({ statusCode: 503, code: "AUDIT_UNAVAILABLE" });
    // While the probe fails, the wait after each probe doubles from 2 s and is capped at 60 s.
    const expected = [0, 2000, 6000, 14_000, 30_000, 62_000, 122_000, 182_000];
    for (const time of expected) {
      if (time > 0) expect(await at(time - 1)).toBe(false);
      expect(await at(time)).toBe(false);
    }
    expect(probed()).toEqual(expected);
    expect(AUDIT_PROBE_MAX_MS).toBe(60_000);
    // The sink recovers; readiness needs two consecutive passes, a full (capped) interval apart.
    state.probe = true;
    expect(await at(242_000)).toBe(false);
    expect(await at(302_000 - 1)).toBe(false);
    expect(await at(302_000)).toBe(true);
    // A write-time failure the probe cannot see: readiness drops again, and the backoff is not reset by probe passes.
    await expect(instance.createUpload(alice, { filename: "a.txt", size_bytes: 1 })).rejects.toMatchObject({ statusCode: 503 });
    expect(await at(302_001)).toBe(false);
    expect(await at(362_000 - 1)).toBe(false);
    expect(await at(362_000)).toBe(false); // First pass after the relapse, 60 s later.
    expect(probed().slice(expected.length)).toEqual([242_000, 302_000, 362_000]);
    // A real successful write restores readiness at once and resets the backoff: the next failure probes at once, then after 2 s.
    state.write = true; await instance.createUpload(alice, { filename: "a.txt", size_bytes: 1 });
    expect(await at(362_001)).toBe(true);
    state.write = false; state.probe = false;
    await expect(instance.createUpload(alice, { filename: "a.txt", size_bytes: 1 })).rejects.toMatchObject({ statusCode: 503 });
    expect(await at(362_002)).toBe(false);
    expect(await at(364_001)).toBe(false);
    expect(await at(364_002)).toBe(false);
    expect(probed().slice(expected.length + 3)).toEqual([362_002, 364_002]);
    // One sanitized event per transition, not per failed write or failed probe.
    expect(log.events()).toEqual([
      { event: "audit_sink_unavailable", code: "EIO" }, { event: "audit_sink_recovered", via: "probe" },
      { event: "audit_sink_unavailable", code: "EIO" }, { event: "audit_sink_recovered", via: "write" },
      { event: "audit_sink_unavailable", code: "EIO" },
    ]);
    expect(log.lines().some(line => line.includes("/var/audit") || line.includes("I/O error"))).toBe(false);
  });

  test("a rejected audit record fails the operation without failing readiness and is logged once per message", async () => {
    const log = stderr();
    const auditDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-audit-policy-log-"));
    cleanup.push(() => fs.rm(auditDir, { recursive: true, force: true }));
    const logger = await createAuditLogger(auditDir);
    const mode = { invalid: false, custom: false };
    // Corrupts one record so the real logger rejects it before touching storage, as a metadata bug would.
    const sink: AuditSink = Object.assign((event: AuditEvent) => {
      if (mode.custom) throw new AuditRecordError("record for tenant-a/agent-a rejected");
      return logger(mode.invalid && event.event === "create_upload" ? { ...event, reason: "private document title" } : event);
    }, { probe: logger.probe });
    const { instance } = await service({ audit: sink });
    mode.invalid = true;
    for (let i = 0; i < 3; i++) await expect(instance.createUpload(alice, { filename: "a.txt", size_bytes: 1 })).rejects.toMatchObject({ statusCode: 503, code: "AUDIT_UNAVAILABLE" });
    const health = await instance.health(alice);
    expect(health.checks.audit).toEqual({ available: true }); expect(health.ready).toBe(true);
    mode.custom = true;
    for (let i = 0; i < 2; i++) await expect(instance.createUpload(alice, { filename: "a.txt", size_bytes: 1 })).rejects.toMatchObject({ statusCode: 503 });
    expect((await instance.publicHealth()).ready).toBe(true);
    // Messages that are not plain fixed strings are replaced; metadata values never reach stderr.
    expect(log.events()).toEqual([{ event: "audit_record_rejected", message: "Invalid audit metadata" }, { event: "audit_record_rejected", message: "Invalid audit record" }]);
    expect(log.lines().some(line => line.includes("private") || line.includes("tenant-a"))).toBe(false);
    mode.invalid = false; mode.custom = false;
    await instance.createUpload(alice, { filename: "a.txt", size_bytes: 1 });
    expect((await fs.readFile(path.join(auditDir, "audit.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line).event)).toEqual(["create_upload", "create_upload_completed"]);
  });

  test("a hung probe is shared and bounded by the health timeout", async () => {
    let calls = 0; let fail = true;
    const hung = deferred();
    const sink: AuditSink = Object.assign((_event: AuditEvent) => { if (fail) throw new Error("down"); }, { probe: async () => { calls++; await hung.promise; } });
    const { instance } = await service({ audit: sink, healthTimeoutMs: 50 });
    await expect(instance.createUpload(alice, { filename: "a.txt", size_bytes: 1 })).rejects.toMatchObject({ statusCode: 503 });
    const started = performance.now();
    const results = await Promise.all([instance.publicHealth(), instance.publicHealth(), instance.health(alice)]);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(results.map(result => result.checks.audit.available)).toEqual([false, false, false]);
    expect(calls).toBe(1);
    // A write that settles while the probe is outstanding wins: the late probe result cannot override a newer failure.
    fail = false; await instance.createUpload(alice, { filename: "b.txt", size_bytes: 1 });
    fail = true; await expect(instance.createUpload(alice, { filename: "c.txt", size_bytes: 1 })).rejects.toMatchObject({ statusCode: 503 });
    hung.resolve(); await new Promise(resolve => setImmediate(resolve));
    expect((await instance.publicHealth()).checks.audit.available).toBe(false);
  });
});

describe("read audit coalescing", () => {
  test("status polling records one read_status per observed state", async () => {
    const { state, sink } = recorder();
    const entered = deferred(), gate = deferred();
    const { instance } = await service({ audit: sink, converter: async (_input, output) => { entered.resolve(); await gate.promise; await fs.writeFile(output, "result"); } });
    const created = await instance.createUpload(alice, { filename: "notes.txt", size_bytes: 4 });
    const id = created.upload_id;
    for (let i = 0; i < 3; i++) expect((await instance.getStatus(alice, id)).status).toBe("awaiting_upload");
    await instance.upload(alice, id, created.upload_token, Readable.from(["test"]));
    for (let i = 0; i < 3; i++) expect((await instance.getStatus(alice, id)).status).toBe("uploaded");
    await instance.startConversion(alice, id); await entered.promise;
    for (let i = 0; i < 3; i++) expect((await instance.getStatus(alice, id)).status).toBe("running");
    gate.resolve(); await until(instance, id, "completed");
    for (let i = 0; i < 3; i++) expect((await instance.getStatus(alice, id)).status).toBe("completed");
    expect(reads(state.events, "read_status", id)).toEqual(["awaiting_upload", "uploaded", "running", "completed"]);
    // Mutations and lifecycle events are not coalesced.
    await instance.startConversion(alice, id); await instance.startConversion(alice, id);
    expect(state.events.filter(e => e.event === "start_conversion").map(e => e.status)).toEqual(["uploaded", "completed", "completed"]);
    expect(state.events.filter(e => e.event === "conversion_completed")).toHaveLength(1);
  });

  test("markdown reads record one read_markdown per observed state, across pages", async () => {
    const { state, sink } = recorder();
    const entered = deferred(), gate = deferred();
    const { instance } = await service({ audit: sink, converter: async (_input, output) => { entered.resolve(); await gate.promise; await fs.writeFile(output, "abcdefghij"); } });
    const id = await uploaded(instance);
    await instance.startConversion(alice, id); await entered.promise;
    for (let i = 0; i < 3; i++) await expect(instance.getMarkdown(alice, id)).rejects.toMatchObject({ statusCode: 409 });
    gate.resolve(); await until(instance, id, "completed");
    let offset: number | null = 0, text = "";
    while (offset !== null) { const page = await instance.getMarkdown(alice, id, { offset, max_chars: 3 }); text += page.markdown; offset = page.next_offset; }
    expect(text).toBe("abcdefghij");
    await instance.getMarkdown(alice, id); // A second full retrieval of the same state is not recorded again.
    expect(reads(state.events, "read_markdown", id)).toEqual(["running", "completed"]);
  });

  test("repeated reads of a completed result are sampled every Nth read; status polling and denials are not", async () => {
    const { state, sink } = recorder();
    const { instance } = await service({ audit: sink });
    const id = await uploaded(instance);
    await instance.startConversion(alice, id); await until(instance, id, "completed");
    expect(AUDIT_READ_REPEAT_EVERY).toBe(10);
    for (let i = 0; i < 25; i++) await instance.getMarkdown(alice, id, { offset: i % 2, max_chars: 2 });
    for (let i = 0; i < 25; i++) await instance.getStatus(alice, id);
    expect(reads(state.events, "read_markdown", id)).toEqual(["completed"]);
    // 24 reads followed the first record: the 10th and 20th each wrote one sampled record with the running count.
    expect(state.events.filter(e => e.event === "read_markdown_repeat").map(e => [e.job_id, e.status, e.repeat_count])).toEqual([[id, "completed", 10], [id, "completed", 20]]);
    expect(state.events.filter(e => e.event === "read_status_repeat")).toHaveLength(0);
    // Unsampled reads succeed while the sink fails; the sampled read fails closed and is written on its retry.
    state.fail = true;
    for (let i = 0; i < 5; i++) await instance.getMarkdown(alice, id); // Reads 25-29.
    await expect(instance.getMarkdown(alice, id)).rejects.toMatchObject({ statusCode: 503, code: "AUDIT_UNAVAILABLE" });
    state.fail = false;
    await instance.getMarkdown(alice, id);
    expect(state.events.filter(e => e.event === "read_markdown_repeat").map(e => e.repeat_count)).toEqual([10, 20, 30]);
    for (let i = 0; i < 3; i++) await expect(instance.getMarkdown(mallory, id)).rejects.toMatchObject({ statusCode: 404 });
    expect(state.events.filter(e => e.event === "authorization_denied")).toHaveLength(3);
  });

  test("authorization_denied is recorded on every attempt", async () => {
    const { state, sink } = recorder();
    const { instance } = await service({ audit: sink });
    const id = await uploaded(instance);
    for (let i = 0; i < 3; i++) await expect(instance.getStatus(mallory, id)).rejects.toMatchObject({ statusCode: 404 });
    for (let i = 0; i < 2; i++) await expect(instance.getMarkdown(mallory, id)).rejects.toMatchObject({ statusCode: 404 });
    const denied = state.events.filter(e => e.event === "authorization_denied");
    expect(denied).toHaveLength(5);
    expect(denied.every(e => e.agent_id === mallory.agentId && e.job_id === id && e.reason === "job_not_found")).toBe(true);
    // A foreign agent's probes never consume the owner's first-observation record.
    await instance.getStatus(alice, id);
    expect(reads(state.events, "read_status", id)).toEqual(["uploaded"]);
  });

  test("a read whose audit failed is recorded on its retry", async () => {
    const { state, sink } = recorder();
    const { instance } = await service({ audit: sink });
    const id = await uploaded(instance);
    state.fail = true;
    await expect(instance.getStatus(alice, id)).rejects.toMatchObject({ statusCode: 503 });
    state.fail = false;
    await instance.getStatus(alice, id); await instance.getStatus(alice, id);
    expect(reads(state.events, "read_status", id)).toEqual(["uploaded"]);
  });

  test("per-job coalescing state is dropped on deletion and on tombstone removal", async () => {
    setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const { state, sink } = recorder();
    const { instance } = await service({ audit: sink });
    const tracked = () => (instance as unknown as { auditedReads: Map<string, Map<string, number>> }).auditedReads;
    const deleted = await uploaded(instance), expiring = await uploaded(instance);
    await instance.getStatus(alice, deleted); await instance.getStatus(alice, expiring);
    expect([...tracked().keys()].sort()).toEqual([deleted, expiring].sort());
    await instance.deleteJob(alice, deleted);
    expect(tracked().has(deleted)).toBe(false);
    await expect(instance.getStatus(alice, deleted)).rejects.toMatchObject({ statusCode: 404 });
    expect(tracked().has(deleted)).toBe(false);
    // Expiry keeps the (bounded) entry with the tombstone; removing the tombstone drops it.
    setSystemTime(new Date(Date.now() + 61_000)); await instance.cleanup();
    expect(state.events.filter(e => e.event === "job_expired").map(e => e.job_id)).toEqual([expiring]);
    setSystemTime(new Date(Date.now() + 61_000)); await instance.cleanup();
    expect(tracked().size).toBe(0);
  });
});
