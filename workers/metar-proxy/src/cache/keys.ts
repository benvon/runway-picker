/**
 * Canonical payload cache keys. Queue metadata must derive these keys rather
 * than persist a second, independently mutable copy of request identity.
 */
const CACHE_KEY_VERSION = 'v1';

export function buildCacheKey(resource: string, normalizedKey: string): string {
  return `${CACHE_KEY_VERSION}:${resource}:${normalizedKey}`;
}
