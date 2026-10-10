import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAuthenticator, hashToken } from "./auth.js";

const execute = promisify(execFile);
const script = path.resolve("scripts/create-agent-credential.ts");
const directories: string[] = [];
async function fixture() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-provisioning-")); directories.push(directory); return { directory, registry: path.join(directory, "agents.json") }; }
async function provision(tenant: string, agent: string, registry: string, token: string) { return execute(process.execPath, [script, tenant, agent, registry, token], { timeout: 10_000, windowsHide: true, maxBuffer: 16_000 }); }
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

test("fresh credential provisioning supports independent agents and rotation without logging secrets", async () => {
  const { directory, registry } = await fixture();
  const credentials: Array<{ token: string; principal: { tenantId: string; agentId: string } }> = [];
  for (const [agent, filename] of [["a", "a.token"], ["b", "b.token"], ["a", "a-rotation.token"]]) {
    const tokenFile = path.join(directory, filename);
    const result = await provision("tenant", agent, registry, tokenFile);
    const token = (await fs.readFile(tokenFile, "utf8")).trim();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(result.stdout + result.stderr).not.toContain(token);
    credentials.push({ token, principal: { tenantId: "tenant", agentId: agent } });
  }
  const raw = await fs.readFile(registry, "utf8");
  const data = JSON.parse(raw);
  expect(data.credentials).toHaveLength(3);
  const auth = createAuthenticator(data);
  for (const entry of credentials) {
    expect(auth.authenticate(entry.token)).toEqual(entry.principal);
    expect(raw).not.toContain(entry.token);
    expect(data.credentials.some((value: any) => value.token_sha256 === hashToken(entry.token))).toBe(true);
  }
  expect((await fs.readdir(directory)).some(name => /\.lock$|\.tmp$/.test(name))).toBe(false);
});

test("provisioning refuses existing token destinations without changing keys or registry", async () => {
  const { directory, registry } = await fixture();
  const tokenFile = path.join(directory, "a.token");
  await provision("tenant", "a", registry, tokenFile);
  const beforeRegistry = await fs.readFile(registry, "utf8"), beforeToken = await fs.readFile(tokenFile, "utf8");
  await expect(provision("tenant", "b", registry, tokenFile)).rejects.toMatchObject({ stderr: expect.stringContaining("EEXIST") });
  expect(await fs.readFile(registry, "utf8")).toBe(beforeRegistry);
  expect(await fs.readFile(tokenFile, "utf8")).toBe(beforeToken);
  expect((await fs.readdir(directory)).some(name => /\.lock$|\.tmp$/.test(name))).toBe(false);
});

test("concurrent provisioning cannot lose successful credentials and failed operations can be retried", async () => {
  const { directory, registry } = await fixture();
  const results = await Promise.allSettled(["a", "b", "c", "d"].map(agent => provision("tenant", agent, registry, path.join(directory, `${agent}.token`))));
  const successful = results.filter(result => result.status === "fulfilled").length;
  expect(successful).toBeGreaterThan(0);
  const initial = JSON.parse(await fs.readFile(registry, "utf8"));
  expect(initial.credentials).toHaveLength(successful);
  for (const [index, result] of results.entries()) {
    const agent = ["a", "b", "c", "d"][index], tokenFile = path.join(directory, `${agent}.token`);
    if (result.status === "rejected") {
      await expect(fs.stat(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
      await provision("tenant", agent, registry, tokenFile);
    }
  }
  const data = JSON.parse(await fs.readFile(registry, "utf8"));
  expect(data.credentials).toHaveLength(4);
  const auth = createAuthenticator(data);
  for (const agent of ["a", "b", "c", "d"]) expect(auth.authenticate((await fs.readFile(path.join(directory, `${agent}.token`), "utf8")).trim())).toEqual({ tenantId: "tenant", agentId: agent });
});

test("invalid identities and corrupted registry fail before creating a usable credential", async () => {
  const { directory, registry } = await fixture();
  const tokenFile = path.join(directory, "rejected.token");
  await expect(provision("../tenant", "a", registry, tokenFile)).rejects.toMatchObject({ stderr: expect.stringContaining("Invalid principal") });
  expect(await fs.readdir(directory)).toEqual([]);
  await fs.writeFile(registry, "{corrupted");
  await expect(provision("tenant", "a", registry, tokenFile)).rejects.toMatchObject({ stderr: expect.stringContaining("Existing credential registry is invalid or unreadable") });
  expect(await fs.readFile(registry, "utf8")).toBe("{corrupted");
  await expect(fs.stat(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await fs.readdir(directory)).sort()).toEqual(["agents.json"]);
});
