import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createConverter } from "./converter.js";
import { ServiceError } from "./errors.js";
import { JobService, type JobServiceOptions } from "./jobs.js";
import type { Principal } from "./identity.js";
import { waitFor } from "./test-helpers.js";

const alice: Principal = { tenantId: "team", agentId: "alice" };
const directories: string[] = [], pidFiles: string[] = [], services: JobService[] = [];

async function tempDir(prefix = "markdownify-converter-") { const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); directories.push(dir); return dir; }
/** A fake `markitdown`: a POSIX shell wrapper that execs bun on `body`, keeping the spawned PID. Records its PID first. */
async function fakeConverter(dir: string, body: string) {
  const pidFile = path.join(dir, `pid-${pidFiles.length}`); pidFiles.push(pidFile);
  const script = path.join(dir, `behaviour-${pidFiles.length}.js`), executable = path.join(dir, `markitdown-${pidFiles.length}`);
  await fs.writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n${body}\n`);
  await fs.writeFile(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
  return { executable, pidFile };
}
const readPid = async (pidFile: string) => Number(await fs.readFile(pidFile, "utf8").catch(() => "")) || 0;
const waitForPid = (pidFile: string) => waitFor(() => readPid(pidFile), { timeoutMs: 5000, label: "fake converter PID" });
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
const exists = (file: string) => fs.stat(file).then(() => true, () => false);
const hang = `process.stdout.write("partial output"); setInterval(() => {}, 1000);`;

afterEach(async () => {
  await Promise.all(services.splice(0).map(instance => instance.close()));
  // Never leave a fake converter running, even when an assertion failed mid-test.
  for (const pidFile of pidFiles.splice(0)) { const pid = await readPid(pidFile); if (pid) try { process.kill(pid, "SIGKILL"); } catch {} }
  await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("subprocess converter", () => {
  test("abort kills the child process after partial output was streamed", async () => {
    const dir = await tempDir(), { executable, pidFile } = await fakeConverter(dir, hang);
    const converter = createConverter({ executable, maxOutputBytes: 1000 });
    const output = path.join(dir, "out.part"), controller = new AbortController();
    const rejection = converter(path.join(dir, "input.txt"), output, controller.signal).then(() => null, error => error);
    const pid = await waitForPid(pidFile);
    await waitFor(async () => (await fs.readFile(output, "utf8").catch(() => "")) === "partial output", { timeoutMs: 5000, label: "streamed partial output" });
    expect(alive(pid)).toBe(true);
    controller.abort();
    const error = await rejection;
    // Current behaviour: the SIGKILLed child surfaces as CONVERSION_FAILED rather than the abort reason;
    // JobService classifies cancellation and timeout from the signal state, not from this error.
    expect(error).toBeInstanceOf(ServiceError);
    expect(error.code).toBe("CONVERSION_FAILED");
    // The converter waits for the child to close before rejecting, so the PID is already reaped.
    expect(alive(pid)).toBe(false);
  });

  test("an already-aborted signal rejects with its reason before anything is spawned", async () => {
    const dir = await tempDir(), output = path.join(dir, "out.part");
    // Spawning this missing executable would reject with ENOENT, not the abort reason.
    const converter = createConverter({ executable: path.join(dir, "missing-markitdown"), maxOutputBytes: 1000 });
    const controller = new AbortController(), reason = new Error("cancelled before start");
    controller.abort(reason);
    await expect(converter(path.join(dir, "input.txt"), output, controller.signal)).rejects.toBe(reason);
    expect(await exists(output)).toBe(false);
  });

  test("a missing executable rejects with ENOENT instead of hanging", async () => {
    const dir = await tempDir();
    const converter = createConverter({ executable: path.join(dir, "missing-markitdown"), maxOutputBytes: 1000 });
    const error = await converter(path.join(dir, "input.txt"), path.join(dir, "out.part"), new AbortController().signal).catch(value => value);
    expect(error).not.toBeInstanceOf(ServiceError);
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  test("a multi-megabyte stderr flood is drained and does not block completion", async () => {
    const dir = await tempDir();
    const { executable } = await fakeConverter(dir, `process.stderr.write("diagnostic ".repeat(800_000), () => process.stdout.write("# done\\n"));`);
    const output = path.join(dir, "out.part");
    await createConverter({ executable, maxOutputBytes: 1000 })(path.join(dir, "input.txt"), output, new AbortController().signal);
    expect(await fs.readFile(output, "utf8")).toBe("# done\n");
  });
});

describe("subprocess converter inside the job service", () => {
  async function service(executable: string, overrides: Partial<JobServiceOptions> = {}) {
    const dataDir = await tempDir("markdownify-converter-jobs-");
    const options: JobServiceOptions = { dataDir, maxUploadBytes: 100, maxOutputBytes: 1000, maxStorageBytes: 100_000, maxJobs: 10, retentionMs: 60_000, uploadTtlMs: 60_000, conversionTimeoutMs: 60_000, concurrency: 1,
      converter: createConverter({ executable, maxOutputBytes: 1000 }), ...overrides };
    const instance = new JobService(options); services.push(instance); await instance.init();
    const job = await instance.createUpload(alice, { filename: "doc.txt", size_bytes: 3 });
    await instance.upload(alice, job.upload_id, job.upload_token, Readable.from(["doc"]));
    return { instance, dataDir, id: job.upload_id, jobDir: path.join(dataDir, job.upload_id) };
  }

  test("shutdown during conversion kills the child and removes the partial output", async () => {
    const dir = await tempDir(), { executable, pidFile } = await fakeConverter(dir, hang);
    const { instance, id, jobDir } = await service(executable);
    await instance.startConversion(alice, id);
    const pid = await waitForPid(pidFile);
    await waitFor(async () => (await fs.readFile(path.join(jobDir, "output.part"), "utf8").catch(() => "")) === "partial output", { timeoutMs: 5000, label: "streamed partial output" });
    await instance.close();
    expect(alive(pid)).toBe(false);
    expect((await fs.readdir(jobDir)).sort()).toEqual(["input.txt", "job.json"]);
    expect(JSON.parse(await fs.readFile(path.join(jobDir, "job.json"), "utf8"))).toMatchObject({ status: "failed", error_code: "CONVERSION_CANCELLED" });
  });

  test("a missing converter executable maps to INTERNAL_ERROR without leaking its path", async () => {
    const dir = await tempDir(), missing = path.join(dir, "private-missing-markitdown");
    const { instance, id, jobDir } = await service(missing);
    await instance.startConversion(alice, id);
    const failed = await waitFor(async () => { const value = await instance.getStatus(alice, id); return value.status === "failed" && value; }, { label: "conversion failure" });
    expect(failed.error_info?.code).toBe("INTERNAL_ERROR");
    expect(failed.error).toBe("Operation failed");
    const manifest = await fs.readFile(path.join(jobDir, "job.json"), "utf8");
    for (const text of [JSON.stringify(failed), manifest]) { expect(text).not.toContain("private-missing"); expect(text).not.toContain("ENOENT"); }
    expect((await fs.readdir(jobDir)).sort()).toEqual(["input.txt", "job.json"]);
  });
});
