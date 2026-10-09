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
    expect(await instance.getMarkdown(alice, id))…14726 tokens truncated…me: "get_service_health", arguments: {} } }) });
    expect(response.status).toBe(401); expect(response.headers.get("www-authenticate")).toBe("Bearer");
  }
});

async function closedPort() {
  const server = createServer(); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port; await new Promise<void>(r => server.close(() => r())); return port;
}
test("validly signed but unusable tokens are rejected at HTTP initialize with a Bearer challenge", async () => {
  const f = await deployment();
  const check = async (bearer: string, target = f) => { const response = await initialize(target.base, `Bearer ${bearer}`); return [response.status, response.headers.get("www-authenticate")]; };
  expect(await check(await signed())).toEqual([200, null]);
  for (const bearer of [await signed("litellm-proxy"), await signed("machine-a", { scope: "openid" }), await signed("machine-a", { aud: "other" })]) expect(await check(bearer)).toEqual([401, "Bearer"]);
  // Unreachable JWKS (closed port) and a throwing key resolver both fail closed instead of hanging or admitting the caller.
  const unreachable = await deployment(createJwtAuthenticator({ issuer, audience, jwksUrl: `http://127.0.0.1:${await closedPort()}/jwks`, allowLoopback: true }));
  const throwing = await deployment(createJwtAuthenticator({ issuer, audience, getKey: async () => { throw new Error("jwks down"); } }));
  for (const target of [unreachable, throwing]) {
    expect(await check(await signed(), target)).toEqual([401, "Bearer"]);
  }
}, 15000);
test("MD_JWT_MAX_TTL_SECONDS is bounded at load and enforced against exp - iat", async () => {
  const env = (ttl?: string) => ({ MD_JWT_ISSUER: issuer, MD_JWT_AUDIENCE: audience, MD_JWT_JWKS_URL: "https://trusted.test/jwks", ...(ttl === undefined ? {} : { MD_JWT_MAX_TTL_SECONDS: ttl }) });
  expect(loadJwtAuthenticator(env("3600")).mode).toBe("jwt"); expect(loadJwtAuthenticator(env()).mode).toBe("jwt");
  for (const ttl of ["0", "3601", "NaN", "abc", "", "-1", "1.5", "Infinity"]) expect(() => loadJwtAuthenticator(env(ttl)), ttl).toThrow("max TTL");
  const auth = createJwtAuthenticator({ issuer, audience, maxTtlSeconds: 60, getKey: createLocalJWKSet({ keys: [publicJwk] }) });
  const now = Math.floor(Date.now() / 1000);
  expect(await auth.authenticate(await signed("machine-a", { iat: now, exp: now + 60 }))).not.toBeNull();
  expect(await auth.authenticate(await signed("machine-a", { iat: now, exp: now + 61 }))).toBeNull();
});
test("JWT clock tolerance allows 5s of iat skew but none for exp", async () => {
  const { setSystemTime } = await import("bun:test");
  setSystemTime(new Date("2026-01-01T12:00:00Z"));
  try {
  const auth = verifier(), now = Math.floor(Date.now() / 1000);
  expect(await auth.authenticate(await signed("machine-a", { iat: now + 4, exp: now + 304 }))).not.toBeNull();
  expect(await auth.authenticate(await signed("machine-a", { iat: now + 6, exp: now + 306 }))).toBeNull();
  // Expired tokens get no grace even though the library tolerance is 5s: the explicit `exp <= now` check rejects them.
  expect(await auth.authenticate(await signed("machine-a", { iat: now - 10, exp: now - 1 }))).toBeNull();
  } finally { setSystemTime(); }
});
