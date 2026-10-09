import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { JobService, ServiceError } from "./jobs.js";
import { createHttpServer } from "./http.js";
import { createAuthenticator, hashToken } from "./auth.js";
import { checkRuntime } from "./health.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture(jwt = true, overrides: Record<string, unknown> = {}, init = true) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-health-"));
  const service = new JobService({ dataDir, maxUploadBytes: 100, maxOutputBytes: 100, maxStorageBytes: 10000, maxJobs: 10, retentionMs: 60000, uploadTtlMs: 60000, conversionTimeoutMs: 1000, concurrency: 1, converter: async () => {}, ...overrides });
  if (init) await service.init();
  const registry = createAuthenticator({ credentials: [{ tenant_id: "a", agent_id: "a", token_sha256: hashToken("a") }, { tenant_id: "b", agent_id: "b", token_sha256: hashToken("b") }] });
  const auth = jwt ? { mode: "jwt" as const, authenticate: registry.authenticate } : registry;
  const server = createHttpServer(service, { authenticator: auth, publicBaseUrl: "http://127.0.0.1", allowedHosts: ["127.0.0.1"] });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  cleanup.push(async () => { await service.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await fs.rm(dataDir, { recursive: true, force: true }); });
  const request = (body: unknown, headers = {}) => fetch(base + "/mcp", { method: "POST", headers: { Host: "127.0.0.1", "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
  return { service, dataDir, base, request };
}
test("LiteLLM anonymous initialize/notification/ping works while tools and batches stay private", async () => {
  const f = await fixture();
  const client = new Client({ name: "litellm-health", version: "1.104.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(f.base + "/mcp"), { requestInit: { headers: { Host: "127.0.0.1" } } }));
  cleanup.push(() => client.close());
  expect(await client.ping()).toEqual({});
  await expect(client.listTools()).rejects.toThrow();
  for (const method of ["tools/call", "tools/list", "resources/list", "prompts/list", "bogus"]) {
    expect((await f.request({ jsonrpc: "2.0", id: 5, method, params: { name: "create_upload", arguments: { filename: "a.txt", size_bytes: 1 } } })).status).toBe(401);
  }
  expect((await f.request([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }])).status).toBe(401);
  // A present but invalid Authorization header is rejected; only header-less probes are public.
  expect((await f.request({ jsonrpc: "2.0", id: 8, method: "ping" }, { Authorization: "Bearer invalid" })).status).toBe(401);
  expect((await f.request({ jsonrpc: "2.0", id: 9, method: "tools/list" }, { Authorization: "Bearer invalid" })).status).toBe(401);
});
test("health measures storage, omits foreign usage, and fails readiness during shutdown", async () => {
  const f = await fixture();
  const a = { tenantId: "a", agentId: "a" }, b = { tenantId: "b", agentId: "b" };
  const job = await f.service.createUpload(b, { filename: "b.txt", size_bytes: 1 });
  const health = await f.service.health(a);
  expect(health.ready).toBe(true); expect(health.checks.storage.writable).toBe(true); expect(health.checks.storage.free_bytes).toBeGreaterThan(0);
  expect((health as any).own_jobs.awaiting_upload).toBe(0);
  expect((await f.service.health(b) as any).own_reserved_bytes).toBe(101);
  expect(JSON.stringify(health)).not.toContain(job.upload_id);
  expect(health.uptime_seconds).toBeGreaterThanOrEqual(0); expect(health.memory_rss_bytes).toBeGreaterThan(0);
  const probe = (p: string) => fetch(f.base + p, { headers: { Host: "127.0.0.1" } });
  const ready = await probe("/readyz");
  expect(ready.status).toBe(200);
  const body = await ready.json();
  for (const v of [body.free_bytes, body.checks.storage.free_bytes, body.memory_rss_bytes, body.uptime_seconds, body.checked_at, body.own_jobs]) expect(v).toBeUndefined();
  expect(body).toEqual({ status: "ok", ready: true, checks: { initialized: true, accepting_work: true, storage: { writable: true }, converter: { available: true } } });
  expect((await fs.readdir(f.dataDir)).some(n => n.startsWith(".health-"))).toBe(false);
  await f.service.close();
  const notReady = await probe("/readyz");
  expect(notReady.status).toBe(503); expect((await notReady.json()).checks.accepting_work).toBe(false);
  for (const p of ["/livez", "/healthz"]) { const r = await probe(p); expect(r.status).toBe(200); expect(await r.json()).toEqual({ status: "ok" }); }
  expect((await fetch(f.base + "/readyz", { method: "POST", headers: { Host: "127.0.0.1" } })).headers.get("allow")).toBe("GET");
  expect((await f.request({ jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(503);
});
test("authenticated health tool returns only the caller's metrics", async () => {
  const f = await fixture();
  await f.service.createUpload({ tenantId: "b", agentId: "b" }, { filename: "b.txt", size_bytes: 1 });
  const client = new Client({ name: "agent", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(f.base + "/mcp"), { requestInit: { headers: { Host: "127.0.0.1", Authorization: "Bearer a" } } }));
  cleanup.push(() => client.close());
  const response: any = await client.callTool({ name: "get_service_health", arguments: {} });
  expect(response.isError).toBe(false);
  const health = JSON.parse(response.content[0].text);
  expect(health.own_jobs.awaiting_upload).toBe(0); expect(health.own_reserved_bytes).toBe(0); expect(health.limits.global_jobs).toBe(10);
});
test("registry mode keeps MCP initialization authenticated", async () => {
  const f = await fixture(false);
  expect((await f.request({ jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
});
test("real health detects missing converter and unwritable storage without leaking paths", async () => {
  const f = await fixture();
  const previous = process.env.MARKITDOWN_PATH;
  try {
    process.env.MARKITDOWN_PATH = path.join(f.dataDir, "private-missing.exe");
    const h = await checkRuntime(path.join(f.dataDir, "absent"), false);
    expect(h.converter.available).toBe(false); expect(h.storage.writable).toBe(false);
    expect(JSON.stringify(h)).not.toContain(f.dataDir);
  } finally { if (previous === undefined) delete process.env.MARKITDOWN_PATH; else process.env.MARKITDOWN_PATH = previous; }
});

test("slow readiness probes remain single-flight and cache TTL starts after completion", async () => {
  const f = await fixture();
  const original = fs.statfs;
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const probe = spyOn(fs, "statfs").mockImplementation(async (target: any) => {
    calls++;
    await gate;
    return original(target);
  });
  let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
  try {
    first = f.service.health();
    setSystemTime(new Date(Date.now() + 2100));
    second = f.service.health();
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    await f.service.health();
    expect(calls).toBe(1);
    setSystemTime(new Date(Date.now() + 2100));
    await f.service.health();
    expect(calls).toBe(2);
  } finally {
    setSystemTime();
    release();
    await Promise.allSettled([first, second].filter(Boolean) as Promise<unknown>[]);
    probe.mockRestore();
  }
});

test("anonymous probe gating treats any present Authorization header as a credential that must verify", async () => {
  const f = await fixture();
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  // The scheme match is case-sensitive today: a lowercase "bearer" with a valid registry token is rejected, not anonymous.
  for (const authorization of ["", "Basic Zm9v", "bearer a", "Bearer "]) {
    const response = await f.request(ping, { Authorization: authorization });
    expect([authorization, response.status]).toEqual([authorization, 401]);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  }
  expect((await f.request(ping, { Authorization: "Bearer a" })).status).toBe(200);
  expect((await f.request(ping)).status).toBe(200);
});
test("readyz 503 body stays minimal after shutdown", async () => {
  const f = await fixture();
  await f.service.close();
  const response = await fetch(f.base + "/readyz", { headers: { Host: "127.0.0.1" } });
  expect(response.status).toBe(503);
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(["checks", "ready", "status"]);
  expect(Object.keys(body.checks).sort()).toEqual(["accepting_work", "converter", "initialized", "storage"]);
  expect(body.checks.storage).toEqual({ writable: true }); expect(body.checks.converter).toEqual({ available: true });
  expect(body).toEqual({ status: "unavailable", ready: false, checks: { initialized: true, accepting_work: false, storage: { writable: true }, converter: { available: true } } });
  for (const key of ["free_bytes", "uptime_seconds", "memory_rss_bytes", "checked_at", "own_jobs"]) expect(JSON.stringify(body)).not.toContain(key);
});
test("livez stays 200 while readyz is 503 for unwritable storage or a missing converter", async () => {
  const f = await fixture();
  const probe = (p: string) => fetch(f.base + p, { headers: { Host: "127.0.0.1" } });
  const statfs = spyOn(fs, "statfs").mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
  try {
    const ready = await probe("/readyz");
    expect(ready.status).toBe(503);
    const body = await ready.json();
    expect(body.ready).toBe(false); expect(body.checks.storage.writable).toBe(false); expect(body.checks.accepting_work).toBe(true);
    expect(JSON.stringify(body)).not.toContain(f.dataDir);
    expect((await probe("/livez")).status).toBe(200);
  } finally { statfs.mockRestore(); }
  const previous = process.env.MARKITDOWN_PATH;
  try {
    process.env.MARKITDOWN_PATH = path.join(f.dataDir, "private-missing.exe");
    const g = await fixture(true, { converter: undefined });
    const ready = await fetch(g.base + "/readyz", { headers: { Host: "127.0.0.1" } });
    expect(ready.status).toBe(503);
    const body = await ready.json();
    expect(body.checks.converter.available).toBe(false); expect(body.checks.storage.writable).toBe(true);
    expect(JSON.stringify(body)).not.toContain("private-missing");
    expect((await fetch(g.base + "/livez", { headers: { Host: "127.0.0.1" } })).status).toBe(200);
    expect((await g.request({ jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(503);
  } finally { if (previous === undefined) delete process.env.MARKITDOWN_PATH; else process.env.MARKITDOWN_PATH = previous; }
});
test("readiness is false before init() and flips to true after it", async () => {
  const f = await fixture(true, {}, false);
  const probe = (p: string) => fetch(f.base + p, { headers: { Host: "127.0.0.1" } });
  const notReady = await probe("/readyz");
  expect(notReady.status).toBe(503);
  expect((await notReady.json()).checks).toMatchObject({ initialized: false, accepting_work: true });
  expect((await probe("/livez")).status).toBe(200);
  expect((await f.request({ jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(503);
  await f.service.init();
  const ready = await probe("/readyz");
  expect(ready.status).toBe(200); expect((await ready.json()).checks.initialized).toBe(true);
  expect((await f.request({ jsonrpc: "2.0", id: 2, method: "ping" })).status).toBe(200);
});
test("audit sink failure does not affect readiness today but fails closed on audited operations", async () => {
  // Documents current behaviour: readiness does not reflect audit availability (tracked separately).
  const f = await fixture(true, { audit: async () => { throw new Error("disk full"); } });
  const principal = { tenantId: "a", agentId: "a" };
  expect((await f.service.health(principal)).ready).toBe(true);
  expect((await f.service.publicHealth()).ready).toBe(true);
  const error = await f.service.createUpload(principal, { filename: "a.txt", size_bytes: 1 }).catch(e => e);
  expect(error).toBeInstanceOf(ServiceError);
  expect(error.statusCode).toBe(503); expect(error.code).toBe("AUDIT_UNAVAILABLE");
  expect(error.message).not.toContain("disk full");
});
