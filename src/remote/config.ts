/**
 * Environment configuration for the remote server, read and validated once at startup. Every problem throws an Error
 * naming the variable, so a misconfigured deployment fails to start instead of running on a fallback.
 */
import fs from "node:fs";
import path from "node:path";
import { loadAuthenticator } from "./auth.js";
import { quotaKey, validatePrincipal, type QuotaOverride } from "./identity.js";
import { parseLockStaleAfterMs } from "./lock.js";

/** Override-file field names, mapped to the QuotaOverride keys they set. */
const overrideFields = { max_jobs: "maxJobs", max_storage_bytes: "maxStorageBytes", max_concurrency: "maxConcurrency" } as const;
/**
 * Ceiling for MD_SHUTDOWN_TIMEOUT_MS before startup warns. The bundled Compose files (compose.remote.yaml,
 * compose.jwt.yaml, compose.multitenant.yaml) set `stop_grace_period: 15s`; a longer shutdown deadline lets the runtime
 * SIGKILL the process first, which leaves the data-volume `.lock` behind. Raise both together.
 */
export const SHUTDOWN_TIMEOUT_WARN_MS = 15_000;
/**
 * The remote server and its operator CLIs ship only as a Linux container image and do not support Windows; on a Windows
 * host, run that image (for example with Docker Desktop). The stdio server is separate and still supports Windows.
 */
export const WINDOWS_UNSUPPORTED_MESSAGE = "The remote server is not supported on Windows. Run the Linux container image (see docs/CONTAINERS.md) instead.";
/**
 * Operator-managed agent-scope caps, read once at startup. Unlisted principals keep the defaults: this is not an
 * allowlist and never grants or denies access. Overrides above a global cap are rejected rather than silently clamped.
 */
