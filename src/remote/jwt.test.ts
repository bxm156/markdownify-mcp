import { afterEach, expect, test } from "bun:test";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createJwtAuthenticator, loadJwtAuthenticator, subjectPrincipal } from "./jwt.js";
import { loadAuthenticator, type Authenticator } from "./auth.js";
import { JobService } from "./jobs.js";
import { createHttpServer } from "./http.js";

const issuer = "https://litellm.test", audience = "markdownify";
const tools = ["create_upload", "start_conversion", "get_conversion_status", "get_markdown", "get_service_health", "delete_job", "lookup_error"];
const allScopes = ["mcp:tools/list", "mcp:tools/call", ...tools.map(t => `mcp:tools/${t}:call`)].join(" ");
const key = await generateKeyPair("RS256", { extractable: true });
const publicJwk = { ...await exportJWK(key.publicKey), kid: "first", alg: "RS256", use: "sig" };
const disposers: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (disposers.length) await disposers.pop()!(); });
const verifier = () => createJwtAuthenticator({ issuer, audience, getKey: createLocalJWKSet({ keys: [publicJwk] }) });
async function signed(subject = "machine-a", changes: Record<string, unknown> = {}, signingKey = key.privateKey, kid = "first") {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: issuer, aud: audience, sub: subject, iat: now, exp: now + 300, scope: allScopes, act: { sub: "untrusted-tenant-claim" }, ...changes }).setProtectedHeader({ alg: "RS256", kid }).sign(signingKey);
}
test("JWT verifies signature and bounded claims, owns jobs by verified subject and preserves refresh ownership", async () => {
  const auth = verifier(); const a = await auth.authenticate(await signed());
  expect(a).toMatchObject({ tenantId: "machine-a", agentId: "machine-a" });
  expect(await auth.authenticate(await signed())).toEqual(a);
  const now = Math.floor(Date.now() / 1000);
  for (const payload of [{ iss: "https://other.test" }, { aud: "other" }, { exp: now - 1 }, { exp: now + 3600 }, { iat: now + 100 }, { nbf: now + 100 }, { scope: "mcp:admin" }, { exp: undefined }, { iat: undefined }, { sub: undefined }]) expect(await auth.authenticate(await signed("machine-a", payload))).toBeNull();
  for (const subject of ["litellm-proxy", "user@example.com", "../escape", "x".repeat(65)]) expect(await auth.authenticate(await signed(subject))).toBeNull();
  for (const aud of [[audience], [audience, "another-service"]]) expect(await auth.authenticate(await signed("machine-a", { aud }))).toBeNull();
  const other = await generateKeyPair("RS256"); expect(await auth.authenticate(await signed("machine-a", {}, other.privateKey))).toBeNull();
  expect(await auth.authenticate(await new SignJWT({ sub: "machine-a" }).setProtectedHeader({ alg: "HS256", kid: "first" }).sign(new Uint8Array(32)))).toBeNull();
  const token = await signed(); expect(await auth.authenticate(token.slice(0, -10) + "tampered")).toBeNull();
  expect(await auth.authenticate("x".repeat(16385))).toBeNull();
});
test("JWT configuration fails closed on ambiguous modes, unsafe URLs and invalid subjects", () => {
  for (const sub of [undefined, 1, "", "litellm-proxy", "a/b", "x".repeat(65)]) expect(subjectPrincipal(sub)).toBeNull();
  expect(subjectPrincipal("agent_1-a")).toEqual({ tenantId: "agent_1-a", agentId: "agent_1-a" });
  expect(() => createJwtAuthenticator({ issuer: "http://remote.test", audience, jwksUrl: "https://trusted.test/jwks" })).toThrow();
  expect(() => createJwtAuthenticator({ issuer, audience, jwksUrl: "https://u:p@trusted.test/jwks" })).toThrow();
  expect(() => loadAuthenticator({ MD_JWT_ISSUER: issuer, MD_API_KEY: "x".repeat(32) })).toThrow("cannot be combined");
  expect(() => loadAuthenticator({ MD_JWT_ISSUER: issuer })).toThrow("JWT auth requires");
});

