import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.js";

describe("remote configuration", () => {
  const env = { MD_API_KEY: "a".repeat(32) };
  test("safe defaults and explicit host allowlist", () => {
    const config = loadConfig(env);
    expect(config.host).toBe("127.0.0.1");
    expect(config.allowedHosts).toContain("localhost:8000");
    expect(config.jobs.maxUploadBytes).toBe(25 * 1024 * 1024);
    expect(loadConfig({ ...env, MD_ALLOWED_HOSTS: "files.example:443, internal:8000" }).allowedHosts).toEqual(["files.example:443", "internal:8000"]);
  });
  test("rejects missing secrets and invalid bounds", () => {
    expect(() => loadConfig({})).toThrow("MD_API_KEY");
    for (const value of ["", "-1", "0", "Infinity", "1.5", "9007199254740992"]) {
      expect(() => loadConfig({ ...env, MD_MAX_JOBS: value })).toThrow("MD_MAX_JOBS");
    }
    expect(() => loadConfig({ ...env, MD_PORT: "65536" })).toThrow("MD_PORT");
  });
  test("rejects credential-bearing and non-origin URLs", () => {
    for (const value of ["https://user:pass@example.com", "file:///tmp/test", "https://example.com/path", "https://example.com?token=x"]) {
      expect(() => loadConfig({ ...env, MD_PUBLIC_BASE_URL: value })).toThrow();
    }
  });
});
