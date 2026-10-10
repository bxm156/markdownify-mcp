import { afterEach, expect, setSystemTime, test } from "bun:test";
import { SignJWT, generateKeyPair, exportJWK, exportSPKI, createLocalJWKSet, type CryptoKey, type JWK } from "jose";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createJwtAuthenticator } from "./jwt.js";
import type { Authenticator } from "./auth.js";
import { loadConfig } from "./config.js";
import { JobService } from "./jobs.js";
import { createHttpServer } from "./http.js";

const issuer = "https://litellm.test", audience = "markdownify";
const allTools = "mcp:tools/list mcp:tools/call mcp:tools/get_service_health:call mcp:tools/create_upload:call mcp:tools/lookup_error:call";
const key = await generateKeyPair("RS256", { extractable: true });
const publicJwk = { ...await exportJWK(key.publicKey), kid: "first", alg: "RS256", use: "sig" };
const disposers: Array<() => Promise<unknown>> = [];
afterEach(async () => { setSystemTime(); while (disposers.length) await disposers.pop()!(); });

const verifier = (extra: Partial<Parameters<typeof createJwtAuthenticator>[0]> = {}) => createJwtAuthenticator({ issuer, audience, getKey: createLocalJWKSet({ keys: [publicJwk] }), ...extra });
// Resolves any kid to the one trusted key, so the explicit kid/claim clauses in jwt.ts are the only thing that can reject a validly signed token.
const kidBlind = () => createJwtAuthenticator({ issuer, audience, getKey: async () => key.publicKey });
const nowSeconds = () => Math.floor(Date.now() / 1000);
function claims(changes: Record<string, unknown> = {}) {
  const now = nowSeconds();
  return { iss: issuer, aud: audience, sub: "machine-a", iat: now, exp: now + 300, scope: "mcp:tools/list mcp:tools/call", ...changes };
}
async function signed(changes: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: "RS256", kid: "first" }, signingKey: CryptoKey | Uint8Array = key.privateKey) {
  return new SignJWT(claims(changes)).setProtectedHeader(header as any).sign(signingKey);
}
const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

