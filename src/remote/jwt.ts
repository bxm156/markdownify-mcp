import { createRemoteJWKSet, customFetch, jwtVerify, type FetchImplementation, type JWTVerifyGetKey } from "jose";
import { validatePrincipal, type Principal } from "./identity.js";
import type { Authenticator, AuthenticatedPrincipal } from "./auth.js";

// LiteLLM's signature is what makes `sub` trustworthy, so the verified subject is the owner: one tenant and
// agent per LiteLLM user ID. `litellm-proxy` is LiteLLM's shared fallback for keys without a user and is never an owner.
export function subjectPrincipal(sub: unknown): Principal | null {
  if (typeof sub !== "string" || sub === "litellm-proxy") return null;
  try { return validatePrincipal({ tenantId: sub, agentId: sub }); } catch { return null; }
}
function trustedUrl(value: string, allowLoopback: boolean) {
  const u = new URL(value);
  if (u.username || u.password || u.hash || u.search || (u.protocol !== "https:" && !(allowLoopback && u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))) throw new Error("JWT issuer/JWKS URLs require HTTPS (explicit loopback HTTP is test-only)");
  return u;
}
const boundedJwksFetch: FetchImplementation = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status !== 200 || !response.body) return response;
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 256 * 1024) throw new Error("JWKS response too large"); chunks.push(value); }
    return new Response(Buffer.concat(chunks), { status: 200, headers: { "Content-Type": "application/json" } });
  } finally { await reader.cancel().catch(() => undefined); }
};
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
export function loadJwtAuthenticator(env: NodeJS.ProcessEnv): Authenticator {
  if (env.MD_AUTH_FILE !== undefined || env.MD_API_KEY !== undefined) throw new Error("JWT auth cannot be combined with MD_AUTH_FILE or MD_API_KEY");
  if (!env.MD_JWT_ISSUER || !env.MD_JWT_AUDIENCE || !env.MD_JWT_JWKS_URL) throw new Error("JWT auth requires MD_JWT_ISSUER, MD_JWT_AUDIENCE and MD_JWT_JWKS_URL");
  if (env.MD_JWT_ALLOW_HTTP_LOCALHOST !== undefined && env.MD_JWT_ALLOW_HTTP_LOCALHOST !== "1") throw new Error("MD_JWT_ALLOW_HTTP_LOCALHOST must be 1 or unset");
  return createJwtAuthenticator({ issuer: env.MD_JWT_ISSUER, audience: env.MD_JWT_AUDIENCE, jwksUrl: env.MD_JWT_JWKS_URL, maxTtlSeconds: env.MD_JWT_MAX_TTL_SECONDS === undefined ? 300 : Number(env.MD_JWT_MAX_TTL_SECONDS), allowLoopback: env.MD_JWT_ALLOW_HTTP_LOCALHOST === "1", toolPrefix: env.MD_JWT_TOOL_PREFIX });
}
