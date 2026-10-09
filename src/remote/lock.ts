import fs from "node:fs/promises";
import path from "node:path";

// Data directories owned by this process. A lock naming our own pid that is absent here was left by an earlier process
// that had the same pid (common for a restarted container), so it is stale.
const held = new Set<string>();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
const lockError = (pid?: number) => new Error(`Data directory is in use${pid ? ` by process ${pid}` : ""}; run one process per data volume, or remove a stale .lock if no service is running`);

/** The pid of a live process holding dataDir's lock, or undefined when it is unlocked or the lock is stale. */
export async function liveLockOwner(dataDir: string) {
  const real = await fs.realpath(dataDir);
  let text: string;
  try { text = await fs.readFile(path.join(real, ".lock"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const pid = Number(text.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (pid === process.pid) return held.has(real) ? pid : undefined;
  return alive(pid) ? pid : undefined;
}
/** Single-process guard for one data volume: refuses a live owner and replaces a stale lock. Returns the key for releaseLock. */
export async function acquireLock(dataDir: string) {
  const real = await fs.realpath(dataDir), target = path.join(real, ".lock");
  const owner = await liveLockOwner(real);
  if (owner !== undefined) throw lockError(owner);
  await fs.rm(target, { force: true });
  try { await fs.writeFile(target, `${process.pid}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw lockError(); throw error; }
  held.add(real); return real;
}
export async function releaseLock(real: string) {
  held.delete(real);
  const target = path.join(real, ".lock");
  try { if ((await fs.readFile(target, "utf8")).trim() === String(process.pid)) await fs.rm(target, { force: true }); } catch {}
}
