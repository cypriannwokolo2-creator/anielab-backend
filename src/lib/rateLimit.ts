/**
 * Minimal in-memory sliding-window rate limiter. Perfect fit for an
 * always-on single-instance Express server (unlike serverless, the bucket
 * map survives between requests). Swap for Redis if this ever runs in
 * multiple replicas behind a load balancer.
 */

const buckets = new Map<string, number[]>()

const WINDOW_MS = 60_000
const DEFAULT_LIMIT = 5

/** Returns true if the caller is within the limit; false means "slow down". */
export function rateLimit(
  key: string,
  limit: number = DEFAULT_LIMIT,
  windowMs: number = WINDOW_MS
): boolean {
  const now = Date.now()
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs)
  if (hits.length >= limit) {
    buckets.set(key, hits)
    return false
  }
  hits.push(now)
  buckets.set(key, hits)
  return true
}

// Periodically prune expired buckets so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now()
  for (const [key, hits] of buckets) {
    const fresh = hits.filter((t) => now - t < WINDOW_MS)
    if (fresh.length === 0) buckets.delete(key)
    else buckets.set(key, fresh)
  }
}, WINDOW_MS).unref()
