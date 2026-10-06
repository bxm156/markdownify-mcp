import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hashToken, loadAuthenticator } from "./auth.js";
import { createHttpServer } from "./http.js";
import { JobService } from "./jobs.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const OLD_A = "old-agent-a-" + "a".repeat(32);
const NEW_A = "new-agent-a-" + "a".repeat(32);
const TOKEN_B = "agent-b-" + "b".repeat(32);
const entry = (token: string, agent_id: string, disabled = false) => ({ tenant_id: "tenant", agent_id, token_sha256: hashToken(token), disabled });
function parsed(result: any): any {
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0].text);
}
function errorText(result: any): string {
  expect(result.isError).toBe(true);
  return JSON.parse(result.content[0].text).error;
}

async function deployment(uploadTtlMs = 60_000) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-http-lifecycle-"));
  const registryPath = path.join(root, "agents.json"), dataDir = path.join(root, "jobs");
  let service: JobService | undefined, server: Server | undefined, base = "";
  const clients = new Set<Client>();
  async function registry(rotated = false) {
    await fs.writeFile(registryPath, JSON.stringify({ credentials: [entry(OLD_A, "a", rotated), ...(rotated ? [entry(NEW_A, "a")] : []), entry(TOKEN_B, "b")] }), { mode: 0o600 });
  }
  async function stop() {
    await Promise.allSettled([...clients].map(client => client.close())); clients.clear();
    await service?.close(); service = undefined;
    if (server) {
      const current = server; server = undefined;
      const closed = new Promise<void>((resolve, reject) => current.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
      current.closeAllConnections();
      await closed;
    }
  }
  async function start() {
    const authenticator = loadAuthenticator({ MD_AUTH_FILE: registryPath });
    service = new JobService({ dataDir, maxUploadBytes: 100_000, maxStorageBytes: 1_000_000, maxJobs: 20, retentionMs: 60_000, uploadTtlMs, conversionTimeoutMs: 1000, maxOutputBytes: 10_000, concurrency: 2, maxTenantConcurrency: 2, maxAgentConcurrency: 1,
      converter: async (input, output) => { await fs.writeFile(output, `# Converted\n${await fs.readFile(input, "utf8")}`); } });
    await service.init();
    const options = { authenticator, publicBaseUrl: "http://127.0.0.1", allowedHosts: ["127.0.0.1"] };
    server = createHttpServer(service, options);
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener address");
    base = `http://127.0.0.1:${address.port}`; options.publicBaseUrl = base;
  }
  async function client(token: string) {
    const value = new Client({ name: "lifecycle-agent", version: "1" }); clients.add(value);
    await value.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}`, Host: "127.0.0.1" } } }));
    return value;
  }
  async function request(route: string, token: string | undefined, init: RequestInit = {}) {
    const headers = new Headers(init.headers); headers.set("Host", "127.0.0.1");
    if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
    return fetch(`${base}${route}`, { ...init, headers, signal: AbortSignal.timeout(5000) });
  }
  async function upload(id: string, token: string | undefined, requiredHeaders: Record<string, string>, text: string) {
    return request(`/uploads/${id}`, token, { method: "PUT", headers: requiredHeaders, body: text });
  }
  cleanups.push(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); });
  await registry(); await start();
  return { client, request, upload, registry, stop, start, dataDir };
}

async function completed(client: Client, id: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const status = parsed(await client.callTool({ name: "get_conversion_status", arguments: { job_id: id } }));
    if (status.status === "completed") return;
    if (status.status === "failed") throw new Error("Fixture conversion failed");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Fixture conversion deadline exceeded");
}

test("credential revocation survives restart while rotated owner keeps the reservation", async () => {
  const fixture = await deployment();
  const before = await fixture.client(OLD_A);
  const upload = parsed(await before.callTool({ name: "create_upload", arguments: { filename: "rotate.txt", size_bytes: 7 } }));
  await fixture.stop(); await fixture.registry(true); await fixture.start();
  const forbidden = await fixture.request("/mcp", OLD_A, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  expect(forbidden.status).toBe(401);
  expect((await fixture.upload(upload.upload_id, OLD_A, upload.required_headers, "private")).status).toBe(401);
  const b = await fixture.client(TOKEN_B);
  expect(errorText(await b.callTool({ name: "get_conversion_status", arguments: { job_id: upload.upload_id } }))).toBe("Job not found");
  expect((await fixture.upload(upload.upload_id, TOKEN_B, upload.required_headers, "private")).status).toBe(404);
  const a = await fixture.client(NEW_A);
  expect(parsed(await a.callTool({ name: "get_conversion_status", arguments: { job_id: upload.upload_id } })).status).toBe("awaiting_upload");
  expect((await fixture.upload(upload.upload_id, NEW_A, upload.required_headers, "private")).status).toBe(204);
  parsed(await a.callTool({ name: "start_conversion", arguments: { upload_id: upload.upload_id } }));
  await completed(a, upload.upload_id);
  expect(parsed(await a.callTool({ name: "get_markdown", arguments: { job_id: upload.upload_id } })).markdown).toBe("# Converted\nprivate");
  expect(errorText(await b.callTool({ name: "delete_job", arguments: { job_id: upload.upload_id } }))).toBe("Job not found");
  parsed(await a.callTool({ name: "delete_job", arguments: { job_id: upload.upload_id } }));
});

test("foreign and unknown IDs remain indistinguishable after expiration", async () => {
  const fixture = await deployment(300);
  const a = await fixture.client(OLD_A), b = await fixture.client(TOKEN_B);
  const upload = parsed(await a.callTool({ name: "create_upload", arguments: { filename: "expires.txt", size_bytes: 1 } }));
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(upload.expires_at) - Date.now()) + 30));
  expect(errorText(await a.callTool({ name: "get_conversion_status", arguments: { job_id: upload.upload_id } }))).toBe("Job expired");
  const missing = randomUUID();
  for (const name of ["start_conversion", "get_conversion_status", "get_markdown", "delete_job"]) {
    for (const id of [upload.upload_id, missing]) {
      expect(errorText(await b.callTool({ name, arguments: name === "start_conversion" ? { upload_id: id } : { job_id: id } }))).toBe("Job not found");
    }
  }
  for (const id of [upload.upload_id, missing]) {
    const denied = await fixture.upload(id, TOKEN_B, upload.required_headers, "x");
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ error: "Job not found", error_info: { code: "JOB_NOT_FOUND" } });
  }
});

test("parallel agents preserve separate output and ownership across a restart", async () => {
  const fixture = await deployment();
  const a = await fixture.client(OLD_A), b = await fixture.client(TOKEN_B);
  const [first, second] = await Promise.all([a, b].map(async client => parsed(await client.callTool({ name: "create_upload", arguments: { filename: "same-name.txt", size_bytes: 9 } }))));
  expect(first.upload_id).not.toBe(second.upload_id);
  const outputs = await Promise.all([fixture.upload(first.upload_id, OLD_A, first.required_headers, "private-A"), fixture.upload(second.upload_id, TOKEN_B, second.required_headers, "private-B")]);
  expect(outputs.map(result => result.status)).toEqual([204, 204]);
  parsed(await a.callTool({ name: "start_conversion", arguments: { upload_id: first.upload_id } }));
  parsed(await b.callTool({ name: "start_conversion", arguments: { upload_id: second.upload_id } }));
  await Promise.all([completed(a, first.upload_id), completed(b, second.upload_id)]);
  await fixture.stop(); await fixture.start();
  const againA = await fixture.client(OLD_A), againB = await fixture.client(TOKEN_B);
  expect(parsed(await againA.callTool({ name: "get_markdown", arguments: { job_id: first.upload_id } })).markdown).toBe("# Converted\nprivate-A");
  expect(parsed(await againB.callTool({ name: "get_markdown", arguments: { job_id: second.upload_id } })).markdown).toBe("# Converted\nprivate-B");
  expect(errorText(await againA.callTool({ name: "get_markdown", arguments: { job_id: second.upload_id } }))).toBe("Job not found");
  expect(errorText(await againB.callTool({ name: "get_markdown", arguments: { job_id: first.upload_id } }))).toBe("Job not found");
  expect((await fixture.request("/mcp", "legacy-shared-key-" + "x".repeat(32), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);
  parsed(await againA.callTool({ name: "delete_job", arguments: { job_id: first.upload_id } }));
  expect(parsed(await againB.callTool({ name: "get_markdown", arguments: { job_id: second.upload_id } })).markdown).toContain("private-B");
  parsed(await againB.callTool({ name: "delete_job", arguments: { job_id: second.upload_id } }));
});
