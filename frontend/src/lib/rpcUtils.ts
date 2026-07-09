/** Wraps a promise so a hung/unresponsive RPC surfaces as an error within
 *  `ms` instead of leaving a hook's `loading` state true forever. viem's own
 *  http transport has a default per-request timeout, but that doesn't help
 *  when a whole chain of dependent calls (block number -> logs -> receipts)
 *  is orchestrated by hand, since a single retrying/misbehaving request in
 *  the middle can still stall the overall operation indefinitely. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms - check your RPC endpoint`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Runs `fn` over `items` with at most `limit` in flight at once. Free/public
 *  RPC endpoints commonly rate-limit (HTTP 429) bursts of concurrent calls -
 *  fetching e.g. 100+ block timestamps or tx receipts via one big
 *  Promise.all is a common way to trip that and fail the whole batch. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const current = cursor++;
      results[current] = await fn(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
