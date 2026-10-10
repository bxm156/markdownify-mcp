import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { JobService, type JobServiceOptions } from "./jobs.js";
import type { Principal } from "./identity.js";
import { waitFor } from "./test-helpers.js";

const alice: Principal = { tenantId: "team", agentId: "alice" };
const services: JobService[] = [], directories: string[] = [];
const restores: (() => void)[] = [];
const realWriteFile = fs.writeFile;

async function service(overrides: Partial<JobServiceOptions> = {}) {
  const dataDir = overrides.dataDir ?? await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-jobs-failures-"));
  if (!directories.includes(dataDir)) directories.push(dataDir);
  const options: JobServiceOptions = { dataDir, maxUploadBytes: 100, maxOutputBytes: 1024, maxStorageBytes: 100_000, maxJobs: 20, retentionMs: 60_000, uploadTtlMs: 60_000, conversionTimeoutMs: 5000, concurrency: 1,
    converter: async (input, output) => { await fs.writeFile(output, await fs.readFile(input)); }, ...overrides };
  const instance = new JobService(options); services.push(instance); await instance.init(); return { instance, options };
}
async function uploaded(instance: JobService, content: string) {
  const job = await instance.createUpload(alice, { filename: "file.txt", size_bytes: Buffer.byteLength(content) });
  await instance.upload(alice, job.upload_id, job.upload_token, Readable.from([content])); return job.upload_id;
}
const statusOf = (instance: JobService, id: string, desired: string) =>
  waitFor(async () => { const value = await instance.getStatus(alice, id); return value.status === desired && value; }, { label: `${id} to become ${desired}` });
const manifest = async (dataDir: string, id: string) => JSON.parse(await fs.readFile(path.join(dataDir, id, "job.json"), "utf8"));
const enospc = (target: unknown) => Promise.reject(Object.assign(new Error(`ENOSPC: no space left on device, open '${String(target)}'`), { code: "ENOSPC" }));
/** Fail manifest writes inside one job directory whose serialized status matches; count every attempt. */
function failManifestWrites(jobDir: string, statuses: string[]) {
  const attempts: string[] = [];
  const spy = spyOn(fs, "writeFile").mockImplementation(((target: any, data: any, ...rest: any[]) => {
    if (String(target).startsWith(jobDir + path.sep) && typeof data === "string") {
      const status = (JSON.parse(data) as { status: string }).status;
      attempts.push(status);
      if (statuses.includes(status)) return enospc(target);
    }
    return (realWriteFile as any)(target, data, ...rest);
  }) as typeof fs.writeFile);
  restores.push(() => spy.mockRestore());
  return attempts;
}

afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  await Promise.all(services.splice(0).map(instance => instance.close()));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("queued-to-running commit failure", () => {
  test("fails the job with INTERNAL_ERROR, never runs the converter and persists the failure when storage recovers", async () => {
    const converted: string[] = [];
    const { instance, options } = await service({ converter: async (input, output) => { const text = await fs.readFile(input, "utf8"); converted.push(text); await fs.writeFile(output, `ok ${text}`); } });
    const id = await uploaded(instance, "broken"), jobDir = path.join(options.dataDir, id);
    // Only the running-state commit fails (e.g. a transient ENOSPC); the failure commit succeeds.
    const attempts = failManifestWrites(jobDir, ["running"]);
    expect((await instance.startConversion(alice, id)).status).toBe("queued");
    const failed = await statusOf(instance, id, "failed");
    expect(failed.error).toBe("Unable to persist conversion job");
    expect(failed.error_info?.code).toBe("INTERNAL_ERROR");
    expect(failed.error_info?.retryable).toBe(false);
    // Neither the server path nor the errno text reaches the client.
    expect(JSON.stringify(failed)).not.toContain(options.dataDir);
    expect(JSON.stringify(failed)).not.toContain("ENOSPC");
    expect(attempts).toEqual(["queued", "running", "failed"]);
    expect(converted).toEqual([]);
    const persisted = await manifest(options.dataDir, id);
    expect(persisted).toMatchObject({ status: "failed", error_code: "INTERNAL_ERROR" });
    expect(Date.parse(persisted.expires_at)).toBeGreaterThan(Date.now());
    expect((await fs.readdir(jobDir)).sort()).toEqual(["input.txt", "job.json"]);
    // The scheduler slot was released: another job runs to completion, and the failed job is not retried.
    const next = await uploaded(instance, "fine");
    await instance.startConversion(alice, next); await statusOf(instance, next, "completed");
    expect(converted).toEqual(["fine"]);
    expect(attempts).toEqual(["queued", "running", "failed"]);
    expect((await instance.startConversion(alice, id)).status).toBe("failed");
  });

  test("a persistently unwritable job directory fails in memory once and pump() does not spin", async () => {
    const converted: string[] = [];
    const { instance, options } = await service({ converter: async (input, output) => { const text = await fs.readFile(input, "utf8"); converted.push(text); await fs.writeFile(output, text); } });
    const id = await uploaded(instance, "stuck"), next = await uploaded(instance, "fine");
    // ENOSPC persists: both the running commit and the best-effort failure commit fail.
    const attempts = failManifestWrites(path.join(options.dataDir, id), ["running", "failed"]);
    await instance.startConversion(alice, id);
    const failed = await statusOf(instance, id, "failed");
    expect(failed.error_info?.code).toBe("INTERNAL_ERROR");
    // If the job stayed queued, pump() would re-select it ahead of `next` forever and `next` could never run.
    await instance.startConversion(alice, next); await statusOf(instance, next, "completed");
    expect(converted).toEqual(["fine"]);
    expect(attempts).toEqual(["queued", "running", "failed"]);
    // The committed manifest still says queued; nothing half-written was left behind.
    expect((await manifest(options.dataDir, id)).status).toBe("queued");
    expect((await fs.readdir(path.join(options.dataDir, id))).sort()).toEqual(["input.txt", "job.json"]);
  });

  test("after a restart with storage restored, the uncommitted job resumes from its last durable state", async () => {
    const { instance, options } = await service();
    const id = await uploaded(instance, "resume");
    failManifestWrites(path.join(options.dataDir, id), ["running", "failed"]);
    await instance.startConversion(alice, id);
    await statusOf(instance, id, "failed");
    await instance.close();
    for (const restore of restores.splice(0)) restore();
    // The in-memory failure was never durable, so the queued manifest is what a new process trusts.
    const { instance: restarted } = await service({ dataDir: options.dataDir });
    await statusOf(restarted, id, "completed");
    expect((await restarted.getMarkdown(alice, id)).markdown).toBe("resume");
  });
});