test("aud must be exactly the configured string: arrays are rejected even when they contain it", async () => {
  const auth = verifier();
  expect(await auth.authenticate(await signed())).not.toBeNull();
  for (const aud of [[audience], [audience, audience], [audience, "another-service"], ["other", audience], [], "other", "", 7]) expect(await auth.authenticate(await signed({ aud })), JSON.stringify(aud)).toBeNull();
});
test("kid is mandatory, non-empty and at most 256 characters even when the signature verifies", async () => {
  const auth = kidBlind();
  expect(await auth.authenticate(await signed({}, { alg: "RS256", kid: "k" }))).not.toBeNull();
  expect(await auth.authenticate(await signed({}, { alg: "RS256", kid: "k".repeat(256) }))).not.toBeNull();
  expect(await auth.authenticate(await signed({}, { alg: "RS256", kid: "k".repeat(257) }))).toBeNull();
  expect(await auth.authenticate(await signed({}, { alg: "RS256" }))).toBeNull();
  expect(await auth.authenticate(await signed({}, { alg: "RS256", kid: "" }))).toBeNull();
  // A kid that is not a string never authenticates.
  expect(await auth.authenticate(await signed({}, { alg: "RS256", kid: 1 }))).toBeNull();
  // The same token is accepted by a resolver that does look at kid, so the rejection above is the kid clause and nothing else.
  expect(await verifier().authenticate(await signed({}, { alg: "RS256", kid: "first" }))).not.toBeNull();
  expect(await verifier().authenticate(await signed({}, { alg: "RS256", kid: "unknown" }))).toBeNull();
});
test("scope is a string of at most 8192 characters containing a tool scope", async () => {
  const auth = verifier(), base = "mcp:tools/list";
  const padded = (length: number) => base + " ".repeat(length - base.length);
  const accepted = await auth.authenticate(await signed({ scope: padded(8192) }));
  expect(accepted).toMatchObject({ tenantId: "machine-a", scopes: [base] });
  expect(await auth.authenticate(await signed({ scope: padded(8193) }))).toBeNull();
  for (const scope of [undefined, null, "", "   ", "openid profile", "mcp:admin", "MCP:TOOLS/LIST", "mcp:tools/lists", ["mcp:tools/list"], { "mcp:tools/list": true }, 1]) expect(await auth.authenticate(await signed({ scope })), JSON.stringify(scope)).toBeNull();
  // Whitespace of any kind separates scopes, and either gateway scope alone is enough to authenticate.
  expect((await auth.authenticate(await signed({ scope: "openid\tmcp:tools/call\n mcp:tools/x:call" })))?.scopes).toEqual(["openid", "mcp:tools/call", "mcp:tools/x:call"]);
  expect((await auth.authenticate(await signed({ scope: "mcp:tools/list" })))?.scopes).toEqual(["mcp:tools/list"]);
});
test("tokens over 16384 characters are rejected before verification, even when validly signed", async () => {
  const auth = verifier();
  const size = async (pad: number) => (await signed({ pad: "p".repeat(pad) })).length;
  // Token length is non-decreasing in the padding, so binary-search the largest padding that still fits.
  let low = 0, high = 16384;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (await size(mid) <= 16384) low = mid; else high = mid - 1; }
  const pad = low;
  const atLimit = await signed({ pad: "p".repeat(pad) }), overLimit = await signed({ pad: "p".repeat(pad + 1) });
  expect(atLimit.length).toBeGreaterThan(16380); expect(atLimit.length).toBeLessThanOrEqual(16384);
  expect(overLimit.length).toBeGreaterThan(16384);
  expect(await auth.authenticate(atLimit)).not.toBeNull();
  expect(await auth.authenticate(overLimit)).toBeNull();
});
test("only RS256 is accepted: HS256 keyed with the public key, none, and other RSA/EC algorithms are rejected", async () => {
  const ec = await generateKeyPair("ES256");
  // WebCrypto RSA keys are bound to one hash, so each foreign algorithm gets its own correctly generated key pair.
  const foreign = Object.fromEntries(await Promise.all(["RS384", "RS512", "PS256", "PS384", "PS512"].map(async alg => [alg, await generateKeyPair(alg)])));
  const auth = createJwtAuthenticator({ issuer, audience, getKey: async header => header.alg === "ES256" ? ec.publicKey : foreign[header.alg!]?.publicKey ?? key.publicKey });
  expect(await auth.authenticate(await signed())).not.toBeNull();
  // Classic algorithm confusion: HMAC signed with the published RSA public key as the secret, with every plausible encoding of it.
  const pem = await exportSPKI(key.publicKey);
  for (const secret of [new TextEncoder().encode(pem), new TextEncoder().encode(JSON.stringify(publicJwk)), Buffer.from(publicJwk.n!, "base64url")]) {
    // A resolver that naively hands back the public key bytes as the HMAC secret makes the algorithm allow-list the only barrier.
    const naive = createJwtAuthenticator({ issuer, audience, getKey: async () => secret });
    for (const alg of ["HS256", "HS384", "HS512"]) {
      const token = await signed({}, { alg, kid: "first" }, secret);
      expect(await auth.authenticate(token), alg).toBeNull();
      expect(await naive.authenticate(token), `naive ${alg}`).toBeNull();
    }
  }
  // Unsigned tokens, with and without a (bogus) signature segment, and with algorithm-name case tricks.
  const payload = b64(claims());
  for (const alg of ["none", "None", "NONE", "nOnE"]) {
    const header = b64({ alg, kid: "first", typ: "JWT" });
    for (const tail of ["", "AAAA", await (async () => (await signed()).split(".")[2])()]) expect(await auth.authenticate(`${header}.${payload}.${tail}`), `${alg}/${tail.slice(0, 4)}`).toBeNull();
  }
  expect(await auth.authenticate(`${b64({ alg: "RS256", kid: "first" })}.${payload}.`)).toBeNull();
  // Validly signed, and the key resolver returns the matching key, but the algorithm is not RS256.
  for (const alg of Object.keys(foreign)) expect(await auth.authenticate(await signed({}, { alg, kid: "first" }, foreign[alg].privateKey)), alg).toBeNull();
  expect(await auth.authenticate(await signed({}, { alg: "ES256", kid: "first" }, ec.privateKey))).toBeNull();
  // Header tricks that try to move key selection into the token: the key always comes from the pinned resolver, so a token signed by the
  // attacker is rejected whatever jku/x5u/jwk it advertises. Those headers are ignored (not honoured) for a token the trusted key signed.
  const attacker = await generateKeyPair("RS256", { extractable: true }), attackerJwk = { ...await exportJWK(attacker.publicKey), kid: "first", alg: "RS256" };
  for (const extra of [{ jku: "https://attacker.test/jwks" }, { x5u: "https://attacker.test/cert" }, { jwk: attackerJwk as JWK }]) {
    expect(await auth.authenticate(await signed({}, { alg: "RS256", kid: "first", ...extra }, attacker.privateKey)), Object.keys(extra)[0]).toBeNull();
    expect(await auth.authenticate(await signed({}, { alg: "RS256", kid: "first", ...extra })), Object.keys(extra)[0]).not.toBeNull();
  }
  // A critical header the verifier does not understand must fail even with a valid signature (jose refuses to sign it, so assemble by hand).
  const input = `${b64({ alg: "RS256", kid: "first", crit: ["x-unknown"], "x-unknown": 1 })}.${b64(claims())}`;
  const signature = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey as CryptoKey, Buffer.from(input))).toString("base64url");
  expect(await auth.authenticate(`${input}.${signature}`)).toBeNull();
  expect(await auth.authenticate(`${b64({ alg: "RS256", kid: "first" })}.${b64(claims())}.${signature}`)).toBeNull();
});
test("exp, iat and sub must each be well-formed on their own", async () => {
  setSystemTime(new Date("2026-03-01T12:00:00Z"));
  const auth = verifier(), now = nowSeconds();
  expect(await auth.authenticate(await signed())).not.toBeNull();
  // exp has no grace: now+1 is the last accepted second and exp == now is already expired, despite the library's 5s tolerance.
  expect(await auth.authenticate(await signed({ iat: now - 10, exp: now + 1 }))).not.toBeNull();
  expect(await auth.authenticate(await signed({ iat: now - 10, exp: now }))).toBeNull();
  // exp not after iat while still in the future (iat within the 5s skew allowance).
  expect(await auth.authenticate(await signed({ iat: now + 3, exp: now + 3 }))).toBeNull();
  expect(await auth.authenticate(await signed({ iat: now + 3, exp: now + 2 }))).toBeNull();
  expect(await auth.authenticate(await signed({ iat: now + 3, exp: now + 4 }))).not.toBeNull();
  // Fractional or non-numeric NumericDates are not safe integers.
  for (const change of [{ iat: now + 0.5 }, { exp: now + 300.5 }, { iat: "1" }, { exp: String(now + 300) }, { iat: null }, { exp: null }]) expect(await auth.authenticate(await signed(change)), JSON.stringify(change)).toBeNull();
  // nbf in the past is fine; in the future beyond the 5s tolerance is not.
  expect(await auth.authenticate(await signed({ nbf: now - 100 }))).not.toBeNull();
  expect(await auth.authenticate(await signed({ nbf: now + 4 }))).not.toBeNull();
  expect(await auth.authenticate(await signed({ nbf: now + 6 }))).toBeNull();
  for (const sub of [123, "", null, ["machine-a"], { id: "machine-a" }, true]) expect(await auth.authenticate(await signed({ sub })), JSON.stringify(sub)).toBeNull();
});
test("subject is bounded to the principal alphabet and 64 characters", async () => {
  const auth = verifier();
  expect((await auth.authenticate(await signed({ sub: "A_-0".repeat(16) })))?.tenantId).toBe("A_-0".repeat(16));
  for (const sub of ["a".repeat(65), "a b", "a.b", "a:b", "a\u0000b", "ümlaut", "litellm-proxy"]) expect(await auth.authenticate(await signed({ sub })), JSON.stringify(sub)).toBeNull();
});
test("authenticator output is frozen and carries only the verified subject, scopes and prefix", async () => {
  const principal = await verifier().authenticate(await signed({ tenant_id: "evil", agent_id: "evil", tenantId: "evil", act: { sub: "evil" }, scope: "mcp:tools/list mcp:tools/call" }));
  expect(principal).toEqual({ tenantId: "machine-a", agentId: "machine-a", scopes: ["mcp:tools/list", "mcp:tools/call"], toolPrefix: "markdownify-" });
  expect(Object.isFrozen(principal)).toBe(true); expect(Object.isFrozen(principal!.scopes)).toBe(true);
  expect((await verifier({ toolPrefix: "gw_" }).authenticate(await signed()))?.toolPrefix).toBe("gw_");
});

