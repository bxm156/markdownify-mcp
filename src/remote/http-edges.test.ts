import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { JobService } from "./jobs.js";
import { createHttpServer } from "./http.js";
import { createAuthenticator, hashToken } from "./auth.js";

const SECRET = "edge-service-secret";
const MIB = 1024 * 1024;
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { while (disposers.length) await disposers.pop()!(); });

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-http-edges-"));
  const service = new JobService({ dataDir, maxUploadBytes: 100000, maxStorageBytes: 1000000, maxJobs: 10, retentionMs: 60000, uploadTtlMs: 60000, conversionTimeoutMs: 1000, maxOutputBytes: 10000, concurrency: 1, converter: async (input, output) => { await fs.writeFile(output, await fs.readFile(input)); } });
  await service.init();
  const options = { authenticator: createAuthenticator({ credentials: [{ tenant_id: "tenant", agent_id: "a", token_sha256: hashToken(SECRET) }] }), publicBaseUrl: "http://127.0.0.1", allowedHosts: ["127.0.0.1", "Allowed.Example"] };
  const server = createHttpServer(service, options);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  const port = address.port;
  disposers.push(async () => { await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(dataDir, { recursive: true, force: true }); });
  async function upload() {
    const client = new Client({ name: "edge-agent", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${SECRET}`, Host: "127.0.0.1" } } }));
    try {
      const result = await client.callTool({ name: "create_upload", arguments: { filename: "edge.txt", size_bytes: 5 } });
      return JSON.parse((result.content as any)[0].text) as { upload_id: string; required_headers: Record<string, string> };
    } finally { await client.close(); }
  }
  return { port, upload };
}

interface RawResponse { status: number; statusLine: string; headers: Record<string, string>; body: string; json: any }
/**
 * Writes raw bytes to the server and resolves as soon as one complete HTTP response
 * (status line, headers and Content-Length body) has arrived, then drops the socket.
 * Using node:net keeps full control of Host, HTTP version, request target and chunking.
 */
function raw(port: number, parts: Array<string | Buffer>): Promise<RawResponse> {
  const headOnly = typeof parts[0] === "string" && parts[0].startsWith("HEAD ");
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let buffer = Buffer.alloc(0), done = false;
    const finish = (error?: Error, value?: RawResponse) => { if (done) return; done = true; socket.destroy(); error ? reject(error) : resolve(value!); };
    // Returns the parsed response once it is complete. A close-delimited body (HTTP/1.0 style) is complete only when `closed`.
    const attempt = (closed: boolean) => {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const [statusLine, ...lines] = buffer.subarray(0, end).toString("latin1").split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of lines) { const index = line.indexOf(":"); headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim(); }
      let body: string;
      if (headOnly || /^HTTP\/1\.. (1\d\d|204|304) /.test(statusLine)) body = "";
      else if (headers["transfer-encoding"]?.toLowerCase() === "chunked") {
        const decoded: Buffer[] = []; let offset = end + 4;
        for (;;) {
          const lineEnd = buffer.indexOf("\r\n", offset);
          if (lineEnd < 0) return;
          const size = parseInt(buffer.subarray(offset, lineEnd).toString("latin1"), 16);
          if (size === 0) break;
          if (buffer.length < lineEnd + 2 + size + 2) return;
          decoded.push(buffer.subarray(lineEnd + 2, lineEnd + 2 + size)); offset = lineEnd + 2 + size + 2;
        }
        body = Buffer.concat(decoded).toString("utf8");
      } else if (headers["content-length"] !== undefined) {
        const length = Number(headers["content-length"]);
        if (buffer.length < end + 4 + length) return;
        body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
      } else {
        if (!closed) return;
        body = buffer.subarray(end + 4).toString("utf8");
      }
      let json: any; try { json = JSON.parse(body); } catch { json = undefined; }
      finish(undefined, { status: Number(statusLine.split(" ")[1]), statusLine, headers, body, json });
    };
    socket.on("data", data => { buffer = Buffer.concat([buffer, data]); attempt(false); });
    // The server may reset the connection after replying early (e.g. 413 with an unread body); only fail if no response arrived.
    socket.on("error", error => { if (!done && !buffer.length) finish(error); });
    socket.on("close", () => { attempt(true); if (!done) finish(new Error(`Connection closed before a full response: ${buffer.toString("latin1")}`)); });
    socket.on("connect", async () => {
      for (const part of parts) {
        if (done) return;
        if (!socket.write(part)) await new Promise<void>(next => socket.once("drain", () => next()).once("close", () => next()));
      }
    });
  });
}
const AUTH = `Authorization: Bearer ${SECRET}`;
const head = (lines: string[]) => lines.join("\r\n") + "\r\n\r\n";

const PING = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
const ACCEPT = "Accept: application/json, text/event-stream";
const JSON_TYPE = "Content-Type: application/json";
const OCTET = "Content-Type: application/octet-stream";
/** Builds a complete request with a Content-Length body; `headers` are raw "Name: value" lines. */
function message(requestLine: string, headers: string[], body = ""): string {
  const length = body ? [`Content-Length: ${Buffer.byteLength(body)}`] : [];
  return head([requestLine, ...headers, ...length]) + body;
}
const mcpPost = (headers: string[], body = PING, target = "/mcp") => message(`POST ${target} HTTP/1.1`, headers, body);
const code = (response: RawResponse) => response.json?.error_info?.code;
const uploadHeaders = (required: Record<string, string>) => Object.entries(required).filter(([name]) => name.toLowerCase() !== "authorization").map(([name, value]) => `${name}: ${value}`);

test("wrong, missing or malformed Host is rejected on /mcp and /uploads even with valid credentials", async () => {
  const { port, upload } = await fixture();
  const { upload_id, required_headers } = await upload();
  const hosts = ["evil.example", "127.0.0.1:1", "127.0.0.1.evil.example", "127.0.0.1@evil.example", "localhost", ""];
  for (const host of hosts) {
    const mcp = await raw(port, [mcpPost([`Host: ${host}`, AUTH, JSON_TYPE, ACCEPT])]);
    expect([host, mcp.status, code(mcp), mcp.json?.error]).toEqual([host, 403, "REQUEST_REJECTED", "Host not allowed"]);
    const put = await raw(port, [message(`PUT /uploads/${upload_id} HTTP/1.1`, [`Host: ${host}`, AUTH, ...uploadHeaders(required_headers), OCTET], "hello")]);
    expect([host, put.status, code(put)]).toEqual([host, 403, "REQUEST_REJECTED"]);
  }
});

test("HTTP/1.0 request without a Host header is rejected on /mcp and /uploads/<uuid>", async () => {
  const { port, upload } = await fixture();
  const { upload_id, required_headers } = await upload();
  const mcp = await raw(port, [message("POST /mcp HTTP/1.0", [AUTH, JSON_TYPE, ACCEPT], PING)]);
  expect([mcp.status, code(mcp), mcp.json?.error]).toEqual([403, "REQUEST_REJECTED", "Host not allowed"]);
  const put = await raw(port, [message(`PUT /uploads/${upload_id} HTTP/1.0`, [AUTH, ...uploadHeaders(required_headers), OCTET], "hello")]);
  expect([put.status, code(put)]).toEqual([403, "REQUEST_REJECTED"]);
});

test("the Host check runs before authentication, routing and method checks", async () => {
  const { port, upload } = await fixture();
  const { upload_id } = await upload();
  const bad = "Host: evil.example";
  // No credentials: 403 (not 401), so an unlisted host learns nothing about auth.
  const anonymous = await raw(port, [mcpPost([bad, JSON_TYPE])]);
  expect([anonymous.status, code(anonymous), anonymous.headers["www-authenticate"]]).toEqual([403, "REQUEST_REJECTED", undefined]);
  // Unknown route, wrong method, wrong content type: all 403 first.
  for (const request of [message("GET /nope HTTP/1.1", [bad]), message("GET /mcp HTTP/1.1", [bad, AUTH]), message(`GET /uploads/${upload_id} HTTP/1.1`, [bad, AUTH]), mcpPost([bad, AUTH, "Content-Type: text/plain"])]) {
    const line = request.split("\r\n")[0];
    const response = await raw(port, [request]);
    expect([line, response.status, code(response), response.headers.allow]).toEqual([line, 403, "REQUEST_REJECTED", undefined]);
  }
});

test("the Host allowlist is case-insensitive and matches the whole header value", async () => {
  const { port } = await fixture();
  const ok = await raw(port, [mcpPost(["Host: ALLOWED.example", AUTH, JSON_TYPE, ACCEPT])]);
  expect(ok.status).toBe(200);
  const withPort = await raw(port, [mcpPost(["Host: allowed.example:80", AUTH, JSON_TYPE, ACCEPT])]);
  expect([withPort.status, code(withPort)]).toEqual([403, "REQUEST_REJECTED"]);
});

test("probe routes skip the Host check but only allow GET and HEAD", async () => {
  const { port } = await fixture();
  for (const route of ["/livez", "/healthz", "/readyz"]) {
    for (const host of ["Host: evil.example", "Host: 10.1.2.3:8080"]) {
      const get = await raw(port, [message(`GET ${route} HTTP/1.1`, [host])]);
      expect([route, host, get.status]).toEqual([route, host, 200]);
    }
    const missing = await raw(port, [message(`GET ${route} HTTP/1.0`, [])]);
    expect([route, missing.status]).toEqual([route, 200]);
    const headOnly = await raw(port, [message(`HEAD ${route} HTTP/1.1`, ["Host: evil.example"])]);
    expect([route, headOnly.status, headOnly.body]).toEqual([route, 200, ""]);
    for (const method of ["POST", "PUT", "DELETE"]) {
      const denied = await raw(port, [message(`${method} ${route} HTTP/1.1`, ["Host: evil.example", "Content-Length: 0"])]);
      expect([route, method, denied.status, denied.headers.allow, code(denied)]).toEqual([route, method, 405, "GET, HEAD", "REQUEST_REJECTED"]);
    }
  }
  // Only the exact probe paths are exempt: a look-alike path still hits the Host check.
  for (const route of ["/healthz/", "/readyz/x", "/HEALTHZ"]) {
    const response = await raw(port, [message(`GET ${route} HTTP/1.1`, ["Host: evil.example"])]);
    expect([route, response.status, code(response)]).toEqual([route, 403, "REQUEST_REJECTED"]);
  }
});

test("a request target with a foreign authority never changes which Host is enforced", async () => {
  const { port } = await fixture();
  const good = "Host: 127.0.0.1", bad = "Host: evil.example";
  // The authority in the target is ignored: only the path (/mcp) is used, and the Host header is what is checked.
  for (const target of ["//evil.example/mcp", "http://evil.example/mcp"]) {
    const denied = await raw(port, [mcpPost([bad, AUTH, JSON_TYPE, ACCEPT], PING, target)]);
    expect([target, denied.status, code(denied)]).toEqual([target, 403, "REQUEST_REJECTED"]);
    const spoofed = target.replace("evil.example", "127.0.0.1");
    const tricked = await raw(port, [mcpPost([bad, AUTH, JSON_TYPE, ACCEPT], PING, spoofed)]);
    expect([spoofed, tricked.status, code(tricked)]).toEqual([spoofed, 403, "REQUEST_REJECTED"]);
    // Pinned current behaviour (see report): with an allowed Host header the foreign authority is silently dropped and the request is served as /mcp.
    const served = await raw(port, [mcpPost([good, AUTH, JSON_TYPE, ACCEPT], PING, target)]);
    expect([target, served.status]).toEqual([target, 200]);
  }
  // Unauthenticated, the same target still gets the normal 401 challenge.
  const anonymous = await raw(port, [mcpPost([good, JSON_TYPE], PING, "//evil.example/mcp")]);
  expect([anonymous.status, anonymous.headers["www-authenticate"], code(anonymous)]).toEqual([401, "Bearer", "AUTH_REQUIRED"]);
});

test("a body streamed with chunked encoding is bounded at 1 MiB without a Content-Length", async () => {
  const { port } = await fixture();
  const chunk = (data: string) => `${Buffer.byteLength(data).toString(16)}\r\n${data}\r\n`;
  const start = head(["POST /mcp HTTP/1.1", "Host: 127.0.0.1", AUTH, JSON_TYPE, ACCEPT, "Transfer-Encoding: chunked"]);
  const padded = (total: number) => PING + " ".repeat(total - PING.length);
  // Exactly 1 MiB, split over several chunks, is accepted: the limit is strictly greater-than.
  const exact = padded(MIB);
  const accepted = await raw(port, [start, chunk(exact.slice(0, 400_000)), chunk(exact.slice(400_000)), "0\r\n\r\n"]);
  expect([accepted.status, accepted.json?.result]).toEqual([200, {}]);
  // One byte over is refused although no Content-Length header ever announced the size.
  const over = padded(MIB + 1);
  const rejected = await raw(port, [start, chunk(over.slice(0, 400_000)), chunk(over.slice(400_000, 800_000)), chunk(over.slice(800_000)), "0\r\n\r\n"]);
  expect([rejected.status, code(rejected), rejected.json?.error]).toEqual([413, "REQUEST_REJECTED", "Request body too large"]);
  // A single oversized chunk hits the same streaming limit.
  const single = await raw(port, [start, chunk(" ".repeat(MIB + 1)), "0\r\n\r\n"]);
  expect([single.status, code(single)]).toEqual([413, "REQUEST_REJECTED"]);
});

test("an oversized Content-Length is refused from the header alone, before any body is sent", async () => {
  const { port } = await fixture();
  const response = await raw(port, [head(["POST /mcp HTTP/1.1", "Host: 127.0.0.1", AUTH, JSON_TYPE, ACCEPT, `Content-Length: ${MIB + 1}`])]);
  expect([response.status, code(response), response.json?.error]).toEqual([413, "REQUEST_REJECTED", "Request body too large"]);
});

test("a malformed Content-Length is rejected by the HTTP parser before reaching a handler", async () => {
  const { port } = await fixture();
  for (const value of ["abc", "-1", "1.5", "2, 3"]) {
    const response = await raw(port, [head(["POST /mcp HTTP/1.1", "Host: 127.0.0.1", AUTH, JSON_TYPE, ACCEPT, `Content-Length: ${value}`]) + "{}"]);
    expect([value, response.status]).toEqual([value, 400]);
    expect(response.headers.connection?.toLowerCase()).toBe("close");
  }
});

test("POST /mcp requires an application/json media type and tolerates parameters and case", async () => {
  const { port } = await fixture();
  const base = ["Host: 127.0.0.1", AUTH, ACCEPT];
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/jsonx", "text/json", "application/octet-stream"]) {
    const response = await raw(port, [mcpPost([...base, `Content-Type: ${type}`])]);
    expect([type, response.status, code(response), response.json?.error]).toEqual([type, 415, "REQUEST_REJECTED", "Use application/json"]);
  }
  // http.ts lower-cases the media type itself, but the MCP SDK transport it delegates to matches "application/json" case-sensitively.
  const upper = await raw(port, [mcpPost([...base, "Content-Type: Application/JSON"])]);
  expect([upper.status, code(upper)]).toEqual([415, undefined]);
  const missing = await raw(port, [mcpPost(base)]);
  expect([missing.status, code(missing)]).toEqual([415, "REQUEST_REJECTED"]);
  for (const type of ["application/json", "application/json; charset=utf-8", "application/json;charset=UTF-8", "application/json ; charset=utf-8"]) {
    const response = await raw(port, [mcpPost([...base, `Content-Type: ${type}`])]);
    expect([type, response.status, response.json?.result]).toEqual([type, 200, {}]);
  }
});

test("405 responses name the allowed method on /mcp and /uploads/<id>", async () => {
  const { port, upload } = await fixture();
  const { upload_id } = await upload();
  const auth = ["Host: 127.0.0.1", AUTH];
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const response = await raw(port, [message(`${method} /mcp HTTP/1.1`, [...auth, "Content-Length: 0"])]);
    expect([method, response.status, response.headers.allow, code(response)]).toEqual([method, 405, "POST", "REQUEST_REJECTED"]);
  }
  for (const method of ["GET", "POST", "DELETE", "HEAD"]) {
    const response = await raw(port, [message(`${method} /uploads/${upload_id} HTTP/1.1`, [...auth, "Content-Length: 0"])]);
    expect([method, response.status, response.headers.allow]).toEqual([method, 405, "PUT"]);
    if (method !== "HEAD") expect(code(response)).toBe("REQUEST_REJECTED");
  }
});

test("every 401 carries WWW-Authenticate: Bearer and the AUTH_REQUIRED code", async () => {
  const { port, upload } = await fixture();
  const { upload_id, required_headers } = await upload();
  const host = "Host: 127.0.0.1";
  const scoped = uploadHeaders(required_headers);
  const requests: Record<string, string> = {
    "mcp without credentials": mcpPost([host, JSON_TYPE, ACCEPT]),
    "mcp with wrong token": mcpPost([host, "Authorization: Bearer wrong", JSON_TYPE, ACCEPT]),
    "mcp with empty token": mcpPost([host, "Authorization: Bearer ", JSON_TYPE, ACCEPT]),
    "mcp with Basic scheme": mcpPost([host, `Authorization: Basic ${SECRET}`, JSON_TYPE, ACCEPT]),
    "mcp with lowercase bearer scheme": mcpPost([host, `Authorization: bearer ${SECRET}`, JSON_TYPE, ACCEPT]),
    "mcp with token only": mcpPost([host, `Authorization: ${SECRET}`, JSON_TYPE, ACCEPT]),
    "mcp with oversized token": mcpPost([host, `Authorization: Bearer ${"x".repeat(5000)}`, JSON_TYPE, ACCEPT]),
    "upload without credentials": message(`PUT /uploads/${upload_id} HTTP/1.1`, [host, ...scoped, OCTET], "hello"),
    "upload with wrong token": message(`PUT /uploads/${upload_id} HTTP/1.1`, [host, ...scoped, "Authorization: Bearer wrong", OCTET], "hello"),
    "GET upload without credentials": message(`GET /uploads/${upload_id} HTTP/1.1`, [host]),
    "GET mcp without credentials": message("GET /mcp HTTP/1.1", [host]),
  };
  for (const [name, request] of Object.entries(requests)) {
    const response = await raw(port, [request]);
    // Authentication precedes method checks, so a 401 must not also leak an Allow header.
    expect([name, response.status, response.headers["www-authenticate"], code(response), response.headers.allow]).toEqual([name, 401, "Bearer", "AUTH_REQUIRED", undefined]);
  }
});

test("non-401 responses never advertise WWW-Authenticate", async () => {
  const { port } = await fixture();
  const forbidden = await raw(port, [mcpPost(["Host: evil.example", AUTH, JSON_TYPE])]);
  const wrongType = await raw(port, [mcpPost(["Host: 127.0.0.1", AUTH, "Content-Type: text/plain"])]);
  const ok = await raw(port, [mcpPost(["Host: 127.0.0.1", AUTH, JSON_TYPE, ACCEPT])]);
  for (const response of [forbidden, wrongType, ok]) expect(response.headers["www-authenticate"]).toBeUndefined();
});

test("routing is exact: trailing slash, wrong case and unknown paths are 404, uppercase upload UUIDs reach the store and miss", async () => {
  const { port, upload } = await fixture();
  const { upload_id, required_headers } = await upload();
  const host = "Host: 127.0.0.1";
  for (const target of ["/mcp/", "/MCP", "/mcp//", "/uploads", "/uploads/", `/uploads/${upload_id}/`, "/uploads/not-a-uuid", `/uploads/${upload_id}x`, "/"]) {
    const response = await raw(port, [mcpPost([host, AUTH, JSON_TYPE, ACCEPT], PING, target)]);
    expect([target, response.status, code(response), response.json?.error]).toEqual([target, 404, "REQUEST_REJECTED", "Not found"]);
  }
  const headers = [host, AUTH, ...uploadHeaders(required_headers), OCTET];
  // The route regex is case-insensitive but the store keys are lowercase, so an uppercase id is just an unknown job.
  const upper = await raw(port, [message(`PUT /uploads/${upload_id.toUpperCase()} HTTP/1.1`, headers, "hello")]);
  expect([upper.status, code(upper)]).toEqual([404, "JOB_NOT_FOUND"]);
  // The reservation is untouched and the canonical lowercase id still works.
  const lower = await raw(port, [message(`PUT /uploads/${upload_id} HTTP/1.1`, headers, "hello")]);
  expect(lower.status).toBe(204);
});
