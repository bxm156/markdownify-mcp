/** Operator-only utility: never expose this as an MCP tool. */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createAuthenticator, hashToken } from "../src/remote/auth.js";
import { validatePrincipal } from "../src/remote/identity.js";

const [tenantId, agentId, registryPath, tokenPath] = process.argv.slice(2);
if (!tenantId || !agentId || !registryPath || !tokenPath) throw new Error("Usage: bun scripts/create-agent-credential.ts tenant agent registry.json token.txt");
validatePrincipal({ tenantId, agentId });
const registry = path.resolve(registryPath), destination = path.resolve(tokenPath);
if (registry === destination) throw new Error("Registry and token files must be different");
await fs.mkdir(path.dirname(registry), { recursive: true, mode: 0o700 });
await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
const lock = await fs.open(`${registry}.lock`, "wx", 0o600);
const temporary = `${registry}.${randomUUID()}.tmp`;
let tokenCreated = false, committed = false;
try {
  let existing: { credentials: Array<Record<string, unknown>> } = { credentials: [] };
  try { existing = JSON.parse(await fs.readFile(registry, "utf8")); createAuthenticator(existing); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Existing credential registry is invalid or unreadable"); }
  const token = randomBytes(32).toString("hex");
  const updated = { credentials: [...existing.credentials, { tenant_id: tenantId, agent_id: agentId, token_sha256: hashToken(token) }] };
  createAuthenticator(updated);
  await fs.writeFile(destination, `${token}\n`, { flag: "wx", mode: 0o600 });
  tokenCreated = true;
  await fs.writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, registry);
  committed = true;
  await fs.chmod(registry, 0o600);
  console.log(`Credential added for ${tenantId}/${agentId}. Registry contains only the token hash. The private token was written to the requested new file.`);
} finally {
  await fs.rm(temporary, { force: true });
  if (tokenCreated && !committed) await fs.rm(destination, { force: true });
  await lock.close();
  await fs.rm(`${registry}.lock`, { force: true });
}
