import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { JobService, type JobServiceOptions } from "./jobs.js";
import { createHttpServer } from "./http.js";
import { createJwtAuthenticator } from "./jwt.js";
import { loadConfig } from "./config.js";
import { errorResponse, lookupError } from "./errors.js";
import { quotaKey, type Principal, type QuotaOverride } from "./identity.js";
import { toolErrorCode, toolJson, toolOk, waitFor } from "./test-helpers.js";

const disposers: Array<() => Promise<unknown>> = [];
afterEach(async () => { setSystemTime(); while (disposers.length) await disposers.pop()!(); });
const user = (id: string, tenant = id): Principal => ({ tenantId: tenant, agentId: id });
const overrides = (...entries: [Principal, QuotaOverride][]) => new Map(entries.map(([principal, value]) => [quotaKey(principal), value]));
async function service(options: Partial<JobServiceOptions> = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-quota-"));
  const instance = new JobService({ dataDir, maxUploadBytes: 100, maxOutputBytes: 1000, maxStorageBytes: 100_000, maxJobs: 20, retentionMs: 60_000, uploadTtlMs: 60_000, conversionTimeoutMs: 60_000, concurrency: 1,
    maxTenantJobs: 20, maxTenantStorageBytes: 100_000, maxAgentJobs: 1, converter: async (input, output) => { await fs.writeFile(output, await fs.readFile(input)); }, ...options });
  await instance.init();
  disposers.push(async () => { await instance.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return instance;
}
/** Converter that holds every conversion until released and records peak concurrency per owner. */
function gatedConverter(owners: Map<string, string>) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const active = new Map<string, number>(), peak = new Map<string, number>();
  const converter = async (input: string, output: string, signal: AbortSignal) => {
    const owner = owners.get(path.basename(path.dirname(input))) ?? "unknown";
    active.set(owner, (active.get(owner) ?? 0) + 1); peak.set(owner, Math.max(peak.get(owner) ?? 0, active.get(owner)!));
    try { await new Promise<void>((resolve, reject) => { gate.then(resolve); signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }); await fs.writeFile(output, "done"); }
    finally { active.set(owner, active.get(owner)! - 1); }
  };
  return { converter, release, peak };
}
const until = (check: () => Promise<boolean>) => waitFor(check, { timeoutMs: 5000, label: "quota scenario condition" });
async function queue(instance: JobService, principal: Principal, owners?: Map<string, string>) {
  const created = await instance.createUpload(principal, { filename: "x.txt", size_bytes: 1 });
  owners?.set(created.upload_id, principal.agentId);
  await instance.upload(principal, created.upload_id, created.upload_token, Readable.from(["x"]));
  await instance.startConversion(principal, created.upload_id);
  return created.upload_id;
}
const health = async (instance: JobService, principal: Principal) => await instance.health(principal) as any;

describe("operator quota overrides", () => {
  test("an override raises only its own principal's agent caps and errors report the override", async () => {
    const vip = user("user-vip"), bulk = user("user-bulk"), std = user("user-std");
    const instance = await service({ maxAgentStorageBytes: 1100, quotaOverrides: overrides([vip, { maxJobs: 3, maxStorageBytes: 3000 }], [bulk, { maxJobs: 5, maxStorageBytes: 2200 }]) });
    await instance.createUpload(std, { filename: "a.txt", size_bytes: 100 });
    await expect(instance.createUpload(std, { filename: "b.txt", size_bytes: 0 })).rejects.toMatchObject({ statusCode: 507, code: "JOB_LIMIT_EXCEEDED", details: { scope: "agent", limit_jobs: 1 } });
    for (let i = 0; i < 3; i++) await instance.createUpload(vip, { filename: "a.txt", size_bytes: 0 });
    await expect(instance.createUpload(vip, { filename: "b.txt", size_bytes: 0 })).rejects.toMatchObject({ code: "JOB_LIMIT_EXCEEDED", details: { scope: "agent", limit_jobs: 3 } });
    for (let i = 0; i < 2; i++) await instance.createUpload(bulk, { filename: "a.txt", size_bytes: 100 });
    await expect(instance.createUpload(bulk, { filename: "b.txt", size_bytes: 0 })).rejects.toMatchObject({ code: "STORAGE_LIMIT_EXCEEDED", details: { scope: "agent", limit_bytes: 2200, reserved_bytes: 1000 } });
    const own = await health(instance, vip), other = await health(instance, std);
    expect(own.limits).toMatchObject({ agent_jobs: 3, agent_reserved_bytes: 3000, agent_override: true, effective: { jobs: 3, reserved_bytes: 3000 } });
    expect(other.limits).toMatchObject({ agent_jobs: 1, agent_override: false, effective: { jobs: 1, reserved_bytes: 1100 } });
    expect((await health(instance, bulk)).limits).toMatchObject({ agent_jobs: 5, agent_reserved_bytes: 2200, effective: { jobs: 5, reserved_bytes: 2200 } });
    for (const anonymous of [await instance.publicHealth(), await instance.health()]) expect(JSON.stringify(anonymous)).not.toMatch(/limits|effective|override|own_/);
    for (const report of [own, other]) for (const foreign of ["user-bulk", report === own ? "user-std" : "user-vip"]) expect(JSON.stringify(report)).not.toContain(foreign);
  });

  test("concurrent admissions never exceed agent overrides or the global cap", async () => {
    const vip = user("user-vip"), std = user("user-std");
    const instance = await service({ quotaOverrides: overrides([vip, { maxJobs: 3 }]) });
    const attempts = Array.from({ length: 12 }, (_, i) => i % 3 ? vip : std);
    const results = await Promise.allSettled(attempts.map(principal => instance.createUpload(principal, { filename: "x.txt", size_bytes: 1 })));
    const accepted = (principal: Principal) => results.filter((result, i) => attempts[i] === principal && result.status === "fulfilled").length;
    expect(accepted(vip)).toBe(3); expect(accepted(std)).toBe(1);
    results.forEach((result, i) => {
      if (result.status === "fulfilled") return;
      const info = errorResponse(result.reason).error_info;
      expect(info).toMatchObject({ code: "JOB_LIMIT_EXCEEDED", retryable: false, details: { scope: "agent", limit_jobs: attempts[i] === vip ? 3 : 1 } });
      expect(lookupError(info.code)).toMatchObject({ code: "JOB_LIMIT_EXCEEDED", next_steps: expect.arrayContaining([expect.stringContaining("delete_job")]) });
    });
    expect((await health(instance, vip)).own_jobs.awaiting_upload).toBe(3);

    const capped = await service({ maxJobs: 4, maxAgentJobs: 4 });
    const subjects = ["s-1", "s-2", "s-3"].map(id => user(id));
    const burst = await Promise.allSettled(subjects.flatMap(subject => [0, 1, 2].map(() => capped.createUpload(subject, { filename: "x.txt", size_bytes: 1 }))));
    expect(burst.filter(result => result.status === "fulfilled")).toHaveLength(4);
    for (const result of burst) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "JOB_LIMIT_EXCEEDED", details: { scope: "global", limit_jobs: 4 } });
  });

  test("effective limits are the minimum of global, tenant and (overridden) agent caps", async () => {
    const generous = user("agent-vip", "tenant-a"), tight = user("agent-low", "tenant-b"), plain = user("agent-def", "tenant-b"), jwtUser = user("litellm-user");
    const instance = await service({ concurrency: 3, maxTenantJobs: 2, maxTenantConcurrency: 1, maxAgentJobs: 3, maxStorageBytes: 50_000, maxTenantStorageBytes: 40_000,
      quotaOverrides: overrides([generous, { maxJobs: 5, maxConcurrency: 2, maxStorageBytes: 45_000 }], [tight, { maxJobs: 1 }], [jwtUser, { maxJobs: 4 }]) });
    expect((await health(instance, generous)).limits).toMatchObject({ agent_jobs: 5, tenant_jobs: 2, agent_concurrency: 2, effective: { jobs: 2, reserved_bytes: 40_000, concurrency: 1 } });
    expect((await health(instance, tight)).limits.effective).toEqual({ jobs: 1, reserved_bytes: 40_000, concurrency: 1 });
    expect((await health(instance, plain)).limits.effective).toEqual({ jobs: 2, reserved_bytes: 40_000, concurrency: 1 });
    // JWT mode: tenant and agent are the same LiteLLM user, so the tenant default still bounds the override.
    expect((await health(instance, jwtUser)).limits.effective.jobs).toBe(2);
    for (let i = 0; i < 2; i++) await instance.createUpload(generous, { filename: "x.txt", size_bytes: 1 });
    await expect(instance.createUpload(generous, { filename: "x.txt", size_bytes: 1 })).rejects.toMatchObject({ code: "JOB_LIMIT_EXCEEDED", details: { scope: "tenant", limit_jobs: 2 } });
    await instance.createUpload(tight, { filename: "x.txt", size_bytes: 1 });
    await expect(instance.createUpload(tight, { filename: "x.txt", size_bytes: 1 })).rejects.toMatchObject({ code: "JOB_LIMIT_EXCEEDED", details: { scope: "agent", limit_jobs: 1 } });
    await instance.createUpload(plain, { filename: "x.txt", size_bytes: 1 });
    await expect(instance.createUpload(plain, { filename: "x.txt", size_bytes: 1 })).rejects.toMatchObject({ code: "JOB_LIMIT_EXCEEDED", details: { scope: "tenant", limit_jobs: 2 } });
  });

  test("with only global caps configured, effective limits equal the global caps", async () => {
    const instance = await service({ maxJobs: 7, maxStorageBytes: 9000, concurrency: 2, maxTenantJobs: undefined, maxTenantStorageBytes: undefined, maxAgentJobs: undefined });
    const limits = (await health(instance, user("only-global"))).limits;
    expect(limits).toMatchObject({ tenant_jobs: 7, agent_jobs: 7, tenant_reserved_bytes: 9000, agent_reserved_bytes: 9000, tenant_concurrency: 2, agent_concurrency: 2, agent_override: false });
    expect(limits.effective).toEqual({ jobs: 7, reserved_bytes: 9000, concurrency: 2 });
  });

  test("scheduler applies a per-principal concurrency override without exceeding tenant or global caps", async () => {
    const owners = new Map<string, string>(), gate = gatedConverter(owners);
    const vip = user("vip", "shared"), std = user("std", "shared");
    const instance = await service({ concurrency: 3, maxTenantConcurrency: 3, maxAgentConcurrency: 1, maxAgentJobs: 5, converter: gate.converter, quotaOverrides: overrides([vip, { maxConcurrency: 2 }]) });
    for (const principal of [vip, vip, vip, std, std]) await queue(instance, principal, owners);
    await until(async () => (await health(instance, vip)).own_jobs.running === 2 && (await health(instance, std)).own_jobs.running === 1);
    expect((await health(instance, vip)).own_jobs.queued).toBe(1); expect((await health(instance, std)).own_jobs.queued).toBe(1);
    expect((await health(instance, vip)).own_reserved_bytes).toBe(3 * 1001);
    expect((await health(instance, vip)).limits.effective.concurrency).toBe(2);
    gate.release();
    await until(async () => (await health(instance, vip)).own_jobs.completed === 3 && (await health(instance, std)).own_jobs.completed === 2);
    expect(gate.peak.get("vip")).toBe(2); expect(gate.peak.get("std")).toBe(1);
  });

  test("cross-tenant fairness is unchanged when one agent has a concurrency override", async () => {
    // Each conversion waits for its own release, so exactly one slot frees at a time and start order is the scheduling order.
    const owners = new Map<string, string>(), starts: string[] = [], waiting: Array<() => void> = [];
    const converter = async (input: string, output: string, signal: AbortSignal) => {
      starts.push(owners.get(path.basename(path.dirname(input)))!);
      await new Promise<void>((resolve, reject) => { waiting.push(resolve); signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
      await fs.writeFile(output, "done");
    };
    const vip = user("vip", "tenant-a"), std = user("std", "tenant-b");
    const instance = await service({ concurrency: 2, maxTenantConcurrency: 2, maxAgentConcurrency: 1, maxAgentJobs: 5, converter, quotaOverrides: overrides([vip, { maxConcurrency: 2 }]) });
    for (let i = 0; i < 4; i++) await queue(instance, vip, owners);
    await until(async () => waiting.length === 2);
    expect(starts).toEqual(["vip", "vip"]);
    for (let i = 0; i < 2; i++) await queue(instance, std, owners);
    expect((await health(instance, std)).own_jobs.queued).toBe(2);
    // FIFO would run vip's two remaining jobs next; round-robin gives each freed slot to the other tenant in turn.
    for (const expected of ["std", "vip", "std", "vip"]) {
      const before = starts.length;
      waiting.shift()!();
      await until(async () => starts.length === before + 1);
      expect(starts.at(-1)).toBe(expected);
    }
    while (waiting.length) waiting.shift()!();
    await until(async () => (await health(instance, vip)).own_jobs.completed === 4 && (await health(instance, std)).own_jobs.completed === 2);
    expect(starts).toEqual(["vip", "vip", "std", "vip", "std", "vip"]);
  });

  test("queued and running work hold reservations until deletion or expiry releases them", async () => {
    const owners = new Map<string, string>(), gate = gatedConverter(owners), principal = user("user-q");
    const instance = await service({ maxAgentJobs: 2, uploadTtlMs: 30_000, converter: gate.converter });
    const running = await queue(instance, principal, owners);
    await until(async () => (await health(instance, principal)).own_jobs.running === 1);
    const queued = await queue(instance, principal, owners);
    expect((await health(instance, principal)).own_jobs).toMatchObject({ running: 1, queued: 1 });
    expect((await health(instance, principal)).own_reserved_bytes).toBe(2 * 1001);
    await expect(instance.createUpload(principal, { filename: "x.txt", size_bytes: 1 })).rejects.toMatchObject({ code: "JOB_LIMIT_EXCEEDED", details: { scope: "agent", limit_jobs: 2 } });
    await instance.deleteJob(principal, queued);
    const pending = await instance.createUpload(principal, { filename: "x.txt", size_bytes: 1 });
    await expect(instance.createUpload(principal, { filename: "x.txt", size_bytes: 1 })).rejects.toMatchObject({ code: "JOB_LIMIT_EXCEEDED" });
    setSystemTime(new Date(Date.now() + 30_001));
    await instance.cleanup();
    expect((await instance.getStatus(principal, running)).status).toBe("running");
    await expect(instance.getStatus(principal, pending.upload_id)).rejects.toMatchObject({ statusCode: 410 });
    expect((await health(instance, principal)).own_jobs).toMatchObject({ running: 1, expired: 1, awaiting_upload: 0 });
    expect((await health(instance, principal)).own_reserved_bytes).toBe(1001);
    await instance.createUpload(principal, { filename: "x.txt", size_bytes: 1 });
    await instance.deleteJob(principal, running);
    await instance.createUpload(principal, { filename: "x.txt", size_bytes: 1 });
    expect((await health(instance, principal)).own_jobs.awaiting_upload).toBe(2);
  });
});

describe("signed subjects see only their own effective quota", () => {
  test("JWT users read private limits, cannot select another user and recover via lookup_error", async () => {
    const issuer = "https://litellm.test", audience = "markdownify";
    const scope = ["mcp:tools/list", "mcp:tools/call", ...["create_upload", "get_service_health", "lookup_error"].map(name => `mcp:tools/${name}:call`)].join(" ");
    const key = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...await exportJWK(key.publicKey), kid: "k", alg: "RS256", use: "sig" };
    const instance = await service({ maxAgentJobs: 1, quotaOverrides: overrides([user("machine-vip"), { maxJobs: 2 }], [user("machine-store"), { maxJobs: 3, maxStorageBytes: 1500 }]) });
    const httpOptions = { authenticator: createJwtAuthenticator({ issuer, audience, getKey: createLocalJWKSet({ keys: [jwk] }) }), publicBaseUrl: "http://127.0.0.1", allowedHosts: ["127.0.0.1"] };
    const server = createHttpServer(instance, httpOptions); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; httpOptions.publicBaseUrl = base;
    disposers.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const connect = async (subject: string) => {
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({ iss: issuer, aud: audience, sub: subject, iat: now, exp: now + 300, scope }).setProtectedHeader({ alg: "RS256", kid: "k" }).sign(key.privateKey);
      const client = new Client({ name: subject, version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Host: "127.0.0.1", Authorization: `Bearer ${token}` } } }));
      disposers.push(() => client.close()); return client;
    };
    const text = toolJson;
    const subjects = ["machine-vip", "machine-a", "machine-b"], clients = await Promise.all(subjects.map(connect));
    const calls = await Promise.all(clients.flatMap(client => [0, 1, 2].map(() => client.callTool({ name: "create_upload", arguments: { filename: "x.txt", size_bytes: 1 } }))));
    const ok = (index: number) => calls.slice(index * 3, index * 3 + 3).filter(result => !result.isError).length;
    expect([ok(0), ok(1), ok(2)]).toEqual([2, 1, 1]);
    const denied = calls.findLast((result, i) => result.isError && i < 3)!;
    expect(toolErrorCode(denied)).toBe("JOB_LIMIT_EXCEEDED");
    expect(text(denied).error_info).toMatchObject({ code: "JOB_LIMIT_EXCEEDED", details: { scope: "agent", limit_jobs: 2 } });
    expect(text(await clients[0].callTool({ name: "lookup_error", arguments: { code: text(denied).error_info.code } }))).toMatchObject({ code: "JOB_LIMIT_EXCEEDED", retryable: false });
    const store = await connect("machine-store");
    toolOk(await store.callTool({ name: "create_upload", arguments: { filename: "x.txt", size_bytes: 1 } }));
    const full = await store.callTool({ name: "create_upload", arguments: { filename: "x.txt", size_bytes: 1 } });
    expect(toolErrorCode(full)).toBe("STORAGE_LIMIT_EXCEEDED");
    expect(text(full).error_info).toMatchObject({ code: "STORAGE_LIMIT_EXCEEDED", retryable: false, details: { scope: "agent", limit_bytes: 1500, requested_bytes: 1, reserved_bytes: 1001 } });
    expect(text(await store.callTool({ name: "lookup_error", arguments: { code: "STORAGE_LIMIT_EXCEEDED" } })).next_steps.join(" ")).toContain("input bytes plus the maximum output bytes");
    expect(text(await store.callTool({ name: "get_service_health", arguments: {} })).limits.effective).toMatchObject({ jobs: 3, reserved_bytes: 1500 });
    for (const [index, client] of clients.entries()) {
      const report = text(await client.callTool({ name: "get_service_health", arguments: {} }));
      expect(report.own_jobs.awaiting_upload).toBe(index ? 1 : 2);
      expect(report.limits).toMatchObject({ agent_override: index === 0, effective: { jobs: index ? 1 : 2 } });
      for (const other of subjects.filter(subject => subject !== subjects[index])) expect(JSON.stringify(report)).not.toContain(other);
      const probe = await client.callTool({ name: "get_service_health", arguments: { tenant_id: "machine-vip", agent_id: "machine-vip" } });
      expect(toolErrorCode(probe)).toBe("INVALID_ARGUMENTS");
    }
  });
});

