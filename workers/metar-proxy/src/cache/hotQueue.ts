import type { CacheEngineEnv, CacheProvenance } from './types';

export type HotCacheResource = 'metar' | 'airport';

export interface HotCacheEntry {
  schemaVersion: number;
  resource: HotCacheResource;
  normalizedKey: string;
  cacheKey: string;
  lastAccessedAt: string;
  lastRefreshedAt: string;
}

export interface HotCacheQueueEntry extends HotCacheEntry {
  metadataKey: string;
}

export interface CacheRefresherConfig {
  enabled: boolean;
  metarRefreshIntervalSeconds: number;
  airportRefreshIntervalSeconds: number;
  inactivityTtlSeconds: number;
  maxItemsPerRun: number;
}

const HOT_QUEUE_SCHEMA_VERSION = 1;
const HOT_QUEUE_KEY_PREFIX = 'v1:hot:';

const DEFAULT_CONFIG: CacheRefresherConfig = {
  enabled: true,
  metarRefreshIntervalSeconds: 1800,
  airportRefreshIntervalSeconds: 86400,
  inactivityTtlSeconds: 432000,
  maxItemsPerRun: 25
};

function isHotResource(value: unknown): value is HotCacheResource {
  return value === 'metar' || value === 'airport';
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string') {
    return fallback;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  return fallback;
}

function parseHotCacheEntry(candidate: unknown, metadataKey: string): HotCacheQueueEntry | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const entry = candidate as Partial<HotCacheEntry>;
  if (
    typeof entry.schemaVersion !== 'number' ||
    !isHotResource(entry.resource) ||
    typeof entry.normalizedKey !== 'string' ||
    typeof entry.cacheKey !== 'string' ||
    !parseDate(entry.lastAccessedAt) ||
    !parseDate(entry.lastRefreshedAt)
  ) {
    return null;
  }

  const lastAccessedAt = entry.lastAccessedAt;
  const lastRefreshedAt = entry.lastRefreshedAt;
  if (typeof lastAccessedAt !== 'string' || typeof lastRefreshedAt !== 'string') {
    return null;
  }

  return {
    schemaVersion: entry.schemaVersion,
    resource: entry.resource,
    normalizedKey: entry.normalizedKey,
    cacheKey: entry.cacheKey,
    lastAccessedAt,
    lastRefreshedAt,
    metadataKey
  };
}

function hotQueueKey(resource: HotCacheResource, normalizedKey: string): string {
  return `${HOT_QUEUE_KEY_PREFIX}${resource}:${normalizedKey}`;
}

export function parseCacheRefresherConfig(env: CacheEngineEnv): CacheRefresherConfig {
  return {
    enabled: readBoolean(env.CACHE_REFRESH_ENABLED, DEFAULT_CONFIG.enabled),
    metarRefreshIntervalSeconds: readPositiveNumber(
      env.CACHE_REFRESH_METAR_INTERVAL_SECONDS,
      DEFAULT_CONFIG.metarRefreshIntervalSeconds
    ),
    airportRefreshIntervalSeconds: readPositiveNumber(
      env.CACHE_REFRESH_AIRPORT_INTERVAL_SECONDS,
      DEFAULT_CONFIG.airportRefreshIntervalSeconds
    ),
    inactivityTtlSeconds: readPositiveNumber(
      env.CACHE_REFRESH_INACTIVITY_TTL_SECONDS,
      DEFAULT_CONFIG.inactivityTtlSeconds
    ),
    maxItemsPerRun: readPositiveNumber(env.CACHE_REFRESH_MAX_ITEMS_PER_RUN, DEFAULT_CONFIG.maxItemsPerRun)
  };
}

export function refreshIntervalSecondsForResource(
  resource: HotCacheResource,
  config: CacheRefresherConfig
): number {
  if (resource === 'metar') {
    return config.metarRefreshIntervalSeconds;
  }

  return config.airportRefreshIntervalSeconds;
}

export async function listHotCacheQueueEntries(env: CacheEngineEnv): Promise<HotCacheQueueEntry[]> {
  if (!env.METAR_CACHE.list) {
    return [];
  }

  const entries: HotCacheQueueEntry[] = [];
  let cursor: string | undefined;
  let complete = false;

  while (!complete) {
    const page = await env.METAR_CACHE.list({
      prefix: HOT_QUEUE_KEY_PREFIX,
      cursor,
      limit: 1000
    });

    for (const key of page.keys) {
      const raw = await env.METAR_CACHE.get(key.name, 'json');
      const parsed = parseHotCacheEntry(raw, key.name);
      if (parsed) {
        entries.push(parsed);
      }
    }

    complete = page.list_complete;
    cursor = page.cursor;
  }

  return entries;
}

export async function touchHotCacheEntry(params: {
  env: CacheEngineEnv;
  resource: HotCacheResource;
  normalizedKey: string;
  cache: CacheProvenance;
  lastAccessedAt: string;
}): Promise<void> {
  const entry: HotCacheEntry = {
    schemaVersion: HOT_QUEUE_SCHEMA_VERSION,
    resource: params.resource,
    normalizedKey: params.normalizedKey,
    cacheKey: params.cache.key,
    lastAccessedAt: params.lastAccessedAt,
    lastRefreshedAt: params.cache.fetchedAt
  };

  await params.env.METAR_CACHE.put(
    hotQueueKey(params.resource, params.normalizedKey),
    JSON.stringify(entry)
  );
}

export async function updateHotCacheEntryAfterRefresh(
  env: CacheEngineEnv,
  entry: HotCacheQueueEntry,
  cache: CacheProvenance
): Promise<void> {
  const next: HotCacheEntry = {
    schemaVersion: entry.schemaVersion,
    resource: entry.resource,
    normalizedKey: entry.normalizedKey,
    cacheKey: cache.key,
    lastAccessedAt: entry.lastAccessedAt,
    lastRefreshedAt: cache.fetchedAt
  };

  await env.METAR_CACHE.put(entry.metadataKey, JSON.stringify(next));
}

export async function deleteHotCacheEntryAndPayload(
  env: CacheEngineEnv,
  entry: HotCacheQueueEntry
): Promise<void> {
  if (env.METAR_CACHE.delete) {
    await env.METAR_CACHE.delete(entry.metadataKey);
    await env.METAR_CACHE.delete(entry.cacheKey);
  }
}

export function readIsoTimestamp(value: string): number {
  const parsed = parseDate(value);
  if (!parsed) {
    return 0;
  }

  return parsed.getTime();
}