export function loadQuotaOverrides(file: string, global: { maxJobs: number; maxStorageBytes: number; concurrency: number; maxOutputBytes: number }) {
  const fail = (reason: string): never => { throw new Error(`MD_QUOTA_OVERRIDES_FILE ${reason}`); };
  if (!file) fail("must be a file path");
  // Read at most one byte past the cap, so an oversized (or growing) file is detected without trusting its stat size.
  const cap = 1024 * 1024;
  let text = "";
  try {
    // One descriptor for check and read: O_NONBLOCK keeps a FIFO from blocking startup, and the read is bounded even if the file grows.
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error();
      const buffer = Buffer.alloc(cap + 1);
      let length = 0, read = 0;
      while (length < buffer.length && (read = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += read;
      if (length > cap) throw new Error();
      text = buffer.toString("utf8", 0, length);
    } finally { fs.closeSync(fd); }
  } catch { fail("must be a readable regular file of at most 1 MiB"); }
  let raw: any;
  try { raw = JSON.parse(text); } catch { fail("must contain valid JSON"); }
  // Expected shape: {"overrides": [{"tenant_id", "agent_id", and at least one of max_jobs, max_storage_bytes, max_concurrency}]},
  // with each principal listed at most once.
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => key !== "overrides") || !Array.isArray(raw.overrides)) fail('must be a JSON object with only an "overrides" array');
  const overrides = new Map<string, QuotaOverride>();
  const caps = { maxJobs: global.maxJobs, maxStorageBytes: global.maxStorageBytes, maxConcurrency: global.concurrency };
  raw.overrides.forEach((entry: any, index: number) => {
    const at = `entry ${index}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`${at} must be an object`);
    const unknown = Object.keys(entry).find(key => key !== "tenant_id" && key !== "agent_id" && !Object.hasOwn(overrideFields, key));
    if (unknown !== undefined) fail(`${at} has unknown field ${JSON.stringify(unknown.slice(0, 64))}`);
    let principal;
    try { principal = validatePrincipal({ tenantId: entry.tenant_id, agentId: entry.agent_id }); } catch { fail(`${at} must have valid tenant_id and agent_id`); }
    const key = quotaKey(principal!);
    if (overrides.has(key)) fail(`${at} duplicates an earlier principal`);
    const override: QuotaOverride = {};
    for (const [field, name] of Object.entries(overrideFields) as [keyof typeof overrideFields, keyof QuotaOverride][]) {
      if (entry[field] === undefined) continue;
      if (!Number.isSafeInteger(entry[field]) || entry[field] <= 0) fail(`${at} ${field} must be a positive safe integer`);
      if (entry[field] > caps[name]) fail(`${at} ${field} exceeds the global cap ${caps[name]}`);
      // Every job reserves its input plus MD_MAX_OUTPUT_BYTES, so a smaller budget could never admit any upload.
      if (field === "max_storage_bytes" && entry[field] < 1 + global.maxOutputBytes) fail(`${at} max_storage_bytes must be at least ${1 + global.maxOutputBytes} (one input byte plus MD_MAX_OUTPUT_BYTES)`);
      override[name] = entry[field];
    }
    if (!Object.keys(override).length) fail(`${at} must set at least one of max_jobs, max_storage_bytes or max_concurrency`);
    overrides.set(key, Object.freeze(override));
  });
  return overrides;
}

/**
 * The Host header values that name a public origin: URL.host, plus `hostname:<default port>` when the origin has no
 * explicit port, since URL.host omits a default port but a client may still send it (Host: example.com:443). Used by
 * loadConfig's default MD_ALLOWED_HOSTS and by createHttpServer when it is given no allowedHosts.
 */
export function publicHostForms(publicUrl: URL) {
  return publicUrl.port ? [publicUrl.host] : [publicUrl.host, `${publicUrl.hostname}:${publicUrl.protocol === "https:" ? 443 : 80}`];
}
/**
 * Reads and validates the remote server configuration from `env`.
 *
 * The authentication mode comes from loadAuthenticator (JWT, credential registry or single MD_API_KEY).
 * MD_PUBLIC_BASE_URL must be a bare HTTP(S) origin: it is the base of upload URLs and the only accepted Origin header.
 * MD_ALLOWED_HOSTS defaults to publicHostForms(origin) plus localhost and 127.0.0.1 on MD_PORT. Numeric settings must be positive safe integers.
 *
 * Quota model (enforced by JobService): every job that is not expired reserves its input size plus MD_MAX_OUTPUT_BYTES,
 * and admission checks the job count and reserved bytes at three independent scopes: global (MD_MAX_JOBS,
 * MD_MAX_STORAGE_BYTES), per tenant (MD_MAX_TENANT_JOBS, MD_MAX_TENANT_STORAGE_BYTES) and per agent (MD_MAX_AGENT_*,
 * or that principal's entry in MD_QUOTA_OVERRIDES_FILE). Concurrency is capped the same way (MD_CONCURRENCY,
 * MD_MAX_TENANT_CONCURRENCY, MD_MAX_AGENT_CONCURRENCY). The tightest scope applies. The tenant and agent caps get the
 * same checks as override entries: a value set above its global cap is rejected, and every storage budget (global,
 * tenant, agent) must be at least 1 + MD_MAX_OUTPUT_BYTES, or no upload could ever be admitted. An unset tenant or agent
 * cap is lowered to its global cap instead of rejected (the tightest scope would apply anyway).
 *
 * MD_LEGACY_OWNER names the owner adopted by job manifests written before jobs had owners.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const integer = (name: string, fallback: number) => {
    const raw = env[name];
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
    return value;
  };
  const authenticator = loadAuthenticator(env);
  let legacyOwner;
  if (env.MD_LEGACY_OWNER !== undefined) {
    try {
      const raw = JSON.parse(env.MD_LEGACY_OWNER);
      if (Object.keys(raw).some(key => !["tenantId", "agentId"].includes(key))) throw new Error();
      legacyOwner = validatePrincipal(raw);
    } catch { throw new Error("MD_LEGACY_OWNER must be a JSON object with valid tenantId and agentId"); }
  }
  const port = integer("MD_PORT", 8000);
  if (port > 65535) throw new Error("MD_PORT must be at most 65535");
  const publicUrl = new URL(env.MD_PUBLIC_BASE_URL ?? `http://localhost:${port}`);
  if (!["http:", "https:"].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== "/") throw new Error("MD_PUBLIC_BASE_URL must be an HTTP(S) origin without credentials, query or path");
  const publicBaseUrl = publicUrl.origin;
  const allowedHosts = env.MD_ALLOWED_HOSTS?.split(",").map(value => value.trim()).filter(Boolean) ?? [...new Set([...publicHostForms(publicUrl), `localhost:${port}`, `127.0.0.1:${port}`])];
  if (!allowedHosts.length || allowedHosts.some(host => /[\s\/\\?#@]/.test(host))) throw new Error("MD_ALLOWED_HOSTS must contain comma-separated Host header values");
  const maxJobs = integer("MD_MAX_JOBS", 100), maxStorageBytes = integer("MD_MAX_STORAGE_BYTES", 256 * 1024 * 1024), concurrency = integer("MD_CONCURRENCY", 2), maxOutputBytes = integer("MD_MAX_OUTPUT_BYTES", 25 * 1024 * 1024);
  // Tenant and agent caps: an explicit value above its global cap is rejected like an override entry; an unset default
  // is lowered to the global cap. A storage budget below one job's reservation is rejected either way.
  const floor = 1 + maxOutputBytes, floorReason = `${floor} (one input byte plus MD_MAX_OUTPUT_BYTES)`;
  if (maxStorageBytes < floor) throw new Error(`MD_MAX_STORAGE_BYTES must be at least ${floorReason}`);
  const scoped = (name: string, fallback: number, capName: string, cap: number) => {
    const set = env[name] !== undefined, value = set ? integer(name, fallback) : Math.min(fallback, cap);
    if (value > cap) throw new Error(`${name} must be at most ${capName} (${cap})`);
    if (capName === "MD_MAX_STORAGE_BYTES" && value < floor) throw new Error(`${name}${set ? "" : ` (default ${value})`} must be at least ${floorReason}`);
    return value;
  };
  const quotaOverrides = env.MD_QUOTA_OVERRIDES_FILE === undefined ? undefined : loadQuotaOverrides(env.MD_QUOTA_OVERRIDES_FILE, { maxJobs, maxStorageBytes, concurrency, maxOutputBytes });
  return {
    authenticator, publicBaseUrl, allowedHosts, port, host: env.MD_HOST ?? "127.0.0.1",
    shutdownTimeoutMs: integer("MD_SHUTDOWN_TIMEOUT_MS", 10_000),
    // Age after which a data-directory lock that is no longer refreshed is reclaimed at startup (lock.ts); 0 never reclaims.
    lockStaleAfterMs: parseLockStaleAfterMs(env.MD_LOCK_STALE_AFTER_MS),
    jobs: {
      dataDir: path.resolve(env.MD_DATA_DIR ?? "./data"),
      maxUploadBytes: integer("MD_MAX_UPLOAD_BYTES", 25 * 1024 * 1024),
      maxStorageBytes,
      maxJobs,
      retentionMs: integer("MD_RETENTION_MS", 24 * 60 * 60 * 1000),
      uploadTtlMs: integer("MD_UPLOAD_TTL_MS", 15 * 60 * 1000),
      conversionTimeoutMs: integer("MD_CONVERSION_TIMEOUT_MS", 120_000),
      maxOutputBytes,
      concurrency,
      maxTenantJobs: scoped("MD_MAX_TENANT_JOBS", 25, "MD_MAX_JOBS", maxJobs),
      maxTenantStorageBytes: scoped("MD_MAX_TENANT_STORAGE_BYTES", 128 * 1024 * 1024, "MD_MAX_STORAGE_BYTES", maxStorageBytes),
      maxTenantConcurrency: scoped("MD_MAX_TENANT_CONCURRENCY", 1, "MD_CONCURRENCY", concurrency),
      maxAgentJobs: scoped("MD_MAX_AGENT_JOBS", 10, "MD_MAX_JOBS", maxJobs),
      maxAgentStorageBytes: scoped("MD_MAX_AGENT_STORAGE_BYTES", 128 * 1024 * 1024, "MD_MAX_STORAGE_BYTES", maxStorageBytes),
      maxAgentConcurrency: scoped("MD_MAX_AGENT_CONCURRENCY", 1, "MD_CONCURRENCY", concurrency),
      legacyOwner,
      quotaOverrides,
    },
  };
}
