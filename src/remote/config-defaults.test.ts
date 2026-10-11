import { expect, test } from "bun:test";
import path from "node:path";
import fs from "node:fs/promises";
import { loadConfig, SHUTDOWN_TIMEOUT_WARN_MS } from "./config.js";
import { DEFAULT_LOCK_STALE_AFTER_MS, HEARTBEAT_MS } from "./lock.js";

const MiB = 1024 * 1024;
const env = { MD_API_KEY: "a".repeat(32) };

test("every numeric default is pinned, including storage, concurrency and timing", () => {
  const config = loadConfig(env);
  expect(config.port).toBe(8000);
  expect(config.host).toBe("127.0.0.1");
  expect(config.shutdownTimeoutMs).toBe(10_000);
  expect(config.lockStaleAfterMs).toBe(60_000);
  expect(config.publicBaseUrl).toBe("http://localhost:8000");
  expect(config.allowedHosts).toEqual(["localhost:8000", "127.0.0.1:8000"]);
  expect(config.jobs).toEqual({
    dataDir: path.resolve("./data"),
    maxUploadBytes: 25 * MiB,
    maxStorageBytes: 256 * MiB,
    maxJobs: 100,
    retentionMs: 24 * 60 * 60 * 1000,
    uploadTtlMs: 15 * 60 * 1000,
    conversionTimeoutMs: 120_000,
    maxOutputBytes: 25 * MiB,
    concurrency: 2,
    maxTenantJobs: 25,
    maxTenantStorageBytes: 128 * MiB,
    maxTenantConcurrency: 1,
    maxAgentJobs: 10,
    maxAgentStorageBytes: 128 * MiB,
    maxAgentConcurrency: 1,
    legacyOwner: undefined,
    quotaOverrides: undefined,
  });
});
test("default per-scope caps never exceed the next wider scope", () => {
  const { jobs } = loadConfig(env);
  expect(jobs.maxAgentJobs).toBeLessThanOrEqual(jobs.maxTenantJobs);
  expect(jobs.maxTenantJobs).toBeLessThanOrEqual(jobs.maxJobs);
  expect(jobs.maxAgentStorageBytes).toBeLessThanOrEqual(jobs.maxTenantStorageBytes);
  expect(jobs.maxTenantStorageBytes).toBeLessThanOrEqual(jobs.maxStorageBytes);
  expect(jobs.maxAgentConcurrency).toBeLessThanOrEqual(jobs.maxTenantConcurrency);
  expect(jobs.maxTenantConcurrency).toBeLessThanOrEqual(jobs.concurrency);
  // One job reserves its input plus the output cap, so the default budget must admit at least one maximal upload.
  expect(jobs.maxAgentStorageBytes).toBeGreaterThanOrEqual(jobs.maxUploadBytes + jobs.maxOutputBytes);
});
test("each default can be overridden independently through its environment variable", () => {
  const overrides = {
    // Values stay within the global caps and above the 1 + MD_MAX_OUTPUT_BYTES storage floor, so no other field moves.
    MD_MAX_UPLOAD_BYTES: ["maxUploadBytes", 11], MD_MAX_STORAGE_BYTES: ["maxStorageBytes", 222 * MiB], MD_MAX_JOBS: ["maxJobs", 33], MD_RETENTION_MS: ["retentionMs", 44], MD_UPLOAD_TTL_MS: ["uploadTtlMs", 55],
    MD_CONVERSION_TIMEOUT_MS: ["conversionTimeoutMs", 66], MD_MAX_OUTPUT_BYTES: ["maxOutputBytes", 77], MD_CONCURRENCY: ["concurrency", 88],
    MD_MAX_TENANT_JOBS: ["maxTenantJobs", 1], MD_MAX_TENANT_STORAGE_BYTES: ["maxTenantStorageBytes", 64 * MiB], MD_MAX_TENANT_CONCURRENCY: ["maxTenantConcurrency", 2],
    MD_MAX_AGENT_JOBS: ["maxAgentJobs", 4], MD_MAX_AGENT_STORAGE_BYTES: ["maxAgentStorageBytes", 32 * MiB], MD_MAX_AGENT_CONCURRENCY: ["maxAgentConcurrency", 2],
  } as const;
  const defaults = loadConfig(env).jobs as Record<string, unknown>;
  for (const [name, [field, value]] of Object.entries(overrides)) {
    const jobs = loadConfig({ ...env, [name]: String(value) }).jobs as Record<string, unknown>;
    expect(jobs[field], name).toBe(value);
    for (const other of Object.keys(jobs)) if (other !== field) expect(jobs[other], `${name} leaked into ${other}`).toEqual(defaults[other]);
  }
});
test("the default shutdown deadline sits below the warning ceiling, which matches every bundled Compose stop_grace_period", async () => {
  expect(loadConfig(env).shutdownTimeoutMs).toBeLessThan(SHUTDOWN_TIMEOUT_WARN_MS);
  const root = path.resolve(import.meta.dir, "../..");
  const files = ["compose.remote.yaml", "compose.jwt.yaml", "compose.multitenant.yaml"];
  for (const file of files) {
    const grace = [...(await fs.readFile(path.join(root, file), "utf8")).matchAll(/^\s*stop_grace_period:\s*(\d+)s\s*$/gm)].map(match => Number(match[1]) * 1000);
    expect(grace, file).toEqual([SHUTDOWN_TIMEOUT_WARN_MS]);
  }
});
test("MD_SHUTDOWN_TIMEOUT_MS overrides only the shutdown deadline", () => {
  const changed = loadConfig({ ...env, MD_SHUTDOWN_TIMEOUT_MS: "1234" }), defaults = loadConfig(env);
  expect(changed.shutdownTimeoutMs).toBe(1234);
  expect(changed.jobs).toEqual(defaults.jobs);
  expect([changed.port, changed.host]).toEqual([defaults.port, defaults.host]);
});
test("every numeric setting rejects empty, zero, negative, fractional and non-numeric values", () => {
  for (const name of ["MD_PORT", "MD_SHUTDOWN_TIMEOUT_MS", "MD_MAX_UPLOAD_BYTES", "MD_MAX_STORAGE_BYTES", "MD_MAX_JOBS", "MD_RETENTION_MS", "MD_UPLOAD_TTL_MS", "MD_CONVERSION_TIMEOUT_MS", "MD_MAX_OUTPUT_BYTES", "MD_CONCURRENCY", "MD_MAX_TENANT_JOBS", "MD_MAX_TENANT_STORAGE_BYTES", "MD_MAX_TENANT_CONCURRENCY", "MD_MAX_AGENT_JOBS", "MD_MAX_AGENT_STORAGE_BYTES", "MD_MAX_AGENT_CONCURRENCY"]) {
    for (const value of ["", "0", "-1", "1.5", "abc", "NaN", "Infinity"]) expect(() => loadConfig({ ...env, [name]: value }), `${name}=${JSON.stringify(value)}`).toThrow(name);
  }
});
test("tenant and agent caps are checked like override entries: never above the global cap, never below one job's storage", () => {
  const floor = 25 * MiB + 1;
  for (const [name, value, message] of [
    ["MD_MAX_TENANT_JOBS", "101", "MD_MAX_TENANT_JOBS must be at most MD_MAX_JOBS (100)"], ["MD_MAX_AGENT_JOBS", "101", "MD_MAX_AGENT_JOBS must be at most MD_MAX_JOBS (100)"],
    ["MD_MAX_TENANT_CONCURRENCY", "3", "MD_MAX_TENANT_CONCURRENCY must be at most MD_CONCURRENCY (2)"], ["MD_MAX_AGENT_CONCURRENCY", "3", "MD_MAX_AGENT_CONCURRENCY must be at most MD_CONCURRENCY (2)"],
    ["MD_MAX_TENANT_STORAGE_BYTES", String(256 * MiB + 1), `MD_MAX_TENANT_STORAGE_BYTES must be at most MD_MAX_STORAGE_BYTES (${256 * MiB})`],
    ["MD_MAX_AGENT_STORAGE_BYTES", String(256 * MiB + 1), `MD_MAX_AGENT_STORAGE_BYTES must be at most MD_MAX_STORAGE_BYTES (${256 * MiB})`],
    ["MD_MAX_TENANT_STORAGE_BYTES", String(floor - 1), `MD_MAX_TENANT_STORAGE_BYTES must be at least ${floor} (one input byte plus MD_MAX_OUTPUT_BYTES)`],
    ["MD_MAX_AGENT_STORAGE_BYTES", String(floor - 1), `MD_MAX_AGENT_STORAGE_BYTES must be at least ${floor} (one input byte plus MD_MAX_OUTPUT_BYTES)`],
    ["MD_MAX_STORAGE_BYTES", String(floor - 1), `MD_MAX_STORAGE_BYTES must be at least ${floor} (one input byte plus MD_MAX_OUTPUT_BYTES)`],
  ] as const) expect(() => loadConfig({ ...env, [name]: value }), `${name}=${value}`).toThrow(message);
  // Exactly at the cap or the floor is accepted.
  const edge = loadConfig({ ...env, MD_MAX_TENANT_JOBS: "100", MD_MAX_AGENT_CONCURRENCY: "2", MD_MAX_TENANT_STORAGE_BYTES: String(256 * MiB), MD_MAX_AGENT_STORAGE_BYTES: String(floor) }).jobs;
  expect([edge.maxTenantJobs, edge.maxAgentConcurrency, edge.maxTenantStorageBytes, edge.maxAgentStorageBytes]).toEqual([100, 2, 256 * MiB, floor]);
});
test("unset tenant and agent caps are lowered to a smaller global cap, but a default storage budget below one job is an error", () => {
  const lowered = loadConfig({ ...env, MD_MAX_JOBS: "5", MD_CONCURRENCY: "1", MD_MAX_STORAGE_BYTES: String(100 * MiB) }).jobs;
  expect([lowered.maxTenantJobs, lowered.maxAgentJobs, lowered.maxTenantConcurrency, lowered.maxAgentConcurrency]).toEqual([5, 5, 1, 1]);
  expect([lowered.maxTenantStorageBytes, lowered.maxAgentStorageBytes]).toEqual([100 * MiB, 100 * MiB]);
  // A 200 MiB output cap needs 200 MiB + 1 per job: the 128 MiB tenant default could never admit an upload.
  const big = { ...env, MD_MAX_OUTPUT_BYTES: String(200 * MiB), MD_MAX_STORAGE_BYTES: String(1024 * MiB) };
  expect(() => loadConfig(big)).toThrow(`MD_MAX_TENANT_STORAGE_BYTES (default ${128 * MiB}) must be at least ${200 * MiB + 1}`);
  expect(() => loadConfig({ ...big, MD_MAX_TENANT_STORAGE_BYTES: String(512 * MiB) })).toThrow(`MD_MAX_AGENT_STORAGE_BYTES (default ${128 * MiB}) must be at least ${200 * MiB + 1}`);
  expect(loadConfig({ ...big, MD_MAX_TENANT_STORAGE_BYTES: String(512 * MiB), MD_MAX_AGENT_STORAGE_BYTES: String(256 * MiB) }).jobs.maxAgentStorageBytes).toBe(256 * MiB);
});
test("the default Host allowlist accepts the public host with and without its default port", () => {
  expect(loadConfig({ ...env, MD_PUBLIC_BASE_URL: "https://files.example" }).allowedHosts).toEqual(["files.example", "files.example:443", "localhost:8000", "127.0.0.1:8000"]);
  expect(loadConfig({ ...env, MD_PUBLIC_BASE_URL: "http://files.example:80" }).allowedHosts).toEqual(["files.example", "files.example:80", "localhost:8000", "127.0.0.1:8000"]);
  expect(loadConfig({ ...env, MD_PUBLIC_BASE_URL: "https://[::1]" }).allowedHosts).toEqual(["[::1]", "[::1]:443", "localhost:8000", "127.0.0.1:8000"]);
  // A non-default port is kept as given and gets no bare form; an explicit MD_ALLOWED_HOSTS replaces the default list.
  expect(loadConfig({ ...env, MD_PUBLIC_BASE_URL: "https://files.example:8443" }).allowedHosts).toEqual(["files.example:8443", "localhost:8000", "127.0.0.1:8000"]);
  expect(loadConfig({ ...env, MD_PUBLIC_BASE_URL: "https://files.example", MD_ALLOWED_HOSTS: "files.example" }).allowedHosts).toEqual(["files.example"]);
});
test("MD_LOCK_STALE_AFTER_MS defaults to 60 s, accepts 0 (never reclaim) or at least three heartbeats, and changes nothing else", () => {
  expect(DEFAULT_LOCK_STALE_AFTER_MS).toBe(60_000);
  const defaults = loadConfig(env);
  for (const [raw, value] of [["0", 0], [String(3 * HEARTBEAT_MS), 15_000], ["120000", 120_000]] as const) {
    const changed = loadConfig({ ...env, MD_LOCK_STALE_AFTER_MS: raw });
    expect(changed.lockStaleAfterMs).toBe(value);
    expect({ ...changed, lockStaleAfterMs: defaults.lockStaleAfterMs, authenticator: undefined }).toEqual({ ...defaults, authenticator: undefined });
  }
  // Below three heartbeats a live holder could be taken for a dead one.
  for (const raw of ["", " ", "-1", "1", "14999", "1.5", "abc", "NaN", "Infinity"]) expect(() => loadConfig({ ...env, MD_LOCK_STALE_AFTER_MS: raw }), JSON.stringify(raw)).toThrow("MD_LOCK_STALE_AFTER_MS must be 0 (never reclaim) or an integer of at least 15000");
});
