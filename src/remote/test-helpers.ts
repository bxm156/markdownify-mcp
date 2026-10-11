import { expect } from "bun:test";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, type CryptoKey, type JWK } from "jose";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type RequestListener } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Authenticator } from "./auth.js";
import { createHttpServer } from "./http.js";
import { JobService } from "./jobs.js";
import { createJwtAuthenticator } from "./jwt.js";

/** Shared test utilities. Not imported by production code. */

export type WaitForOptions = { timeoutMs?: number; intervalMs?: number; label?: string };

/**
 * Poll `predicate` until it returns a truthy value and return that value.
 * A predicate that throws counts as "not yet"; the last error is reported if the deadline passes.
 * Prefer this over fixed sleeps so tests wait for the actual state change.
 */
/** The truthy members of T: `cond && value` predicates resolve to the value type alone. */
export type Truthy<T> = Exclude<T, false | 0 | 0n | "" | null | undefined>;

export async function waitFor<T>(predicate: () => T | Promise<T>, { timeoutMs = 2000, intervalMs = 5, label = "condition" }: WaitForOptions = {}): Promise<Truthy<T>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value as Truthy<T>;
    } catch (error) { lastError = error; }
    if (Date.now() >= deadline) {
      const cause = lastError instanceof Error ? `: ${lastError.message}` : "";
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}${cause}`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/** A port that was free a moment ago and now refuses connections. */
export async function closedPort(): Promise<number> {
  const server = createServer(); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port; await new Promise<void>(r => server.close(() => r())); return port;
}

/** Parsed JSON body of a tool result's first text block. */
export const toolJson = (result: any) => JSON.parse(result.content[0].text);
/** Parsed tool result, asserting it is not an error. */
export function toolOk(result: any) { expect(result.isError).not.toBe(true); return toolJson(result); }
/** `error_info.code` of a tool result, asserting it is an error. */
export function toolErrorCode(result: any): string { expect(result.isError).toBe(true); return toolJson(result).error_info.code; }
/** Raw MCP `initialize` POST with the given Authorization header value. */
export function mcpInitialize(base: string, authorization: string) {
  return fetch(`${base}/mcp`, { method: "POST", headers: { Host: "127.0.0.1", Authorization: authorization, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "1" } } }) });
}

export type JwtFixtureOptions = {
  issuer?: string; audience?: string;
  /** `kid` of the published key and of tokens signed by default. */
  kid?: string;
  /** Default `scope` claim of signed tokens. */
  scope?: string;
  /** Scope of tokens used by `deployment().client()`; defaults to `scope`. */
  clientScope?: string;
  /** Extra default claims for every signed token (overridden by per-call changes). */
  claims?: Record<string, unknown>;
};
export type JwtDeploymentOptions = {
  /** JobService option overrides on top of the defaults (large limits, converter that copies input to output). */
  jobs?: Record<string, unknown>;
};
export type JwtFixture = Awaited<ReturnType<typeof createJwtFixture>>;

/**
 * Everything the JWT test files share: one RS256 key pair, token signing, authenticators, local JWKS servers and a
 * JobService + HTTP server deployment with an MCP client factory that connects with freshly signed tokens.
 * `close()` disposes every server, deployment and client created through the fixture (in reverse order) and leaves the
 * key pair usable, so call it from `afterEach`. Register extra cleanups with `defer()`.
 */
export async function createJwtFixture({ issuer = "https://litellm.test", audience = "markdownify", kid = "first", scope = "mcp:tools/list mcp:tools/call", clientScope = scope, claims: baseClaims = {} }: JwtFixtureOptions = {}) {
  const key = await generateKeyPair("RS256", { extractable: true });
  const publicJwk: JWK = { ...await exportJWK(key.publicKey), kid, alg: "RS256", use: "sig" };
  const disposers: Array<() => Promise<unknown>> = [];
  const defer = (dispose: () => Promise<unknown>) => { disposers.push(dispose); };
  const close = async () => { while (disposers.length) await disposers.pop()!(); };
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  /** Default claims (iat now, 300 s lifetime) merged with `changes`; an `undefined` value drops the claim from the signed token. */
  function claims(changes: Record<string, unknown> = {}) {
    const now = nowSeconds();
    return { iss: issuer, aud: audience, sub: "machine-a", iat: now, exp: now + 300, scope, ...baseClaims, ...changes };
  }
  /** Sign `claims(changes)` with the given protected header and key (default: RS256, the fixture kid and key). */
  async function sign(changes: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: "RS256", kid }, signingKey: CryptoKey | Uint8Array = key.privateKey) {
    return new SignJWT(claims(changes)).setProtectedHeader(header as any).sign(signingKey);
  }
  /** Authenticator that trusts exactly the fixture public key. */
  const verifier = (extra: Partial<Parameters<typeof createJwtAuthenticator>[0]> = {}) => createJwtAuthenticator({ issuer, audience, getKey: createLocalJWKSet({ keys: [publicJwk] }), ...extra });
  /** Authenticator that fetches `jwksUrl` over loopback HTTP. */
  const remoteVerifier = (jwksUrl: string, extra: Partial<Parameters<typeof createJwtAuthenticator>[0]> = {}) => createJwtAuthenticator({ issuer, audience, jwksUrl, allowLoopback: true, ...extra });

  /** Loopback HTTP server closed by `close()`. */
  async function serve(handler: RequestListener) {
    const server = createServer(handler);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    defer(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
    const port = (server.address() as { port: number }).port;
    return { port, url: `http://127.0.0.1:${port}` };
  }
  /** Local JWKS endpoint at `url`; the served key set is mutable through `setKeys` and every request is counted. */
  async function serveJwks(initial: JWK[] = [publicJwk]) {
    let keys = initial, requests = 0;
    const server = await serve((_req, res) => { requests++; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ keys })); });
    return { url: `${server.url}/jwks`, requests: () => requests, setKeys: (next: JWK[]) => { keys = next; } };
  }

  async function deployment(auth: Authenticator = verifier(), { jobs = {} }: JwtDeploymentOptions = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-jwt-"));
    const options = { dataDir, maxUploadBytes: 1000, maxOutputBytes: 1000, maxStorageBytes: 1_000_000, maxJobs: 50, retentionMs: 3_600_000, uploadTtlMs: 3_600_000, conversionTimeoutMs: 1000, concurrency: 1, converter: async (input: string, output: string) => { await fs.writeFile(output, await fs.readFile(input)); }, ...jobs };
    const service = new JobService(options); await service.init();
    const httpOptions = { authenticator: auth, publicBaseUrl: "http://127.0.0.1", allowedHosts: ["127.0.0.1"] };
    const server = createHttpServer(service, httpOptions); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; httpOptions.publicBaseUrl = base;
    defer(async () => { await service.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await fs.rm(dataDir, { recursive: true, force: true }); });
    /** MCP client authenticated as `subject` with a freshly signed token. */
    async function client(subject = "machine-a", tokenScope = clientScope) {
      const c = new Client({ name: "jwt-agent", version: "1" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Host: "127.0.0.1", Authorization: `Bearer ${await sign({ sub: subject, scope: tokenScope })}` } } }));
      defer(() => c.close()); return c;
    }
    /** PUT one byte using an upload grant's own headers, optionally replacing Authorization. */
    const put = (upload: any, bearer?: string) => fetch(upload.upload_url, { method: "PUT", headers: { ...upload.required_headers, Host: "127.0.0.1", ...(bearer ? { Authorization: bearer } : {}) }, body: "x" });
    return { service, options, base, client, put };
  }

  return { issuer, audience, kid, scope, key, publicJwk, nowSeconds, claims, sign, verifier, remoteVerifier, serve, serveJwks, deployment, defer, close };
}
