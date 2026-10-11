import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { JobService } from "./jobs.js";
import { createHttpServer } from "./http.js";
import { createAuthenticator, hashToken } from "./auth.js";
import { toolErrorCode, toolJson, toolOk, waitFor } from "./test-helpers.js";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { while (disposers.length) await disposers.pop()!(); });

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-http-test-"));
  const service = new JobService({ dataDir, maxUploadBytes: 100000, maxStorageBytes: 1000000, maxJobs: 10, retentionMs: 60000, uploadTtlMs: 60000, conversionTimeoutMs: 1000, maxOutputBytes: 10000, concurrency: 1, converter: async (input, output) => { await fs.writeFile(output, `# Converted\n${await fs.readFile(input, "utf8")}`); } });
  await service.init();
  const options = { apiKey: "test-service-secret", authenticator: createAuthenticator({ credentials: [{ tenant_id: "tenant", agent_id: "a", token_sha256: hashToken("test-service-secret") }, { tenant_id: "tenant", agent_id: "b", token_sha256: hashToken("agent-b-secret") }, { tenant_id: "other", agent_id: "a", token_sha256: hashToken("other-tenant-secret") }] }), publicBaseUrl: "http://127.0.0.1", allowedHosts: ["127.0.0.1"] };
  const server = createHttpServer(service, options);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  const base = `http://127.0.0.1:${address.port}`;
  options.publicBaseUrl = base;
  disposers.push(async () => { await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(dataDir, { recursive: true, force: true }); });
  async function client(apiKey = options.apiKey) {
    const value = new Client({ name: "test-agent", version: "1" });
    await value.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${apiKey}`, Host: "127.0.0.1" } } }));
    disposers.push(() => value.close());
    return value;
  }
  async function request(route: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers); headers.set("Host", "127.0.0.1");
    return fetch(`${base}${route}`, { ...init, headers });
  }
  return { base, client, request, service, options, dataDir };
}
/** Asserts a raw HTTP rejection: the status, the stable `error_info.code` in the JSON body and, when given, the `Allow` header. */
async function expectRejected(response: Response, status: number, code: string, allow?: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(((await response.json()) as any).error_info.code).toBe(code);
  if (allow !== undefined) expect(response.headers.get("allow")).toBe(allow);
}

test("SDK error envelopes and static lookup guide recovery without disclosing foreign jobs", async () => {
  const { client, request, options } = await fixture(); const a = await client(), b = await client("agent-b-secret");
  const listed = await a.listTools(); expect(listed.tools.every(tool => tool.description && tool.description.length > 80)).toBe(true);
  const tooLarge = await a.callTool({ name: "create_upload", arguments: { filename: "x.pdf", size_bytes: 100001 } });
  expect(toolErrorCode(tooLarge)).toBe("FILE_TOO_LARGE");
  const failure = toolJson(tooLarge);
  expect(failure.error_info).toMatchObject({ code: "FILE_TOO_LARGE", retryable: false, details: { limit_bytes: 100000, requested_bytes: 100001 } });
  const guidance = toolOk(await a.callTool({ name: "lookup_error", arguments: { code: failure.error_info.code } }));
  expect(guidance.next_steps.join(" ")).toContain("split");
  expect(toolErrorCode(await a.callTool({ name: "lookup_error", arguments: { code: "__proto__" } }))).toBe("UNKNOWN_ERROR_CODE");
  const upload = toolOk(await a.callTool({ name: "create_upload", arguments: { filename: "x.txt", size_bytes: 1 } }));
  const foreign = await b.callTool({ name: "get_conversion_status", arguments: { job_id: upload.upload_id } });
  const missing = await b.callTool({ name: "get_conversion_status", arguments: { job_id: crypto.randomUUID() } });
  expect(foreign.content).toEqual(missing.content);
  const excess = await request(`/uploads/${upload.upload_id}`, { method: "PUT", headers: { ...upload.required_headers, Authorization: `Bearer ${options.apiKey}` }, body: "too long" });
  expect(excess.status).toBe(413); expect((await excess.json() as any).error_info.code).toBe("UPLOAD_SIZE_MISMATCH");
});

test("stateless SDK clients can upload, convert, poll and retrieve across reconnects", async () => {
  const { client, request, base, options } = await fixture();
  const first = await client();
  const tools = await first.listTools();
  expect(tools.tools.map(tool => tool.name).sort()).toEqual(["create_upload", "delete_job", "get_conversion_status", "get_markdown", "get_service_health", "lookup_error", "start_conversion"]);
  const upload = toolOk(await first.callTool({ name: "create_upload", arguments: { filename: "example.txt", size_bytes: 5 } }));
  expect(upload.upload_url).toBe(`${base}/uploads/${upload.upload_id}`);
  await first.close();
  expect((await request(`/uploads/${upload.upload_id}`, { method: "PUT", headers: { ...upload.required_headers, Authorization: `Bearer ${options.apiKey}` }, body: "hello" })).status).toBe(204);
  const second = await client();
  const job = toolOk(await second.callTool({ name: "start_conversion", arguments: { upload_id: upload.upload_id } }));
  await second.close();
  const third = await client();
  const status = await waitFor(async () => { const current = toolOk(await third.callTool({ name: "get_conversion_status", arguments: { job_id: job.job_id } })); return current.status === "completed" && current; }, { label: "conversion completed" });
  expect(status.status).toBe("completed");
  const page = toolOk(await third.callTool({ name: "get_markdown", arguments: { job_id: job.job_id, max_chars: 4 } }));
  expect(page.markdown).toBe("# Co");
  expect(page.next_offset).toBe(4);
  toolOk(await third.callTool({ name: "delete_job", arguments: { job_id: job.job_id } }));
  expect(toolErrorCode(await third.callTool({ name: "get_conversion_status", arguments: { job_id: job.job_id } }))).toBe("JOB_NOT_FOUND");
});

test("HTTP enforces authentication, host/origin checks and bounded JSON", async () => {
  const { request, options } = await fixture();
  expect((await request("/healthz")).status).toBe(200);
  await expectRejected(await request("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), 401, "AUTH_REQUIRED");
  await expectRejected(await request("/mcp", { method: "POST", headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" }, body: "{}" }), 401, "AUTH_REQUIRED");
  await expectRejected(await request("/mcp", { method: "POST", headers: { Origin: "https://attacker.invalid", "Content-Type": "application/json" }, body: "{}" }), 403, "REQUEST_REJECTED");
  expect((await request("/healthz", { headers: { Origin: "https://attacker.invalid" } })).status).toBe(200);
  const headers = { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" };
  await expectRejected(await request("/mcp", { headers }), 405, "REQUEST_REJECTED", "POST");
  await expectRejected(await request("/mcp?token=secret", { method: "POST", headers, body: "{}" }), 400, "REQUEST_REJECTED");
  await expectRejected(await request("/mcp", { method: "POST", headers, body: "bad" }), 400, "REQUEST_REJECTED");
  await expectRejected(await request("/mcp", { method: "POST", headers, body: " ".repeat(1024 * 1024 + 1) }), 413, "REQUEST_REJECTED");
});

test("upload token is scoped and tool validation returns isError", async () => {
  const { client, request, options } = await fixture();
  const agent = await client();
  const invalid = await agent.callTool({ name: "create_upload", arguments: { filename: "file.txt", size_bytes: -1, filepath: "/etc/passwd" } });
  expect(toolErrorCode(invalid)).toBe("INVALID_ARGUMENTS");
  expect(toolErrorCode(await agent.callTool({ name: "get_markdown", arguments: { job_id: "not-an-id" } }))).toBe("INVALID_ARGUMENTS");
  const a = toolOk(await agent.callTool({ name: "create_upload", arguments: { filename: "a.txt", size_bytes: 1 } }));
  const b = toolOk(await agent.callTool({ name: "create_upload", arguments: { filename: "b.txt", size_bytes: 1 } }));
  await expectRejected(await request(`/uploads/${a.upload_id}`, { method: "PUT", headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/octet-stream" }, body: "a" }), 404, "JOB_NOT_FOUND");
  await expectRejected(await request(`/uploads/${b.upload_id}`, { method: "PUT", headers: { ...a.required_headers, Authorization: `Bearer ${options.apiKey}` }, body: "b" }), 404, "JOB_NOT_FOUND");
  await expectRejected(await request(`/uploads/${a.upload_id}`, { method: "PUT", headers: { ...a.required_headers, Authorization: `Bearer ${options.apiKey}`, "Content-Type": "text/plain" }, body: "a" }), 415, "REQUEST_REJECTED");
  expect((await request(`/uploads/${a.upload_id}`, { method: "PUT", headers: { ...a.required_headers, Authorization: `Bearer ${options.apiKey}` }, body: "a" })).status).toBe(204);
  await expectRejected(await request(`/uploads/${a.upload_id}`, { method: "PUT", headers: { ...a.required_headers, Authorization: `Bearer ${options.apiKey}` }, body: "a" }), 409, "UPLOAD_ALREADY_COMPLETED");
});

test("oversized upload responds clearly and remains retriable", async () => {
  const { client, request, options } = await fixture();
  const agent = await client();
  const upload = toolOk(await agent.callTool({ name: "create_upload", arguments: { filename: "small.txt", size_bytes: 2 } }));
  const oversized = await request(`/uploads/${upload.upload_id}`, { method: "PUT", headers: { ...upload.required_headers, Authorization: `Bearer ${options.apiKey}` }, body: "too big" });
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toMatchObject({ error: expect.stringContaining("Upload exceeds declared size"), error_info: { code: "UPLOAD_SIZE_MISMATCH" } });
  const status = toolOk(await agent.callTool({ name: "get_conversion_status", arguments: { job_id: upload.upload_id } }));
  expect(status.status).toBe("awaiting_upload");
  expect((await request(`/uploads/${upload.upload_id}`, { method: "PUT", headers: { ...upload.required_headers, Authorization: `Bearer ${options.apiKey}` }, body: "ok" })).status).toBe(204);
});

test("disconnect during a binary upload preserves the reservation for a retry", async () => {
  const { client, request, base, options, dataDir } = await fixture();
  const agent = await client();
  const upload = toolOk(await agent.callTool({ name: "create_upload", arguments: { filename: "retry.txt", size_bytes: 5 } }));
  const partial = path.join(dataDir, upload.upload_id, "input.part");
  const interrupted = httpRequest(`${base}/uploads/${upload.upload_id}`, { method: "PUT", headers: { ...upload.required_headers, Authorization: `Bearer ${options.apiKey}`, Host: "127.0.0.1", "Content-Length": "5" } });
  const closed = new Promise<void>(resolve => { interrupted.on("error", () => resolve()); });
  interrupted.write("he");
  // Disconnect only once the server has actually received the partial body.
  await waitFor(async () => (await fs.stat(partial).catch(() => undefined))?.size === 2, { label: "server to receive the partial upload" });
  interrupted.destroy(new Error("Intentional test disconnect")); await closed;
  await waitFor(async () => !(await fs.stat(partial).catch(() => undefined)), { label: "abandoned partial upload cleanup" });
  const status = toolOk(await agent.callTool({ name: "get_conversion_status", arguments: { job_id: upload.upload_id } }));
  expect(status.status).toBe("awaiting_upload");
  // The server may still be releasing the aborted request's upload lock (409); the reservation itself must accept a retry.
  const retry = await waitFor(async () => { const response = await request(`/uploads/${upload.upload_id}`, { method: "PUT", headers: { ...upload.required_headers, Authorization: `Bearer ${options.apiKey}` }, body: "hello" }); return response.status !== 409 && response; }, { label: "upload lock release" });
  expect(retry.status).toBe(204);
});

test("each authenticated agent is isolated even within the same tenant", async () => {
  const { client, request, options } = await fixture();
  const owner = await client();
  const sibling = await client("agent-b-secret");
  const outsider = await client("other-tenant-secret");
  const upload = toolOk(await owner.callTool({ name: "create_upload", arguments: { filename: "private.txt", size_bytes: 3 } }));
  expect(upload.required_headers.Authorization).toBeUndefined();
  expect(JSON.stringify(upload)).not.toContain(options.apiKey);
  for (const foreign of [sibling, outsider]) {
    for (const [name, arguments_] of [["start_conversion", { upload_id: upload.upload_id }], ["get_conversion_status", { job_id: upload.upload_id }], ["get_markdown", { job_id: upload.upload_id }], ["delete_job", { job_id: upload.upload_id }]] as const) {
      const response = await foreign.callTool({ name, arguments: arguments_ });
      expect(toolErrorCode(response)).toBe("JOB_NOT_FOUND");
      expect(toolJson(response).error).toBe("Job not found");
    }
  }
  for (const credential of ["agent-b-secret", "other-tenant-secret"]) {
    const denied = await request(`/uploads/${upload.upload_id}`, { method: "PUT", headers: { ...upload.required_headers, Authorization: `Bearer ${credential}`, "X-Tenant-Id": "tenant", "X-Agent-Id": "a" }, body: "abc" });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ error: "Job not found", error_info: { code: "JOB_NOT_FOUND" } });
  }
  await expectRejected(await request(`/uploads/${upload.upload_id}`, { method: "PUT", headers: upload.required_headers, body: "abc" }), 401, "AUTH_REQUIRED");
  expect((await request(`/uploads/${upload.upload_id}`, { method: "PUT", headers: { ...upload.required_headers, Authorization: `Bearer ${options.apiKey}` }, body: "abc" })).status).toBe(204);
  toolOk(await owner.callTool({ name: "start_conversion", arguments: { upload_id: upload.upload_id } }));
  await waitFor(async () => toolOk(await owner.callTool({ name: "get_conversion_status", arguments: { job_id: upload.upload_id } })).status === "completed", { label: "conversion completed" });
  expect(toolOk(await owner.callTool({ name: "get_markdown", arguments: { job_id: upload.upload_id } })).markdown).toContain("abc");
  for (const foreign of [sibling, outsider]) {
    const result = await foreign.callTool({ name: "get_markdown", arguments: { job_id: upload.upload_id } });
    expect(toolErrorCode(result)).toBe("JOB_NOT_FOUND");
    expect(toolJson(result).error).toBe("Job not found");
  }
});

test("tool arguments cannot override authenticated identity", async () => {
  const { client } = await fixture();
  const agent = await client("agent-b-secret");
  for (const identity of [{ tenant_id: "tenant", agent_id: "a" }, { principal: { tenantId: "tenant", agentId: "a" } }]) {
    const response = await agent.callTool({ name: "create_upload", arguments: { filename: "file.txt", size_bytes: 1, ...identity } });
    expect(toolErrorCode(response)).toBe("INVALID_ARGUMENTS");
    expect(toolJson(response).error).toBe("Invalid tool arguments");
  }
});
