import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { JobService } from "./jobs.js";
import { createHttpServer } from "./http.js";
import { createAuthenticator, hashToken } from "./auth.js";
import { checkRuntime } from "./health.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture(jwt = true) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-health-"));
  const service = new JobService({ dataDir, maxUploadBytes: 100, maxOutputBytes: 100, maxStorageBytes: 10000, maxJobs: 10, retentionMs: 60000, uploadTtlMs: 60000, conversionTimeoutMs: 1000, concurrency: 1, converter: async () => {} });
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
  // Missing-sub/invalid Authorization never acquires a job owner; probe methods remain public.
  expect((await f.request({ jsonrpc: "2.0", id: 8, method: "ping" }, { Authorization: "Bearer invalid" })).status).toBe(200);
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
    await new Promise(resolve => setTimeout(resolve, 2100));
    second = f.service.health();
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    await f.service.health();
    expect(calls).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 2100));
    await f.service.health();
    expect(calls).toBe(2);
  } finally {
    release();
    await Promise.allSettled([first, second].filter(Boolean) as Promise<unknown>[]);
    probe.mockRestore();
  }
}, 10000);
