import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createAuthenticator } from "../src/remote/auth.js";

const execute = promisify(execFile);
const script = path.resolve(import.meta.dir, "create-test-agent-registry.ts");
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

test("CI agent registry holds only hashes, masks every key and maps a/b to tenantA and c to tenantB", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-ci-registry-"));
  directories.push(directory);
  const registry = path.join(directory, "agents.json"), environment = path.join(directory, "github.env");
  const run = () => execute(process.execPath, [script, registry, environment], { timeout: 10_000, windowsHide: true });
  const { stdout } = await run();
  const env = await fs.readFile(environment, "utf8");
  const match = /^MD_TEST_AGENT_KEYS=(.+)\n$/.exec(env);
  expect(match).not.toBeNull();
  const keys: Record<string, string> = JSON.parse(match![1]);
  expect(Object.keys(keys).sort()).toEqual(["a", "b", "c"]);
  const raw = await fs.readFile(registry, "utf8");
  const auth = createAuthenticator(JSON.parse(raw));
  for (const [agent, token] of Object.entries(keys)) {
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(stdout).toContain(`::add-mask::${token}`);
    expect(raw).not.toContain(token);
    expect(await auth.authenticate(token)).toEqual({ tenantId: agent === "c" ? "tenantB" : "tenantA", agentId: agent });
  }
  // The registry is created exclusively, so a rerun cannot silently replace mounted credentials.
  await expect(run()).rejects.toThrow();
  expect(await fs.readFile(registry, "utf8")).toBe(raw);
});
