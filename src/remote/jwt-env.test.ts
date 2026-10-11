import { afterEach, expect, test } from "bun:test";
import { loadAuthenticator } from "./auth.js";
import { loadConfig } from "./config.js";
import { loadJwtAuthenticator } from "./jwt.js";
import { createJwtFixture } from "./test-helpers.js";

const fx = await createJwtFixture({ kid: "env" });
const { issuer, audience } = fx;
afterEach(() => fx.close());

const jwksServer = () => fx.serveJwks();
const token = (scope = "mcp:tools/list mcp:tools/call") => fx.sign({ scope });
const base = (extra: Record<string, string | undefined> = {}) => ({ MD_JWT_ISSUER: issuer, MD_JWT_AUDIENCE: audience, MD_JWT_JWKS_URL: "https://trusted.test/jwks", ...extra }) as NodeJS.ProcessEnv;

test("loadJwtAuthenticator success path verifies tokens against the configured JWKS URL with the default tool prefix", async () => {
  const jwks = await jwksServer();
  const auth = loadJwtAuthenticator(base({ MD_JWT_JWKS_URL: jwks.url, MD_JWT_ALLOW_HTTP_LOCALHOST: "1" }));
  expect(auth.mode).toBe("jwt");
  expect(await auth.authenticate(await token())).toEqual({ tenantId: "machine-a", agentId: "machine-a", scopes: ["mcp:tools/list", "mcp:tools/call"], toolPrefix: "markdownify-" });
  expect(jwks.requests()).toBe(1);
  expect(await auth.authenticate(undefined)).toBeNull();
  expect(await auth.authenticate("")).toBeNull();
  expect(await auth.authenticate("not.a.jwt")).toBeNull();
});
test("loadJwtAuthenticator applies MD_JWT_AUDIENCE, MD_JWT_ISSUER and MD_JWT_TOOL_PREFIX from the environment", async () => {
  const jwks = await jwksServer(), env = { MD_JWT_JWKS_URL: jwks.url, MD_JWT_ALLOW_HTTP_LOCALHOST: "1" };
  expect((await loadJwtAuthenticator(base({ ...env, MD_JWT_TOOL_PREFIX: "litellm_" })).authenticate(await token()))?.toolPrefix).toBe("litellm_");
  // An explicitly empty prefix is valid (the pattern allows 0 to 64 characters) and is not replaced by the default.
  expect((await loadJwtAuthenticator(base({ ...env, MD_JWT_TOOL_PREFIX: "" })).authenticate(await token()))?.toolPrefix).toBe("");
  expect((await loadJwtAuthenticator(base({ ...env, MD_JWT_TOOL_PREFIX: "a".repeat(64) })).authenticate(await token()))?.toolPrefix).toBe("a".repeat(64));
  expect(await loadJwtAuthenticator(base({ ...env, MD_JWT_AUDIENCE: "other" })).authenticate(await token())).toBeNull();
  expect(await loadJwtAuthenticator(base({ ...env, MD_JWT_ISSUER: "https://elsewhere.test" })).authenticate(await token())).toBeNull();
});
test("MD_JWT_TOOL_PREFIX rejects invalid characters and lengths", () => {
  for (const prefix of ["bad prefix", "a/b", "a:b", "a.b", "ü", "a\n", "a".repeat(65)]) expect(() => loadJwtAuthenticator(base({ MD_JWT_TOOL_PREFIX: prefix })), JSON.stringify(prefix)).toThrow("tool prefix");
  for (const prefix of ["markdownify-", "A_b-9", "x"]) expect(() => loadJwtAuthenticator(base({ MD_JWT_TOOL_PREFIX: prefix })), prefix).not.toThrow();
});
test("MD_JWT_ALLOW_HTTP_LOCALHOST accepts only 1 and loopback HTTP; everything else fails closed", () => {
  const http = { MD_JWT_JWKS_URL: "http://127.0.0.1:9/jwks" };
  for (const value of ["true", "TRUE", "yes", "0", "false", "", " 1", "1 "]) expect(() => loadJwtAuthenticator(base({ ...http, MD_JWT_ALLOW_HTTP_LOCALHOST: value })), JSON.stringify(value)).toThrow("must be 1 or unset");
  // Without the opt-in, plain HTTP JWKS and issuer URLs are refused even on loopback.
  expect(() => loadJwtAuthenticator(base(http))).toThrow("HTTPS");
  expect(() => loadJwtAuthenticator(base({ MD_JWT_ISSUER: "http://127.0.0.1:9", MD_JWT_JWKS_URL: "https://trusted.test/jwks" }))).toThrow("HTTPS");
  // The opt-in is limited to loopback hosts, so it cannot enable cleartext JWKS fetches from the network.
  for (const url of ["http://trusted.test/jwks", "http://10.0.0.1/jwks", "http://localhost.evil.test/jwks"]) expect(() => loadJwtAuthenticator(base({ MD_JWT_JWKS_URL: url, MD_JWT_ALLOW_HTTP_LOCALHOST: "1" })), url).toThrow("HTTPS");
  for (const url of ["http://localhost:9/jwks", "http://127.0.0.1:9/jwks", "http://[::1]:9/jwks"]) expect(() => loadJwtAuthenticator(base({ MD_JWT_JWKS_URL: url, MD_JWT_ALLOW_HTTP_LOCALHOST: "1" })), url).not.toThrow();
  // URLs with credentials, queries or fragments are rejected even over HTTPS.
  for (const url of ["https://u:p@trusted.test/jwks", "https://trusted.test/jwks?x=1", "https://trusted.test/jwks#frag", "not a url"]) expect(() => loadJwtAuthenticator(base({ MD_JWT_JWKS_URL: url })), url).toThrow();
});
test("MD_JWT_MAX_TTL_SECONDS fails closed on empty and non-numeric values and defaults to 300 only when unset", async () => {
  for (const ttl of ["", "abc", " ", "1e3x", "0x10x"]) expect(() => loadJwtAuthenticator(base({ MD_JWT_MAX_TTL_SECONDS: ttl })), JSON.stringify(ttl)).toThrow("max TTL");
  const jwks = await jwksServer(), env = { MD_JWT_JWKS_URL: jwks.url, MD_JWT_ALLOW_HTTP_LOCALHOST: "1" };
  const now = Math.floor(Date.now() / 1000);
  const withTtl = (ttl: number) => fx.sign({ iat: now, exp: now + ttl, scope: "mcp:tools/list" });
  const defaults = loadJwtAuthenticator(base(env)), short = loadJwtAuthenticator(base({ ...env, MD_JWT_MAX_TTL_SECONDS: "60" }));
  expect(await defaults.authenticate(await withTtl(300))).not.toBeNull();
  expect(await defaults.authenticate(await withTtl(301))).toBeNull();
  expect(await short.authenticate(await withTtl(60))).not.toBeNull();
  expect(await short.authenticate(await withTtl(61))).toBeNull();
});
test("required MD_JWT_* settings are each mandatory and non-empty", () => {
  for (const name of ["MD_JWT_ISSUER", "MD_JWT_AUDIENCE", "MD_JWT_JWKS_URL"]) {
    expect(() => loadJwtAuthenticator(base({ [name]: undefined })), name).toThrow("JWT auth requires");
    expect(() => loadJwtAuthenticator(base({ [name]: "" })), name).toThrow("JWT auth requires");
  }
  expect(() => loadJwtAuthenticator({})).toThrow("JWT auth requires");
  expect(() => loadJwtAuthenticator(base({ MD_JWT_AUDIENCE: "a".repeat(513) }))).toThrow("audience");
});
test("JWT mode refuses to share the environment with static credentials", () => {
  for (const extra of [{ MD_API_KEY: "a".repeat(32) }, { MD_API_KEY: "" }, { MD_AUTH_FILE: "/nonexistent/auth.json" }, { MD_AUTH_FILE: "" }]) {
    expect(() => loadJwtAuthenticator(base(extra)), JSON.stringify(extra)).toThrow("cannot be combined");
    expect(() => loadAuthenticator(base(extra)), JSON.stringify(extra)).toThrow("cannot be combined");
    expect(() => loadConfig(base(extra)), JSON.stringify(extra)).toThrow("cannot be combined");
  }
  expect(() => loadConfig(base({ MD_AUTH_FILE: "/nonexistent/auth.json", MD_API_KEY: "a".repeat(32) }))).toThrow("cannot be combined");
});
test("loadAuthenticator dispatches to JWT on any MD_JWT_-prefixed variable, never falling back to a static key", () => {
  const apiKey = "a".repeat(32);
  // A lone, unrecognised or empty MD_JWT_ variable still selects JWT mode, so a half-configured deployment fails instead of silently using the shared key.
  for (const env of [{ MD_JWT_TOOL_PREFIX: "x" }, { MD_JWT_UNKNOWN: "1" }, { MD_JWT_ISSUER: "" }, { MD_JWT_ALLOW_HTTP_LOCALHOST: "1" }]) {
    expect(() => loadAuthenticator(env), JSON.stringify(env)).toThrow("JWT auth requires");
    expect(() => loadAuthenticator({ ...env, MD_API_KEY: apiKey }), JSON.stringify(env)).toThrow("cannot be combined");
  }
  expect(loadAuthenticator(base()).mode).toBe("jwt");
  // Only the exact `MD_JWT_` prefix dispatches.
  for (const env of [{ MD_JWT: "x" }, { MD_JWTX: "x" }, { XMD_JWT_ISSUER: issuer }, { md_jwt_issuer: issuer }]) {
    const auth = loadAuthenticator({ ...env, MD_API_KEY: apiKey });
    expect(auth.mode, JSON.stringify(env)).toBeUndefined();
    expect(auth.authenticate(apiKey)).toEqual({ tenantId: "default", agentId: "default" });
  }
  expect(loadAuthenticator({ MD_API_KEY: apiKey }).mode).toBeUndefined();
});
test("MD_JWT_ variables whose value is undefined are unset; any defined value, even empty, still selects JWT mode", () => {
  const apiKey = "a".repeat(32);
  // process.env never holds undefined, so this only matters for programmatic env objects: undefined means unset and does not select JWT mode.
  for (const env of [{ MD_JWT_ISSUER: undefined }, { MD_JWT_ISSUER: undefined, MD_JWT_AUDIENCE: undefined, MD_JWT_JWKS_URL: undefined }, { MD_JWT_UNKNOWN: undefined }]) {
    const auth = loadAuthenticator({ ...env, MD_API_KEY: apiKey });
    expect(auth.mode, JSON.stringify(env)).toBeUndefined();
    expect(auth.authenticate(apiKey)).toEqual({ tenantId: "default", agentId: "default" });
    expect(loadConfig({ ...env, MD_API_KEY: apiKey }).authenticator.mode, JSON.stringify(env)).toBeUndefined();
    expect(() => loadAuthenticator(env), JSON.stringify(env)).toThrow("MD_API_KEY");
  }
  // One defined variable is enough, wherever it sits among undefined ones, and an empty string is defined: it fails closed.
  for (const env of [{ MD_JWT_ISSUER: undefined, MD_JWT_UNKNOWN: "1" }, { MD_JWT_ISSUER: undefined, MD_JWT_AUDIENCE: "" }]) {
    expect(() => loadAuthenticator(env), JSON.stringify(env)).toThrow("JWT auth requires");
    expect(() => loadAuthenticator({ ...env, MD_API_KEY: apiKey }), JSON.stringify(env)).toThrow("cannot be combined");
  }
  expect(() => loadAuthenticator({ MD_JWT_ISSUER: "", MD_API_KEY: apiKey })).toThrow("cannot be combined");
  // A complete JWT configuration with an extra undefined variable is unaffected.
  expect(loadAuthenticator(base({ MD_JWT_TOOL_PREFIX: undefined })).mode).toBe("jwt");
});
test("loadConfig builds a JWT deployment from MD_JWT_* variables alone and keeps the other defaults", () => {
  const config = loadConfig(base({ MD_JWT_TOOL_PREFIX: "gw_" }));
  expect(config.authenticator.mode).toBe("jwt");
  expect(config.jobs.maxAgentJobs).toBe(10);
  expect(() => loadConfig(base({ MD_JWT_MAX_TTL_SECONDS: "abc" }))).toThrow("max TTL");
  expect(() => loadConfig(base({ MD_JWT_ALLOW_HTTP_LOCALHOST: "true" }))).toThrow("must be 1 or unset");
  expect(() => loadConfig({})).toThrow("MD_API_KEY");
});
