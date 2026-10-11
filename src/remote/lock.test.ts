import { afterEach, describe, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LOCK_STALE_AFTER_MS, HEARTBEAT_MS, LockHeldError, acquireLock, readLock, releaseLock, type LockOptions } from "./lock.js";
import { LOCK_LOST_MESSAGE, PurgeRefused, purgeOwnerJobs } from "./purge-owner.js";
import { waitFor } from "./test-helpers.js";

const directories: string[] = [], acquired: string[] = [];
const FOREIGN = "00000000-0000-0000-0000-000000000000";
const realRename = fs.rename, realRm = fs.rm;
afterEach(async () => {
  for (const real of acquired.splice(0)) await releaseLock(real);
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
async function dataDir() { const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "markdownify-lock-"))); directories.push(directory); return directory; }
/** Acquires with a recording log; the lock is released in afterEach. Heartbeats are effectively off unless asked for. */
async function acquire(directory: string, options: LockOptions = {}) {
  const lines: string[] = [];
  const real = await acquireLock(directory, { heartbeatMs: 3_600_000, log: line => { lines.push(line); }, ...options });
  acquired.push(real);
  return { real, lines, events: () => lines.map(line => JSON.parse(line)) };
}
const lockFile = (directory: string) => path.join(directory, ".lock");
const tokenIn = async (directory: string) => (await fs.readFile(lockFile(directory), "utf8")).split("\n")[1];
/** A lock left behind by a dead holder: the old two-line format, with an mtime `ageMs` in the past. */
async function leftover(directory: string, ageMs: number, token = FOREIGN) {
  await fs.writeFile(lockFile(directory), `4242\n${token}\n`, { mode: 0o600 });
  const then = new Date(Date.now() - ageMs);
  await fs.utimes(lockFile(directory), then, then);
}
/** Writes a lock temporary (or any file) whose mtime is `ageMs` in the past. */
async function aged(file: string, ageMs: number) { await fs.writeFile(file, "x"); const then = new Date(Date.now() - ageMs); await fs.utimes(file, then, then); }
const leftoverName = (kind: "tmp" | "stale") => `.lock.${crypto.randomUUID()}.${kind}`;
const exists = (file: string) => fs.lstat(file).then(() => true, () => false);
/** A rename failure with an errno code, as fs would throw it. */
const errno = (code: string) => Object.assign(new Error(code), { code });
const strays = async (directory: string) => (await fs.readdir(directory)).filter(name => name.startsWith(".lock."));

