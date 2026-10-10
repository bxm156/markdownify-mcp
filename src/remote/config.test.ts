import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.js";

describe("remote configuration", () => {
  const env = { MD_API_KEY: "a".repeat(32) };
  test("safe defaults and explicit host allowlist", () => {
    const config = loadConfig(env);
    expect(config.host).toBe("127.0.0.1");
    expect(config.allowedHosts).toContain("localhost:8000");
    expect(config.jobs.maxUploadBytes).toBe(25 * 1024 * 1024);
    expect(config.jobs.maxTenantJobs).toBe(25);
    expect(config.jobs.maxAgentJobs).toBe(10);
    expect(config.authenticator.authenticate(env.MD_API_KEY)).toEqual({ tenantId: "default", agentId: "default" });
    expect("apiKey" in config).toBe(false);
    expect(loadConfig({ ...env, MD_ALLOWED_HOSTS: "files.example:443, internal:8000" }).allowedHosts).toEqual(["files.example:443", "internal:8000"]);
  });
  test("explicit legacy ownership is validated, never inferred", () => {
    expect(loadConfig(env).jobs.legacyOwner).toBeUndefined();
    expect(loadConfig({ ...env, MD_LEGACY_OWNER: '{"tenantId":"tenant","agentId":"agent"}' }).jobs.legacyOwner).toEqual({ tenantId: "tenant", agentId: "agent" });
    for (const value of ["bad", "null", '{"tenantId":"../escape","agentId":"agent"}', '{"tenantId":"tenant","agentId":"agent","unexpected":1}']) expect(() => loadConfig({ ...env, MD_LEGACY_OWNER: value })).toThrow("MD_LEGACY_OWNER");
  });
  test("rejects missing secrets and invalid bounds", () => {
    expect(() => loadConfig({})).toThrow("MD_API_KEY");
    for (const value of ["", "-1", "0", "Infinity", "1.5", "9007199254740992"]) {
      expect(() => loadConfig({ ...env, MD_MAX_JOBS: value })).toThrow("MD_MAX_JOBS");
    }
    expect(() => loadConfig({ ...env, MD_PORT: "65536" })).toThrow("MD_PORT");
    for (const name of ["MD_MAX_TENANT_JOBS", "MD_MAX_TENANT_STORAGE_BYTES", "MD_MAX_TENANT_CONCURRENCY", "MD_MAX_AGENT_JOBS", "MD_MAX_AGENT_STORAGE_BYTES", "MD_MAX_AGENT_CONCURRENCY"]) expect(() => loadConfig({ ...env, [name]: "0" })).toThrow(name);
  });
  test("rejects credential-bearing and non-origin URLs", () => {
    for (const value of ["https://user:pass@example.com", "file:///tmp/test", "https://example.com/path", "https://example.com?token=x"]) {
      expect(() => loadConfig({ ...env, MD_PUBLIC_BASE_URL: value }), value).toThrow("MD_PUBLIC_BASE_URL must be an HTTP(S) origin without credentials, query or path");
    }
  });
});
