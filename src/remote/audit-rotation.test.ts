import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAuditLogger } from "./audit.js";

const directories: string[] = [], restores: (() => void)[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const value of directories.splice(0)) await fs.rm(value, { recursive: true, force: true });
});
const maxBytes = 1024, archives = 3;
const chain = ["audit.jsonl.3", "audit.jsonl.2", "audit.jsonl.1", "audit.jsonl"]; // Oldest to newest.
const lines = async (file: string) => (await fs.readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line) as { event: string });
const seq = (record: { event: string }) => Number(record.event.slice("evt_".length));
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index);

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-audit-rotation-")); directories.push(dir);
  const target = path.join(dir, "audit.jsonl");
  const audit = await createAuditLogger(dir, { maxBytes, archives });
  const state = { next: 0 };
  const write = () => audit({ event: `evt_${state.next++}`, tenant_id: "tenantA", agent_id: "agentA" });
  /** Every record across the live file and the archives, oldest first. */
  const survivors = async () => { const all: number[] = []; for (const file of chain) all.push(...(await lines(path.join(dir, file))).map(seq)); return all; };
  const files = async () => (await fs.readdir(dir)).sort();
  /** Writes until the archive named `file` exists. */
  const fillUntil = async (file: string) => { while (!(await files()).includes(file)) { await write(); expect(state.next).toBeLessThan(400); } };
  const stderr: Record<string, unknown>[] = [];
  const log = spyOn(console, "error").mockImplementation((...args: unknown[]) => { stderr.push(JSON.parse(String(args[0]))); });
  restores.push(() => log.mockRestore());
  return { dir, target, write, state, survivors, files, fillUntil, stderr };
}

