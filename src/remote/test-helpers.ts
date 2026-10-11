/** Shared test utilities. Not imported by production code. */

export type WaitForOptions = { timeoutMs?: number; intervalMs?: number; label?: string };

/**
 * Poll `predicate` until it returns a truthy value and return that value.
 * A predicate that throws counts as "not yet"; the last error is reported if the deadline passes.
 * Prefer this over fixed sleeps so tests wait for the actual state change.
 */
/** The truthy members of T: `cond && value` predicates resolve to the value type alone. */
export type Truthy<T> = Exclude<T, false | 0 | 0n | "" | null | undefined>;

export async function waitFor<T>(predicate: () => T | Promise<T>, { timeoutMs = 2000, intervalMs = 5, label = "condition" }: WaitForOptions = {}): Promise<Truthy<T>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value as Truthy<T>;
    } catch (error) { lastError = error; }
    if (Date.now() >= deadline) {
      const cause = lastError instanceof Error ? `: ${lastError.message}` : "";
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}${cause}`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
