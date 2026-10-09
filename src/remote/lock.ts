import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// Never reclaim automatically: PIDs are reused and are not comparable across containers.
// Directories whose lock this process created, mapped to the exact contents written (pid plus a per-acquisition token).
// A lock is only ever unlinked while its contents still match, so a lock replaced by an operator and re-acquired by
// another process is never removed by this one.
const held = new Map<string, string>();
let exitHook = false;
export const LOCK_REMOVAL_HINT = "If no markdownify process is using this volume (for example after a crash or SIGKILL), remove MD_DATA_DIR/.lock and restart; see docs/MULTITENANT.md";
/** The data directory's lock file already exists. */
export class LockHeldError extends Error {}
const lockError = () => new LockHeldError(`Data directory is in use: MD_DATA_DIR/.lock exists. Run one process per data volume. ${LOCK_REMOVAL_HINT}`);

/** The contents of an existing lock, or undefined when the data directory is unlocked. The PID is informational only. */
export async function readLock(dataDir: string) {
  const real = await fs.realpath(dataDir);
  let text: string;
  try { text = await fs.readFile(path.join(real, ".lock"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const [first = "", token = ""] = text.split("\n"), pid = Number(first.trim());
  return { pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null, token: /^[0-9a-f-]{36}$/.test(token.trim()) ? token.trim() : null };
}
/** Atomic exclusive creation. Operators must remove crash leftovers only after stopping every volume user. */
export async function acquireLock(dataDir: string) {
  const real = await fs.realpath(dataDir), target = path.join(real, ".lock"), contents = `${process.pid}\n${randomUUID()}\n`;
  try { await fs.writeFile(target, contents, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw lockError(); throw error; }
  held.set(real, contents);
  // process.exit() (including the shutdown deadline), uncaught exceptions and normal exits release held locks.
  // SIGKILL, OOM kills and host crashes cannot run this, so those leftovers need the documented operator removal.
  if (!exitHook) { exitHook = true; process.on("exit", () => { for (const [directory, mine] of held) { try { const target = path.join(directory, ".lock"); if (readFileSync(target, "utf8") === mine) rmSync(target, { force: true }); } catch {} } held.clear(); }); }
  return real;
}
export async function releaseLock(real: string) {
  const mine = held.get(real), target = path.join(real, ".lock");
  if (mine === undefined) return;
  try { if (await fs.readFile(target, "utf8") === mine) await fs.rm(target, { force: true }); held.delete(real); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") held.delete(real); /* otherwise the exit hook retries */ }
}
