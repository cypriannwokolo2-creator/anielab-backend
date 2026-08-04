/**
 * Minimal in-memory sliding-window rate limiter. Good enough for guarding
 * cheap public endpoints (e.g. the wallet challenge nonce) in a single
 * serverless instance; swap for a shared store (Redis/Supabase) if this ever
 * runs in multiple replicas.
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

/** Prunes the stored hit lists so the map can't grow unbounded. */
export function clearRateLimits(): void {
  buckets.clear()
}
