import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, PassThrough } from "node:stream";
import { JobService, JobServiceOptions } from "./jobs.js";
import { createConverter } from "./converter.js";

const principal = { tenantId: "tenant-a", agentId: "agent-a" };
const services: JobService[] = [];
const directories: string[] = [];
async function service(overrides: Partial<JobServiceOptions> = {}) {
  const dataDir = overrides.dataDir ?? await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-jobs-test-"));
  if (!directories.includes(dataDir)) directories.push(dataDir);
  const options: JobServiceOptions = { dataDir, maxUploadBytes: 100, maxStorageBytes: 10_000, maxJobs: 10, retentionMs: 60_000, uploadTtlMs: 60_000, conversionTimeoutMs: 1000, maxOutputBytes: 1000, concurrency: 1,
    converter: async (input, output) => { await fs.writeFile(output, `# Converted\n${await fs.readFile(input, "utf8")}`); }, ...overrides };
  const instance = new JobService(options); services.push(instance); await instance.init();
  return { instance, options };
}
async function waitFor(instance: JobService, id: string, status: string) {
  for (let tries = 0; tries < 200; tries++) {
    const result = await instance.getStatus(principal, id);
    if (result.status === status) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Job never became ${status}`);
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(value => value.close()));
  await Promise.all(directories.splice(0).map(value => fs.rm(value, { recursive: true, force: true })));
});

describe("durable single tenant jobs", () => {
  test("upload token is hashed, conversion is asynchronous and Markdown is paginated", async () => {
    const { instance, options } = await service();
    const created = await instance.createUpload(principal, { filename: "notes.txt", size_bytes: 4 });
    const manifest = await fs.readFile(path.join(options.dataDir, created.upload_id, "job.json"), "utf8");
    expect(manifest.includes(created.upload_token)).toBe(false);
    await expect(instance.upload(principal, created.upload_id, "wrong", Readable.from(["test"]))).rejects.toMatchObject({ statusCode: 404 });
    await instance.upload(principal, created.upload_id, created.upload_token, Readable.from(["test"]));
    expect((await instance.startConversion(principal, created.upload_id)).status).toBe("queued");
    await waitFor(instance, created.upload_id, "completed");
    const page = await instance.getMarkdown(principal, created.upload_id, { max_chars: 3 });
    expect(page).toEqual({ markdown: "# C", next_offset: 3, total_chars: 16 });
    expect((await instance.getMarkdown(principal, created.upload_id, { offset: 3 })).markdown).toBe("onverted\ntest");
    await expect(instance.upload(principal, created.upload_id, created.upload_token, Readable.from(["test"]))).rejects.toMatchObject({ statusCode: 409 });
    await instance.deleteJob(principal, created.upload_id);
    await expect(instance.getStatus(principal, created.upload_id)).rejects.toMatchObject({ statusCode: 404 });
  });
  test("size mismatch and excess remove partial bytes and permit retry", async () => {
    const { instance, options } = await service();
    const job = await instance.createUpload(principal, { filename: "file.txt", size_bytes: 4 });
    await expect(instance.upload(principal, job.upload_id, job.upload_token, Readable.from(["abcde"]))).rejects.toMatchObject({ statusCode: 413 });
    await expect(instance.upload(principal, job.upload_id, job.upload_token, Readable.from(["a"]))).rejects.toMatchObject({ statusCode: 400 });
    expect((await fs.readdir(path.join(options.dataDir, job.upload_id))).sort()).toEqual(["job.json"]);
    await instance.upload(principal, job.upload_id, job.upload_token, Readable.from(["abcd"]));
    expect((await instance.getStatus(principal, job.upload_id)).status).toBe("uploaded");
  });
  test("rejects filenames, sizes, unsupported formats, and overcommit", async () => {
    const { instance } = await service({ maxJobs: 2, maxStorageBytes: 1004 });
    await expect(instance.createUpload(principal, { filename: "../x.txt", size_bytes: 1 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(instance.createUpload(principal, { filename: "x.exe", size_bytes: 1 })).rejects.toMatchObject({ statusCode: 415 });
    await expect(instance.createUpload(principal, { filename: "x.txt", size_bytes: 101 })).rejects.toMatchObject({ statusCode: 413 });
    await instance.createUpload(principal, { filename: "a.txt", size_bytes: 4 });
    await expect(instance.createUpload(principal, { filename: "b.txt", size_bytes: 0 })).rejects.toMatchObject({ statusCode: 507 });
  });
  test("concurrent registry requests obey job cap and upload attempts cannot overlap", async () => {
    const { instance } = await service({ maxJobs: 1 });
    const results = await Promise.allSettled([instance.createUpload(principal, { filename: "a.txt", size_bytes: 4 }), instance.createUpload(principal, { filename: "b.txt", size_bytes: 4 })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const job = (results.find(result => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<JobService["createUpload"]>>>).value;
    const stream = new PassThrough();
    const uploading = instance.upload(principal, job.upload_id, job.upload_token, stream);
    await expect(instance.upload(principal, job.upload_id, job.upload_token, Readable.from(["test"]))).rejects.toMatchObject({ statusCode: 409 });
    stream.end("test"); await uploading;
  });
  test("completed jobs survive restart; interrupted workers fail and queued jobs resume", async () => {
    const { instance, options } = await service();
    const finished = await instance.createUpload(principal, { filename: "a.txt", size_bytes: 1 });
    await instance.upload(principal, finished.upload_id, finished.upload_token, Readable.from(["a"]));
    await instance.startConversion(principal, finished.upload_id); await waitFor(instance, finished.upload_id, "completed");
    const queued = await instance.createUpload(principal, { filename: "b.txt", size_bytes: 1 });
    await instance.upload(principal, queued.upload_id, queued.upload_token, Readable.from(["b"]));
    const interrupted = await instance.createUpload(principal, { filename: "c.txt", size_bytes: 1 });
    await instance.close();
    for (const [id, status] of [[queued.upload_id, "queued"], [interrupted.upload_id, "running"]]) {
      const filename = path.join(options.dataDir, id, "job.json");
      const manifest = JSON.parse(await fs.readFile(filename, "utf8")); manifest.status = status; await fs.writeFile(filename, JSON.stringify(manifest));
    }
    const { instance: restarted } = await service(options);
    expect((await restarted.getMarkdown(principal, finished.upload_id)).markdown).toBe("# Converted\na");
    expect((await restarted.getStatus(principal, interrupted.upload_id)).error).toBe("Conversion interrupted by server restart");
    await waitFor(restarted, queued.upload_id, "completed");
  });
  test("expiry erases uploaded bytes and releases reservations", async () => {
    const { instance, options } = await service({ retentionMs: 20, maxJobs: 1 });
    const job = await instance.createUpload(principal, { filename: "a.txt", size_bytes: 1 });
    await instance.upload(principal, job.upload_id, job.upload_token, Readable.from(["a"]));
    await new Promise(resolve => setTimeout(resolve, 35)); await instance.cleanup();
    await expect(instance.getStatus(principal, job.upload_id)).rejects.toMatchObject({ statusCode: 410 });
    expect(await fs.readdir(path.join(options.dataDir, job.upload_id))).toEqual(["job.json"]);
    await instance.createUpload(principal, { filename: "b.txt", size_bytes: 1 });
  });
  test("running jobs are retained beyond retention and deletion waits for converter termination", async () => {
    let stopped = false;
    const { instance, options } = await service({ retentionMs: 20, converter: async (_input, _output, signal) => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => setTimeout(() => { stopped = true; resolve(); }, 20), { once: true }));
    } });
    const job = await instance.createUpload(principal, { filename: "a.txt", size_bytes: 1 });
    await instance.upload(principal, job.upload_id, job.upload_token, Readable.from(["a"]));
    await instance.startConversion(principal, job.upload_id); await waitFor(instance, job.upload_id, "running");
    await new Promise(resolve => setTimeout(resolve, 30)); await instance.cleanup();
    expect((await instance.getStatus(principal, job.upload_id)).status).toBe("running");
    await instance.deleteJob(principal, job.upload_id); expect(stopped).toBe(true);
    await expect(fs.stat(path.join(options.dataDir, job.upload_id))).rejects.toThrow();
  });
  test("output cap and timeout become readable failure states", async () => {
    const { instance } = await service({ maxOutputBytes: 2 });
    const job = await instance.createUpload(principal, { filename: "a.txt", size_bytes: 1 });
    await instance.upload(principal, job.upload_id, job.upload_token, Readable.from(["a"])); await instance.startConversion(principal, job.upload_id);
    expect((await waitFor(instance, job.upload_id, "failed")).error_info).toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED", details: { limit_bytes: 2 } });
    await expect(instance.getMarkdown(principal, job.upload_id)).rejects.toMatchObject({ statusCode: 409 });
    const { instance: timed } = await service({ conversionTimeoutMs: 20, converter: async (_input, _output, signal) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } });
    const slow = await timed.createUpload(principal, { filename: "slow.txt", size_bytes: 1 });
    await timed.upload(principal, slow.upload_id, slow.upload_token, Readable.from(["a"])); await timed.startConversion(principal, slow.upload_id);
    expect((await waitFor(timed, slow.upload_id, "failed")).error_info).toMatchObject({ code: "CONVERSION_TIMEOUT" });
  });
  test("stalled uploads time out and close and deletion abort pending streams", async () => {
    const { instance, options } = await service({ uploadTtlMs: 30 });
    const stalled = await instance.createUpload(principal, { filename: "a.txt", size_bytes: 1 });
    await expect(instance.upload(principal, stalled.upload_id, stalled.upload_token, new PassThrough())).rejects.toMatchObject({ statusCode: 408 });
    expect(await fs.readdir(path.join(options.dataDir, stalled.upload_id))).toEqual(["job.json"]);
    const { instance: deletable } = await service();
    const pending = await deletable.createUpload(principal, { filename: "b.txt", size_bytes: 1 });
    const upload = deletable.upload(principal, pending.upload_id, pending.upload_token, new PassThrough());
    const rejected = upload.catch(error => error);
    await deletable.deleteJob(principal, pending.upload_id); expect(await rejected).toMatchObject({ statusCode: 408 });
    const closing = await deletable.createUpload(principal, { filename: "c.txt", size_bytes: 1 });
    const closeUpload = deletable.upload(principal, closing.upload_id, closing.upload_token, new PassThrough());
    // Let the upload acquire its lock before closing.
    await new Promise(resolve => setTimeout(resolve, 5));
    const closeRejected = closeUpload.catch(error => error);
    await deletable.close(); expect(await closeRejected).toMatchObject({ statusCode: 408 });
  });
  test("expired tombstones are bounded under repeated uploads", async () => {
    const { instance, options } = await service({ maxJobs: 1, retentionMs: 20 });
    for (let index = 0; index < 3; index++) {
      const job = await instance.createUpload(principal, { filename: "a.txt", size_bytes: 1 });
      await instance.upload(principal, job.upload_id, job.upload_token, Readable.from(["a"]));
      await new Promise(resolve => setTimeout(resolve, 25)); await instance.cleanup();
      expect((await fs.readdir(options.dataDir)).length).toBeLessThanOrEqual(1);
    }
  });
  test("subprocess adapter bounds stdout and terminates on abort", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-converter-test-")); directories.push(directory);
    const large = path.join(directory, "large.js");
    await fs.writeFile(large, 'process.stdout.write("a".repeat(100_000));');
    const converter = createConverter({ executable: process.execPath, maxOutputBytes: 10 });
    await expect(converter(large, path.join(directory, "large.md"), new AbortController().signal)).rejects.toThrow("output limit");
    const hanging = path.join(directory, "hanging.js");
    await fs.writeFile(hanging, 'setInterval(() => {}, 1000);');
    const abort = new AbortController();
    const conversion = converter(hanging, path.join(directory, "hanging.md"), abort.signal);
    const rejection = conversion.catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 30)); abort.abort();
    expect(await rejection).toBeInstanceOf(Error);
    const nonzero = path.join(directory, "nonzero.js");
    const failedOutput = path.join(directory, "nonzero.md");
    await fs.writeFile(nonzero, 'process.stdout.write("some output"); process.exitCode = 1;');
    const normalConverter = createConverter({ executable: process.execPath, maxOutputBytes: 1000 });
    await expect(normalConverter(nonzero, failedOutput, new AbortController().signal)).rejects.toThrow("conversion failed");
    // Deletion immediately after rejection must succeed, with no late flush
    // recreating a partial artifact and no Windows open-handle failure.
    await fs.rm(failedOutput);
    await new Promise(resolve => setTimeout(resolve, 10));
    await expect(fs.stat(failedOutput)).rejects.toThrow();
  });
  test("restart removes crash leftovers before an awaiting upload can be retried", async () => {
    const { instance, options } = await service();
    const job = await instance.createUpload(principal, { filename: "a.txt", size_bytes: 1 });
    await instance.close();
    const directory = path.join(options.dataDir, job.upload_id);
    await fs.writeFile(path.join(directory, "input.txt"), "orphan completed rename");
    await fs.writeFile(path.join(directory, "input.part"), "partial");
    await fs.writeFile(path.join(directory, "job.json.00000000-0000-0000-0000-000000000000.tmp"), "partial manifest");
    const orphan = path.join(options.dataDir, "11111111-1111-1111-1111-111111111111");
    await fs.mkdir(orphan); await fs.writeFile(path.join(orphan, "input.part"), "partial create");
    const { instance: restarted } = await service(options);
    expect(await fs.readdir(directory)).toEqual(["job.json"]);
    await expect(fs.stat(orphan)).rejects.toThrow();
    await restarted.upload(principal, job.upload_id, job.upload_token, Readable.from(["a"]));
    expect((await restarted.getStatus(principal, job.upload_id)).status).toBe("uploaded");
  });
});


describe("agent isolation and tenant budgets", () => {
  const sibling = { tenantId: "tenant-a", agentId: "agent-b" };
  const foreign = { tenantId: "tenant-b", agentId: "agent-a" };
  test("same tenant and other tenants cannot use any job operation or token", async () => {
    const { instance, options } = await service();
    const job = await instance.createUpload(principal, { filename: "private.txt", size_bytes: 1 });
    const manifest = JSON.parse(await fs.readFile(path.join(options.dataDir, job.upload_id, "job.json"), "utf8"));
    expect([manifest.tenant_id, manifest.agent_id]).toEqual([principal.tenantId, principal.agentId]);
    for (const actor of [sibling, foreign]) {
      await expect(instance.upload(actor, job.upload_id, job.upload_token, Readable.from(["a"]))).rejects.toMatchObject({ statusCode: 404 });
      await expect(instance.startConversion(actor, job.upload_id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(instance.getStatus(actor, job.upload_id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(instance.getMarkdown(actor, job.upload_id, { offset: -1 })).rejects.toMatchObject({ statusCode: 404 });
      await expect(instance.deleteJob(actor, job.upload_id)).rejects.toMatchObject({ statusCode: 404 });
    }
    await instance.upload(principal, job.upload_id, job.upload_token, Readable.from(["a"]));
    await instance.startConversion(principal, job.upload_id); await waitFor(instance, job.upload_id, "completed");
    await expect(instance.getMarkdown(sibling, job.upload_id)).rejects.toMatchObject({ statusCode: 404 });
    await instance.close(); const { instance: restarted } = await service(options);
    expect((await restarted.getMarkdown(principal, job.upload_id)).markdown).toBe("# Converted\na");
    await expect(restarted.getStatus(sibling, job.upload_id)).rejects.toMatchObject({ statusCode: 404 });
  });
  test("foreign requests cannot cancel or block an owner's upload and conversion", async () => {
    let aborted = false;
    const { instance } = await service({ converter: async (_input, output, signal) => {
      signal.addEventListener("abort", () => { aborted = true; });
      await new Promise(resolve => setTimeout(resolve, 30)); await fs.writeFile(output, "ok");
    } });
    const job = await instance.createUpload(principal, { filename: "a.txt", size_bytes: 1 });
    const stream = new PassThrough(); const pending = instance.upload(principal, job.upload_id, job.upload_token, stream);
    await new Promise(resolve => setTimeout(resolve, 5));
    await expect(instance.deleteJob(sibling, job.upload_id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(instance.upload(sibling, job.upload_id, job.upload_token, Readable.from(["a"]))).rejects.toMatchObject({ statusCode: 404 });
    stream.end("a"); await pending;
    await instance.startConversion(principal, job.upload_id); await waitFor(instance, job.upload_id, "running");
    await expect(instance.deleteJob(foreign, job.upload_id)).rejects.toMatchObject({ statusCode: 404 });
    await waitFor(instance, job.upload_id, "completed"); expect(aborted).toBe(false);
  });
  test("agent and tenant job/storage reservations are atomic and release on delete", async () => {
    const { instance } = await service({ maxJobs: 8, maxStorageBytes: 50_000, maxAgentJobs: 1, maxTenantJobs: 2, maxTenantStorageBytes: 2002 });
    const race = await Promise.allSettled([instance.createUpload(principal, { filename: "a.txt", size_bytes: 1 }), instance.createUpload(principal, { filename: "b.txt", size_bytes: 1 })]);
    expect(race.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const owned = (race.find(result => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<JobService["createUpload"]>>>).value;
    await instance.createUpload(sibling, { filename: "c.txt", size_bytes: 1 });
    await expect(instance.createUpload({ tenantId: "tenant-a", agentId: "agent-c" }, { filename: "d.txt", size_bytes: 0 })).rejects.toMatchObject({ statusCode: 507 });
    await instance.createUpload(foreign, { filename: "e.txt", size_bytes: 1 });
    await instance.deleteJob(principal, owned.upload_id);
    await instance.createUpload(principal, { filename: "f.txt", size_bytes: 1 });
    const { instance: bytes } = await service({ maxAgentStorageBytes: 1001 });
    await expect(bytes.createUpload(principal, { filename: "g.txt", size_bytes: 2 })).rejects.toMatchObject({ statusCode: 507 });
  });
  test("explicit legacy migration preserves scoped upload credentials and rejects partial ownership", async () => {
    const { createHash } = await import("node:crypto");
    const { instance, options } = await service();
    const job = await instance.createUpload(principal, { filename: "a.txt", size_bytes: 1 }); await instance.close();
    const file = path.join(options.dataDir, job.upload_id, "job.json");
    const legacy = JSON.parse(await fs.readFile(file, "utf8")); delete legacy.tenant_id; delete legacy.agent_id;
    legacy.token_hash = createHash("sha256").update(job.upload_token).digest("hex"); await fs.writeFile(file, JSON.stringify(legacy));
    await expect(service(options)).rejects.toThrow("legacyOwner");
    expect(JSON.parse(await fs.readFile(file, "utf8")).tenant_id).toBeUndefined();
    const { instance: migrated } = await service({ ...options, legacyOwner: principal });
    await migrated.upload(principal, job.upload_id, job.upload_token, Readable.from(["a"]));
    await expect(migrated.getStatus(sibling, job.upload_id)).rejects.toMatchObject({ statusCode: 404 });
  });
  test("audit failures block upload creation, reads and deletion without disclosing content", async () => {
    const events: unknown[] = []; let fail = false;
    const { instance } = await service({ audit: event => { if (fail) throw new Error("disk failure"); events.push(event); } });
    const job = await instance.createUpload(principal, { filename: "secret.txt", size_bytes: 1 });
    fail = true;
    await expect(instance.createUpload(sibling, { filename: "other.txt", size_bytes: 0 })).rejects.toMatchObject({ statusCode: 503 });
    await expect(instance.getStatus(principal, job.upload_id)).rejects.toMatchObject({ statusCode: 503 });
    await expect(instance.deleteJob(principal, job.upload_id)).rejects.toMatchObject({ statusCode: 503 });
    fail = false; expect((await instance.getStatus(principal, job.upload_id)).status).toBe("awaiting_upload");
    expect(JSON.stringify(events)).not.toContain("secret"); expect(JSON.stringify(events)).not.toContain(job.upload_token);
  });
});

test("fair scheduler rotates tenants and agents while respecting scoped concurrency", async () => {
  const other = { tenantId: "tenant-b", agentId: "agent-a" };
  const sibling = { tenantId: "tenant-a", agentId: "agent-b" };
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { instance } = await service({ maxStorageBytes: 50_000, converter: async (input, output) => {
    const text = await fs.readFile(input, "utf8"); order.push(text);
    if (text === "0") await gate; await fs.writeFile(output, text);
  } });
  const queued: { actor: typeof principal; id: string }[] = [];
  for (const [actor, text] of [[principal, "0"], [principal, "1"], [principal, "2"], [sibling, "3"], [other, "4"]] as const) {
    const job = await instance.createUpload(actor, { filename: "a.txt", size_bytes: 1 });
    await instance.upload(actor, job.upload_id, job.upload_token, Readable.from([text]));
    await instance.startConversion(actor, job.upload_id); queued.push({ actor, id: job.upload_id });
    if (text === "0") await waitFor(instance, job.upload_id, "running");
  }
  release();
  for (let tries = 0; tries < 100 && order.length < 5; tries++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(order).toEqual(["0", "4", "3", "1", "2"]);

  let simultaneous = 0, maxSimultaneous = 0;
  const { instance: scoped } = await service({ concurrency: 3, maxTenantConcurrency: 1, maxAgentConcurrency: 1, maxStorageBytes: 50_000,
    converter: async (_input, output) => { simultaneous++; maxSimultaneous = Math.max(maxSimultaneous, simultaneous); await new Promise(resolve => setTimeout(resolve, 20)); await fs.writeFile(output, "ok"); simultaneous--; } });
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    const job = await scoped.createUpload(principal, { filename: "b.txt", size_bytes: 1 }); ids.push(job.upload_id);
    await scoped.upload(principal, job.upload_id, job.upload_token, Readable.from(["a"])); await scoped.startConversion(principal, job.upload_id);
  }
  for (const id of ids) await waitFor(scoped, id, "completed");
  expect(maxSimultaneous).toBe(1);
});

test("startup validates every manifest before legacy migration and cannot infer missing actor", async () => {
  const { instance, options } = await service();
  const legacy = await instance.createUpload(principal, { filename: "legacy.txt", size_bytes: 1 });
  const corrupt = await instance.createUpload(principal, { filename: "corrupt.txt", size_bytes: 1 }); await instance.close();
  const legacyFile = path.join(options.dataDir, legacy.upload_id, "job.json");
  const legacyData = JSON.parse(await fs.readFile(legacyFile, "utf8")); delete legacyData.tenant_id; delete legacyData.agent_id;
  await fs.writeFile(legacyFile, JSON.stringify(legacyData));
  const corruptFile = path.join(options.dataDir, corrupt.upload_id, "job.json");
  const corruptData = JSON.parse(await fs.readFile(corruptFile, "utf8")); delete corruptData.agent_id;
  await fs.writeFile(corruptFile, JSON.stringify(corruptData));
  await expect(service({ ...options, legacyOwner: principal })).rejects.toThrow("Invalid principal");
  expect(JSON.parse(await fs.readFile(legacyFile, "utf8")).tenant_id).toBeUndefined();
  await expect(instance.createUpload(undefined as never, { filename: "x.txt", size_bytes: 1 })).rejects.toMatchObject({ statusCode: 401 });
  await expect(instance.getStatus(undefined as never, legacy.upload_id)).rejects.toMatchObject({ statusCode: 401 });
});
