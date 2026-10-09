import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// Never reclaim automatically: PIDs are reused and are not comparable across containers.
// Data directories whose lock this process created; only these are ever unlinked by this process.
const held = new Set<string>();
let exitHook = false;
export const LOCK_REMOVAL_HINT = "If no markdownify process is using this volume (for example after a crash or SIGKILL), remove MD_DATA_DIR/.lock and restart; see docs/MULTITENANT.md";
const lockError = () => new Error(`Data directory is in use: MD_DATA_DIR/.lock exists. Run one process per data volume. ${LOCK_REMOVAL_HINT}`);

/** The contents of an existing lock, or undefined when the data directory is unlocked. The PID is informational only. */
export async function readLock(dataDir: string) {
  const real = await fs.realpath(dataDir);
  let text: string;
  try { text = await fs.readFile(path.join(real, ".lock"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const pid = Number(text.trim());
  return { pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null };
}
/** Atomic exclusive creation. Operators must remove crash leftovers only after stopping every volume user. */
export async function acquireLock(dataDir: string) {
  const real = await fs.realpath(dataDir), target = path.join(real, ".lock");
  try { await fs.writeFile(target, `${process.pid}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw lockError(); throw error; }
  held.add(real);
  // process.exit() (including the shutdown deadline), uncaught exceptions and normal exits release held locks.
  // SIGKILL, OOM kills and host crashes cannot run this, so those leftovers need the documented operator removal.
  if (!exitHook) { exitHook = true; process.on("exit", () => { for (const directory of held) { try { rmSync(path.join(directory, ".lock"), { force: true }); } catch {} } held.clear(); }); }
  return real;
}
export async function releaseLock(real: string) {
  if (!held.has(real)) return;
  // On failure the directory stays held so the exit hook tries again.
  try { await fs.rm(path.join(real, ".lock"), { force: true }); held.delete(real); } catch {}
}
