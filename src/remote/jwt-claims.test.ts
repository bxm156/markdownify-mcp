import { afterEach, expect, setSystemTime, test } from "bun:test";
import { SignJWT, generateKeyPair, exportJWK, exportSPKI, jwtVerify, type JWK } from "jose";
import { createJwtAuthenticator } from "./jwt.js";
import type { Authenticator } from "./auth.js";
import { loadConfig } from "./config.js";
import { createJwtFixture, mcpInitialize, toolJson as text, toolOk as ok } from "./test-helpers.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const allTools = "mcp:tools/list mcp:tools/call mcp:tools/get_service_health:call mcp:tools/create_upload:call mcp:tools/lookup_error:call";
const fx = await createJwtFixture({ clientScope: allTools });
const { issuer, audience, key, publicJwk, verifier, claims, nowSeconds, sign: signed } = fx;
afterEach(async () => { setSystemTime(); await fx.close(); });

// Resolves any kid to the one trusted key, so the explicit kid/claim clauses in jwt.ts are the only thing that can reject a validly signed token.
const kidBlind = () => createJwtAuthenticator({ issuer, audience, getKey: async () => key.publicKey });
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
  // A critical header the verifier does not understand must fail even with a valid signature (jose refuses to sign it, so assemble by hand).
  const input = `${b64({ alg: "RS256", kid: "first", crit: ["x-unknown"], "x-unknown": 1 })}.${b64(claims())}`;
  const signature = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey as CryptoKey, Buffer.from(input))).toString("base64url");
  expect(await auth.authenticate(`${input}.${signature}`)).toBeNull();
  expect(await auth.authenticate(`${b64({ alg: "RS256", kid: "first" })}.${b64(claims())}.${signature}`)).toBeNull();
});
test("jku, x5u, x5c and jwk headers are rejected before key resolution, whoever signed the token", async () => {
  const attacker = await generateKeyPair("RS256", { extractable: true }), attackerJwk = { ...await exportJWK(attacker.publicKey), kid: "first", alg: "RS256" } as JWK;
  const extras: Array<Record<string, unknown>> = [{ jku: "https://attacker.test/jwks" }, { x5u: "https://attacker.test/cert" }, { x5c: ["MIIB"] }, { jwk: attackerJwk }, { jku: "" }, { x5c: [] }, { jwk: null }, { jku: "https://attacker.test/jwks", x5u: "https://attacker.test/cert", x5c: ["MIIB"], jwk: attackerJwk }];
  let resolved = 0;
  const counting = createJwtAuthenticator({ issuer, audience, getKey: async () => { resolved++; return key.publicKey; } });
  // Control: the same resolver accepts a token without those headers, so the resolver is not what rejects the cases below.
  expect(await counting.authenticate(await signed())).not.toBeNull(); expect(resolved).toBe(1);
  for (const [name, auth] of [["pinned JWKS", verifier()], ["resolver that trusts any kid", kidBlind()], ["counting resolver", counting]] as const) {
    for (const extra of extras) {
      const label = `${name} ${JSON.stringify(Object.keys(extra))}`;
      // Signed by the attacker's own key: rejected whatever key source it advertises.
      expect(await auth.authenticate(await signed({}, { alg: "RS256", kid: "first", ...extra }, attacker.privateKey)), `attacker ${label}`).toBeNull();
      // Signed by the trusted key: still rejected. The headers are refused outright instead of being ignored.
      expect(await auth.authenticate(await signed({}, { alg: "RS256", kid: "first", ...extra })), `trusted ${label}`).toBeNull();
    }
  }
  // The key resolver never runs for these tokens, so no key lookup (and no network fetch in production) can be influenced by them.
  expect(resolved).toBe(1);
  // Unrelated optional headers remain fine.
  expect(await verifier().authenticate(await signed({}, { alg: "RS256", kid: "first", typ: "JWT", cty: "x" }))).not.toBeNull();
});
test("crit is rejected even for an extension the signer declares and jose itself would accept", async () => {
  const token = await new SignJWT(claims()).setProtectedHeader({ alg: "RS256", kid: "first", crit: ["x-ext"], "x-ext": 1 }).sign(key.privateKey, { crit: { "x-ext": true } });
  // Control: a verifier told that the extension is understood accepts the very same token, so only the authenticator's own policy rejects it.
  await expect(jwtVerify(token, key.publicKey, { crit: { "x-ext": true }, issuer, audience })).resolves.toMatchObject({ protectedHeader: { crit: ["x-ext"], "x-ext": 1 } });
  await expect(jwtVerify(token, key.publicKey, { issuer, audience })).rejects.toThrow();
  expect(await verifier().authenticate(token)).toBeNull();
  expect(await kidBlind().authenticate(token)).toBeNull();
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

const deployment = (auth: Authenticator = verifier(), jobs: Record<string, unknown> = {}) => fx.deployment(auth, { jobs });
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
  const initialize = () => mcpInitialize(f.base, bearer);
  setSystemTime(new Date(start.getTime() + 299_000)); expect((await initialize()).status).toBe(200);
  setSystemTime(new Date(start.getTime() + 300_000)); const expired = await initialize();
  expect(expired.status).toBe(401); expect(expired.headers.get("www-authenticate")).toBe("Bearer");
});
test("revoking the signing key from JWKS takes effect only after the cache lifetime", async () => {
  const jwks = await fx.serveJwks(), requests = jwks.requests;
  const start = new Date("2026-04-01T08:00:00Z"); setSystemTime(start);
  const auth = fx.remoteVerifier(jwks.url);
  const t0 = nowSeconds(), at = (seconds: number) => setSystemTime(new Date(start.getTime() + seconds * 1000));
  const token = await signed({ iat: t0, exp: t0 + 300 });
  expect(await auth.authenticate(token)).not.toBeNull(); expect(requests()).toBe(1);
  jwks.setKeys([]); // Operator removes the key from the JWKS.
  at(30); expect(await auth.authenticate(token)).not.toBeNull(); expect(requests()).toBe(1); // Still served from the 60s cache.
  at(61); expect(await auth.authenticate(token)).toBeNull(); expect(requests()).toBe(2); // Cache expired: the key is gone, so the token is refused well before its exp.
  jwks.setKeys([fx.publicJwk]); at(62); expect(await auth.authenticate(token)).toBeNull(); // Failed refresh is rate limited by the 5s cooldown...
  at(67); expect(await auth.authenticate(token)).not.toBeNull(); // ...and recovers once the key is published again.
});
test("key removal is effective 60s after the last JWKS fetch; the 5s refresh cooldown does not extend it", async () => {
  const jwks = await fx.serveJwks(), start = new Date("2026-04-01T08:00:00Z"); setSystemTime(start);
  const auth = fx.remoteVerifier(jwks.url, { maxTtlSeconds: 1000 }), at = (seconds: number) => setSystemTime(new Date(start.getTime() + seconds * 1000));
  const t0 = nowSeconds(), token = await signed({ iat: t0, exp: t0 + 1000 }), stranger = await signed({ iat: t0, exp: t0 + 300 }, { alg: "RS256", kid: "unknown" });
  expect(await auth.authenticate(token)).not.toBeNull(); expect(jwks.requests()).toBe(1); // Fetch at t=0.
  // A token with an unknown kid, after the cooldown, forces a refresh at t=50 and restarts the 60s cache clock.
  at(50); expect(await auth.authenticate(stranger)).toBeNull(); expect(jwks.requests()).toBe(2);
  at(51); jwks.setKeys([]); // Operator removes the key at t=51.
  at(109); expect(await auth.authenticate(token)).not.toBeNull(); expect(jwks.requests()).toBe(2); // Cached keys serve until t=110 ...
  at(110); expect(await auth.authenticate(token)).toBeNull(); expect(jwks.requests()).toBe(3); // ... then the next verification refetches and refuses the token: 59s after removal.
});
test("an upload grant works until its own expiry, outlives the JWT that created it, and fails at expiry", async () => {
  const start = new Date("2026-04-01T08:00:00Z"); setSystemTime(start);
  const f = await deployment(), at = (seconds: number) => setSystemTime(new Date(start.getTime() + seconds * 1000));
  // Token valid for 300s; the agent creates its grants late in that window and the signer then stops issuing.
  const t0 = nowSeconds(), c = new Client({ name: "grant", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), { requestInit: { headers: { Host: "127.0.0.1", Authorization: `Bearer ${await signed({ iat: t0, exp: t0 + 300, scope: allTools })}` } } })); fx.defer(() => c.close());
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
  fx.defer(() => fs.rm(dataDir, { recursive: true, force: true }));
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

test("MD_QUOTA_OVERRIDES_FILE entries keyed by a same-user JWT principal apply through get_service_health, bounded by the tenant defaults", async () => {
  const MiB = 1024 * 1024, dir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-jwt-quota-"));
  fx.defer(() => fs.rm(dir, { recursive: true, force: true }));
  const overrides = path.join(dir, "quota.json");
  await fs.writeFile(overrides, JSON.stringify({ overrides: [
    { tenant_id: "machine-a", agent_id: "machine-a", max_jobs: 2 }, // Lowered.
    { tenant_id: "machine-b", agent_id: "machine-b", max_jobs: 40, max_storage_bytes: 200 * MiB, max_concurrency: 2 }, // Raised above the tenant defaults.
    { tenant_id: "machine-c", agent_id: "someone-else", max_jobs: 3 }, // Not a same-user key, so it can never match a JWT principal.
  ] }));
  const config = loadConfig({ MD_JWT_ISSUER: issuer, MD_JWT_AUDIENCE: audience, MD_JWT_JWKS_URL: "https://trusted.test/jwks", MD_DATA_DIR: path.join(dir, "data"), MD_QUOTA_OVERRIDES_FILE: overrides });
  expect(config.jobs.quotaOverrides!.size).toBe(3);
  const f = await deployment(verifier(), { ...config.jobs, converter: async () => {} });
  const health = async (subject: string) => ok(await (await f.client(subject)).callTool({ name: "get_service_health", arguments: {} }));
  const lowered = await health("machine-a"), raised = await health("machine-b"), mismatched = await health("machine-c"), unlisted = await health("machine-d");
  expect(lowered.limits).toMatchObject({ agent_jobs: 2, tenant_jobs: 25, agent_override: true, effective: { jobs: 2, reserved_bytes: 128 * MiB, concurrency: 1 } });
  // The raised agent caps are still held down by the tenant scope, which is the same single user with default caps.
  expect(raised.limits).toMatchObject({ agent_jobs: 40, agent_reserved_bytes: 200 * MiB, agent_concurrency: 2, tenant_jobs: 25, tenant_reserved_bytes: 128 * MiB, tenant_concurrency: 1, agent_override: true, effective: { jobs: 25, reserved_bytes: 128 * MiB, concurrency: 1 } });
  for (const report of [mismatched, unlisted]) expect(report.limits).toMatchObject({ agent_jobs: 10, agent_override: false, effective: { jobs: 10, reserved_bytes: 128 * MiB, concurrency: 1 } });
  // The lowered cap is enforced for real, and as an agent-scope denial.
  const a = await f.client("machine-a");
  for (let i = 0; i < 2; i++) ok(await a.callTool({ name: "create_upload", arguments: { filename: "x.txt", size_bytes: 1 } }));
  const denied = await a.callTool({ name: "create_upload", arguments: { filename: "x.txt", size_bytes: 1 } });
  expect(denied.isError).toBe(true); expect(text(denied).error_info).toMatchObject({ code: "JOB_LIMIT_EXCEEDED", details: { scope: "agent", limit_jobs: 2 } });
  expect(ok(await a.callTool({ name: "get_service_health", arguments: {} })).own_jobs.awaiting_upload).toBe(2);
  // Another user's report neither shows nor shares that usage, and never exposes the other subjects.
  const after = await health("machine-d");
  expect(after.own_jobs.awaiting_upload).toBe(0); expect(JSON.stringify(after)).not.toMatch(/machine-[abc]|someone-else/);
});
