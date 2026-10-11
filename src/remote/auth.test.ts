import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuthenticator, hashToken, loadAuthenticator } from "./auth.js";

const credential = (token: string, tenant_id = "tenant", agent_id = "agent", disabled = false) => ({ tenant_id, agent_id, token_sha256: hashToken(token), disabled });
test("credentials map only to trusted principals and support rotation and revocation", () => {
  const auth = createAuthenticator({ credentials: [credential("first"), credential("rotation"), credential("other", "tenant", "other"), credential("disabled", "tenant", "disabled", true)] });
  expect(auth.authenticate("first")).toEqual({ tenantId: "tenant", agentId: "agent" });
  expect(auth.authenticate("rotation")).toEqual(auth.authenticate("first"));
  expect(auth.authenticate("other")).toEqual({ tenantId: "tenant", agentId: "other" });
  for (const token of [undefined, "", "wrong", "disabled", "x".repeat(4097)]) expect(auth.authenticate(token)).toBeNull();
  expect(JSON.stringify(auth)).not.toContain("first");
});
test("registry validation rejects ambiguous or malformed identities and credentials", () => {
  for (const registry of [null, [], {}, { credentials: [] }, { credentials: [credential("x")], secret: "plaintext" }, { credentials: [credential("same"), credential("same", "other")] }, { credentials: [{ ...credential("x"), token: "plaintext" }] }, { credentials: [{ ...credential("x"), disabled: "false" }] }, { credentials: [{ ...credential("x"), token_sha256: "bad" }] }]) expect(() => createAuthenticator(registry), JSON.stringify(registry)).toThrow(/^(Invalid credential registry|Credential registry must contain credentials|Invalid credential entry|Duplicate credential hash)$/);
  for (const value of ["", "../escape", "a b", "a".repeat(65), "ümlaut", 1]) {
    expect(() => createAuthenticator({ credentials: [credential("x", value as string)] }), String(value)).toThrow("Invalid principal");
    expect(() => createAuthenticator({ credentials: [credential("x", "tenant", value as string)] }), String(value)).toThrow("Invalid principal");
  }
  expect(() => createAuthenticator({ credentials: [credential("x", "A_-0", "B_-9")] })).not.toThrow();
});
test("auth file is startup loaded and excludes legacy shared key", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "markdownify-auth-"));
  const filename = path.join(directory, "auth.json");
  try {
    fs.writeFileSync(filename, JSON.stringify({ credentials: [credential("secret")] }));
    const auth = loadAuthenticator({ MD_AUTH_FILE: filename });
    expect(auth.authenticate("secret")).toEqual({ tenantId: "tenant", agentId: "agent" });
    fs.writeFileSync(filename, JSON.stringify({ credentials: [credential("secret", "tenant", "agent", true)] }));
    expect(auth.authenticate("secret")).not.toBeNull();
    expect(loadAuthenticator({ MD_AUTH_FILE: filename }).authenticate("secret")).toBeNull();
    expect(() => loadAuthenticator({ MD_AUTH_FILE: filename, MD_API_KEY: "a".repeat(32) })).toThrow("cannot be combined");
    fs.writeFileSync(filename, "{bad");
    expect(() => loadAuthenticator({ MD_AUTH_FILE: filename })).toThrow("Unable to read");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  const auth = loadAuthenticator({ MD_API_KEY: "a".repeat(32) });
  expect(auth.authenticate("a".repeat(32))).toEqual({ tenantId: "default", agentId: "default" });
  for (const token of ["", "short", "a".repeat(32) + "\n"]) expect(() => loadAuthenticator({ MD_API_KEY: token })).toThrow("MD_API_KEY");
});
