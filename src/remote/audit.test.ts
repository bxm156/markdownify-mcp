import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuditRecordError, createAuditLogger, type AuditEvent } from "./audit.js";

const directories: string[] = [];
async function directory() { const value = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-audit-")); directories.push(value); return value; }
afterEach(async () => { for (const value of directories.splice(0)) await fs.rm(value, { recursive: true, force: true }); });
test("audit writes concurrent metadata records without leaking payloads", async () => {
  const dir = await directory(), audit = await createAuditLogger(dir);
  await Promise.all(Array.from({ length: 40 }, (_, index) => audit({ event: "markdown_read", tenant_id: "tenantA", agent_id: `agent${index}`, status: "completed", token: "private-token", filename: "private-document.pdf", content: "private-text" } as AuditEvent)));
  const raw = await fs.readFile(path.join(dir, "audit.jsonl"), "utf8");
  const records = raw.trim().split("\n").map(line => JSON.parse(line));
  expect(records).toHaveLength(40);
  expect(new Set(records.map(record => record.agent_id)).size).toBe(40);
  expect(raw.includes("private-")).toBe(false);
  expect(records.every(record => typeof record.timestamp === "string")).toBe(true);
});
test("audit rejects freeform sensitive strings and remains usable after errors", async () => {
  const dir = await directory(), audit = await createAuditLogger(dir);
  await expect(audit({ event: "failure", tenant_id: "tenantA", agent_id: "agentA", reason: "secret document content" })).rejects.toThrow("Invalid audit metadata");
  await audit({ event: "authorization_denied", tenant_id: "tenantA", agent_id: "agentA", reason: "owner_mismatch" });
  expect((await fs.readFile(path.join(dir, "audit.jsonl"), "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
});
test("audit retention is bounded through rotation and restart", async () => {
  const dir = await directory();
  const audit = await createAuditLogger(dir, { maxBytes: 1024, archives: 2 });
  for (let index = 0; index < 40; index++) await audit({ event: "upload_created", tenant_id: "tenantA", agent_id: "agentA" });
  const restarted = await createAuditLogger(dir, { maxBytes: 1024, archives: 2 });
  await restarted({ event: "job_deleted", tenant_id: "tenantA", agent_id: "agentA" });
  const files = await fs.readdir(dir);
  expect(files.sort()).toEqual(["audit.jsonl", "audit.jsonl.1", "audit.jsonl.2"]);
  for (const file of files) expect((await fs.stat(path.join(dir, file))).size).toBeLessThanOrEqual(1024);
});

test("filesystem audit failure rejects the event and later writes recover without invalid records", async () => {
  const dir = await directory(), audit = await createAuditLogger(dir);
  const target = path.join(dir, "audit.jsonl"), saved = path.join(dir, "saved-audit.jsonl");
  await audit({ event: "upload_created", tenant_id: "tenantA", agent_id: "agentA" });
  await fs.rename(target, saved);
  await fs.mkdir(target);
  await expect(audit({ event: "job_deleted", tenant_id: "tenantA", agent_id: "agentA" })).rejects.toMatchObject({ code: expect.stringMatching(/^(EISDIR|EPERM|EACCES)$/) });
  await fs.rmdir(target);
  await fs.rename(saved, target);
  await audit({ event: "read_markdown", tenant_id: "tenantA", agent_id: "agentA" });
  const records = (await fs.readFile(target, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(records.map(record => record.event)).toEqual(["upload_created", "read_markdown"]);
});

test("records rejected before storage throw AuditRecordError; repeat_count is validated and kept", async () => {
  const dir = await directory(), audit = await createAuditLogger(dir);
  for (const event of [{ event: "x", tenant_id: "tenantA", agent_id: "agentA", reason: "free text" }, { event: "x", tenant_id: "../t", agent_id: "agentA" }, { event: "x", tenant_id: "tenantA", agent_id: "agentA", repeat_count: 0 }, { event: "x", tenant_id: "tenantA", agent_id: "agentA", repeat_count: 1.5 }]) {
    const error = await audit(event).catch(caught => caught);
    expect(error).toBeInstanceOf(AuditRecordError); expect(error.message).toBe("Invalid audit metadata");
  }
  await audit({ event: "read_markdown_repeat", tenant_id: "tenantA", agent_id: "agentA", status: "completed", repeat_count: 10 });
  const records = (await fs.readFile(path.join(dir, "audit.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(records).toMatchObject([{ event: "read_markdown_repeat", status: "completed", repeat_count: 10 }]);
});