async function deployment(auth: Authenticator = verifier(), options: Record<string, unknown> = {}, jobs: Record<string, unknown> = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-claims-"));
  const service = new JobService({ dataDir, maxUploadBytes: 1000, maxOutputBytes: 1000, maxStorageBytes: 1_000_000, maxJobs: 50, retentionMs: 3_600_000, uploadTtlMs: 3_600_000, conversionTimeoutMs: 1000, concurrency: 1, converter: async (input: string, output: string) => { await fs.writeFile(output, await fs.readFile(input)); }, ...options });
  await service.init();
  const httpOptions = { authenticator: auth, publicBaseUrl: "http://127.0.0.1", allowedHosts: ["127.0.0.1"], ...jobs };
  const server = createHttpServer(service, httpOptions); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; httpOptions.publicBaseUrl = base;
  disposers.push(async () => { await service.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await fs.rm(dataDir, { recursive: true, force: true }); });
  async function client(subject = "machine-a", scope = allTools) {
    const c = new Client({ name: "claims", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Host: "127.0.0.1", Authorization: `Bearer ${await signed({ sub: subject, scope })}` } } }));
    disposers.push(() => c.close()); return c;
  }
  const put = (upload: any) => fetch(upload.upload_url, { method: "PUT", headers: { ...upload.required_headers, Host: "127.0.0.1" }, body: "x" });
  return { service, base, client, put };
}
const text = (result: any) => JSON.parse(result.content[0].text);
const ok = (result: any) => { expect(result.isError).not.toBe(true); return text(result); };

