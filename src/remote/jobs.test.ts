import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, PassThrough } from "node:stream";
import { JobService, JobServiceOptions } from "./jobs.js";
import { createConverter } from "./converter.js";

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
    const result = await instance.getStatus(id);
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
    const created = await instance.createUpload({ filename: "notes.txt", size_bytes: 4 });
    const manifest = await fs.readFile(path.join(options.dataDir, created.upload_id, "job.json"), "utf8");
    expect(manifest.includes(created.upload_token)).toBe(false);
    await expect(instance.upload(created.upload_id, "wrong", Readable.from(["test"]))).rejects.toMatchObject({ statusCode: 401 });
    await instance.upload(created.upload_id, created.upload_token, Readable.from(["test"]));
    expect((await instance.startConversion(created.upload_id)).status).toBe("queued");
    await waitFor(instance, created.upload_id, "completed");
    const page = await instance.getMarkdown(created.upload_id, { max_chars: 3 });
    expect(page).toEqual({ markdown: "# C", next_offset: 3, total_chars: 16 });
    expect((await instance.getMarkdown(created.upload_id, { offset: 3 })).markdown).toBe("onverted\ntest");
    await expect(instance.upload(created.upload_id, created.upload_token, Readable.from(["test"]))).rejects.toMatchObject({ statusCode: 409 });
    await instance.deleteJob(created.upload_id);
    await expect(instance.getStatus(created.upload_id)).rejects.toMatchObject({ statusCode: 404 });
  });
  test("size mismatch and excess remove partial bytes and permit retry", async () => {
    const { instance, options } = await service();
    const job = await instance.createUpload({ filename: "file.txt", size_bytes: 4 });
    await expect(instance.upload(job.upload_id, job.upload_token, Readable.from(["abcde"]))).rejects.toMatchObject({ statusCode: 413 });
    await expect(instance.upload(job.upload_id, job.upload_token, Readable.from(["a"]))).rejects.toMatchObject({ statusCode: 400 });
    expect((await fs.readdir(path.join(options.dataDir, job.upload_id))).sort()).toEqual(["job.json"]);
    await instance.upload(job.upload_id, job.upload_token, Readable.from(["abcd"]));
    expect((await instance.getStatus(job.upload_id)).status).toBe("uploaded");
  });
  test("rejects filenames, sizes, unsupported formats, and overcommit", async () => {
    const { instance } = await service({ maxJobs: 2, maxStorageBytes: 1004 });
    await expect(instance.createUpload({ filename: "../x.txt", size_bytes: 1 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(instance.createUpload({ filename: "x.exe", size_bytes: 1 })).rejects.toMatchObject({ statusCode: 415 });
    await expect(instance.createUpload({ filename: "x.txt", size_bytes: 101 })).rejects.toMatchObject({ statusCode: 413 });
    await instance.createUpload({ filename: "a.txt", size_bytes: 4 });
    await expect(instance.createUpload({ filename: "b.txt", size_bytes: 0 })).rejects.toMatchObject({ statusCode: 507 });
  });
  test("concurrent registry requests obey job cap and upload attempts cannot overlap", async () => {
    const { instance } = await service({ maxJobs: 1 });
    const results = await Promise.allSettled([instance.createUpload({ filename: "a.txt", size_bytes: 4 }), instance.createUpload({ filename: "b.txt", size_bytes: 4 })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const job = (results.find(result => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<JobService["createUpload"]>>>).value;
    const stream = new PassThrough();
    const uploading = instance.upload(job.upload_id, job.upload_token, stream);
    await expect(instance.upload(job.upload_id, job.upload_token, Readable.from(["test"]))).rejects.toMatchObject({ statusCode: 409 });
    stream.end("test"); await uploading;
  });
  test("completed jobs survive restart; interrupted workers fail and queued jobs resume", async () => {
    const { instance, options } = await service();
    const finished = await instance.createUpload({ filename: "a.txt", size_bytes: 1 });
    await instance.upload(finished.upload_id, finished.upload_token, Readable.from(["a"]));
    await instance.startConversion(finished.upload_id); await waitFor(instance, finished.upload_id, "completed");
    const queued = await instance.createUpload({ filename: "b.txt", size_bytes: 1 });
    await instance.upload(queued.upload_id, queued.upload_token, Readable.from(["b"]));
    const interrupted = await instance.createUpload({ filename: "c.txt", size_bytes: 1 });
    await instance.close();
    for (const [id, status] of [[queued.upload_id, "queued"], [interrupted.upload_id, "running"]]) {
      const filename = path.join(options.dataDir, id, "job.json");
      const manifest = JSON.parse(await fs.readFile(filename, "utf8")); manifest.status = status; await fs.writeFile(filename, JSON.stringify(manifest));
    }
    const { instance: restarted } = await service(options);
    expect((await restarted.getMarkdown(finished.upload_id)).markdown).toBe("# Converted\na");
    expect((await restarted.getStatus(interrupted.upload_id)).error).toBe("Conversion interrupted by server restart");
    await waitFor(restarted, queued.upload_id, "completed");
  });
  test("expiry erases uploaded bytes and releases reservations", async () => {
    const { instance, options } = await service({ retentionMs: 20, maxJobs: 1 });
    const job = await instance.createUpload({ filename: "a.txt", size_bytes: 1 });
    await instance.upload(job.upload_id, job.upload_token, Readable.from(["a"]));
    await new Promise(resolve => setTimeout(resolve, 35)); await instance.cleanup();
    await expect(instance.getStatus(job.upload_id)).rejects.toMatchObject({ statusCode: 410 });
    expect(await fs.readdir(path.join(options.dataDir, job.upload_id))).toEqual(["job.json"]);
    await instance.createUpload({ filename: "b.txt", size_bytes: 1 });
  });
  test("running jobs are retained beyond retention and deletion waits for converter termination", async () => {
    let stopped = false;
    const { instance, options } = await service({ retentionMs: 20, converter: async (_input, _output, signal) => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => setTimeout(() => { stopped = true; resolve(); }, 20), { once: true }));
    } });
    const job = await instance.createUpload({ filename: "a.txt", size_bytes: 1 });
    await instance.upload(job.upload_id, job.upload_token, Readable.from(["a"]));
    await instance.startConversion(job.upload_id); await waitFor(instance, job.upload_id, "running");
    await new Promise(resolve => setTimeout(resolve, 30)); await instance.cleanup();
    expect((await instance.getStatus(job.upload_id)).status).toBe("running");
    await instance.deleteJob(job.upload_id); expect(stopped).toBe(true);
    await expect(fs.stat(path.join(options.dataDir, job.upload_id))).rejects.toThrow();
  });
  test("output cap and timeout become readable failure states", async () => {
    const { instance } = await service({ maxOutputBytes: 2 });
    const job = await instance.createUpload({ filename: "a.txt", size_bytes: 1 });
    await instance.upload(job.upload_id, job.upload_token, Readable.from(["a"])); await instance.startConversion(job.upload_id);
    expect((await waitFor(instance, job.upload_id, "failed")).error).toBe("Document conversion failed");
    await expect(instance.getMarkdown(job.upload_id)).rejects.toMatchObject({ statusCode: 409 });
    const { instance: timed } = await service({ conversionTimeoutMs: 20, converter: async (_input, _output, signal) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } });
    const slow = await timed.createUpload({ filename: "slow.txt", size_bytes: 1 });
    await timed.upload(slow.upload_id, slow.upload_token, Readable.from(["a"])); await timed.startConversion(slow.upload_id);
    expect((await waitFor(timed, slow.upload_id, "failed")).error).toBe("Conversion cancelled or timed out");
  });
  test("stalled uploads time out and close and deletion abort pending streams", async () => {
    const { instance, options } = await service({ uploadTtlMs: 30 });
    const stalled = await instance.createUpload({ filename: "a.txt", size_bytes: 1 });
    await expect(instance.upload(stalled.upload_id, stalled.upload_token, new PassThrough())).rejects.toMatchObject({ statusCode: 408 });
    expect(await fs.readdir(path.join(options.dataDir, stalled.upload_id))).toEqual(["job.json"]);
    const { instance: deletable } = await service();
    const pending = await deletable.createUpload({ filename: "b.txt", size_bytes: 1 });
    const upload = deletable.upload(pending.upload_id, pending.upload_token, new PassThrough());
    const rejected = upload.catch(error => error);
    await deletable.deleteJob(pending.upload_id); expect(await rejected).toMatchObject({ statusCode: 408 });
    const closing = await deletable.createUpload({ filename: "c.txt", size_bytes: 1 });
    const closeUpload = deletable.upload(closing.upload_id, closing.upload_token, new PassThrough());
    // Let the upload acquire its lock before closing.
    await new Promise(resolve => setTimeout(resolve, 5));
    const closeRejected = closeUpload.catch(error => error);
    await deletable.close(); expect(await closeRejected).toMatchObject({ statusCode: 408 });
  });
  test("expired tombstones are bounded under repeated uploads", async () => {
    const { instance, options } = await service({ maxJobs: 1, retentionMs: 20 });
    for (let index = 0; index < 3; index++) {
      const job = await instance.createUpload({ filename: "a.txt", size_bytes: 1 });
      await instance.upload(job.upload_id, job.upload_token, Readable.from(["a"]));
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
    const job = await instance.createUpload({ filename: "a.txt", size_bytes: 1 });
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
    await restarted.upload(job.upload_id, job.upload_token, Readable.from(["a"]));
    expect((await restarted.getStatus(job.upload_id)).status).toBe("uploaded");
  });
});
