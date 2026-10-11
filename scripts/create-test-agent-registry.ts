/**
 * CI-only fixture: random disposable credentials; never source production secrets.
 *
 * Writes a credential registry with three agents (a and b in tenantA, c in
 * tenantB) holding only token hashes, masks the tokens in the GitHub Actions
 * log (`::add-mask::`), and appends them to the given GITHUB_ENV file as
 * MD_TEST_AGENT_KEYS={"a":...,"b":...,"c":...} for multitenant-http-smoke.ts.
 *
 * Usage: bun scripts/create-test-agent-registry.ts <registry.json> <github-env-file>
 * The registry file must not exist yet.
 */
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