test("a token with only mcp:tools/list authenticates and lists tools, but every call is denied with AUTH_SCOPE_REQUIRED", async () => {
  const auth = verifier();
  expect(await auth.authenticate(await signed({ scope: "mcp:tools/list" }))).toMatchObject({ scopes: ["mcp:tools/list"] });
  const f = await deployment(auth), c = await f.client("machine-a", "mcp:tools/list");
  expect((await c.listTools()).tools.map(t => t.name)).toContain("get_service_health");
  for (const [name, args] of [["get_service_health", {}], ["lookup_error", { code: "FILE_TOO_LARGE" }], ["create_upload", { filename: "x.txt", size_bytes: 1 }]] as const) {
    const result = await c.callTool({ name, arguments: args });
    expect(result.isError, name).toBe(true); expect(text(result).error_info.code, name).toBe("AUTH_SCOPE_REQUIRED");
  }
  expect((await f.service.health({ tenantId: "machine-a", agentId: "machine-a" }) as any).own_jobs.awaiting_upload).toBe(0);
});
test("calls need the gateway call scope and a per-tool scope, with either the bare or the prefixed tool name", async () => {
  const auth = verifier({ toolPrefix: "gw_" }), f = await deployment(auth);
  const attempt = async (scope: string) => (await (await f.client("machine-a", scope)).callTool({ name: "lookup_error", arguments: { code: "FILE_TOO_LARGE" } }));
  ok(await attempt("mcp:tools/list mcp:tools/call mcp:tools/lookup_error:call"));
  ok(await attempt("mcp:tools/call mcp:tools/gw_lookup_error:call"));
  // A per-tool scope alone is not enough to authenticate at all.
  expect(await auth.authenticate(await signed({ scope: "mcp:tools/lookup_error:call" }))).toBeNull();
  for (const scope of ["mcp:tools/call", "mcp:tools/call mcp:tools/markdownify-lookup_error:call", "mcp:tools/call mcp:tools/get_service_health:call", "mcp:tools/call mcp:tools/gw_get_service_health:call"]) {
    const result = await attempt(scope);
    expect(result.isError, scope).toBe(true); expect(text(result).error_info.code, scope).toBe("AUTH_SCOPE_REQUIRED");
  }
});
test("a call-only token authenticates but cannot list tools", async () => {
  const f = await deployment(), c = await f.client("machine-a", "mcp:tools/call mcp:tools/lookup_error:call");
  await expect(c.listTools()).rejects.toThrow("Scope not granted");
  ok(await c.callTool({ name: "lookup_error", arguments: { code: "FILE_TOO_LARGE" } }));
});

