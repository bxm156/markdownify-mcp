import fs from "node:fs/promises";
import path from "node:path";

// Never reclaim automatically: PIDs are reused and are not comparable across containers.
const held = new Set<string>();
const lockError = (pid?: number) => new Error(`Data directory is in use${pid ? ` by process ${pid}` : ""}; run one process per data volume, or remove a stale .lock if no service is running`);

/** A lock owner (or a sentinel for an incomplete lock); only absence means unlocked. */
export async function liveLockOwner(dataDir: string) {
  const real = await fs.realpath(dataDir);
  let text: string;
  try { text = await fs.readFile(path.join(real, ".lock"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const pid = Number(text.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : process.pid;
}
/** Atomic exclusive creation. Operators must remove crash leftovers only after stopping every volume user. */
export async function acquireLock(dataDir: string) {
  const real = await fs.realpath(dataDir), target = path.join(real, ".lock");
  try { await fs.writeFile(target, `${process.pid}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw lockError(); throw error; }
  held.add(real); return real;
}
export async function releaseLock(real: string) {
  if (!held.has(real)) return;
  const target = path.join(real, ".lock");
  try { if ((await fs.readFile(target, "utf8")).trim() === String(process.pid)) await fs.rm(target, { force: true }); } catch {}
  held.delete(real);
}
