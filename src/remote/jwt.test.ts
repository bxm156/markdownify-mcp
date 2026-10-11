import { afterEach, expect, setSystemTime, test } from "bun:test";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createJwtAuthenticator, loadJwtAuthenticator, subjectPrincipal } from "./jwt.js";
import { loadAuthenticator, type Authenticator } from "./auth.js";
import { JobService } from "./jobs.js";
import { closedPort, createJwtFixture, mcpInitialize, toolErrorCode as errorCode, toolOk as parsed, waitFor } from "./test-helpers.js";

const tools = ["create_upload", "start_conversion", "get_conversion_status", "get_markdown", "get_service_health", "delete_job", "lookup_error"];
const allScopes = ["mcp:tools/list", "mcp:tools/call", ...tools.map(t => `mcp:tools/${t}:call`)].join(" ");
const fx = await createJwtFixture({ scope: allScopes, claims: { act: { sub: "untrusted-tenant-claim" } } });
const { issuer, audience, verifier } = fx;
afterEach(async () => { setSystemTime(); await fx.close(); });
const signed = (subject = "machine-a", changes: Record<string, unknown> = {}, signingKey = fx.key.privateKey, kid = "first") => fx.sign({ sub: subject, ...changes }, { alg: "RS256", kid }, signingKey);
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
  expect(() => createJwtAuthenticator({ issuer: "http://remote.test", audience, jwksUrl: "https://trusted.test/jwks" })).toThrow("JWT issuer/JWKS URLs require HTTPS");
  expect(() => createJwtAuthenticator({ issuer, audience, jwksUrl: "https://u:p@trusted.test/jwks" })).toThrow("JWT issuer/JWKS URLs require HTTPS");
  expect(() => loadAuthenticator({ MD_JWT_ISSUER: issuer, MD_API_KEY: "x".repeat(32) })).toThrow("cannot be combined");
  expect(() => loadAuthenticator({ MD_JWT_ISSUER: issuer })).toThrow("JWT auth requires");
});

const deployment = (auth: Authenticator = verifier(), ttl = 60000) => fx.deployment(auth, { jobs: { maxStorageBytes: 100000, maxJobs: 20, retentionMs: 60000, uploadTtlMs: ttl } });
const initialize = mcpInitialize;
test("JWT agents use scoped upload grants, enforce tool scopes and keep files private across tenants", async () => {
  const f = await deployment(), a = await f.client(), b = await f.client("machine-b"), c = await f.client("machine-c");
  const upload = parsed(await a.callTool({ name: "create_upload", arguments: { filename: "x.txt", size_bytes: 1 } }));
  expect(upload.required_headers.Authorization).toMatch(/^Bearer /);
  const manifest = await fs.readFile(path.join(f.options.dataDir, upload.upload_id, "job.json"), "utf8");
  expect(manifest).not.toContain(upload.required_headers.Authorization.slice(7)); expect(manifest).not.toContain(upload.required_headers["X-Upload-Token"]);
  for (const peer of [b, c]) { expect(errorCode(await peer.callTool({ name: "get_conversion_status", arguments: { job_id: upload.upload_id } }))).toBe("JOB_NOT_FOUND"); }
  const other = parsed(await b.callTool({ name: "create_upload", arguments: { filename: "x.txt", size_bytes: 1 } }));
  expect((await f.put(upload, other.required_headers.Authorization)).status).toBe(401);
  expect((await f.put(upload, `Bearer ${await signed("machine-b")}`)).status).toBe(401);
  const grantResponse = await initialize(f.base, upload.required_headers.Authorization);
  expect(grantResponse.status).toBe(401); expect(grantResponse.headers.get("www-authenticate")).toBe("Bearer");
  const grantClient = new Client({ name: "bad-grant", version: "1" });
  await expect(grantClient.connect(new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), { requestInit: { headers: { Host: "127.0.0.1", Authorization: upload.required_headers.Authorization } } }))).rejects.toMatchObject({ code: 401 }); await grantClient.close();
  expect((await f.put(upload)).status).toBe(204); expect((await f.put(upload)).status).toBe(401);
  parsed(await a.callTool({ name: "start_conversion", arguments: { upload_id: upload.upload_id } }));
  await waitFor(async () => parsed(await a.callTool({ name: "get_conversion_status", arguments: { job_id: upload.upload_id } })).status === "completed", { label: "conversion completed" });
  expect(parsed(await a.callTool({ name: "get_markdown", arguments: { job_id: upload.upload_id } })).markdown).toBe("x");
  const refreshed = await f.client(); expect(parsed(await refreshed.callTool({ name: "get_markdown", arguments: { job_id: upload.upload_id } })).markdown).toBe("x");
  const limited = await f.client("machine-a", "mcp:tools/list mcp:tools/call mcp:tools/lookup_error:call");
  parsed(await limited.callTool({ name: "lookup_error", arguments: { code: "FILE_TOO_LARGE" } }));
  const healthDenied = await limited.callTool({ name: "get_service_health", arguments: {} });
  expect(errorCode(healthDenied)).toBe("AUTH_SCOPE_REQUIRED");
  expect(parsed(await a.callTool({ name: "get_service_health", arguments: {} })).own_jobs.completed).toBe(1);
  const denied = await limited.callTool({ name: "delete_job", arguments: { job_id: upload.upload_id } }); expect(errorCode(denied)).toBe("AUTH_SCOPE_REQUIRED");
  const listDenied = await f.client("machine-a", "mcp:tools/call mcp:tools/lookup_error:call");
  await expect(listDenied.listTools()).rejects.toThrow("Scope not granted");
});
test("upload grants survive restart but expire", async () => {
  const f = await deployment(verifier(), 200), actor = { tenantId: "machine-a", agentId: "machine-a" };
  const upload = await f.service.createUpload(actor, { filename: "x.txt", size_bytes: 1 }, true); await f.service.close();
  const restarted = new JobService(f.options); await restarted.init(); fx.defer(() => restarted.close());
  expect(await restarted.authenticateUpload(upload.upload_id, upload.upload_auth_token)).toEqual(actor);
  setSystemTime(new Date(Date.now() + 1000)); expect(await restarted.authenticateUpload(upload.upload_id, upload.upload_auth_token)).toBeNull();
});
test("remote JWKS verification uses the pinned endpoint, caches and accepts rotated keys on refresh", async () => {
  const rotated = await generateKeyPair("RS256", { extractable: true }), jwks = await fx.serveJwks();
  const auth = fx.remoteVerifier(jwks.url);
  expect(await auth.authenticate(await signed())).not.toBeNull(); expect(await auth.authenticate(await signed())).not.toBeNull(); expect(jwks.requests()).toBe(1);
  jwks.setKeys([{ ...await exportJWK(rotated.publicKey), kid: "rotated", alg: "RS256", use: "sig" }]);
  const token = await signed("machine-a", {}, rotated.privateKey, "rotated");
  setSystemTime(new Date(Date.now() + 5100)); expect(await auth.authenticate(token)).not.toBeNull(); expect(jwks.requests()).toBe(2);
});

