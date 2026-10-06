import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { JobService, type JobServiceOptions } from "./jobs.js";
import { ServiceError } from "./errors.js";
import type { Principal } from "./identity.js";

const alice: Principal = { tenantId: "team", agentId: "alice" };
const bob: Principal = { tenantId: "team", agentId: "bob" };
const carol: Principal = { tenantId: "other", agentId: "carol" };
const services: JobService[] = [], directories: string[] = [], children: ChildProcess[] = [];
const releaseGates: (() => void)[] = [];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); releaseGates.push(resolve); return { promise, resolve }; }
async function bounded(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Timed out waiting for conversion barrier")), 2000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function eventually<T>(check: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) { const value = await check(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function service(overrides: Partial<JobServiceOptions> = {}) {
  const dataDir = overrides.dataDir ?? await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-lifecycle-"));
  if (!directories.includes(dataDir)) directories.push(dataDir);
  const options: JobServiceOptions = { dataDir, maxUploadBytes: 100, maxOutputBytes: 1024, maxStorageBytes: 100_000, maxJobs: 20, retentionMs: 60_000, uploadTtlMs: 60_000, conversionTimeoutMs: 5000, concurrency: 1,
    converter: async (input, output) => { await fs.writeFile(output, await fs.readFile(input)); }, ...overrides };
  const instance = new JobService(options); services.push(instance); await instance.init(); return { instance, options };
}
async function uploaded(instance: JobService, actor: Principal, content = "x") {
  const job = await instance.createUpload(actor, { filename: "file.txt", size_bytes: Buffer.byteLength(content) });
  await instance.upload(actor, job.upload_id, job.upload_token, Readable.from([content])); return job.upload_id;
}
const status = (instance: JobService, actor: Principal, id: string, desired: string) => eventually(() => instance.getStatus(actor, id), value => value.status === desired, `${id}: ${desired}`);
afterEach(async () => {
  for (const release of releaseGates.splice(0)) release();
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all(services.splice(0).map(instance => instance.close()));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("production job lifecycle", () => {
  test("concurrent and repeated start requests execute one conversion and preserve final output", async () => {
    const gate = deferred(), entered = deferred(); let calls = 0;
    const { instance } = await service({ converter: async (_input, output) => { calls++; entered.resolve(); await gate.promise; await fs.writeFile(output, "result 😀"); } });
    const id = await uploaded(instance, alice);
    const starts = await Promise.all(Array.from({ length: 20 }, () => instance.startConversion(alice, id)));
    expect(starts.every(result => ["queued", "running"].includes(result.status))).toBe(true);
    await bounded(entered.promise); expect(calls).toBe(1);
    expect((await instance.startConversion(alice, id)).status).toBe("running");
    gate.resolve(); await status(instance, alice, id, "completed");
    const before = await instance.getMarkdown(alice, id);
    const completed = await Promise.all(Array.from({ length: 10 }, () => instance.startConversion(alice, id)));
    expect(completed.every(result => result.status === "completed")).toBe(true);
    expect(await instance.getMarkdown(alice, id)).toEqual(before); expect(calls).toBe(1);
  });

  test("a killed real worker preserves queued owners and resumes work under tenant limits", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-crash-")); directories.push(dataDir);
    // The child uses the production service to persist every state. SIGKILL models
    // a crash rather than fabricating manifests or invoking graceful close().
    const workerFile = path.join(dataDir, "worker.ts");
    const modulePath = path.resolve(import.meta.dir, "jobs.ts").replaceAll("\\", "/");
    await fs.writeFile(workerFile, `import fs from 'node:fs/promises'; import { Readable } from 'node:stream'; import { JobService } from ${JSON.stringify(modulePath)};
const actors = [{tenantId:'team',agentId:'alice'},{tenantId:'team',agentId:'bob'},{tenantId:'team',agentId:'alice'},{tenantId:'other',agentId:'carol'}];
const service=new JobService({dataDir:${JSON.stringify(dataDir)},maxUploadBytes:100,maxOutputBytes:1024,maxStorageBytes:100000,maxJobs:20,retentionMs:60000,uploadTtlMs:60000,conversionTimeoutMs:60000,concurrency:1,converter:async()=>{await new Promise(()=>{setInterval(()=>{},1000);});}}); await service.init(); const ids=[];
for(let i=0;i<actors.length;i++){const actor=actors[i];const job=await service.createUpload(actor,{filename:'a.txt',size_bytes:1});await service.upload(actor,job.upload_id,job.upload_token,Readable.from([String(i)]));await service.startConversion(actor,job.upload_id);ids.push(job.upload_id);if(i===0){while((await service.getStatus(actor,job.upload_id)).status!=='running')await new Promise(r=>setTimeout(r,5));}}
process.stdout.write(JSON.stringify(ids)+'\\n');`);
    const child = spawn(process.execPath, [workerFile], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); children.push(child);
    let stdout = "", stderr = ""; child.stdout!.on("data", chunk => { stdout += chunk.toString(); }); child.stderr!.on("data", chunk => { stderr += chunk.toString(); });
    await eventually(async () => ({ stdout, exited: child.exitCode !== null }), value => value.stdout.includes("\n") || value.exited, "crash worker readiness");
    if (!stdout.includes("\n")) throw new Error(`Worker exited: ${stderr}`);
    const ids: string[] = JSON.parse(stdout.trim());
    const before = await Promise.all(ids.map(id => fs.readFile(path.join(dataDir, id, "job.json"), "utf8").then(JSON.parse)));
    expect(before.map(job => job.status)).toEqual(["running", "queued", "queued", "queued"]);
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exited;
    let activeTeam = 0, maxActiveTeam = 0;
    const { instance } = await service({ dataDir, concurrency: 3, maxTenantConcurrency: 1, maxAgentConcurrency: 1, converter: async (input, output) => {
      const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(input), "job.json"), "utf8"));
      if (manifest.tenant_id === "team") { activeTeam++; maxActiveTeam = Math.max(maxActiveTeam, activeTeam); }
      await new Promise(resolve => setTimeout(resolve, 15)); await fs.writeFile(output, await fs.readFile(input));
      if (manifest.tenant_id === "team") activeTeam--;
    } });
    expect((await instance.getStatus(alice, ids[0])).error).toBe("Conversion interrupted by server restart");
    for (const [actor, id, text] of [[bob, ids[1], "1"], [alice, ids[2], "2"], [carol, ids[3], "3"]] as const) {
      await status(instance, actor, id, "completed"); expect((await instance.getMarkdown(actor, id)).markdown).toBe(text);
      await expect(instance.getStatus(actor === bob ? alice : bob, id)).rejects.toMatchObject({ statusCode: 404 });
    }
    expect(maxActiveTeam).toBe(1);
  }, 10_000);

  for (const scope of ["global", "tenant", "agent"] as const) test(`${scope} capacity expires, erases indexes and becomes reusable`, async () => {
    const limits = scope === "global" ? { maxJobs: 1, maxStorageBytes: 1025 } : scope === "tenant" ? { maxTenantJobs: 1, maxTenantStorageBytes: 1025 } : { maxAgentJobs: 1, maxAgentStorageBytes: 1025 };
    const { instance, options } = await service({ retentionMs: 200, ...limits });
    const id = await uploaded(instance, alice); await instance.startConversion(alice, id); await status(instance, alice, id, "completed");
    const blocked = scope === "global" ? carol : scope === "tenant" ? bob : alice;
    await expect(instance.createUpload(blocked, { filename: "blocked.txt", size_bytes: 1 })).rejects.toMatchObject({ statusCode: 507 });
    expect(await fs.stat(path.join(options.dataDir, id, "output.md.index.json")).then(value => value.isFile())).toBe(true);
    await eventually(async () => { await instance.cleanup(); return fs.readdir(path.join(options.dataDir, id)).catch(() => []); }, files => !files.includes("output.md"), "expiration cleanup");
    await expect(fs.stat(path.join(options.dataDir, id, "input.txt"))).rejects.toThrow();
    await expect(fs.stat(path.join(options.dataDir, id, "output.md.index.json"))).rejects.toThrow();
    const replacement = await instance.createUpload(blocked, { filename: "replacement.txt", size_bytes: 1 });
    await instance.deleteJob(blocked, replacement.upload_id);
    const own = await instance.createUpload(alice, { filename: "own.txt", size_bytes: 1 }); expect(own.upload_id).not.toBe(id);
  });

  test("conversion failure releases scheduler capacity for another agent", async () => {
    const gate = deferred(), entered = deferred(); let calls = 0;
    const { instance } = await service({ converter: async (input, output) => { calls++; const text = await fs.readFile(input, "utf8"); if (text === "bad") { entered.resolve(); await gate.promise; throw new ServiceError(422, "Document conversion failed", "CONVERSION_FAILED"); } await fs.writeFile(output, "good result"); } });
    const failed = await uploaded(instance, alice, "bad"); await instance.startConversion(alice, failed); await bounded(entered.promise);
    const good = await uploaded(instance, bob, "good"); expect((await instance.startConversion(bob, good)).status).toBe("queued");
    gate.resolve(); expect((await status(instance, alice, failed, "failed")).error).toBe("Document conversion failed");
    await status(instance, bob, good, "completed"); expect((await instance.getMarkdown(bob, good)).markdown).toBe("good result"); expect(calls).toBe(2);
  });

  test("failed deletion audit cannot cancel an active conversion", async () => {
    const gate = deferred(), entered = deferred(); let aborted = false;
    const { instance } = await service({ audit: event => { if (event.event === "delete_job") throw new Error("audit unavailable"); }, converter: async (_input, output, signal) => { signal.addEventListener("abort", () => { aborted = true; }); entered.resolve(); await gate.promise; await fs.writeFile(output, "preserved"); } });
    const id = await uploaded(instance, alice); await instance.startConversion(alice, id); await bounded(entered.promise);
    await expect(instance.deleteJob(alice, id)).rejects.toMatchObject({ statusCode: 503 }); expect(aborted).toBe(false);
    expect((await instance.getStatus(alice, id)).status).toBe("running"); gate.resolve(); await status(instance, alice, id, "completed");
    expect((await instance.getMarkdown(alice, id)).markdown).toBe("preserved"); expect(aborted).toBe(false);
  });

  test("failed atomic queue commit leaves an uploaded job retriable without running a worker", async () => {
    let calls = 0;
    const { instance, options } = await service({ converter: async (_input, output) => { calls++; await fs.writeFile(output, "recovered"); } });
    const id = await uploaded(instance, alice), manifest = path.join(options.dataDir, id, "job.json"), backup = `${manifest}.backup`;
    // A real directory at the manifest target prevents atomic file rename on
    // Windows and Linux, without mocking the implementation or filesystem API.
    await fs.rename(manifest, backup); await fs.mkdir(manifest);
    await expect(instance.startConversion(alice, id)).rejects.toThrow(); expect(calls).toBe(0);
    expect((await instance.getStatus(alice, id)).status).toBe("uploaded");
    await fs.rmdir(manifest); await fs.rename(backup, manifest);
    await instance.startConversion(alice, id); await status(instance, alice, id, "completed");
    expect(calls).toBe(1); expect((await instance.getMarkdown(alice, id)).markdown).toBe("recovered");
  });
});
