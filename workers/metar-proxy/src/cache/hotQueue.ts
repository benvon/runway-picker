import type { CacheEngineEnv, CacheProvenance, KvListPage } from './types';
import { buildCacheKey } from './keys';

export type HotCacheResource = 'metar' | 'airport';

export interface HotCacheEntry {
  schemaVersion: number;
  resource: HotCacheResource;
  normalizedKey: string;
  lastAccessedAt: string;
  lastRefreshedAt: string;
}

export interface HotCacheQueueEntry extends HotCacheEntry {
  metadataKey: string;
  /** Derived from canonical resource identity; never persisted in queue metadata. */
  cacheKey: string;
}

export interface HotCacheQueuePage {
  entries: HotCacheQueueEntry[];
  scanned: number;
  listComplete: boolean;
}

export interface CacheRefresherConfig {
  enabled: boolean;
  metarRefreshIntervalSeconds: number;
  airportRefreshIntervalSeconds: number;
  inactivityTtlSeconds: number;
  maxItemsPerRun: number;
}

const HOT_QUEUE_SCHEMA_VERSION = 2;
const HOT_QUEUE_KEY_PREFIX = 'v2:hot:';
const HOT_QUEUE_CURSOR_SCHEMA_VERSION = 1;
const HOT_QUEUE_CURSOR_KEY_PREFIX = 'v2:control:hot-refresh-cursor:';
const KV_LIST_PAGE_LIMIT = 1000;

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
    entry.schemaVersion !== HOT_QUEUE_SCHEMA_VERSION ||
    !isHotResource(entry.resource) ||
    typeof entry.normalizedKey !== 'string' ||
    entry.normalizedKey.length === 0 ||
    !parseDate(entry.lastAccessedAt) ||
    !parseDate(entry.lastRefreshedAt) ||
    metadataKey !== hotQueueKey(entry.resource, entry.normalizedKey)
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
    cacheKey: buildCacheKey(entry.resource, entry.normalizedKey),
    lastAccessedAt,
    lastRefreshedAt,
    metadataKey
  };
}

function hotQueueKey(resource: HotCacheResource, normalizedKey: string): string {
  return `${HOT_QUEUE_KEY_PREFIX}${resource}:${normalizedKey}`;
}

function hotQueueResourcePrefix(resource: HotCacheResource): string {
  return `${HOT_QUEUE_KEY_PREFIX}${resource}:`;
}

function hotQueueCursorKey(resource: HotCacheResource): string {
  return `${HOT_QUEUE_CURSOR_KEY_PREFIX}${resource}`;
}

function parseCursorCheckpoint(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const checkpoint = candidate as { schemaVersion?: unknown; cursor?: unknown };
  if (
    checkpoint.schemaVersion !== HOT_QUEUE_CURSOR_SCHEMA_VERSION ||
    typeof checkpoint.cursor !== 'string' ||
    checkpoint.cursor.length === 0
  ) {
    return null;
  }

  return checkpoint.cursor;
}

async function clearHotQueueCursor(env: CacheEngineEnv, resource: HotCacheResource): Promise<void> {
  if (env.METAR_CACHE.delete) {
    await env.METAR_CACHE.delete(hotQueueCursorKey(resource));
  }
}

async function saveHotQueueCursor(
  env: CacheEngineEnv,
  resource: HotCacheResource,
  cursor: string
): Promise<void> {
  await env.METAR_CACHE.put(
    hotQueueCursorKey(resource),
    JSON.stringify({ schemaVersion: HOT_QUEUE_CURSOR_SCHEMA_VERSION, cursor })
  );
}

