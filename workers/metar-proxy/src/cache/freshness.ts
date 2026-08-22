import type { CacheProvenance } from './types';

/**
 * Returns the whole seconds a record can still be treated as fresh at `now`.
 * The adapter policy bounds untrusted or future expiry timestamps.
 */
export function remainingFreshnessSeconds(
  expiresAt: Date | string,
  now: Date,
  ttlSeconds: number
): number {
  const expiresAtMs = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return 0;
  }

  const remainingMilliseconds = expiresAtMs - now.getTime();
  const wholeRemainingSeconds = Math.floor(remainingMilliseconds / 1000);
  const policyMaximum = Math.max(0, Math.floor(ttlSeconds));
  return Math.min(Math.max(0, wholeRemainingSeconds), policyMaximum);
}

/** Re-stamps provenance at the response boundary using the record's exact expiry. */
export function provenanceAtResponseTime(
  cache: CacheProvenance,
  now = new Date()
): CacheProvenance {
  return {
    ...cache,
    servedAt: now.toISOString(),
    freshnessRemainingSeconds: remainingFreshnessSeconds(cache.expiresAt, now, cache.ttlSeconds)
  };
}
