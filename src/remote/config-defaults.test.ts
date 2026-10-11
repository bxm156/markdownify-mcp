import { expect, test } from "bun:test";
import path from "node:path";
import { loadConfig } from "./config.js";

const MiB = 1024 * 1024;
const env = { MD_API_KEY: "a".repeat(32) };

test("every numeric default is pinned, including storage, concurrency and timing", () => {
  const config = loadConfig(env);
  expect(config.port).toBe(8000);
  expect(config.host).toBe("127.0.0.1");
  expect(config.shutdownTimeoutMs).toBe(10_000);
  expect(config.publicBaseUrl).toBe("http://localhost:8000");
  expect(config.allowedHosts).toEqual(["localhost:8000", "localhost:8000", "127.0.0.1:8000"]);
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
    MD_MAX_UPLOAD_BYTES: ["maxUploadBytes", 11], MD_MAX_STORAGE_BYTES: ["maxStorageBytes", 22], MD_MAX_JOBS: ["maxJobs", 33], MD_RETENTION_MS: ["retentionMs", 44], MD_UPLOAD_TTL_MS: ["uploadTtlMs", 55],
    MD_CONVERSION_TIMEOUT_MS: ["conversionTimeoutMs", 66], MD_MAX_OUTPUT_BYTES: ["maxOutputBytes", 77], MD_CONCURRENCY: ["concurrency", 88],
    MD_MAX_TENANT_JOBS: ["maxTenantJobs", 1], MD_MAX_TENANT_STORAGE_BYTES: ["maxTenantStorageBytes", 2], MD_MAX_TENANT_CONCURRENCY: ["maxTenantConcurrency", 3],
    MD_MAX_AGENT_JOBS: ["maxAgentJobs", 4], MD_MAX_AGENT_STORAGE_BYTES: ["maxAgentStorageBytes", 5], MD_MAX_AGENT_CONCURRENCY: ["maxAgentConcurrency", 6],
  } as const;
  const defaults = loadConfig(env).jobs as Record<string, unknown>;
  for (const [name, [field, value]] of Object.entries(overrides)) {
    const jobs = loadConfig({ ...env, [name]: String(value) }).jobs as Record<string, unknown>;
    expect(jobs[field], name).toBe(value);
    for (const other of Object.keys(jobs)) if (other !== field) expect(jobs[other], `${name} leaked into ${other}`).toEqual(defaults[other]);
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