test("a still-valid JWT keeps working until exp after the signer stops issuing, with no grace afterwards", async () => {
  const start = new Date("2026-04-01T08:00:00Z"); setSystemTime(start);
  const auth = verifier(), t0 = nowSeconds(), issued = await signed({ iat: t0, exp: t0 + 300 });
  // The signer is "stopped" from here on: nothing below mints another token.
  for (const offset of [0, 1, 150, 299]) { setSystemTime(new Date(start.getTime() + offset * 1000)); expect(await auth.authenticate(issued), `+${offset}s`).toMatchObject({ tenantId: "machine-a", agentId: "machine-a" }); }
  for (const offset of [300, 301, 305, 306, 3600]) { setSystemTime(new Date(start.getTime() + offset * 1000)); expect(await auth.authenticate(issued), `+${offset}s`).toBeNull(); }
});
test("a replayed JWT stays valid over HTTP until exp and no longer", async () => {
  const start = new Date("2026-04-01T08:00:00Z"); setSystemTime(start);
  const f = await deployment(), t0 = nowSeconds(), bearer = `Bearer ${await signed({ iat: t0, exp: t0 + 300, scope: allTools })}`;
  const initialize = () => fetch(`${f.base}/mcp`, { method: "POST", headers: { Host: "127.0.0.1", Authorization: bearer, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "replay", version: "1" } } }) });
  setSystemTime(new Date(start.getTime() + 299_000)); expect((await initialize()).status).toBe(200);
  setSystemTime(new Date(start.getTime() + 300_000)); const expired = await initialize();
  expect(expired.status).toBe(401); expect(expired.headers.get("www-authenticate")).toBe("Bearer");
});
test("revoking the signing key from JWKS takes effect only after the cache lifetime", async () => {
  let keys: JWK[] = [publicJwk], requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ keys })); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); disposers.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const jwksUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/jwks`;
  const start = new Date("2026-04-01T08:00:00Z"); setSystemTime(start);
  const auth = createJwtAuthenticator({ issuer, audience, jwksUrl, allowLoopback: true });
  const t0 = nowSeconds(), at = (seconds: number) => setSystemTime(new Date(start.getTime() + seconds * 1000));
  const token = await signed({ iat: t0, exp: t0 + 300 });
  expect(await auth.authenticate(token)).not.toBeNull(); expect(requests).toBe(1);
  keys = []; // Operator removes the key from the JWKS.
  at(30); expect(await auth.authenticate(token)).not.toBeNull(); expect(requests).toBe(1); // Still served from the 60s cache.
  at(61); expect(await auth.authenticate(token)).toBeNull(); expect(requests).toBe(2); // Cache expired: the key is gone, so the token is refused well before its exp.
  keys = [publicJwk]; at(62); expect(await auth.authenticate(token)).toBeNull(); // Failed refresh is rate limited by the 5s cooldown...
  at(67); expect(await auth.authenticate(token)).not.toBeNull(); // ...and recovers once the key is published again.
});
test("an upload grant works until its own expiry, outlives the JWT that created it, and fails at expiry", async () => {
  const start = new Date("2026-04-01T08:00:00Z"); setSystemTime(start);
  const f = await deployment(), at = (seconds: number) => setSystemTime(new Date(start.getTime() + seconds * 1000));
  // Token valid for 300s; the agent creates its grants late in that window and the signer then stops issuing.
  const t0 = nowSeconds(), c = new Client({ name: "grant", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), { requestInit: { headers: { Host: "127.0.0.1", Authorization: `Bearer ${await signed({ iat: t0, exp: t0 + 300, scope: allTools })}` } } })); disposers.push(() => c.close());
  at(200);
  const early = ok(await c.callTool({ name: "create_upload", arguments: { filename: "x.txt", size_bytes: 1 } }));
  const late = ok(await c.callTool({ name: "create_upload", arguments: { filename: "x.txt", size_bytes: 1 } }));
  const expiresAt = Date.parse(early.expires_at);
  expect(expiresAt - Date.now()).toBe(300_000); // Capped at five minutes although uploadTtlMs is an hour.
  // 100s later the JWT has expired but the grant still works...
  at(350);
  const reconnect = await fetch(`${f.base}/mcp`, { method: "POST", headers: { Host: "127.0.0.1", Authorization: `Bearer ${await signed({ iat: t0, exp: t0 + 300, scope: allTools })}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  expect(reconnect.status).toBe(401);
  at(499); expect((await f.put(early)).status).toBe(204);
  // ...and is refused from the instant it expires.
  at(500); expect(Date.now()).toBe(expiresAt); expect((await f.put(late)).status).toBe(401);
  at(501); expect((await f.put(late)).status).toBe(401);
  expect(await f.service.authenticateUpload(late.upload_id, late.required_headers.Authorization.slice(7))).toBeNull();
});