function logCursorRecovery(resource: HotCacheResource, reason: 'malformed' | 'rejected'): void {
  // One diagnostic per resource page keeps recovery observable without logging opaque cursors.
  console.warn('Scheduled cache refresh cursor checkpoint reset.', { resource, reason });
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

export async function readHotCacheQueuePage(
  env: CacheEngineEnv,
  resource: HotCacheResource,
  maxScanEntries: number
): Promise<HotCacheQueuePage> {
  if (!env.METAR_CACHE.list || maxScanEntries <= 0) {
    return { entries: [], scanned: 0, listComplete: true };
  }

  const cursorKey = hotQueueCursorKey(resource);
  const checkpointRaw = await env.METAR_CACHE.get(cursorKey, 'json');
  let cursor: string | undefined;
  if (checkpointRaw !== null) {
    const parsedCursor = parseCursorCheckpoint(checkpointRaw);
    if (parsedCursor) {
      cursor = parsedCursor;
    } else {
      await clearHotQueueCursor(env, resource);
      logCursorRecovery(resource, 'malformed');
    }
  }

  let page: KvListPage;
  try {
    page = await env.METAR_CACHE.list({
      prefix: hotQueueResourcePrefix(resource),
      cursor,
      limit: Math.min(KV_LIST_PAGE_LIMIT, maxScanEntries)
    });
  } catch (error) {
    if (!cursor) {
      throw error;
    }

    await clearHotQueueCursor(env, resource);
    logCursorRecovery(resource, 'rejected');
    page = await env.METAR_CACHE.list({
      prefix: hotQueueResourcePrefix(resource),
      limit: Math.min(KV_LIST_PAGE_LIMIT, maxScanEntries)
    });
  }

  if (page.list_complete) {
    await clearHotQueueCursor(env, resource);
  } else if (typeof page.cursor === 'string' && page.cursor.length > 0) {
    await saveHotQueueCursor(env, resource, page.cursor);
  } else {
    throw new Error('KV returned an incomplete hot-cache queue page without a cursor.');
  }

  const parsedEntries = await Promise.all(
    page.keys.map(async (key) => {
      const raw = await env.METAR_CACHE.get(key.name, 'json');
      return parseHotCacheEntry(raw, key.name);
    })
  );

  return {
    entries: parsedEntries.filter((entry): entry is HotCacheQueueEntry => entry !== null),
    scanned: page.keys.length,
    listComplete: page.list_complete
  };
}

export async function readHotCacheQueueEntry(
  env: CacheEngineEnv,
  metadataKey: string
): Promise<HotCacheQueueEntry | null> {
  const raw = await env.METAR_CACHE.get(metadataKey, 'json');
  return parseHotCacheEntry(raw, metadataKey);
}

export async function touchHotCacheEntry(params: {
  env: CacheEngineEnv;
  resource: HotCacheResource;
  normalizedKey: string;
  cache: CacheProvenance;
  lastAccessedAt: string;
  expirationTtl?: number;
}): Promise<void> {
  const entry: HotCacheEntry = {
    schemaVersion: HOT_QUEUE_SCHEMA_VERSION,
    resource: params.resource,
    normalizedKey: params.normalizedKey,
    lastAccessedAt: params.lastAccessedAt,
    lastRefreshedAt: params.cache.fetchedAt
  };

  await params.env.METAR_CACHE.put(
    hotQueueKey(params.resource, params.normalizedKey),
    JSON.stringify(entry),
    params.expirationTtl ? { expirationTtl: params.expirationTtl } : undefined
  );
}

export async function updateHotCacheEntryAfterRefresh(
  env: CacheEngineEnv,
  entry: HotCacheQueueEntry,
  cache: CacheProvenance,
  expirationTtl?: number
): Promise<void> {
  // Preserve the most recent lastAccessedAt in case it was updated concurrently by touchHotCacheEntry.
  let lastAccessedAt = entry.lastAccessedAt;

  const existingRaw = await env.METAR_CACHE.get(entry.metadataKey, 'json');
  if (existingRaw) {
    const existing = parseHotCacheEntry(existingRaw, entry.metadataKey);
    if (existing) {
      const existingTs = readIsoTimestamp(existing.lastAccessedAt);
      const entryTs = readIsoTimestamp(entry.lastAccessedAt);
      if (existingTs > entryTs) {
        lastAccessedAt = existing.lastAccessedAt;
      }
    }
  }

  const next: HotCacheEntry = {
    schemaVersion: HOT_QUEUE_SCHEMA_VERSION,
    resource: entry.resource,
    normalizedKey: entry.normalizedKey,
    lastAccessedAt,
    lastRefreshedAt: cache.fetchedAt
  };

  await env.METAR_CACHE.put(
    entry.metadataKey,
    JSON.stringify(next),
    expirationTtl ? { expirationTtl } : undefined
  );
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