async function deployment(auth: Authenticator = verifier(), ttl = 60000) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-jwt-"));
  const options = { dataDir, maxUploadBytes: 1000, maxOutputBytes: 1000, maxStorageBytes: 100000, maxJobs: 20, retentionMs: 60000, uploadTtlMs: ttl, conversionTimeoutMs: 1000, concurrency: 1, converter: async (input: string, output: string) => { await fs.writeFile(output, await fs.readFile(input)); } };
  let service = new JobService(options); await service.init();
  const httpOptions = { authenticator: auth, publicBaseUrl: "http://127.0.0.1", allowedHosts: ["127.0.0.1"] };
  const server = createHttpServer(service, httpOptions); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port, base = `http://127.0.0.1:${port}`; httpOptions.publicBaseUrl = base;
  disposers.push(async () => { await service.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await fs.rm(dataDir, { recursive: true, force: true }); });
  async function client(subject = "machine-a", scope = allScopes) {
    const client = new Client({ name: "jwt-agent", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Host: "127.0.0.1", Authorization: `Bearer ${await signed(subject, { scope })}` } } }));
    disposers.push(() => client.close()); return client;
  }
  async function put(upload: any, bearer?: string) { return fetch(upload.upload_url, { method: "PUT", headers: { ...upload.required_headers, Host: "127.0.0.1", ...(bearer ? { Authorization: bearer } : {}) }, body: "x" }); }
  return { service, options, client, put, base };
}
function initialize(base: string, authorization: string) { return fetch(`${base}/mcp`, { method: "POST", headers: { Host: "127.0.0.1", Authorization: authorization, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "1" } } }) }); }
function parsed(result: any) { expect(result.isError).not.toBe(true); return JSON.parse(result.content[0].text); }
test("JWT agents use scoped upload grants, enforce tool scopes and keep files private across tenants", async () => {
  const f = await deployment(), a = await f.client(), b = await f.client("machine-b"), c = await f.client("machine-c");
  const upload = parsed(await a.callTool({ name: "create_upload", arguments: { filename: "x.txt", size_bytes: 1 } }));
  expect(upload.required_headers.Authorization).toMatch(/^Bearer /);
  const manifest = await fs.readFile(path.join(f.options.dataDir, upload.upload_id, "job.json"), "utf8");
  expect(manifest).not.toContain(upload.required_headers.Authorization.slice(7)); expect(manifest).not.toContain(upload.required_headers["X-Upload-Token"]);
  for (const peer of [b, c]) { const error = await peer.callTool({ name: "get_conversion_status", arguments: { job_id: upload.upload_id } }); expect(error.isError).toBe(true); expect(JSON.parse((error.content as any)[0].text).error_info.code).toBe("JOB_NOT_FOUND"); }
  const other = parsed(await b.callTool({ name: "create_upload", arguments: { filename: "x.txt", size_bytes: 1 } }));
  expect((await f.put(upload, other.required_headers.Authorization)).status).toBe(401);
  expect((await f.put(upload, `Bearer ${await signed("machine-b")}`)).status).toBe(401);
  const grantResponse = await initialize(f.base, upload.required_headers.Authorization);
  expect(grantResponse.status).toBe(401); expect(grantResponse.headers.get("www-authenticate")).toBe("Bearer");
  const grantClient = new Client({ name: "bad-grant", version: "1" });
  await expect(grantClient.connect(new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), { requestInit: { headers: { Host: "127.0.0.1", Authorization: upload.required_headers.Authorization } } }))).rejects.toThrow(); await grantClient.close();
  expect((await f.put(upload)).status).toBe(204); expect((await f.put(upload)).status).toBe(401);
  parsed(await a.callTool({ name: "start_conversion", arguments: { upload_id: upload.upload_id } }));
  for (let i = 0; i < 100; i++) { const s = parsed(await a.callTool({ name: "get_conversion_status", arguments: { job_id: upload.upload_id } })); if (s.status === "completed") break; await new Promise(r => setTimeout(r, 10)); }
  expect(parsed(await a.callTool({ name: "get_markdown", arguments: { job_id: upload.upload_id } })).markdown).toBe("x");
  const refreshed = await f.client(); expect(parsed(await refreshed.callTool({ name: "get_markdown", arguments: { job_id: upload.upload_id } })).markdown).toBe("x");
  const limited = await f.client("machine-a", "mcp:tools/list mcp:tools/call mcp:tools/lookup_error:call");
  parsed(await limited.callTool({ name: "lookup_error", arguments: { code: "FILE_TOO_LARGE" } }));
  const healthDenied = await limited.callTool({ name: "get_service_health", arguments: {} });
  expect(healthDenied.isError).toBe(true);
  expect(parsed(await a.callTool({ name: "get_service_health", arguments: {} })).own_jobs.completed).toBe(1);
  const denied = await limited.callTool({ name: "delete_job", arguments: { job_id: upload.upload_id } }); expect(denied.isError).toBe(true); expect(JSON.parse((denied.content as any)[0].text).error_info.code).toBe("AUTH_SCOPE_REQUIRED");
  const listDenied = await f.client("machine-a", "mcp:tools/call mcp:tools/lookup_error:call");
  await expect(listDenied.listTools()).rejects.toThrow("Scope not granted");
});
test("upload grants survive restart but expire", async () => {
  const f = await deployment(verifier(), 200), actor = { tenantId: "machine-a", agentId: "machine-a" };
  const upload = await f.service.createUpload(actor, { filename: "x.txt", size_bytes: 1 }, true); await f.service.close();
  const restarted = new JobService(f.options); await restarted.init(); disposers.push(() => restarted.close());
  expect(await restarted.authenticateUpload(upload.upload_id, upload.upload_auth_token)).toEqual(actor);
  await new Promise(r => setTimeout(r, 220)); expect(await restarted.authenticateUpload(upload.upload_id, upload.upload_auth_token)).toBeNull();
});
test("remote JWKS verification uses the pinned endpoint, caches and accepts rotated keys on refresh", async () => {
  const rotated = await generateKeyPair("RS256", { extractable: true }); let keys = [publicJwk]; let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ keys })); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); disposers.push(() => new Promise<void>(r => server.close(() => r())));
  const port = (server.address() as { port: number }).port;
  const auth = createJwtAuthenticator({ issuer, audience, jwksUrl: `http://127.0.0.1:${port}/jwks`, allowLoopback: true });
  expect(await auth.authenticate(await signed())).not.toBeNull(); expect(await auth.authenticate(await signed())).not.toBeNull(); expect(requests).toBe(1);
  keys = [{ ...await exportJWK(rotated.publicKey), kid: "rotated", alg: "RS256", use: "sig" }];
  const token = await signed("machine-a", {}, rotated.privateKey, "rotated");
  await new Promise(r => setTimeout(r, 5100)); expect(await auth.authenticate(token)).not.toBeNull(); expect(requests).toBe(2);
}, 15000);

