import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { JobService, type JobServiceOptions } from "./jobs.js";
import { errorResponse, lookupError } from "./errors.js";
import { waitFor } from "./test-helpers.js";
const actor = { tenantId: "t", agentId: "a" };
const instances: JobService[] = [], dirs: string[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map(s => s.close())); await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });
async function fixture(overrides: Partial<JobServiceOptions> = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-errors-")); dirs.push(dataDir);
  const options = { dataDir, maxUploadBytes: 100, maxOutputBytes: 10, maxStorageBytes: 10000, maxJobs: 20, retentionMs: 60000, uploadTtlMs: 60000, conversionTimeoutMs: 1000, concurrency: 1, ...overrides };
  const service = new JobService(options); instances.push(service); await service.init(); return { service, options };
}
for (const scope of ["global", "tenant", "agent"] as const) for (const kind of ["jobs", "storage"] as const) {
  test(`${scope} ${kind} quota reports configured limits without foreign usage and releases on own delete`, async () => {
    const key = scope === "global" ? kind === "jobs" ? "maxJobs" : "maxStorageBytes" : `max${scope === "tenant" ? "Tenant" : "Agent"}${kind === "jobs" ? "Jobs" : "StorageBytes"}`;
    const { service } = await fixture({ [key]: kind === "jobs" ? 1 : 12 });
    const first = await service.createUpload(actor, { filename: "one.txt", size_bytes: 1 });
    let failure: unknown;
    try { await service.createUpload(actor, { filename: "two.txt", size_bytes: 1 }); } catch (error) { failure = error; }
    const response = errorResponse(failure);
    expect(response.error_info.code).toBe(kind === "jobs" ? "JOB_LIMIT_EXCEEDED" : "STORAGE_LIMIT_EXCEEDED");
    expect(response.error_info.details).toEqual(kind === "jobs" ? { scope, limit_jobs: 1 } : { scope, limit_bytes: 12, requested_bytes: 1, reserved_bytes: 11 });
    expect(response.error_info.retryable).toBe(false); expect(response.error_info.next_steps.join(" ")).toContain("own");
    expect(JSON.stringify(response)).not.toContain(first.upload_id);
    await service.deleteJob(actor, first.upload_id);
    expect((await service.createUpload(actor, { filename: "two.txt", size_bytes: 1 })).upload_id).toBeString();
  });
}
test("large input has a numeric limit and unexpected failures never expose raw diagnostics", async () => {
  const { service } = await fixture();
  let failure: unknown; try { await service.createUpload(actor, { filename: "secret.txt", size_bytes: 101 }); } catch (error) { failure = error; }
  expect(errorResponse(failure).error_info).toMatchObject({ code: "FILE_TOO_LARGE", details: { limit_bytes: 100, requested_bytes: 101 } });
  expect(errorResponse(new Error("private content /data/secrets key"))).toEqual({ error: "Operation failed", error_info: lookupError("INTERNAL_ERROR") });
  expect(lookupError("__proto__").code).toBe("UNKNOWN_ERROR_CODE");
});
test("real subprocess output limit remains distinct and persisted across restart", async () => {
  const { service, options } = await fixture();
  const script = path.join(options.dataDir, "writer.js"); await fs.writeFile(script, "process.stdout.write('x'.repeat(1000))");
  const { createConverter } = await import("./converter.js");
  let failure: unknown; try { await createConverter({ maxOutputBytes: 10, executable: process.execPath })(script, path.join(options.dataDir, "stream.part"), new AbortController().signal); } catch (error) { failure = error; }
  expect(errorResponse(failure).error_info).toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED", details: { limit_bytes: 10 } });
  await service.close();
  const custom = new JobService({ ...options, converter: async (_input, output) => { await fs.writeFile(output, "x".repeat(20)); } }); instances.push(custom); await custom.init();
  const job = await custom.createUpload(actor, { filename: "x.txt", size_bytes: 1 }); await custom.upload(actor, job.upload_id, job.upload_token, Readable.from(["x"])); await custom.startConversion(actor, job.upload_id);
  const status = await waitFor(async () => { const current = await custom.getStatus(actor, job.upload_id); return current.status === "failed" && current; }, { label: "output-limit failure" });
  expect(status.error_info).toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED", retryable: false, details: { limit_bytes: 10 } });
  await custom.close(); const restarted = new JobService(options); instances.push(restarted); await restarted.init();
  expect((await restarted.getStatus(actor, job.upload_id)).error_info).toEqual(status.error_info);
});

