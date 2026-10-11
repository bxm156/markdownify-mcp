/**
 * JWT authentication for deployments behind a LiteLLM gateway that signs a short-lived RS256 token per user.
 *
 * A token authenticates only when all of these hold; anything else yields null, never an error or a diagnostic:
 *  - it is at most 16384 characters and its protected header has none of jku, x5u, jwk, x5c or crit;
 *  - its RS256 signature verifies with a key from the pinned resolver (the configured JWKS URL, or an injected key set),
 *    and the header has a non-empty string `kid` of at most 256 characters;
 *  - iss, aud, sub, iat and exp are present; `iss` equals the configured issuer and `aud` is exactly the configured
 *    audience string (an array is refused);
 *  - iat and exp are integers, exp is in the future with no clock tolerance, exp > iat, both exp - iat and the token's
 *    age are at most the max TTL, and iat is at most 5 s in the future;
 *  - `sub` names a valid principal other than `litellm-proxy`, and becomes both the tenant and the agent ID;
 *  - `scope` is a string of at most 8192 characters that includes mcp:tools/list or mcp:tools/call.
 * Issuer and JWKS URLs must be HTTPS without credentials, query or fragment; loopback HTTP is allowed only for tests.
 */
import { createRemoteJWKSet, customFetch, decodeProtectedHeader, jwtVerify, type FetchImplementation, type JWTVerifyGetKey } from "jose";
import { validatePrincipal, type Principal } from "./identity.js";
import type { Authenticator, AuthenticatedPrincipal } from "./auth.js";

// LiteLLM's signature is what makes `sub` trustworthy, so the verified subject is the owner: one tenant and
// agent per LiteLLM user ID. `litellm-proxy` is LiteLLM's shared fallback for keys without a user and is never an owner.
/** The owner named by a verified `sub` claim, or null when that subject cannot own jobs. */
export function subjectPrincipal(sub: unknown): Principal | null {
  if (typeof sub !== "string" || sub === "litellm-proxy") return null;
  try { return validatePrincipal({ tenantId: sub, agentId: sub }); } catch { return null; }
}
// Headers that would move key selection into the token. Keys only ever come from the pinned resolver, so these are never
// honoured; rejecting them outright keeps that true even if key resolution changes, and flags a token that was crafted to probe it.
const keySourceHeaders = ["jku", "x5u", "jwk", "x5c"] as const;
// No header extension is ever understood, so any `crit` member (whatever its value) is refused alongside them, before
// the key resolver runs: such a token can never verify, and it should not cost a key lookup or JWKS fetch to find out.
const rejectedHeaders = [...keySourceHeaders, "crit"] as const;
/** Parses an issuer or JWKS URL, requiring HTTPS without credentials, query or fragment (loopback HTTP only when allowed). */
function trustedUrl(value: string, allowLoopback: boolean) {
  const u = new URL(value);
  if (u.username || u.password || u.hash || u.search || (u.protocol !== "https:" && !(allowLoopback && u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))) throw new Error("JWT issuer/JWKS URLs require HTTPS (explicit loopback HTTP is test-only)");
  return u;
}
/**
 * JWKS fetch that buffers at most 256 KiB of a 200 response, so a broken or hostile endpoint cannot exhaust memory.
 * Any other status passes through unread for jose to reject.
 */
const boundedJwksFetch: FetchImplementation = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status !== 200 || !response.body) return response;
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 256 * 1024) throw new Error("JWKS response too large"); chunks.push(value); }
    return new Response(Buffer.concat(chunks), { status: 200, headers: { "Content-Type": "application/json" } });
  } finally { await reader.cancel().catch(() => undefined); }
};
/**
 * Builds the JWT authenticator; the acceptance rules are in the module comment. `getKey` replaces the remote JWKS
 * (tests). Remote keys are cached for 60 s, refetched at most once per 5 s (an unknown `kid` triggers a refetch) and
 * each fetch times out after 5 s. `maxTtlSeconds` (default 300, at most 3600) bounds token lifetime and age.
 * `toolPrefix` (default "markdownify-", may be empty) is the alias prefix accepted in per-tool scopes.
 */
