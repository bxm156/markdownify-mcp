import { afterEach, beforeAll, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { JobService, type JobServiceOptions } from "./jobs.js";
import { purgeOwnerJobs } from "./purge-owner.js";
import { acquireLock, readLock, releaseLock } from "./lock.js";
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
const lines = (spy: { mock: { calls: unknown[][] } }, message: string) => spy.mock.calls.filter(call => call[0] === message);
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;
afterEach(async () => {
  setSystemTime();
  await Promise.all(services.splice(0).map(instance => instance.close()));
  await Promise.all(directories.splice(0).map(directory => realRm(directory, { recursive: true, force: true })));
});

describe("retention cleanup resilience", () => {
  test("a remove failure is isolated to one job, visible only to its owner, logged without paths and retried until recovery", async () => {
    const { instance, options } = await service();
    const failing = await completed(instance, alice), other = await completed(instance, carol), failingDir = path.join(options.dataDir, failing);
    const rm = spyOn(fs, "rm").mockImplementation(((target: any, opts: any) => String(target).startsWith(failingDir) ? denied(target) : realRm(target, opts)) as typeof fs.rm);
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      advance(120_000); await instance.cleanup();
      // The failure on the first job did not stop the sweep: another tenant's job is erased and tombstoned.
      expect(await files(options.dataDir, other)).toEqual(["job.json"]);
      expect((await manifest(options.dataDir, other)).status).toBe("expired");
      // The failed job keeps its committed state and reservation, and stays inaccessible after expiry.
      expect((await manifest(options.dataDir, failing)).status).toBe("completed");
      expect(await files(options.dataDir, failing)).toEqual(["input.txt", "job.json", "output.md", "output.md.index.json"]);
      await expect(instance.getMarkdown(alice, failing)).rejects.toMatchObject({ statusCode: 410 });
      const owner = await health(instance);
      expect(owner.own_reserved_bytes).toBe(1 + options.maxOutputBytes);
      expect(owner.cleanup).toEqual({ last_sweep_at: expect.any(String), own_jobs_failed_last_sweep: 1, own_jobs_pending_retry: 1 });
      // Other tenants and agents never see failures caused by someone else's job.
      for (const actor of [carol, bob]) {
        const foreign = await health(instance, actor);
        expect(foreign.cleanup).toMatchObject({ own_jobs_failed_last_sweep: 0, own_jobs_pending_retry: 0 });
        expect(JSON.stringify(foreign)).not.toContain("EACCES"); expect(JSON.stringify(foreign)).not.toContain(failing);
      }
      expect(lines(logged, "Job cleanup failed")).toHaveLength(1); expect(lines(logged, "Job cleanup sweep incomplete")).toHaveLength(1);
      expect(lines(logged, "Job cleanup sweep incomplete")[0][1]).toMatchObject({ jobs_failed: 1, failures_total: 1, consecutive_failed_sweeps: 1, last_error_code: "EACCES" });
      const log = JSON.stringify(logged.mock.calls);
      expect(log).toContain(failing); expect(log).toContain("EACCES"); expect(log).not.toContain(options.dataDir); expect(log).not.toContain("permission denied");
      // Repeated sweeps keep retrying the failed job and still remove the other tenant's expired tombstone.
      advance(120_000); await instance.cleanup();
      await expect(fs.stat(path.join(options.dataDir, other))).rejects.toMatchObject({ code: "ENOENT" });
      expect(lines(logged, "Job cleanup failed")).toHaveLength(2);
      expect(lines(logged, "Job cleanup sweep incomplete")[1][1]).toMatchObject({ failures_total: 2, consecutive_failed_sweeps: 2 });
      rm.mockRestore(); await instance.cleanup();
      expect(await files(options.dataDir, failing)).toEqual(["job.json"]);
      expect((await manifest(options.dataDir, failing)).status).toBe("expired");
      const after = await health(instance);
      expect(after.own_reserved_bytes).toBe(0); expect(after.ready).toBe(true);
      expect(after.cleanup).toMatchObject({ own_jobs_failed_last_sweep: 0, own_jobs_pending_retry: 0 });
      expect(logged).toHaveBeenCalledTimes(4);
      // Cleanup state stays on the authenticated health result; public probes never expose it.
      expect(await instance.health()).not.toHaveProperty("cleanup"); expect(await instance.publicHealth()).not.toHaveProperty("cleanup");
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
      expect(pending.cleanup).toMatchObject({ own_jobs_failed_last_sweep: 1, own_jobs_pending_retry: 1 });
      // The reservation is not released before the tombstone commit succeeds.
      await expect(instance.createUpload(alice, { filename: "next.txt", size_bytes: 1 })).rejects.toMatchObject({ statusCode: 507 });
      expect(lines(logged, "Job cleanup failed")).toHaveLength(1); expect(JSON.stringify(logged.mock.calls)).not.toContain(options.dataDir);
      spy.mockRestore(); await instance.cleanup();
      const tombstone = await manifest(options.dataDir, failing);
      expect(tombstone.status).toBe("expired"); expect(tombstone).not.toHaveProperty("token_hash"); expect(tombstone).not.toHaveProperty("upload_auth_hash");
      expect((await health(instance)).own_reserved_bytes).toBe(0); expect((await health(instance)).cleanup.own_jobs_pending_retry).toBe(0);
      await instance.createUpload(alice, { filename: "next.txt", size_bytes: 1 });
    } finally { spy.mockRestore(); logged.mockRestore(); setSystemTime(); }
  });

  test("tombstone removal failures are skipped silently by upload admission and retried by sweeps until they recover", async () => {
    const { instance, options } = await service();
    const expired = await uploaded(instance, bob); advance(120_000); await instance.cleanup();
    const tombstoneDir = path.join(options.dataDir, expired);
    const rm = spyOn(fs, "rm").mockImplementation(((target: any, opts: any) => String(target) === tombstoneDir ? denied(target) : realRm(target, opts)) as typeof fs.rm);
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (let index = 0; index < 5; index++) await instance.deleteJob(alice, (await instance.createUpload(alice, { filename: "a.txt", size_bytes: 1 })).upload_id);
      expect((await manifest(options.dataDir, expired)).status).toBe("expired");
      expect(logged).not.toHaveBeenCalled(); expect((await health(instance, bob)).cleanup.own_jobs_pending_retry).toBe(0);
      // Once the tombstone itself expires, the sweep reports the failure once and keeps the tombstone for the next attempt.
      advance(120_000); await instance.cleanup();
      expect((await manifest(options.dataDir, expired)).status).toBe("expired");
      expect(lines(logged, "Job cleanup failed")).toHaveLength(1); expect(lines(logged, "Job cleanup failed")[0][1]).toMatchObject({ status: "expired", code: "EACCES" });
      expect((await health(instance, bob)).cleanup).toMatchObject({ own_jobs_failed_last_sweep: 1, own_jobs_pending_retry: 1 });
      expect((await health(instance, bob)).own_jobs.expired).toBe(1);
      rm.mockRestore(); await instance.cleanup();
      await expect(fs.stat(tombstoneDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await health(instance, bob)).cleanup).toMatchObject({ own_jobs_failed_last_sweep: 0, own_jobs_pending_retry: 0 });
    } finally { rm.mockRestore(); logged.mockRestore(); setSystemTime(); }
  });

  test("audit failures during cleanup still commit the tombstone", async () => {
    const { instance, options } = await service({ audit: event => { if (event.event === "job_expired") throw new Error("audit unavailable"); } });
    const id = await completed(instance, alice);
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      advance(120_000); await instance.cleanup();
      expect(await files(options.dataDir, id)).toEqual(["job.json"]); expect((await manifest(options.dataDir, id)).status).toBe("expired");
      expect(logged).toHaveBeenCalledTimes(1); expect(logged.mock.calls[0][0]).toBe("Job audit unavailable");
      expect((await health(instance)).cleanup).toMatchObject({ own_jobs_failed_last_sweep: 0, own_jobs_pending_retry: 0 });
    } finally { logged.mockRestore(); setSystemTime(); }
  });

  test("concurrent cleanup calls and timer ticks share one in-flight sweep that never overlaps itself", async () => {
    const { instance, options } = await service();
    const slow = await uploaded(instance, alice), broken = await uploaded(instance, carol), other = await uploaded(instance, bob);
    const brokenDir = path.join(options.dataDir, broken), slowInput = path.join(options.dataDir, slow, "input.txt");
    let release!: () => void, entered!: () => void, slowCalls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
    // The first job holds the sweep open; the second fails on every pass, so its log lines count sweep passes.
    const rm = spyOn(fs, "rm").mockImplementation((async (target: any, opts: any) => {
      if (String(target).startsWith(brokenDir)) return denied(target);
      if (String(target) === slowInput) { slowCalls++; entered(); await gate; }
      return realRm(target, opts);
    }) as typeof fs.rm);
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    const passes = () => lines(logged, "Job cleanup failed").length;
    let first: Promise<void> | undefined;
    try {
      advance(120_000); first = instance.cleanup(); await reached;
      // Periodic ticks during a long sweep are skipped: they neither start a sweep nor queue another pass.
      for (let index = 0; index < 3; index++) (instance as any).tick();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(passes()).toBe(0); expect(slowCalls).toBe(1); expect((await manifest(options.dataDir, other)).status).toBe("uploaded");
      release(); await first;
      expect(passes()).toBe(1);
      expect((await manifest(options.dataDir, slow)).status).toBe("expired"); expect((await manifest(options.dataDir, other)).status).toBe("expired");
      // Explicit callers that join an in-flight sweep share its promise and get exactly one follow-up pass, not one each.
      let hold!: () => void; const held = new Promise<void>(resolve => { hold = resolve; });
      rm.mockImplementation((async (target: any, opts: any) => { if (String(target).startsWith(brokenDir)) { await held; return denied(target); } return realRm(target, opts); }) as typeof fs.rm);
      const second = instance.cleanup(), third = instance.cleanup(), fourth = instance.cleanup();
      expect(third).toBe(second); expect(fourth).toBe(second);
      hold(); await second;
      expect(passes()).toBe(3); expect(slowCalls).toBe(1);
      const next = instance.cleanup(); expect(next).not.toBe(second); await next; expect(passes()).toBe(4);
    } finally { release(); await first?.catch(() => undefined); rm.mockRestore(); logged.mockRestore(); setSystemTime(); }
  });

  test("close during an in-flight sweep stops before the next job and waits for the sweep to finish", async () => {
    const { instance, options } = await service();
    const slow = await uploaded(instance, alice), next = await uploaded(instance, bob), slowInput = path.join(options.dataDir, slow, "input.txt");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
    const rm = spyOn(fs, "rm").mockImplementation((async (target: any, opts: any) => { if (String(target) === slowInput) { entered(); await gate; } return realRm(target, opts); }) as typeof fs.rm);
    try {
      advance(120_000); const sweep = instance.cleanup(); await reached;
      let closed = false; const closing = instance.close().then(() => { closed = true; });
      await new Promise(resolve => setTimeout(resolve, 20)); expect(closed).toBe(false);
      release(); await closing;
      expect((instance as any).sweep).toBeUndefined(); await sweep;
      expect((await manifest(options.dataDir, slow)).status).toBe("expired");
      expect((await manifest(options.dataDir, next)).status).toBe("uploaded");
      await expect(fs.stat(path.join(options.dataDir, ".lock"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { release(); rm.mockRestore(); setSystemTime(); }
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
      expect((await instance.getMarkdown(carol, running)).markdown).toBe("hold"); expect((await health(instance, carol)).cleanup.own_jobs_failed_last_sweep).toBe(0);
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

describe("one process per data volume", () => {
  test("existing locks fail closed and crash leftovers require operator removal", async () => {
    const { instance, options } = await service(), lock = path.join(options.dataDir, ".lock");
    expect((await fs.readFile(lock, "utf8")).split("\n")[0]).toBe(String(process.pid));
    if (process.platform !== "win32") expect((await fs.stat(lock)).mode & 0o777).toBe(0o600);
    // The current test process holds the lock, so a second service on the same volume is refused.
    await expect(new JobService(options).init()).rejects.toThrow("Data directory is in use");
    await instance.close(); await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await fs.writeFile(lock, `${sleeper.pid}\n`);
      await expect(new JobService(options).init()).rejects.toThrow("Data directory is in use");
      expect((await fs.readFile(lock, "utf8")).split("\n")[0]).toBe(String(sleeper.pid));
    } finally { sleeper.kill("SIGKILL"); await new Promise(resolve => sleeper.once("exit", resolve)); }
    // Even a dead or reused PID cannot safely prove ownership across containers.
    for (const stale of [String(deadPid()), String(process.pid), "garbage"]) {
      await fs.writeFile(lock, stale);
      await expect(new JobService(options).init()).rejects.toThrow("Data directory is in use");
      expect(await fs.readFile(lock, "utf8")).toBe(stale);
      await fs.rm(lock);
      const { instance: next } = await service({ dataDir: options.dataDir });
      expect((await fs.readFile(lock, "utf8")).split("\n")[0]).toBe(String(process.pid)); await next.close();
    }
  });
  test("release never removes a lock this process did not write", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-foreign-lock-")); directories.push(dataDir);
    const real = await acquireLock(dataDir), lock = path.join(real, ".lock");
    const mine = await readLock(dataDir);
    expect(mine).toEqual({ pid: process.pid, token: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    // An operator removed the lock of a hung process and another process acquired a fresh one.
    const foreign = `${process.pid}\n00000000-0000-0000-0000-000000000000\n`;
    await fs.writeFile(lock, foreign); await releaseLock(real);
    expect(await fs.readFile(lock, "utf8")).toBe(foreign);
    await fs.rm(lock); const again = await acquireLock(dataDir); await releaseLock(again);
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("concurrent acquisitions admit exactly one service", async () => {
    const { instance, options } = await service(); await instance.close();
    const contenders = Array.from({ length: 10 }, () => new JobService(options));
    services.push(...contenders);
    const results = await Promise.allSettled(contenders.map(s => s.init()));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(9);
  });
  test("a request at sweep settlement starts another pass", async () => {
    const { instance } = await service();
    let calls = 0, boundary: Promise<void> | undefined;
    const sweep = spyOn(instance as any, "sweepOnce").mockImplementation(() => Promise.resolve().then(() => {
      if (++calls === 1) queueMicrotask(() => queueMicrotask(() => { boundary = instance.cleanup(); }));
    }));
    try {
      await instance.cleanup();
      await boundary;
      expect(calls).toBe(2);
      expect((instance as any).sweep).toBeUndefined();
    } finally { sweep.mockRestore(); }
  });
});

describe("retired owner purge tool", () => {
  test("dry run lists only the owner's jobs, apply reports each job and other owners are untouched", async () => {
    const { instance, options } = await service();
    const mine = [await completed(instance, alice), await uploaded(instance, alice), await uploaded(instance, alice)], theirs = [await uploaded(instance, bob), await uploaded(instance, carol)];
    // The service is still running, so purging is refused.
    await expect(purgeOwnerJobs(options.dataDir, alice)).rejects.toThrow("A lock file exists (MD_DATA_DIR/.lock). Stop the service if it is running.");
    await instance.close();
    const mismatch = "22222222-2222-2222-2222-222222222222", legacy = "33333333-3333-3333-3333-333333333333";
    await fs.mkdir(path.join(options.dataDir, mismatch)); await fs.writeFile(path.join(options.dataDir, mismatch, "job.json"), JSON.stringify({ ...await manifest(options.dataDir, mine[1]), id: mine[1] }));
    await fs.mkdir(path.join(options.dataDir, legacy)); await fs.writeFile(path.join(options.dataDir, legacy, "job.json"), JSON.stringify({ id: legacy, status: "completed" }));
    const dry = await purgeOwnerJobs(options.dataDir, alice);
    expect(dry.applied).toBe(false); expect(dry.jobs.map(job => job.job_id).sort()).toEqual([...mine].sort()); expect(dry.unreadable).toEqual([]);
    expect(dry.jobs.every(job => job.result === "listed" && job.bytes! > 0)).toBe(true);
    expect(dry.skipped).toEqual(expect.arrayContaining([{ job_id: mismatch, reason: "id_mismatch" }, { job_id: legacy, reason: "legacy_unowned" }]));
    for (const id of mine) expect((await manifest(options.dataDir, id)).agent_id).toBe("alice");
    // One failed removal does not stop the others, and the report says exactly which jobs were deleted.
    const failingDir = path.join(options.dataDir, mine[0]);
    const rm = spyOn(fs, "rm").mockImplementation(((target: any, opts: any) => String(target) === failingDir ? denied(target) : realRm(target, opts)) as typeof fs.rm);
    let applied;
    try { applied = await purgeOwnerJobs(options.dataDir, alice, true); } finally { rm.mockRestore(); }
    await expect(fs.stat(path.join(options.dataDir, ".lock"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(applied.jobs.find(job => job.job_id === mine[0])).toMatchObject({ result: "failed", code: "EACCES" });
    expect(applied.jobs.filter(job => job.result === "deleted").map(job => job.job_id).sort()).toEqual([mine[1], mine[2]].sort());
    for (const id of [mine[1], mine[2]]) await expect(fs.stat(path.join(options.dataDir, id))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await manifest(options.dataDir, mismatch)).id).toBe(mine[1]); expect(await files(options.dataDir, mine[0])).toContain("output.md");
    expect((await purgeOwnerJobs(options.dataDir, alice, true)).jobs).toMatchObject([{ job_id: mine[0], result: "deleted" }]);
    await realRm(path.join(options.dataDir, mismatch), { recursive: true }); await realRm(path.join(options.dataDir, legacy), { recursive: true });
    const { instance: restarted } = await service({ dataDir: options.dataDir });
    await expect(restarted.getStatus(alice, mine[0])).rejects.toMatchObject({ statusCode: 404 });
    expect((await restarted.getStatus(bob, theirs[0])).status).toBe("uploaded"); expect((await restarted.getStatus(carol, theirs[1])).status).toBe("uploaded");
  });

  test("a running purge holds the volume lock so the service cannot start mid-deletion", async () => {
    const { instance, options } = await service();
    const id = await uploaded(instance, alice); await instance.close();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
    const target = path.join(options.dataDir, id);
    const rm = spyOn(fs, "rm").mockImplementation((async (path: any, opts: any) => { if (String(path) === target) { entered(); await gate; } return realRm(path, opts); }) as typeof fs.rm);
    let purge: Promise<unknown> | undefined;
    try {
      purge = purgeOwnerJobs(options.dataDir, alice, true); await reached;
      await expect(new JobService(options).init()).rejects.toThrow("Data directory is in use: MD_DATA_DIR/.lock exists");
      release(); expect(await purge).toMatchObject({ jobs: [{ job_id: id, result: "deleted" }] });
    } finally { release(); await purge?.catch(() => undefined); rm.mockRestore(); }
    await expect(fs.stat(path.join(options.dataDir, ".lock"))).rejects.toMatchObject({ code: "ENOENT" });
    const { instance: restarted } = await service({ dataDir: options.dataDir });
    await expect(restarted.getStatus(alice, id)).rejects.toMatchObject({ statusCode: 404 });
  });

  test("refuses invalid owners, missing paths and directories that are not a data volume", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-not-data-")); directories.push(empty);
    await expect(purgeOwnerJobs(empty, alice)).rejects.toThrow("Not a markdownify data directory");
    await expect(purgeOwnerJobs(path.join(empty, "missing"), alice)).rejects.toThrow("Data directory not found");
    await expect(purgeOwnerJobs(empty, { tenantId: "bad tenant", agentId: "x" })).rejects.toThrow("Invalid tenant_id or agent_id");
    await fs.writeFile(path.join(empty, "audit.jsonl"), "");
    expect((await purgeOwnerJobs(empty, alice)).jobs).toEqual([]);
  });

  test("null manifests are unreadable and partial owners are skipped as malformed, both left untouched", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-malformed-")); directories.push(dataDir);
    const nullish = "55555555-5555-5555-5555-555555555555", partial = "66666666-6666-6666-6666-666666666666", typed = "77777777-7777-7777-7777-777777777777";
    for (const [id, body] of [[nullish, "null"], [partial, JSON.stringify({ id: partial, tenant_id: "team", status: "completed" })], [typed, JSON.stringify({ id: typed, tenant_id: "team", agent_id: 7 })]]) {
      await fs.mkdir(path.join(dataDir, id)); await fs.writeFile(path.join(dataDir, id, "job.json"), body);
    }
    const report = await purgeOwnerJobs(dataDir, alice, true);
    expect(report.unreadable).toEqual([nullish]); expect(report.jobs).toEqual([]);
    expect(report.skipped).toEqual(expect.arrayContaining([{ job_id: partial, reason: "malformed_owner" }, { job_id: typed, reason: "malformed_owner" }]));
    for (const id of [nullish, partial, typed]) expect(await files(dataDir, id)).toEqual(["job.json"]);
  });

});

const node = Bun.which("node"), root = path.resolve(import.meta.dir, "../..");
// Hold an ephemeral port until just before the first spawn to narrow the window in which another process could take it.
const reservePort = () => new Promise<{ port: number; release: () => Promise<void> }>((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, release: () => new Promise<void>(done => server.close(() => done())) })); });
describe.skipIf(!node)("compiled entry points under node", () => {
  beforeAll(() => { const build = spawnSync(process.execPath, ["run", "build:remote"], { cwd: root, encoding: "utf8" }); if (build.status !== 0) throw new Error(`build failed: ${build.stdout}${build.stderr}`); }, 60_000);

  test("purge CLI reports usage, refusals and unreadable manifests, and follows symlinks to itself and the data directory", async () => {
    const cli = (...args: string[]) => spawnSync(node!, [path.join(root, "dist/remote/purge-owner.js"), ...args], { encoding: "utf8" });
    expect(cli().status).toBe(2); expect(cli().stderr).toContain("Usage:");
    const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-link-")); directories.push(linkParent);
    // A symlinked CLI behaves like a direct invocation instead of silently exiting 0.
    const linkedCli = path.join(linkParent, "purge-owner.js"); await fs.symlink(path.join(root, "dist/remote/purge-owner.js"), linkedCli);
    const viaLink = spawnSync(node!, [linkedCli], { encoding: "utf8" }); expect(viaLink.status).toBe(2); expect(viaLink.stderr).toContain("Usage:");
    const { instance, options } = await service();
    const mine = await uploaded(instance, alice);
    // A service holds the lock, so the CLI refuses without printing a report.
    const live = cli(options.dataDir, alice.tenantId, alice.agentId);
    expect(live.status).toBe(1); expect(live.stderr).toContain("A lock file exists (MD_DATA_DIR/.lock)"); expect(live.stderr).toContain("remove MD_DATA_DIR/.lock"); expect(live.stdout).toBe("");
    await instance.close();
    const missing = cli(path.join(options.dataDir, "missing"), alice.tenantId, alice.agentId);
    expect(missing.status).toBe(1); expect(missing.stderr).toContain("Data directory not found");
    const link = path.join(linkParent, "data"); await fs.symlink(options.dataDir, link, "dir");
    const linked = cli(link, alice.tenantId, alice.agentId);
    expect(linked.status).toBe(0); expect(JSON.parse(linked.stdout).jobs).toMatchObject([{ job_id: mine, result: "listed" }]);
    const corrupt = "44444444-4444-4444-4444-444444444444";
    await fs.mkdir(path.join(options.dataDir, corrupt)); await fs.writeFile(path.join(options.dataDir, corrupt, "job.json"), "{not json");
    const unreadable = cli(options.dataDir, alice.tenantId, alice.agentId, "--apply");
    expect(unreadable.status).toBe(1);
    const report = JSON.parse(unreadable.stdout);
    expect(report.unreadable).toEqual([corrupt]); expect(report.jobs).toMatchObject([{ job_id: mine, result: "deleted" }]);
    await expect(fs.stat(path.join(options.dataDir, mine))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(options.dataDir, corrupt, "job.json"), "utf8")).toBe("{not json");
  }, 30_000);

  test("process.exit and uncaught exceptions release the lock, but never a lock replaced by another process", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-exit-lock-")); directories.push(dataDir);
    const lockModule = JSON.stringify(path.join(root, "dist/remote/lock.js")), lock = path.join(dataDir, ".lock"), foreign = "4242\n00000000-0000-0000-0000-000000000000\n";
    const run = (body: string) => spawnSync(node!, ["--input-type=module", "-e", `import { acquireLock } from ${lockModule}; import fs from 'node:fs'; await acquireLock(${JSON.stringify(dataDir)}); if (!fs.existsSync(${JSON.stringify(lock)})) process.exit(9); ${body}`], { encoding: "utf8" });
    for (const ending of ["process.exit(1);", "throw new Error('boom');"]) {
      expect(run(ending).status).toBe(1);
      await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
      // The lock was removed and re-acquired by someone else before this process exited: the exit hook leaves it alone.
      expect(run(`fs.writeFileSync(${JSON.stringify(lock)}, ${JSON.stringify(foreign)}); ${ending}`).status).toBe(1);
      expect(await fs.readFile(lock, "utf8")).toBe(foreign); await fs.rm(lock);
    }
  });

  test("a SIGKILLed server leaves its lock, restarts fail with the removal step, and removing it allows restart", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-sigkill-")); directories.push(dataDir);
    const { port, release } = await reservePort(), lock = path.join(dataDir, ".lock");
    const env = { ...process.env, MD_API_KEY: "k".repeat(40), MD_DATA_DIR: dataDir, MD_HOST: "127.0.0.1", MD_PORT: String(port), MD_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, MARKITDOWN_PATH: node! };
    const start = () => { const child = spawn(node!, [path.join(root, "dist/remote/index.js")], { env, stdio: ["ignore", "ignore", "pipe"] }); let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; }); const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code))); return { child, exited, stderr: () => stderr }; };
    const ready = async (server: ReturnType<typeof start>) => {
      for (let tries = 0; tries < 200; tries++) {
        if (server.child.exitCode !== null) throw new Error(`server exited: ${server.stderr()}`);
        const ok = await fetch(`http://127.0.0.1:${port}/readyz`, { headers: { Host: `127.0.0.1:${port}` } }).then(response => response.ok, () => false);
        if (ok) return; await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error("server never became ready");
    };
    await release(); const first = start();
    try { await ready(first); expect((await fs.readFile(lock, "utf8")).split("\n")[0]).toBe(String(first.child.pid)); first.child.kill("SIGKILL"); await first.exited; }
    finally { if (first.child.exitCode === null) first.child.kill("SIGKILL"); }
    expect((await fs.readFile(lock, "utf8")).split("\n")[0]).toBe(String(first.child.pid));
    const refused = start();
    try { expect(await refused.exited).toBe(1); } finally { if (refused.child.exitCode === null) refused.child.kill("SIGKILL"); }
    expect(refused.stderr()).toContain("Data directory is in use: MD_DATA_DIR/.lock exists"); expect(refused.stderr()).toContain("remove MD_DATA_DIR/.lock and restart");
    await fs.rm(lock, { force: true });
    for (const signal of process.platform === "win32" ? ["SIGKILL"] as const : ["SIGTERM", "SIGHUP"] as const) {
      const restarted = start();
      try {
        await ready(restarted);
        expect((await fs.readFile(lock, "utf8")).split("\n")[0]).toBe(String(restarted.child.pid));
        if (process.platform === "win32") {
          // Windows kill() terminates the child without running Node's signal handlers.
          restarted.child.kill("SIGKILL");
          await restarted.exited;
          expect((await fs.readFile(lock, "utf8")).split("\n")[0]).toBe(String(restarted.child.pid));
        } else {
          restarted.child.kill(signal);
          expect(await restarted.exited).toBe(0);
          // POSIX graceful shutdown on SIGTERM and SIGHUP releases the lock again.
          await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally { if (restarted.child.exitCode === null) restarted.child.kill("SIGKILL"); }
    }
  }, 30_000);
});
