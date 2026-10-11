/**
 * Static bearer-token authentication (credential registry or one MD_API_KEY) and selection of the authentication mode.
 * Only SHA-256 digests of tokens are kept in memory, and credentials are read once at startup, so changes need a restart.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULT_PRINCIPAL, validatePrincipal, type Principal } from "./identity.js";
import { loadJwtAuthenticator } from "./jwt.js";

/** An authenticated owner. `scopes` and `toolPrefix` are set only in JWT mode; without scopes every tool is allowed (mcp.ts). */
export type AuthenticatedPrincipal = Principal & { scopes?: readonly string[]; toolPrefix?: string };
/**
 * Maps a bearer token (undefined when absent) to its principal, or null. `mode: "jwt"` switches uploads to scoped
 * upload credentials and allows the header-less probe path in http.ts.
 */
export interface Authenticator { mode?: "jwt"; authenticate(token: string | undefined): AuthenticatedPrincipal | null | Promise<AuthenticatedPrincipal | null> }
/** Hex SHA-256 of a token: the `token_sha256` form stored in MD_AUTH_FILE. */
export function hashToken(token: string): string { return createHash("sha256").update(token, "utf8").digest("hex"); }

/**
 * Builds an authenticator from a credential registry: `{"credentials": [{tenant_id, agent_id, token_sha256, disabled?}]}`.
 * Unknown keys, invalid principals, malformed or duplicate digests and an empty list throw; several tokens may map to
 * one principal. A disabled entry never authenticates. Tokens that are empty or longer than 4096 characters are
 * rejected without hashing.
 */
export function createAuthenticator(registry: unknown): Authenticator {
  if (!registry || typeof registry !== "object" || Array.isArray(registry) || Object.keys(registry).some(key => key !== "credentials")) throw new Error("Invalid credential registry");
  const credentials = (registry as Record<string, unknown>).credentials;
  if (!Array.isArray(credentials) || !credentials.length) throw new Error("Credential registry must contain credentials");
  const seen = new Set<string>();
  const entries = credentials.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !["tenant_id", "agent_id", "token_sha256", "disabled"].includes(key))) throw new Error("Invalid credential entry");
    const { tenant_id, agent_id, token_sha256, disabled } = raw;
    const principal = validatePrincipal({ tenantId: tenant_id, agentId: agent_id });
    if (typeof token_sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(token_sha256) || (disabled !== undefined && typeof disabled !== "boolean")) throw new Error("Invalid credential entry");
    const normalized = token_sha256.toLowerCase();
    if (seen.has(normalized)) throw new Error("Duplicate credential hash");
    seen.add(normalized);
    return { principal, digest: Buffer.from(normalized, "hex"), disabled: disabled === true };
  });
  return Object.freeze({
    authenticate(token: string | undefined): Principal | null {
      if (typeof token !== "string" || token.length === 0 || token.length > 4096) return null;
      const digest = Buffer.from(hashToken(token), "hex");
      let match: Principal | null = null;
      // Always compare every entry: no prefix comparisons or plaintext secrets.
      for (const entry of entries) if (timingSafeEqual(digest, entry.digest) && !entry.disabled) match = entry.principal;
      return match;
    },
  });
}

/**
 * Selects the authentication mode from the environment: any MD_JWT_* variable selects JWT (loadJwtAuthenticator);
 * otherwise MD_AUTH_FILE selects the credential registry; otherwise MD_API_KEY (32 to 4096 non-whitespace characters)
 * is the single credential of DEFAULT_PRINCIPAL. Conflicting combinations throw.
 */
export function loadAuthenticator(env: NodeJS.ProcessEnv = process.env): Authenticator {
  // Any MD_JWT_ variable selects JWT mode, even an empty one, so a half-configured deployment fails closed instead of using a static key.
  // Keys whose value is undefined (possible only in a programmatic env object, never in process.env) are treated as unset.
  if (Object.entries(env).some(([name, value]) => name.startsWith("MD_JWT_") && value !== undefined)) return loadJwtAuthenticator(env);
  if (env.MD_AUTH_FILE !== undefined) {
    if (!env.MD_AUTH_FILE || env.MD_API_KEY !== undefined) throw new Error("MD_AUTH_FILE requires a path and cannot be combined with MD_API_KEY");
    let registry: unknown;
    try { registry = JSON.parse(readFileSync(env.MD_AUTH_FILE, "utf8")); } catch { throw new Error("Unable to read MD_AUTH_FILE credential registry"); }
    return createAuthenticator(registry);
  }
  const token = env.MD_API_KEY ?? "";
  if (token.length < 32 || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token)) throw new Error("MD_API_KEY must contain 32 to 4096 non-whitespace characters");
  return createAuthenticator({ credentials: [{ tenant_id: DEFAULT_PRINCIPAL.tenantId, agent_id: DEFAULT_PRINCIPAL.agentId, token_sha256: hashToken(token) }] });
}
