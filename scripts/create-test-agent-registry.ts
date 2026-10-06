/** CI-only fixture: random disposable credentials; never source production secrets. */
import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs/promises";

const [registryPath, environmentPath] = process.argv.slice(2);
if (!registryPath || !environmentPath) throw new Error("Usage: bun scripts/create-test-agent-registry.ts registry.json github-env-file");
const keys = { a: randomBytes(32).toString("hex"), b: randomBytes(32).toString("hex"), c: randomBytes(32).toString("hex") };
for (const token of Object.values(keys)) console.log(`::add-mask::${token}`);
const credentials = Object.entries(keys).map(([agent_id, token]) => ({ tenant_id: agent_id === "c" ? "tenantB" : "tenantA", agent_id, token_sha256: createHash("sha256").update(token).digest("hex") }));
// Hashes only. CI bind-mounts this registry into a non-root container.
await fs.writeFile(registryPath, JSON.stringify({ credentials }), { flag: "wx", mode: 0o644 });
await fs.appendFile(environmentPath, `MD_TEST_AGENT_KEYS=${JSON.stringify(keys)}\n`, { mode: 0o600 });