test("same-user JWT principals (tenantId === agentId) are bound by the tighter default agent caps, visible through get_service_health", async () => {
  const config = loadConfig({ MD_JWT_ISSUER: issuer, MD_JWT_AUDIENCE: audience, MD_JWT_JWKS_URL: "https://trusted.test/jwks" });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-compose-"));
  disposers.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const f = await deployment(verifier(), { ...config.jobs, dataDir, converter: async () => {} });
  const a = await f.client("machine-a"), b = await f.client("machine-b");
  const health = ok(await a.callTool({ name: "get_service_health", arguments: {} }));
  const MiB = 1024 * 1024;
  expect(health.limits).toMatchObject({
    global_jobs: 100, tenant_jobs: 25, agent_jobs: 10, global_reserved_bytes: 256 * MiB, tenant_reserved_bytes: 128 * MiB, agent_reserved_bytes: 128 * MiB,
    global_concurrency: 2, tenant_concurrency: 1, agent_concurrency: 1, agent_override: false,
    effective: { jobs: 10, reserved_bytes: 128 * MiB, concurrency: 1 },
  });
  // The tenant scope is the same single user, so the byte budget (not the job count) is what binds: each job reserves 1 + 25 MiB output.
  const perJob = 1 + config.jobs.maxOutputBytes, fits = Math.floor(128 * MiB / perJob);
  expect(fits).toBe(5);
  for (let i = 0; i < fits; i++) ok(await a.callTool({ name: "create_upload", arguments: { filename: "x.txt", size_bytes: 1 } }));
  const full = await a.callTool({ name: "create_upload", arguments: { filename: "x.txt", size_bytes: 1 } });
  expect(full.isError).toBe(true); expect(text(full).error_info.code).toBe("STORAGE_LIMIT_EXCEEDED");
  const after = ok(await a.callTool({ name: "get_service_health", arguments: {} }));
  expect(after.own_jobs.awaiting_upload).toBe(fits); expect(after.own_reserved_bytes).toBe(fits * perJob);
  // A different subject is a different tenant and agent: it neither sees nor shares that usage.
  const other = ok(await b.callTool({ name: "get_service_health", arguments: {} }));
  expect(other.own_jobs.awaiting_upload).toBe(0); expect(other.own_reserved_bytes).toBe(0);
  ok(await b.callTool({ name: "create_upload", arguments: { filename: "x.txt", size_bytes: 1 } }));
  expect(JSON.stringify(other)).not.toContain("machine-a");
});