describe("MD_QUOTA_OVERRIDES_FILE configuration", () => {
  const env = { MD_API_KEY: "a".repeat(32) };
  async function file(content: unknown) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-quota-config-"));
    disposers.push(() => fs.rm(dir, { recursive: true, force: true }));
    const target = path.join(dir, "quota.json");
    await fs.writeFile(target, typeof content === "string" ? content : JSON.stringify(content));
    return target;
  }
  const entry = (changes: Record<string, unknown> = {}) => ({ tenant_id: "user-a", agent_id: "user-a", max_jobs: 5, ...changes });
  test.skipIf(process.platform === "win32")("a FIFO is rejected without blocking startup", async () => {
    const fifo = path.join(path.dirname(await file({ overrides: [] })), "fifo.json");
    execFileSync("mkfifo", [fifo]);
    // A blocking open would stall the whole event loop, so a timer in this process could never fire; bound it in a child process.
    const script = `const { loadConfig } = await import(${JSON.stringify(path.join(import.meta.dir, "config.ts"))});
      try { loadConfig({ MD_API_KEY: "a".repeat(32), MD_QUOTA_OVERRIDES_FILE: ${JSON.stringify(fifo)} }); console.log("loaded"); } catch (error) { console.log(error.message); }`;
    expect(execFileSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10_000 })).toContain("MD_QUOTA_OVERRIDES_FILE must be a readable regular file of at most 1 MiB");
  }, 15_000);
  test("the documented example produces the documented effective limits", async () => {
    const docs = await fs.readFile(path.join(import.meta.dir, "../../docs/MULTITENANT.md"), "utf8");
    const where = "docs/MULTITENANT.md \"### Operator quota overrides\"";
    const start = docs.indexOf("### Operator quota overrides");
    expect(start, `${where} section is missing`).toBeGreaterThanOrEqual(0);
    const section = docs.slice(start);
    const block = (language: string) => {
      const match = section.match(new RegExp("```" + language + "\\r?\\n([\\s\\S]*?)```"));
      expect(match, `${where} has no \`\`\`${language} block`).not.toBeNull();
      return match![1];
    };
    const settings = Object.fromEntries(block("dotenv").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"))
      .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-quota-docs-"));
    disposers.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const config = loadConfig({ ...env, ...settings, MD_DATA_DIR: dataDir, MD_QUOTA_OVERRIDES_FILE: await file(block("json")) });
    const instance = new JobService({ ...config.jobs, converter: async () => {} }); await instance.init(); disposers.push(() => instance.close());
    const effective = async (principal: Principal) => (await health(instance, principal)).limits.effective;
    expect(await effective(user("batch-agent", "tenant-a"))).toEqual({ jobs: 40, reserved_bytes: 134_217_728, concurrency: 2 });
    expect(await effective(user("markdownify-agent-b"))).toEqual({ jobs: 2, reserved_bytes: 67_108_864, concurrency: 1 });
    expect(await effective(user("other-agent", "tenant-a"))).toEqual({ jobs: 10, reserved_bytes: 134_217_728, concurrency: 1 });
    // The documented table lists the same values, each on its own caller's row.
    for (const row of ["| `tenant-a` / `batch-agent` (raised) | 40 | 134,217,728 (128 MiB) | 2 |", "| `markdownify-agent-b` (lowered) | 2 | 67,108,864 (64 MiB) | 1 |", "| Any unlisted principal | 10 | 134,217,728 (128 MiB) | 1 |"]) expect(section, `${where} table row`).toContain(row);
    // As documented, storage binds before the raised job count: the 128 MiB tenant budget holds five 1-byte jobs.
    const batch = user("batch-agent", "tenant-a");
    for (let i = 0; i < 5; i++) await instance.createUpload(batch, { filename: "x.txt", size_bytes: 1 });
    await expect(instance.createUpload(batch, { filename: "x.txt", size_bytes: 1 })).rejects.toMatchObject({ code: "STORAGE_LIMIT_EXCEEDED", details: { scope: "tenant", limit_bytes: 134_217_728 } });
  });
  test("valid overrides load keyed by principal and absence keeps defaults", async () => {
    expect(loadConfig(env).jobs.quotaOverrides).toBeUndefined();
    const loaded = loadConfig({ ...env, MD_MAX_OUTPUT_BYTES: "1000", MD_QUOTA_OVERRIDES_FILE: await file({ overrides: [entry({ max_concurrency: 2, max_storage_bytes: 1024 }), { tenant_id: "t", agent_id: "b", max_concurrency: 1 }] }) }).jobs.quotaOverrides!;
    expect(loaded.size).toBe(2);
    expect(loaded.get(quotaKey(user("user-a")))).toEqual({ maxJobs: 5, maxStorageBytes: 1024, maxConcurrency: 2 });
    expect(loaded.get(quotaKey(user("b", "t")))).toEqual({ maxConcurrency: 1 });
    expect(loadConfig({ ...env, MD_QUOTA_OVERRIDES_FILE: await file({ overrides: [] }) }).jobs.quotaOverrides!.size).toBe(0);
    expect(loadConfig({ ...env, MD_MAX_JOBS: "500", MD_QUOTA_OVERRIDES_FILE: await file({ overrides: [entry({ max_jobs: 500 })] }) }).jobs.quotaOverrides!.get(quotaKey(user("user-a")))!.maxJobs).toBe(500);
  });
  test("invalid override files fail at startup", async () => {
    const invalid: [unknown, string][] = [
      ["not json", "valid JSON"], [[], '"overrides" array'], [{ overrides: {} }, '"overrides" array'], [{ overrides: [], extra: 1 }, '"overrides" array'],
      [{ overrides: [null] }, "entry 0 must be an object"], [{ overrides: [entry({ tenant_id: "../escape" })] }, "valid tenant_id"], [{ overrides: [entry({ agent_id: undefined })] }, "valid tenant_id"],
      [{ overrides: [entry(), entry({ max_jobs: 2 })] }, "entry 1 duplicates"], [{ overrides: [entry({ max_jobs: 101 })] }, "exceeds the global cap 100"],
      [{ overrides: [entry({ max_concurrency: 3 })] }, "max_concurrency exceeds the global cap 2"], [{ overrides: [entry({ max_storage_bytes: 256 * 1024 * 1024 + 1 })] }, "max_storage_bytes exceeds"],
      [{ overrides: [entry({ disabled: true })] }, "unknown field"], [{ overrides: [entry({ max_jobs: 1.5 })] }, "max_jobs must be a positive safe integer"],
      [{ overrides: [entry({ max_jobs: "2" })] }, "positive safe integer"], [{ overrides: [entry({ max_jobs: 0 })] }, "positive safe integer"], [{ overrides: [entry({ max_concurrency: -1 })] }, "positive safe integer"],
      [{ overrides: [{ tenant_id: "user-a", agent_id: "user-a" }] }, "at least one"],
      [{ overrides: [entry({ max_storage_bytes: 25 * 1024 * 1024 })] }, `max_storage_bytes must be at least ${25 * 1024 * 1024 + 1}`], [{ overrides: [entry({ max_storage_bytes: 1 })] }, "one input byte plus MD_MAX_OUTPUT_BYTES"],
      ['{"overrides": [], "__proto__": {"polluted": true}}', '"overrides" array'], ['{"overrides": [], "constructor": {"prototype": {"polluted": true}}}', '"overrides" array'],
      ['{"overrides": [{"tenant_id": "user-a", "agent_id": "user-a", "max_jobs": 1, "__proto__": {"polluted": true}}]}', 'unknown field "__proto__"'],
      ['{"overrides": [{"tenant_id": "user-a", "agent_id": "user-a", "max_jobs": 1, "constructor": {"prototype": {"polluted": true}}}]}', 'unknown field "constructor"'],
    ];
    for (const [content, message] of invalid) { const target = await file(content); expect(() => loadConfig({ ...env, MD_QUOTA_OVERRIDES_FILE: target })).toThrow(message); }
    expect(() => loadConfig({ ...env, MD_QUOTA_OVERRIDES_FILE: "" })).toThrow("MD_QUOTA_OVERRIDES_FILE must be a file path");
    expect(({} as any).polluted).toBeUndefined(); expect(Object.prototype).not.toHaveProperty("polluted");
    const exact = JSON.stringify({ overrides: [entry()] }), mib = 1024 * 1024;
    expect(loadConfig({ ...env, MD_QUOTA_OVERRIDES_FILE: await file(exact + " ".repeat(mib - exact.length)) }).jobs.quotaOverrides!.size).toBe(1);
    expect(loadConfig({ ...env, MD_QUOTA_OVERRIDES_FILE: await file({ overrides: [entry({ max_storage_bytes: 25 * 1024 * 1024 + 1 })] }) }).jobs.quotaOverrides!.size).toBe(1);
    const large = await file(exact + " ".repeat(mib - exact.length + 1));
    for (const target of [large, path.dirname(large), path.join(path.dirname(large), "missing.json")]) expect(() => loadConfig({ ...env, MD_QUOTA_OVERRIDES_FILE: target })).toThrow("at most 1 MiB");
    expect(() => new JobService({ dataDir: os.tmpdir(), maxUploadBytes: 1, maxStorageBytes: 1, maxJobs: 1, retentionMs: 1, uploadTtlMs: 1, conversionTimeoutMs: 1, maxOutputBytes: 1, concurrency: 1, quotaOverrides: overrides([user("x"), { maxJobs: 0 }]) })).toThrow("quotaOverrides");
  });
});