test("JWKS redirects and oversized bodies fail closed without following token-controlled key URLs", async () => {
  let mode = "redirect"; const paths: string[] = [];
  const server = createServer((req, res) => { paths.push(req.url!); if (mode === "redirect") { res.writeHead(302, { Location: "/unexpected-key" }); res.end(); } else { res.writeHead(200); res.end("x".repeat(300000)); } });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); disposers.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const port = (server.address() as { port: number }).port;
  const options = { issuer, audience, jwksUrl: `http://127.0.0.1:${port}/jwks`, allowLoopback: true };
  expect(await createJwtAuthenticator(options).authenticate(await signed())).toBeNull(); expect(paths).toEqual(["/jwks"]);
  mode = "large"; expect(await createJwtAuthenticator(options).authenticate(await signed())).toBeNull(); expect(paths).toEqual(["/jwks", "/jwks"]);
});
test("JWT upload grants are capped at five minutes even when legacy upload TTL is larger", async () => {
  const f = await deployment(verifier(), 3600000);
  const now = Date.now(); const grant = await f.service.createUpload({ tenantId: "machine-a", agentId: "machine-a" }, { filename: "x.txt", size_bytes: 1 }, true);
  expect(Date.parse(grant.expires_at) - now).toBeLessThanOrEqual(300050);
  expect(Date.parse(grant.expires_at) - now).toBeGreaterThan(299000);
});

test("verified JWT without sub is rejected at connect and on every MCP method", async () => {
  const f = await deployment(), bearer = `Bearer ${await signed("machine-a", { sub: undefined })}`;
  const client = new Client({ name: "identity-free-probe", version: "1" });
  await expect(client.connect(new StreamableHTTPClientTransport(new URL(f.base + "/mcp"), { requestInit: { headers: { Host: "127.0.0.1", Authorization: bearer } } }))).rejects.toThrow(); await client.close();
  for (const method of ["initialize", "ping", "tools/list", "tools/call"]) {
    const response = await fetch(f.base + "/mcp", { method: "POST", headers: { Host: "127.0.0.1", Authorization: bearer, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { name: "get_service_health", arguments: {} } }) });
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
