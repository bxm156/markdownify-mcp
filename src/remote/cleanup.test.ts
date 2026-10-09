import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { JobService, type JobServiceOptions } from "./jobs.js";
import { purgeOwnerJobs } from "./purge-owner.js";
import type { Principal } from "./identity.js";

const alice: Principal = { tenantId: "team", agentId: "alice" }, bob: Principal = { tenantId: "team", agentId: "bob" }, carol: Principal = { tenantId: "other", agentId: "carol" };
const services: JobService[] = [], directories: string[] = [];
// Captured before any spy so fault injection can delegate to the real filesystem.
const realRm = fs.rm, realWriteFile = fs.writeFile, realRename = fs.rename;
const denied = (target: unknown) => Promise.reject(Object.assign(new Error(`EACCES: permission denied, open '${String(target)}'`), { code: "EACCES", path: String(target) }));
async function service(overrides: Partial<JobServiceOptions> = {}) {
  const dataDir = overrides.dataDir ?? await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-cleanup-"));
  if (!directories.includes(dataDir)) directories.push(dataDir);
  const options: JobServiceOptions = { dataDir, maxUploadBytes: 100, maxOutputBytes: 1024, maxStorageBytes: 100_000, maxJobs: 20, retentionMs: 60_000, uploadTtlMs: 60_000, conversionTimeoutMs: 5000, concurrency: 1,
    converter: async (input, output) => { await fs.writeFile(output, await fs.readFile(input)); }, ...overrides };
  const instance = new JobService(options); services.push(instance); await instance.init(); return { instance, options };
}
async function uploaded(instance: JobService, actor: Principal, content = "x") {
  const job = await instance.createUpload(actor, { filename: "file.txt", size_bytes: Buffer.byteLength(content) });
  await instance.upload(actor, job.upload_id, job.upload_token, Readable.from([content])); return job.upload_id;
}
async function until(instance: JobService, actor: Principal, id: string, desired: string) {
  for (let tries = 0; tries < 400; tries++) { if ((await instance.getStatus(actor, id)).status === desired) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Job never became ${desired}`);
}
async function completed(instance: JobService, actor: Principal) { const id = await uploaded(instance, actor); await instance.startConversion(actor, id); await until(instance, actor, id, "completed"); return id; }
const manifest = async (dataDir: string, id: string) => JSON.parse(await fs.readFile(path.join(dataDir, id, "job.json"), "utf8"));
const files = async (dataDir: string, id: string) => (await fs.readdir(path.join(dataDir, id))).sort();
const health = async (instance: JobService, actor = alice) => await instance.health(actor) as any;
const advance = (ms: number) => setSystemTime(new Date(Date.now() + ms));
afterEach(async () => {
  setSystemTime();
  await Promise.all(services.splice(0).map(instance => instance.close()));
  await Promise.all(directories.splice(0).map(directory => realRm(directory, { recursive: true, force: true })));
});

describe("retention cleanup resilience", () => {
  test("a remove failure is isolated to one job, logged without paths and retried until a later sweep recovers", async () => {
    const { instance, options } = await service();
    const failing = await completed(instance, alice), other = await completed(instance, carol), failingDir = path.join(options.dataDir, failing);
    const rm = spyOn(fs, "rm").mockImplementation(((target: any, opts: any) => String(target).startsWith(failingDir) ? denied(target) : realRm(target, opts)) as typeof fs.rm);
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      advance(120_000); await instance.cleanup();
      // The failure on the first job did not stop the sweep: another owner's job is erased and tombstoned.
      expect(await files(options.dataDir, other)).toEqual(["job.json"]);
      expect((await manifest(options.dataDir, other)).status).toBe("expired");
      // The failed job keeps its committed state and reservation, and stays inaccessible after expiry.
      expect((await manifest(options.dataDir, failing)).status).toBe("completed");
      expect(await files(options.dataDir, failing)).toEqual(["input.txt", "job.json", "output.md", "output.md.index.json"]);
      await expect(instance.getMarkdown(alice, failing)).rejects.toMatchObject({ statusCode: 410 });
      expect((await health(instance)).own_reserved_bytes).toBe(1 + options.maxOutputBytes);
      expect((await health(instance)).cleanup).toMatchObject({ jobs_failed_last_sweep: 1, failures_total: 1, consecutive_failed_sweeps: 1, last_error_code: "EACCES" });
      expect(logged).toHaveBeenCalledTimes(1);
      const log = JSON.stringify(logged.mock.calls);
      expect(log).toContain(failing); expect(log).toContain("EACCES"); expect(log).not.toContain(options.dataDir); expect(log).not.toContain("permission denied");
      // Repeated sweeps keep retrying the failed job and still remove the other owner's expired tombstone.
      advance(120_000); await instance.cleanup();
      await expect(fs.stat(path.join(options.dataDir, other))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await health(instance)).cleanup).toMatchObject({ jobs_failed_last_sweep: 1, failures_total: 2, consecutive_failed_sweeps: 2 });
      expect(logged).toHaveBeenCalledTimes(2);
      rm.mockRestore(); await instance.cleanup();
      expect(await files(options.dataDir, failing)).toEqual(["job.json"]);
      expect((await manifest(options.dataDir, failing)).status).toBe("expired");
      const after = await health(instance);
      expect(after.own_reserved_bytes).toBe(0); expect(after.ready).toBe(true);
      expect(after.cleanup).toMatchObject({ jobs_failed_last_sweep: 0, failures_total: 2, consecutive_failed_sweeps: 0, last_error_code: "EACCES" });
      expect(typeof after.cleanup.last_failure_at).toBe("string"); expect(after.cleanup.last_duration_ms).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(after.cleanup)).not.toContain(options.dataDir); expect(logged).toHaveBeenCalledTimes(2);
    } finally { rm.mockRestore(); logged.mockRestore(); setSystemTime(); }
  });

  for (const method of ["writeFile", "rename"] as const) test(`a failed tombstone ${method} keeps the job reserved and inaccessible until a later sweep commits it`, async () => {
    const { instance, options } = await service({ maxAgentJobs: 1 });
    const failing = await uploaded(instance, alice), other = await uploaded(instance, bob), target = path.join(options.dataDir, failing, "job.json");
    const original: (...args: any[]) => Promise<unknown> = method === "writeFile" ? realWriteFile : realRename;
    const spy = spyOn(fs, method).mockImplementation(((...args: any[]) => String(args[method === "writeFile" ? 0 : 1]).startsWith(target) ? denied(args[0]) : original(...args)) as any);
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      advance(120_000); await instance.cleanup();
      // Input bytes were erased before the failed commit; no temporary manifest is left behind and the job never became a tombstone.
      expect(await files(options.dataDir, failing)).toEqual(["job.json"]);
      expect((await manifest(options.dataDir, failing)).status).toBe("uploaded");
      await expect(instance.getStatus(alice, failing)).rejects.toMatchObject({ statusCode: 410 });
      expect((await manifest(options.dataDir, other)).status).toBe("expired");
      const pending = await health(instance);
      expect(pending.own_jobs.uploaded).toBe(1); expect(pending.own_reserved_bytes).toBe(1 + options.maxOutputBytes);
      expect(pending.cleanup).toMatchObject({ jobs_failed_last_sweep: 1, failures_total: 1, last_error_code: "EACCES" });
      // The reservation is not released before the tombstone commit succeeds.
      await expect(instance.createUpload(alice, { filename: "next.txt", size_bytes: 1 })).rejects.toMatchObject({ statusCode: 507 });
      expect(logged).toHaveBeenCalledTimes(1); expect(JSON.stringify(logged.mock.calls)).not.toContain(options.dataDir);
      spy.mockRestore(); await instance.cleanup();
      const tombstone = await manifest(options.dataDir, failing);
      expect(tombstone.status).toBe("expired"); expect(tombstone).not.toHaveProperty("token_hash"); expect(tombstone).not.toHaveProperty("upload_auth_hash");
      expect((await health(instance)).own_reserved_bytes).toBe(0); expect((await health(instance)).cleanup.consecutive_failed_sweeps).toBe(0);
      await instance.createUpload(alice, { filename: "next.txt", size_bytes: 1 });
    } finally { spy.mockRestore(); logged.mockRestore(); setSystemTime(); }
  });

  test("a failed tombstone removal during upload admission is reported without blocking the upload", async () => {
    const { instance, options } = await service();
    const expired = await uploaded(instance, bob); advance(120_000); await instance.cleanup(); setSystemTime();
    const rm = spyOn(fs, "rm").mockImplementation(((target: any, opts: any) => String(target) === path.join(options.dataDir, expired) ? denied(target) : realRm(target, opts)) as typeof fs.rm);
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await instance.createUpload(alice, { filename: "a.txt", size_bytes: 1 });
      expect((await manifest(options.dataDir, expired)).status).toBe("expired");
      expect((await health(instance)).cleanup).toMatchObject({ failures_total: 1, last_error_code: "EACCES" }); expect(logged).toHaveBeenCalledTimes(1);
      rm.mockRestore(); await instance.createUpload(alice, { filename: "b.txt", size_bytes: 1 });
      await expect(fs.stat(path.join(options.dataDir, expired))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { rm.mockRestore(); logged.mockRestore(); }
  });

  test("concurrent cleanup calls share one in-flight sweep that never overlaps itself", async () => {
    const { instance, options } = await service();
    const broken = await uploaded(instance, carol), slow = await uploaded(instance, alice), other = await uploaded(instance, bob);
    const brokenDir = path.join(options.dataDir, broken), slowInput = path.join(options.dataDir, slow, "input.txt");
    let release!: () => void, entered!: () => void, slowCalls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
    // The first job fails on every pass, so failures_total counts sweep passes; the second job holds the sweep open.
    const rm = spyOn(fs, "rm").mockImplementation((async (target: any, opts: any) => {
      if (String(target).startsWith(brokenDir)) return denied(target);
      if (String(target) === slowInput) { slowCalls++; entered(); await gate; }
      return realRm(target, opts);
    }) as typeof fs.rm);
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    let first: Promise<void> | undefined;
    try {
      advance(120_000); first = instance.cleanup(); await reached;
      const second = instance.cleanup(), third = instance.cleanup();
      expect(second).toBe(first); expect(third).toBe(first);
      await new Promise(resolve => setTimeout(resolve, 20));
      // An overlapping sweep would already have retried the first job and processed the third.
      expect((await health(instance)).cleanup.failures_total).toBe(1);
      expect((await manifest(options.dataDir, other)).status).toBe("uploaded"); expect(slowCalls).toBe(1);
      release(); await first;
      expect((await manifest(options.dataDir, slow)).status).toBe("expired"); expect((await manifest(options.dataDir, other)).status).toBe("expired");
      // Callers that joined late are covered by exactly one follow-up pass, not one pass each.
      expect((await health(instance)).cleanup).toMatchObject({ failures_total: 2, consecutive_failed_sweeps: 2 }); expect(slowCalls).toBe(1);
      const next = instance.cleanup(); expect(next).not.toBe(first); await next;
    } finally { release(); await first?.catch(() => undefined); rm.mockRestore(); logged.mockRestore(); setSystemTime(); }
  });

  test("periodic ticks skip while a long sweep is still running", async () => {
    let slowInput = "", brokenDir = "", release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
    const rm = spyOn(fs, "rm").mockImplementation((async (target: any, opts: any) => {
      if (brokenDir && String(target).startsWith(brokenDir)) return denied(target);
      if (slowInput && String(target) === slowInput) { entered(); await gate; }
      return realRm(target, opts);
    }) as typeof fs.rm);
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // A 30 ms retention also makes the cleanup interval 30 ms, so real timer ticks drive these sweeps.
      const { instance, options } = await service({ retentionMs: 30 });
      const broken = await instance.createUpload(carol, { filename: "a.txt", size_bytes: 1 });
      const slow = await instance.createUpload(alice, { filename: "b.txt", size_bytes: 1 }); slowInput = path.join(options.dataDir, slow.upload_id, "input.txt");
      await instance.upload(carol, broken.upload_id, broken.upload_token, Readable.from(["a"])); brokenDir = path.join(options.dataDir, broken.upload_id);
      await instance.upload(alice, slow.upload_id, slow.upload_token, Readable.from(["b"]));
      await reached; const atGate = (await health(instance)).cleanup.failures_total;
      await new Promise(resolve => setTimeout(resolve, 150));
      expect((await health(instance)).cleanup.failures_total).toBe(atGate);
    } finally { release(); rm.mockRestore(); logged.mockRestore(); }
  });

  test("expiry erases every artifact, leaves credential-free tombstones and skips active workers", async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const { instance, options } = await service({ concurrency: 2, converter: async (input, output) => { if (await fs.readFile(input, "utf8") === "hold") await gate; await fs.writeFile(output, await fs.readFile(input)); } });
    try {
      const done = await completed(instance, alice);
      const pending = await instance.createUpload(alice, { filename: "pending.txt", size_bytes: 1 }, true);
      expect(await manifest(options.dataDir, pending.upload_id)).toMatchObject({ token_hash: expect.any(String), upload_auth_hash: expect.any(String) });
      const running = await uploaded(instance, carol, "hold"); await instance.startConversion(carol, running); await until(instance, carol, running, "running");
      advance(120_000); await instance.cleanup();
      for (const id of [done, pending.upload_id]) {
        expect(await files(options.dataDir, id)).toEqual(["job.json"]);
        const tombstone = await manifest(options.dataDir, id);
        expect(tombstone.status).toBe("expired"); expect(tombstone).not.toHaveProperty("token_hash"); expect(tombstone).not.toHaveProperty("upload_auth_hash");
      }
      expect(await instance.authenticateUpload(pending.upload_id, pending.upload_auth_token)).toBeNull();
      // The active worker is excluded even though its retention deadline passed.
      expect((await instance.getStatus(carol, running)).status).toBe("running"); expect(await files(options.dataDir, running)).toContain("input.txt");
      release(); await until(instance, carol, running, "completed");
      expect((await instance.getMarkdown(carol, running)).markdown).toBe("hold"); expect((await health(instance)).cleanup.jobs_failed_last_sweep).toBe(0);
    } finally { release(); setSystemTime(); }
  });

  test("restart removes input and output crash partials without touching committed results", async () => {
    const { instance, options } = await service();
    const id = await completed(instance, alice); await instance.close();
    await fs.writeFile(path.join(options.dataDir, id, "input.part"), "partial upload"); await fs.writeFile(path.join(options.dataDir, id, "output.part"), "partial output");
    const { instance: restarted } = await service({ dataDir: options.dataDir });
    expect(await files(options.dataDir, id)).toEqual(["input.txt", "job.json", "output.md", "output.md.index.json"]);
    expect((await restarted.getMarkdown(alice, id)).markdown).toBe("x");
  });
});

describe("retired owner purge tool", () => {
  test("dry run lists only the owner's jobs and apply removes them without touching other owners", async () => {
    const { instance, options } = await service();
    const mine = [await completed(instance, alice), await uploaded(instance, alice)], theirs = [await uploaded(instance, bob), await uploaded(instance, carol)];
    await instance.close();
    const dry = await purgeOwnerJobs(options.dataDir, alice);
    expect(dry.applied).toBe(false); expect(dry.jobs.map(job => job.job_id).sort()).toEqual([...mine].sort()); expect(dry.unreadable).toEqual([]);
    expect(dry.jobs.every(job => job.bytes > 0 && ["completed", "uploaded"].includes(job.status))).toBe(true);
    for (const id of mine) expect((await manifest(options.dataDir, id)).agent_id).toBe("alice");
    // Same-tenant and cross-tenant jobs are untouched; the CLI applies the same selection.
    const cli = spawnSync(process.execPath, [path.join(import.meta.dir, "purge-owner.ts"), options.dataDir, alice.tenantId, alice.agentId, "--apply"], { encoding: "utf8" });
    expect(cli.status).toBe(0); expect(JSON.parse(cli.stdout).jobs).toHaveLength(2);
    for (const id of mine) await expect(fs.stat(path.join(options.dataDir, id))).rejects.toMatchObject({ code: "ENOENT" });
    const { instance: restarted } = await service({ dataDir: options.dataDir });
    await expect(restarted.getStatus(alice, mine[0])).rejects.toMatchObject({ statusCode: 404 });
    expect((await restarted.getStatus(bob, theirs[0])).status).toBe("uploaded"); expect((await restarted.getStatus(carol, theirs[1])).status).toBe("uploaded");
    expect(spawnSync(process.execPath, [path.join(import.meta.dir, "purge-owner.ts"), options.dataDir, "bad tenant", "x"], { encoding: "utf8" }).status).toBe(1);
  });
});
