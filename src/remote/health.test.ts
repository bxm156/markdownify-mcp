import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { JobService } from "./jobs.js";
import { createHttpServer } from "./http.js";
import { createAuthenticator, hashToken } from "./auth.js";
import { checkRuntime } from "./health.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture(jwt = true, extra: { healthTimeoutMs?: number } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-health-"));
  const service = new JobService({ dataDir, maxUploadBytes: 100, maxOutputBytes: 100, maxStorageBytes: 10000, maxJobs: 10, retentionMs: 60000, uploadTtlMs: 60000, conversionTimeoutMs: 1000, concurrency: 1, converter: async () => {}, ...extra });
  await service.init();
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
  for (const p of ["/livez", "/healthz", "/readyz"]) {
    const r = await fetch(f.base + p, { method: "POST", headers: { Host: "127.0.0.1" } });
    expect(r.status).toBe(405); expect(r.headers.get("allow")).toBe("GET, HEAD");
  }
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

test("probe routes accept any Host and HEAD while other routes keep the allowlist", async () => {
  const f = await fixture();
  const at = (p: string, init: RequestInit = {}) => fetch(f.base + p, { ...init, headers: { Host: "10.0.0.7:8000", Origin: "http://10.0.0.7:8000", ...init.headers } });
  for (const p of ["/livez", "/healthz", "/readyz"]) {
    const r = await at(p);
    expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("no-store"); expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const head = await at(p, { method: "HEAD" });
    expect(head.status).toBe(200); expect(head.headers.get("content-type")).toBe("application/json"); expect(await head.text()).toBe("");
    expect((await at(p + "?verbose=1")).status).toBe(400);
  }
  expect((await at("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
  expect((await at("/uploads/00000000-0000-0000-0000-000000000000", { method: "PUT" })).status).toBe(403);
  await f.service.close();
  expect((await at("/readyz")).status).toBe(503); expect((await at("/readyz", { method: "HEAD" })).status).toBe(503);
});

test("hung storage probe reports 503 within the bound and a later probe retries", async () => {
  const f = await fixture(true, { healthTimeoutMs: 50 });
  const original = fs.statfs;
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const probe = spyOn(fs, "statfs").mockImplementation(async (target: any) => { calls++; await gate; return original(target); });
  const ready = () => fetch(f.base + "/readyz", { headers: { Host: "127.0.0.1" } });
  try {
    const started = performance.now();
    const [a, b] = await Promise.all([ready(), ready()]);
    expect(performance.now() - started).toBeLessThan(2000);
    expect([a.status, b.status]).toEqual([503, 503]); expect(calls).toBe(1);
    expect((await a.json()).checks).toEqual({ initialized: true, accepting_work: true, storage: { writable: false }, converter: { available: true } });
    expect((await ready()).status).toBe(503); expect(calls).toBe(1);
    release();
    setSystemTime(new Date(Date.now() + 2100));
    expect((await ready()).status).toBe(200); expect(calls).toBe(2);
    expect((await fs.readdir(f.dataDir)).some(n => n.startsWith(".health-"))).toBe(false);
  } finally {
    setSystemTime();
    release();
    probe.mockRestore();
  }
});

test("abandoned probe file is removed when a hung write eventually finishes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-health-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const original = fs.writeFile;
  let release!: () => void, written!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), wrote = new Promise<void>(resolve => { written = resolve; });
  const spy = spyOn(fs, "writeFile").mockImplementation(async (...args: any[]) => { await gate; await (original as any)(...args); written(); });
  try {
    const h = await checkRuntime(dir, true, 20);
    expect(h.storage.writable).toBe(false); expect(h.converter.available).toBe(true);
    release(); await wrote;
    for (let i = 0; i < 100 && (await fs.readdir(dir)).length; i++) await new Promise(r => setTimeout(r, 10));
    expect(await fs.readdir(dir)).toEqual([]); expect(h.storage.writable).toBe(false);
  } finally { release(); spy.mockRestore(); }
});

test("malformed request target is rejected with 400, not 500", async () => {
  const f = await fixture();
  const port = new URL(f.base).port;
  for (const target of ["http://[", "http://[/livez"]) {
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(port), "127.0.0.1", () => socket.end(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
      let data = ""; socket.on("data", d => { data += d; }); socket.on("end", () => resolve(data)); socket.on("error", reject);
    });
    expect(raw.split("\r\n", 1)[0]).toBe("HTTP/1.1 400 Bad Request");
    expect(raw).toContain("Invalid request target");
  }
});