test("JWKS redirects and oversized bodies fail closed without following token-controlled key URLs", async () => {
  let mode = "redirect"; const paths: string[] = [];
  const server = await fx.serve((req, res) => { paths.push(req.url!); if (mode === "redirect") { res.writeHead(302, { Location: "/unexpected-key" }); res.end(); } else { res.writeHead(200); res.end("x".repeat(300000)); } });
  expect(await fx.remoteVerifier(`${server.url}/jwks`).authenticate(await signed())).toBeNull(); expect(paths).toEqual(["/jwks"]);
  mode = "large"; expect(await fx.remoteVerifier(`${server.url}/jwks`).authenticate(await signed())).toBeNull(); expect(paths).toEqual(["/jwks", "/jwks"]);
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
  await expect(client.connect(new StreamableHTTPClientTransport(new URL(f.base + "/mcp"), { requestInit: { headers: { Host: "127.0.0.1", Authorization: bearer } } }))).rejects.toMatchObject({ code: 401 }); await client.close();
  for (const method of ["initialize", "ping", "tools/list", "tools/call"]) {
    const response = await fetch(f.base + "/mcp", { method: "POST", headers: { Host: "127.0.0.1", Authorization: bearer, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { name: "get_service_health", arguments: {} } }) });
    expect(response.status).toBe(401); expect(response.headers.get("www-authenticate")).toBe("Bearer");
  }
});

test("validly signed but unusable tokens are rejected at HTTP initialize with a Bearer challenge", async () => {
  const f = await deployment();
  const check = async (bearer: string, target = f) => { const response = await initialize(target.base, `Bearer ${bearer}`); return [response.status, response.headers.get("www-authenticate")]; };
  expect(await check(await signed())).toEqual([200, null]);
  for (const bearer of [await signed("litellm-proxy"), await signed("machine-a", { scope: "openid" }), await signed("machine-a", { aud: "other" })]) expect(await check(bearer)).toEqual([401, "Bearer"]);
  // Unreachable JWKS (closed port) and a throwing key resolver both fail closed instead of hanging or admitting the caller.
  const unreachable = await deployment(fx.remoteVerifier(`http://127.0.0.1:${await closedPort()}/jwks`));
  const throwing = await deployment(createJwtAuthenticator({ issuer, audience, getKey: async () => { throw new Error("jwks down"); } }));
  for (const target of [unreachable, throwing]) {
    expect(await check(await signed(), target)).toEqual([401, "Bearer"]);
  }
}, 15000);
test("MD_JWT_MAX_TTL_SECONDS is bounded at load and enforced against exp - iat", async () => {
  const env = (ttl?: string) => ({ MD_JWT_ISSUER: issuer, MD_JWT_AUDIENCE: audience, MD_JWT_JWKS_URL: "https://trusted.test/jwks", ...(ttl === undefined ? {} : { MD_JWT_MAX_TTL_SECONDS: ttl }) });
  expect(loadJwtAuthenticator(env("3600")).mode).toBe("jwt"); expect(loadJwtAuthenticator(env()).mode).toBe("jwt");
  for (const ttl of ["0", "3601", "NaN", "abc", "", "-1", "1.5", "Infinity"]) expect(() => loadJwtAuthenticator(env(ttl)), ttl).toThrow("max TTL");
  const auth = verifier({ maxTtlSeconds: 60 });
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
