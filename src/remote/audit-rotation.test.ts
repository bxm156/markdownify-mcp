import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAuditLogger } from "./audit.js";

const directories: string[] = [], restores: (() => void)[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  for (const value of directories.splice(0)) await fs.rm(value, { recursive: true, force: true });
});
const maxBytes = 1024, archives = 3;
const lines = async (file: string) => (await fs.readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line) as { event: string });
const seq = (record: { event: string }) => Number(record.event.slice("evt_".length));

test("a non-ENOENT rename failure part-way through the archive chain keeps later writes whole and archives bounded", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-audit-rotation-")); directories.push(dir);
  const target = path.join(dir, "audit.jsonl");
  const audit = await createAuditLogger(dir, { maxBytes, archives });
  let next = 0;
  const write = () => audit({ event: `evt_${next++}`, tenant_id: "tenantA", agent_id: "agentA" });
  // Fill until two rotations have produced .1 and .2.
  while (!(await fs.readdir(dir)).includes("audit.jsonl.2")) { await write(); expect(next).toBeLessThan(200); }
  expect((await fs.readdir(dir)).sort()).toEqual(["audit.jsonl", "audit.jsonl.1", "audit.jsonl.2"]);

  // `.2` -> `.3` succeeds, then `.1` -> `.2` fails once with a non-ENOENT error.
  const original = fs.rename;
  const renames: string[] = [];
  let failures = 0;
  const spy = spyOn(fs, "rename").mockImplementation(((from: any, to: any) => {
    renames.push(`${path.basename(String(from))}>${path.basename(String(to))}`);
    if (String(from) === `${target}.1` && failures++ === 0) return Promise.reject(Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }));
    return original(from, to);
  }) as typeof fs.rename);
  restores.push(() => spy.mockRestore());
  let failed = -1, liveBefore = "";
  while (failed < 0) {
    const attempt = next;
    liveBefore = await fs.readFile(target, "utf8");
    try { await write(); } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("EBUSY"); failed = attempt; }
    expect(next).toBeLessThan(400);
  }
  spy.mockRestore();
  expect(renames).toEqual(["audit.jsonl.2>audit.jsonl.3", "audit.jsonl.1>audit.jsonl.2"]);
  // The rejected record was not written; the live file still holds its pre-rotation contents (size is stale, not reset).
  expect((await fs.readdir(dir)).sort()).toEqual(["audit.jsonl", "audit.jsonl.1", "audit.jsonl.3"]);
  expect(await fs.readFile(target, "utf8")).toBe(liveBefore);

  // The stale size forces rotation on the very next write, so that record starts a fresh live file.
  await write();
  expect((await lines(target)).map(seq)).toEqual([failed + 1]);
  for (let index = 0; index < 60; index++) await write();

  const files = (await fs.readdir(dir)).sort();
  expect(files).toEqual(["audit.jsonl", "audit.jsonl.1", "audit.jsonl.2", "audit.jsonl.3"]);
  for (const file of files) expect((await fs.stat(path.join(dir, file))).size).toBeLessThanOrEqual(maxBytes);
  // Oldest to newest: every surviving record appears exactly once and in order, and the failed one never appears.
  const survivors: number[] = [];
  for (const file of ["audit.jsonl.3", "audit.jsonl.2", "audit.jsonl.1", "audit.jsonl"]) survivors.push(...(await lines(path.join(dir, file))).map(seq));
  expect(survivors).not.toContain(failed);
  expect(survivors.every((value, index) => index === 0 || value === survivors[index - 1] + 1)).toBe(true);
  expect(survivors.at(-1)).toBe(next - 1);
});