export function createJwtAuthenticator(options: { issuer: string; audience: string; jwksUrl?: string; getKey?: JWTVerifyGetKey; maxTtlSeconds?: number; allowLoopback?: boolean; toolPrefix?: string }): Authenticator {
  trustedUrl(options.issuer, options.allowLoopback === true);
  if (!options.audience || options.audience.length > 512) throw new Error("JWT audience is required");
  const maxTtl = options.maxTtlSeconds ?? 300;
  if (!Number.isSafeInteger(maxTtl) || maxTtl < 1 || maxTtl > 3600) throw new Error("JWT max TTL must be 1 to 3600 seconds");
  const toolPrefix = options.toolPrefix ?? "markdownify-";
  if (!/^[A-Za-z0-9_-]{0,64}$/.test(toolPrefix)) throw new Error("Invalid JWT tool prefix");
  const key = options.getKey ?? createRemoteJWKSet(trustedUrl(options.jwksUrl ?? "", options.allowLoopback === true), { timeoutDuration: 5000, cooldownDuration: 5000, cacheMaxAge: 60000, [customFetch]: boundedJwksFetch });
  return Object.freeze({
    mode: "jwt" as const,
    async authenticate(token: string | undefined): Promise<AuthenticatedPrincipal | null> {
      if (!token || token.length > 16384) return null;
      try {
        const header = decodeProtectedHeader(token);
        if (rejectedHeaders.some(name => Object.hasOwn(header, name))) return null;
        const { payload, protectedHeader } = await jwtVerify(token, key, { algorithms: ["RS256"], issuer: options.issuer, audience: options.audience, requiredClaims: ["iss", "aud", "sub", "iat", "exp"], maxTokenAge: maxTtl, clockTolerance: 5 });
        const now = Date.now() / 1000;
        if (payload.aud !== options.audience || typeof protectedHeader.kid !== "string" || !protectedHeader.kid || protectedHeader.kid.length > 256 || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.exp! <= now || payload.exp! <= payload.iat! || payload.exp! - payload.iat! > maxTtl || payload.iat! > now + 5) return null;
        const principal = subjectPrincipal(payload.sub);
        if (!principal || typeof payload.scope !== "string" || payload.scope.length > 8192) return null;
        const scopes = payload.scope.split(/\s+/).filter(Boolean);
        if (!scopes.includes("mcp:tools/list") && !scopes.includes("mcp:tools/call")) return null;
        return Object.freeze({ ...principal, scopes: Object.freeze(scopes), toolPrefix });
      } catch { return null; } // Never expose signatures, claims, URLs or JWKS diagnostics.
    },
  });
}
/**
 * JWT mode from the environment. MD_JWT_ISSUER, MD_JWT_AUDIENCE and MD_JWT_JWKS_URL are required; MD_JWT_MAX_TTL_SECONDS,
 * MD_JWT_TOOL_PREFIX and MD_JWT_ALLOW_HTTP_LOCALHOST=1 (tests only) are optional. Cannot be combined with MD_AUTH_FILE or
 * MD_API_KEY.
 */
export function loadJwtAuthenticator(env: NodeJS.ProcessEnv): Authenticator {
  if (env.MD_AUTH_FILE !== undefined || env.MD_API_KEY !== undefined) throw new Error("JWT auth cannot be combined with MD_AUTH_FILE or MD_API_KEY");
  if (!env.MD_JWT_ISSUER || !env.MD_JWT_AUDIENCE || !env.MD_JWT_JWKS_URL) throw new Error("JWT auth requires MD_JWT_ISSUER, MD_JWT_AUDIENCE and MD_JWT_JWKS_URL");
  if (env.MD_JWT_ALLOW_HTTP_LOCALHOST !== undefined && env.MD_JWT_ALLOW_HTTP_LOCALHOST !== "1") throw new Error("MD_JWT_ALLOW_HTTP_LOCALHOST must be 1 or unset");
  return createJwtAuthenticator({ issuer: env.MD_JWT_ISSUER, audience: env.MD_JWT_AUDIENCE, jwksUrl: env.MD_JWT_JWKS_URL, maxTtlSeconds: env.MD_JWT_MAX_TTL_SECONDS === undefined ? 300 : Number(env.MD_JWT_MAX_TTL_SECONDS), allowLoopback: env.MD_JWT_ALLOW_HTTP_LOCALHOST === "1", toolPrefix: env.MD_JWT_TOOL_PREFIX });
}