type Step = { op: "rm" | "rename"; from: string; to?: string };
/** Fails the first filesystem step matching `fail` with EBUSY, records every rm/rename step, and passes the rest through. */
function faults(fail: (step: Step) => boolean) {
  const steps: string[] = [];
  let failed = false;
  const check = (step: Step) => {
    steps.push(step.to === undefined ? `rm ${step.from}` : `${step.from}>${step.to}`);
    if (!failed && fail(step)) { failed = true; return Promise.reject(Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" })); }
  };
  const rename = fs.rename, rm = fs.rm;
  const renameSpy = spyOn(fs, "rename").mockImplementation(((from: any, to: any) => check({ op: "rename", from: path.basename(String(from)), to: path.basename(String(to)) }) ?? rename(from, to)) as typeof fs.rename);
  const rmSpy = spyOn(fs, "rm").mockImplementation(((target: any, options: any) => check({ op: "rm", from: path.basename(String(target)) }) ?? rm(target, options)) as typeof fs.rm);
  const restore = () => { renameSpy.mockRestore(); rmSpy.mockRestore(); };
  restores.push(restore);
  return { steps, restore, failed: () => failed };
}

test("a rename failure part-way through the archive chain is resumed: no generation is lost and archives stay bounded", async () => {
  const { target, write, state, survivors, files, fillUntil, stderr } = await setup();
  await fillUntil("audit.jsonl.2");
  expect(await files()).toEqual(["audit.jsonl", "audit.jsonl.1", "audit.jsonl.2"]);

  // `.2` -> `.3` succeeds, then `.1` -> `.2` fails once with a non-ENOENT error.
  const fault = faults(step => step.from === "audit.jsonl.1");
  let rejected = -1, liveBefore = "";
  while (rejected < 0) {
    const attempt = state.next;
    liveBefore = await fs.readFile(target, "utf8");
    try { await write(); } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("EBUSY"); rejected = attempt; }
    expect(state.next).toBeLessThan(400);
  }
  expect(fault.steps).toEqual(["audit.jsonl.2>audit.jsonl.3", "audit.jsonl.1>audit.jsonl.2"]);
  // The rejected record was not written and the live file still holds its pre-rotation contents.
  expect(await files()).toEqual(["audit.jsonl", "audit.jsonl.1", "audit.jsonl.3"]);
  expect(await fs.readFile(target, "utf8")).toBe(liveBefore);
  expect(stderr).toEqual([{ event: "audit_rotation_failed", code: "EBUSY" }]);

  // The next write resumes the rotation: only the failed rename and the live file move, and nothing is deleted.
  fault.steps.length = 0;
  await write();
  expect(fault.steps).toEqual(["audit.jsonl.1>audit.jsonl.2", "audit.jsonl>audit.jsonl.1"]);
  expect(await files()).toEqual(["audit.jsonl", "audit.jsonl.1", "audit.jsonl.2", "audit.jsonl.3"]);
  expect((await fs.readFile(target, "utf8")).split("\n").filter(Boolean).map(line => seq(JSON.parse(line)))).toEqual([rejected + 1]);
  // Every record written so far survives except the rejected one.
  expect(await survivors()).toEqual(range(0, state.next).filter(value => value !== rejected));

  // Later rotations drop only the oldest generation, so the history stays a contiguous suffix and bounded.
  for (let index = 0; index < 60; index++) await write();
  const finalFiles = await files();
  expect(finalFiles).toEqual(["audit.jsonl", "audit.jsonl.1", "audit.jsonl.2", "audit.jsonl.3"]);
  for (const file of finalFiles) expect((await fs.stat(path.join(path.dirname(target), file))).size).toBeLessThanOrEqual(maxBytes);
  const after = await survivors();
  expect(after).toEqual(range(after[0], state.next));
  expect(after[0]).toBeGreaterThan(rejected);
  expect(stderr).toEqual([{ event: "audit_rotation_failed", code: "EBUSY" }]);
  expect(stderr.some(entry => entry.event === "audit_archive_dropped")).toBe(false);
});

for (const [name, match] of [
  ["deleting the oldest archive", (step: Step) => step.op === "rm" && step.from === "audit.jsonl.3"],
  ["renaming .2 to .3", (step: Step) => step.from === "audit.jsonl.2"],
  ["renaming .1 to .2", (step: Step) => step.from === "audit.jsonl.1"],
  ["archiving the live file", (step: Step) => step.from === "audit.jsonl"],
] as const) {
  test(`a full chain whose rotation fails at ${name} loses only the oldest generation once the rotation resumes`, async () => {
    const { dir, write, state, survivors, files, fillUntil, stderr } = await setup();
    await fillUntil("audit.jsonl.3");
    const fault = faults(match);
    let rejected = -1, oldest: number[] = [];
    while (rejected < 0) {
      const attempt = state.next;
      oldest = (await lines(path.join(dir, "audit.jsonl.3"))).map(seq);
      try { await write(); } catch { rejected = attempt; }
      expect(state.next).toBeLessThan(400);
    }
    fault.restore();
    expect(stderr).toEqual([{ event: "audit_rotation_failed", code: "EBUSY" }]);
    await write();
    expect(await files()).toEqual(["audit.jsonl", "audit.jsonl.1", "audit.jsonl.2", "audit.jsonl.3"]);
    // The designed retention drops the generation that was oldest before the failed rotation, and nothing else.
    expect(await survivors()).toEqual(range(0, state.next).filter(value => value !== rejected && !oldest.includes(value)));
    expect(stderr).toHaveLength(1);
  });
}

test("a live file removed externally before rotation does not wedge the logger or disturb the archives", async () => {
  const { target, write, state, survivors, files, fillUntil, stderr } = await setup();
  await fillUntil("audit.jsonl.1");
  const archived = (await lines(`${target}.1`)).map(seq);
  // Records differ only in their sequence number, so the size of the next one is known exactly.
  const size = (n: number) => Buffer.byteLength(`${JSON.stringify({ timestamp: new Date(0).toISOString(), event: `evt_${n}`, tenant_id: "tenantA", agent_id: "agentA" })}\n`);
  while ((await fs.stat(target)).size + size(state.next) <= maxBytes) await write();
  // The next write rotates, but there is no live file left to archive.
  await fs.rm(target);
  const first = state.next;
  await write();
  expect(await files()).toEqual(["audit.jsonl", "audit.jsonl.2"]);
  expect((await lines(target)).map(seq)).toEqual([first]);
  // The next rotation fills the vacant `.1` instead of shifting (or deleting) anything.
  await fillUntil("audit.jsonl.1");
  expect(await files()).toEqual(["audit.jsonl", "audit.jsonl.1", "audit.jsonl.2"]);
  expect((await lines(`${target}.2`)).map(seq)).toEqual(archived);
  expect(await survivors()).toEqual([...archived, ...range(first, state.next)]);
  expect(stderr).toEqual([]);
});