describe("data-directory lock", () => {
  test("the defaults are a 5 s heartbeat and a 60 s reclaim threshold, and a new lock carries pid, token and heartbeat", async () => {
    expect([HEARTBEAT_MS, DEFAULT_LOCK_STALE_AFTER_MS]).toEqual([5000, 60_000]);
    const directory = await dataDir();
    await acquire(directory, { now: () => 1234 });
    const text = await fs.readFile(lockFile(directory), "utf8");
    expect(text).toMatch(new RegExp(`^${process.pid}\\n[0-9a-f-]{36}\\nheartbeat=1234\\n$`));
    expect((await fs.stat(lockFile(directory))).mode & 0o777).toBe(0o600);
    expect(await readLock(directory)).toEqual({ pid: process.pid, token: text.split("\n")[1] });
  });

  test("a fresh lock is refused with a hint naming the reclaim threshold and leaves the file untouched", async () => {
    const directory = await dataDir();
    await leftover(directory, 1000);
    const before = await fs.readFile(lockFile(directory), "utf8"), log: string[] = [];
    const error = await acquireLock(directory, { staleAfterMs: 30_000, log: line => { log.push(line); } }).catch(caught => caught);
    expect(error).toBeInstanceOf(LockHeldError);
    expect(error.message).toContain("Data directory is in use: MD_DATA_DIR/.lock exists");
    expect(error.message).toContain("older than 30000 ms (MD_LOCK_STALE_AFTER_MS) unless MD_LOCK_STALE_AFTER_MS=0");
    expect(error.message).toContain("remove MD_DATA_DIR/.lock");
    expect(await fs.readFile(lockFile(directory), "utf8")).toBe(before);
    expect(log).toEqual([]);
    // Two-line files written by older versions still parse.
    expect(await readLock(directory)).toEqual({ pid: 4242, token: FOREIGN });
  });

  test("a lock whose mtime is older than the threshold is reclaimed once, with a new token and one event", async () => {
    const directory = await dataDir();
    await leftover(directory, 120_000);
    const { lines, events } = await acquire(directory, { staleAfterMs: 60_000 });
    expect(lines).toHaveLength(1);
    expect(events()[0]).toEqual({ event: "stale_lock_reclaimed", age_ms: expect.any(Number) });
    expect(events()[0].age_ms).toBeGreaterThanOrEqual(120_000);
    expect(lines[0]).not.toContain(directory);
    const token = await tokenIn(directory);
    expect(token).not.toBe(FOREIGN);
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(await strays(directory)).toEqual([]);
  });

  test("the age comes from the file's mtime, not from the heartbeat it claims", async () => {
    const directory = await dataDir();
    // A skewed host wrote a heartbeat far in the future, but the file has not been touched for two minutes.
    await fs.writeFile(lockFile(directory), `4242\n${FOREIGN}\nheartbeat=${Date.now() + 86_400_000}\n`);
    const then = new Date(Date.now() - 120_000); await fs.utimes(lockFile(directory), then, then);
    const { events } = await acquire(directory, { staleAfterMs: 60_000 });
    expect(events()).toMatchObject([{ event: "stale_lock_reclaimed" }]);
    // And a lock touched just now is fresh whatever its heartbeat text says.
    const other = await dataDir();
    await fs.writeFile(lockFile(other), `4242\n${FOREIGN}\nheartbeat=1\n`);
    await expect(acquireLock(other, { staleAfterMs: 60_000, log: () => {} })).rejects.toBeInstanceOf(LockHeldError);
  });

  test("a threshold of 0 never reclaims, however old the lock", async () => {
    const directory = await dataDir();
    await leftover(directory, 30 * 86_400_000);
    const log: string[] = [];
    const error = await acquireLock(directory, { staleAfterMs: 0, log: line => { log.push(line); } }).catch(caught => caught);
    expect(error).toBeInstanceOf(LockHeldError);
    expect(error.message).toContain("Automatic reclaim is disabled (MD_LOCK_STALE_AFTER_MS=0)");
    expect(error.message).toContain("remove MD_DATA_DIR/.lock");
    expect(await tokenIn(directory)).toBe(FOREIGN);
    expect(log).toEqual([]);
  });

  test("the heartbeat rewrites the file with a fresh mtime and heartbeat while keeping the token", async () => {
    const directory = await dataDir();
    let clock = 1000;
    const { real, lines } = await acquire(directory, { heartbeatMs: 10, now: () => ++clock });
    const token = await tokenIn(directory);
    const old = new Date(Date.now() - 600_000); await fs.utimes(lockFile(directory), old, old);
    const refreshed = await waitFor(async () => { const [stat, text] = await Promise.all([fs.stat(lockFile(directory)), fs.readFile(lockFile(directory), "utf8")]); return stat.mtimeMs > old.getTime() + 300_000 && text; }, { label: "heartbeat to refresh the lock" });
    expect(refreshed.split("\n")[1]).toBe(token);
    expect(Number(/heartbeat=(\d+)/.exec(refreshed)![1])).toBeGreaterThan(1001);
    expect((await fs.stat(lockFile(directory))).mode & 0o777).toBe(0o600);
    // Release waits for any beat in flight, so no heartbeat can recreate the file afterwards.
    await releaseLock(real);
    await expect(fs.stat(lockFile(directory))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await strays(directory)).toEqual([]);
    expect(lines).toEqual([]);
  });

  test("losing the token to another process calls onLost once, logs lock_lost and stops heartbeating", async () => {
    const directory = await dataDir();
    let lost = 0;
    const { real, events } = await acquire(directory, { heartbeatMs: 10, onLost: () => { lost++; } });
    await fs.writeFile(lockFile(directory), `4242\n${FOREIGN}\n`);
    await waitFor(() => lost === 1, { label: "onLost" });
    // Age the foreign lock, then let another holder beat several times: the first holder must not touch the file again.
    const old = new Date(Date.now() - 600_000); await fs.utimes(lockFile(directory), old, old);
    const witness = await dataDir();
    let beats = 0;
    await acquire(witness, { heartbeatMs: 10, now: () => { beats++; return Date.now(); } });
    await waitFor(() => beats >= 5, { label: "several heartbeat intervals" });
    expect(lost).toBe(1);
    expect(events()).toEqual([{ event: "lock_lost" }]);
    expect(await tokenIn(directory)).toBe(FOREIGN);
    expect((await fs.stat(lockFile(directory))).mtimeMs).toBe(old.getTime());
    // The lock is forgotten: releasing never removes the other process's file.
    await releaseLock(real);
    expect(await tokenIn(directory)).toBe(FOREIGN);
  });

  test("a deleted lock file also counts as lost and is not recreated", async () => {
    const directory = await dataDir();
    let lost = 0;
    await acquire(directory, { heartbeatMs: 10, onLost: () => { lost++; } });
    await fs.rm(lockFile(directory));
    await waitFor(() => lost === 1, { label: "onLost" });
    await expect(fs.stat(lockFile(directory))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("releaseLock removes only this acquisition's own file", async () => {
    const directory = await dataDir();
    const first = await acquireLock(directory, { log: () => {} });
    await releaseLock(first);
    await expect(fs.stat(lockFile(directory))).rejects.toMatchObject({ code: "ENOENT" });
    const second = await acquireLock(directory, { log: () => {} });
    const foreign = `4242\n${FOREIGN}\nheartbeat=1\n`;
    await fs.writeFile(lockFile(directory), foreign);
    await releaseLock(second);
    expect(await fs.readFile(lockFile(directory), "utf8")).toBe(foreign);
    // An unrelated path is a no-op.
    await releaseLock(await dataDir());
    expect(await fs.readFile(lockFile(directory), "utf8")).toBe(foreign);
  });

  test("acquiring sweeps lock temporaries older than the threshold and leaves fresh ones, .lock and job directories alone", async () => {
    const directory = await dataDir(), at = (name: string) => path.join(directory, name);
    const [oldTmp, oldStale, freshTmp, freshStale, oldDirectory, job] = [leftoverName("tmp"), leftoverName("stale"), leftoverName("tmp"), leftoverName("stale"), leftoverName("tmp"), "11111111-1111-1111-1111-111111111111"];
    await aged(at(oldTmp), 120_000); await aged(at(oldStale), 120_000);
    await aged(at(freshTmp), 1000); await aged(at(freshStale), 1000);
    // Look-alikes that are not lock temporaries: an old directory with a leftover's name, a non-UUID name, a job directory.
    await fs.mkdir(at(oldDirectory)); await aged(at(".lock.backup.tmp"), 120_000); await fs.mkdir(at(job)); await aged(at(`${job}/job.json`), 120_000);
    const old = new Date(Date.now() - 120_000); await fs.utimes(at(oldDirectory), old, old); await fs.utimes(at(job), old, old);
    const { lines, events } = await acquire(directory, { staleAfterMs: 60_000 });
    expect(events()).toEqual([{ event: "lock_leftovers_removed", count: 2 }]);
    expect(lines[0]).not.toContain(directory);
    expect((await strays(directory)).sort()).toEqual([freshTmp, freshStale, oldDirectory, ".lock.backup.tmp"].sort());
    expect(await exists(at(`${job}/job.json`))).toBe(true);
    expect(await tokenIn(directory)).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("with reclaim disabled the sweep still waits for the default threshold, and nothing to sweep logs nothing", async () => {
    const directory = await dataDir(), young = leftoverName("stale"), old = leftoverName("stale");
    await aged(path.join(directory, young), DEFAULT_LOCK_STALE_AFTER_MS - 10_000); await aged(path.join(directory, old), DEFAULT_LOCK_STALE_AFTER_MS + 10_000);
    const { events } = await acquire(directory, { staleAfterMs: 0 });
    expect(events()).toEqual([{ event: "lock_leftovers_removed", count: 1 }]);
    expect(await strays(directory)).toEqual([young]);
    const clean = await dataDir();
    expect((await acquire(clean)).lines).toEqual([]);
  });

  test("the heartbeat sweeps at most once per threshold", async () => {
    const directory = await dataDir();
    let offset = 0, beats = 0;
    const { events } = await acquire(directory, { staleAfterMs: 60_000, heartbeatMs: 10, now: () => { beats++; return Date.now() + offset; } });
    const first = path.join(directory, leftoverName("tmp"));
    await aged(first, 0);
    // Time passes: the leftover is now older than the threshold and a sweep is due.
    offset = 120_000;
    await waitFor(async () => !(await exists(first)), { label: "heartbeat sweep" });
    expect(events()).toEqual([{ event: "lock_leftovers_removed", count: 1 }]);
    // Another old leftover waits for the next sweep, one threshold later.
    const second = path.join(directory, leftoverName("stale"));
    await aged(second, 600_000);
    const seen = beats; await waitFor(() => beats >= seen + 10, { label: "several heartbeats" });
    expect(await exists(second)).toBe(true);
    offset += 60_000;
    await waitFor(async () => !(await exists(second)), { label: "next heartbeat sweep" });
    expect(events()).toEqual([{ event: "lock_leftovers_removed", count: 1 }, { event: "lock_leftovers_removed", count: 1 }]);
  });

  test("lock_heartbeat_failed is logged once per run of failures and re-armed by a successful heartbeat", async () => {
    const directory = await dataDir();
    let failWith: string | undefined = "EIO", failures = 0, successes = 0;
    const rename = spyOn(fs, "rename").mockImplementation((async (from: any, to: any) => {
      if (String(to) === lockFile(directory)) { if (failWith) { failures++; throw errno(failWith); } successes++; }
      return realRename(from, to);
    }) as typeof fs.rename);
    try {
      const { events } = await acquire(directory, { heartbeatMs: 10 });
      await waitFor(() => failures >= 5, { label: "several failed heartbeats" });
      expect(events()).toEqual([{ event: "lock_heartbeat_failed", code: "EIO" }]);
      failWith = undefined;
      await waitFor(() => successes >= 1, { label: "a successful heartbeat" });
      expect(events()).toHaveLength(1);
      failWith = "ENOSPC"; const before = failures;
      await waitFor(() => failures >= before + 5, { label: "a second run of failures" });
      expect(events()).toEqual([{ event: "lock_heartbeat_failed", code: "EIO" }, { event: "lock_heartbeat_failed", code: "ENOSPC" }]);
      // A failed rewrite never leaves its temporary behind.
      expect(await strays(directory)).toEqual([]);
    } finally { rename.mockRestore(); }
  });

  test("a contender whose moved stale lock vanished (swept by a resumed holder) fails cleanly", async () => {
    const directory = await dataDir();
    await leftover(directory, 120_000);
    const rename = spyOn(fs, "rename").mockImplementation((async (from: any, to: any) => {
      await realRename(from, to);
      if (String(to).endsWith(".stale")) await realRm(to, { force: true });
    }) as typeof fs.rename);
    try { await expect(acquireLock(directory, { staleAfterMs: 60_000, log: () => {} })).rejects.toBeInstanceOf(LockHeldError); }
    finally { rename.mockRestore(); }
  });

  test("two acquirers racing on a stale lock: exactly one wins and the lock carries its token", async () => {
    for (let round = 0; round < 20; round++) {
      const directory = await dataDir();
      await leftover(directory, 120_000);
      const lines: string[] = [];
      const results = await Promise.allSettled([0, 1].map(() => acquireLock(directory, { heartbeatMs: 3_600_000, log: line => { lines.push(line); } })));
      const won = results.filter(result => result.status === "fulfilled") as PromiseFulfilledResult<string>[];
      expect(won, `round ${round}`).toHaveLength(1);
      acquired.push(won[0]!.value);
      expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(LockHeldError);
      // Usually the winner reclaimed (one event). If the loser moved the stale file away just before the winner's first
      // exclusive create, the winner took a plain lock and the loser, failing, logs nothing.
      expect(lines.length).toBeLessThanOrEqual(1);
      expect(await tokenIn(directory)).not.toBe(FOREIGN);
      expect(await strays(directory)).toEqual([]);
      await releaseLock(won[0]!.value);
    }
  });

  test("a contender that judged the lock stale before the winner replaced it puts the winner's lock back and fails", async () => {
    const directory = await dataDir();
    await leftover(directory, 120_000);
    // Both contenders found the lock stale; hold each claim (rename of .lock to *.stale) and let them go one at a time.
    const claims: (() => void)[] = [];
    let bothClaiming!: () => void;
    const claiming = new Promise<void>(resolve => { bothClaiming = resolve; });
    const rename = spyOn(fs, "rename").mockImplementation((async (from: any, to: any) => {
      if (String(to).endsWith(".stale")) { const turn = new Promise<void>(resolve => { claims.push(resolve); }); if (claims.length === 2) bothClaiming(); await turn; }
      return realRename(from, to);
    }) as typeof fs.rename);
    try {
      const lines: string[] = [];
      const settle = (promise: Promise<string>) => promise.then(value => ({ value }), (error: unknown) => ({ error }));
      const contenders = [0, 1].map(() => settle(acquireLock(directory, { heartbeatMs: 3_600_000, log: line => { lines.push(line); } })));
      await claiming;
      claims[0]!();
      const winner = await Promise.race(contenders);
      expect(winner).toEqual({ value: directory });
      acquired.push(directory);
      const token = await tokenIn(directory);
      claims[1]!();
      const results = await Promise.all(contenders);
      expect(results.filter(result => "value" in result)).toHaveLength(1);
      expect((results.find(result => "error" in result) as { error: unknown }).error).toBeInstanceOf(LockHeldError);
      expect(await tokenIn(directory)).toBe(token);
      expect(lines).toHaveLength(1);
      expect(await strays(directory)).toEqual([]);
      // The restored file is the winner's own, so release removes it.
      await releaseLock(directory);
      await expect(fs.stat(lockFile(directory))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { for (const go of claims) go(); rename.mockRestore(); }
  });
});

describe("purge-owner and the lock", () => {
  const alice = { tenantId: "team", agentId: "alice" };
  async function volume() {
    const directory = await dataDir(), id = "11111111-1111-1111-1111-111111111111";
    await fs.mkdir(path.join(directory, id));
    await fs.writeFile(path.join(directory, id, "job.json"), JSON.stringify({ id, tenant_id: alice.tenantId, agent_id: alice.agentId, status: "completed" }));
    return { directory, target: path.join(directory, id) };
  }
  /** Gates removal of the job directory so the purge is observably mid-run. */
  function gateRemoval(target: string) {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
    const rm = spyOn(fs, "rm").mockImplementation((async (file: any, options: any) => { if (String(file) === target) { entered(); await gate; } return realRm(file, options); }) as typeof fs.rm);
    return { release, reached, restore: () => { release(); rm.mockRestore(); } };
  }

  test("heartbeats while it runs and releases the lock afterwards", async () => {
    const { directory, target } = await volume(), gate = gateRemoval(target);
    try {
      let clock = 0;
      const purge = purgeOwnerJobs(directory, alice, true, { heartbeatMs: 10, now: () => ++clock, log: () => {} });
      await gate.reached;
      const first = await fs.readFile(lockFile(directory), "utf8");
      await waitFor(async () => (await fs.readFile(lockFile(directory), "utf8")) !== first, { label: "purge heartbeat" });
      gate.release();
      expect(await purge).toMatchObject({ jobs: [{ result: "deleted" }] });
      await expect(fs.stat(lockFile(directory))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { gate.restore(); }
  });

  test("reclaims a stale lock and aborts with a clear message when the lock is lost mid-run", async () => {
    const { directory, target } = await volume(), gate = gateRemoval(target);
    await leftover(directory, 120_000);
    try {
      let lost = 0;
      const lines: string[] = [];
      const purge = purgeOwnerJobs(directory, alice, true, { heartbeatMs: 10, onLost: () => { lost++; }, log: line => { lines.push(line); } });
      await gate.reached;
      expect(lines).toHaveLength(1);
      await fs.writeFile(lockFile(directory), `4242\n${FOREIGN}\n`);
      await waitFor(() => lost === 1, { label: "purge to lose the lock" });
      gate.release();
      const error = await purge.catch(caught => caught);
      expect(error).toBeInstanceOf(PurgeRefused);
      expect(error.message).toBe(LOCK_LOST_MESSAGE);
      expect(lines.map(line => JSON.parse(line).event)).toEqual(["stale_lock_reclaimed", "lock_lost"]);
      expect(await tokenIn(directory)).toBe(FOREIGN);
    } finally { gate.restore(); }
  });

  test("a dry run proceeds read-only past a stale lock with one note, and leaves the lock exactly as it was", async () => {
    const { directory } = await volume();
    await leftover(directory, 120_000);
    const before = await fs.readFile(lockFile(directory), "utf8"), mtime = (await fs.stat(lockFile(directory))).mtimeMs, lines: string[] = [];
    const report = await purgeOwnerJobs(directory, alice, false, { staleAfterMs: 60_000, log: line => { lines.push(line); } });
    expect(report).toMatchObject({ applied: false, jobs: [{ result: "listed" }] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Note: MD_DATA_DIR\/\.lock was last refreshed \d+ ms ago \(older than MD_LOCK_STALE_AFTER_MS=60000\)/);
    expect(lines[0]).not.toContain(directory);
    expect(await fs.readFile(lockFile(directory), "utf8")).toBe(before);
    expect((await fs.stat(lockFile(directory))).mtimeMs).toBe(mtime);
    expect(await strays(directory)).toEqual([]);
  });

  test("a dry run still refuses a fresh lock, and any lock when reclaim is disabled", async () => {
    const { directory } = await volume();
    for (const [ageMs, staleAfterMs, hint] of [[1000, 60_000, "older than 60000 ms"], [30 * 86_400_000, 0, "Automatic reclaim is disabled"]] as const) {
      await leftover(directory, ageMs);
      const lines: string[] = [];
      const error = await purgeOwnerJobs(directory, alice, false, { staleAfterMs, log: line => { lines.push(line); } }).catch(caught => caught);
      expect(error).toBeInstanceOf(PurgeRefused);
      expect(error.message).toContain("A lock file exists (MD_DATA_DIR/.lock). Stop the service if it is running.");
      expect(error.message).toContain(hint);
      expect(lines).toEqual([]);
      expect(await tokenIn(directory)).toBe(FOREIGN);
    }
  });
});