const failedStatus = (service: JobService, id: string) => waitFor(async () => { const status = await service.getStatus(actor, id); return status.status === "failed" && status; }, { timeoutMs: 3000, label: "conversion failure" });
async function startTestJob(service: JobService) {
  const job = await service.createUpload(actor, { filename: "x.txt", size_bytes: 1 });
  await service.upload(actor, job.upload_id, job.upload_token, Readable.from(["x"]));
  await service.startConversion(actor, job.upload_id);
  return job.upload_id;
}
test("shutdown cancellation stays cancelled when cleanup crosses the conversion deadline", async () => {
  let entered!: () => void, aborted!: () => void, release!: () => void;
  const running = new Promise<void>(resolve => { entered = resolve; });
  const stopped = new Promise<void>(resolve => { aborted = resolve; });
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  // Capture the conversion deadline timer (a distinctive delay) so the test can fire it after the abort
  // instead of sleeping past it: the late deadline must not turn the cancellation into a timeout.
  const deadline = 123_457, deadlines: Array<() => void> = [], realSetTimeout = globalThis.setTimeout;
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((handler: any, ms?: number, ...args: any[]) => {
    if (ms === deadline) deadlines.push(() => handler(...args));
    return realSetTimeout(handler, ms, ...args);
  }) as any);
  const { service } = await fixture({ conversionTimeoutMs: deadline, converter: async (_input, _output, signal) => {
    signal.addEventListener("abort", aborted, { once: true });
    entered();
    await cleanup;
    signal.throwIfAborted();
  } });
  const id = await startTestJob(service); await running;
  const closing = service.close();
  try { await stopped; expect(deadlines).toHaveLength(1); deadlines[0]!(); }
  finally { release(); await closing; timers.mockRestore(); }
  expect((await service.getStatus(actor, id)).error_info?.code).toBe("CONVERSION_CANCELLED");
});
for (const mode of ["document", "missing-executable", "index"] as const) {
  test(`conversion failure classification and safe persisted guidance: ${mode}`, async () => {
    const { createConverter } = await import("./converter.js");
    const { service, options } = await fixture({ converter: mode === "index"
      ? async (_input, output) => { await fs.writeFile(output, "ok"); await fs.mkdir(path.join(path.dirname(output), "output.md.index.json")); }
      : async (input, output, signal) => {
        const source = mode === "document" ? path.join(path.dirname(input), "failure.js") : input;
        if (mode === "document") await fs.writeFile(source, "process.exit(2)");
        await createConverter({ maxOutputBytes: 10, executable: mode === "document" ? process.execPath : path.join(path.dirname(input), "private-missing-converter") })(source, output, signal);
      }
    });
    const id = await startTestJob(service);
    const status = await failedStatus(service, id);
    const code = mode === "document" ? "CONVERSION_FAILED" : "INTERNAL_ERROR";
    expect(status.error_info?.code).toBe(code);
    expect(status.error_info?.next_steps).toEqual(lookupError(code).next_steps);
    expect(JSON.stringify(status)).not.toContain("private-missing-converter");
    expect(JSON.stringify(status)).not.toContain(options.dataDir);
    await service.close();
    const restarted = new JobService(options); instances.push(restarted); await restarted.init();
    expect((await restarted.getStatus(actor, id)).error_info).toEqual(status.error_info);
  });
}
