/**
 * Shared helpers for the stdio server's tests (src/*.test.ts). Not imported
 * by production code; tsconfig.json leaves it out of the build. The remote
 * service has its own src/remote/test-helpers.ts.
 */
import fs from "node:fs";

/**
 * True while `pid` is a running process. A killed process that its parent
 * has not reaped yet is a zombie: still listed, but dead (Linux /proc). Some
 * containers' PID 1 never reaps the orphans a killed tool leaves behind.
 */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw e;
  }
  try {
    return !/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    // No /proc (macOS): kill(pid, 0) succeeded, so it is running. On
    // Linux the entry vanished between the two checks.
    return process.platform !== "linux";
  }
}

/** Polls `predicate` every 10 ms until it is true; throws after `timeoutMs`. */
export async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** SIGKILLs each pid, ignoring ones already gone (test cleanup). */
export function killQuietly(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
