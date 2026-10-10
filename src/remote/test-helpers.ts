/** Shared test utilities. Not imported by production code. */

export type WaitForOptions = { timeoutMs?: number; intervalMs?: number; label?: string };

/**
 * Poll `predicate` until it returns a truthy value and return that value.
 * A predicate that throws counts as "not yet"; the last error is reported if the deadline passes.
 * Prefer this over fixed sleeps so tests wait for the actual state change.
 */
export async function waitFor<T>(predicate: () => T | Promise<T>, { timeoutMs = 2000, intervalMs = 5, label = "condition" }: WaitForOptions = {}): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value as NonNullable<T>;
    } catch (error) { lastError = error; }
    if (Date.now() >= deadline) {
      const cause = lastError instanceof Error ? `: ${lastError.message}` : "";
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}${cause}`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
