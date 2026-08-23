import type { CacheEngineEnv, CacheProvenance, KvListPage } from './types';
import { buildCacheKey } from './keys';

export type HotCacheResource = 'metar' | 'airport';

export interface HotCacheEntry {
  schemaVersion: number;
  resource: HotCacheResource;
  normalizedKey: string;
  lastAccessedAt: string;
  /** Legacy scheduler state; accepted only to lazily migrate old demand records. */
  lastRefreshedAt?: string;
  /** Legacy scheduler state; current demand records never write it. */
  consecutiveRefreshFailures?: number;
}

export interface HotCacheQueueEntry extends HotCacheEntry {
  metadataKey: string;
  /** Derived from canonical resource identity; never persisted in queue metadata. */
  cacheKey: string;
}

export interface HotCacheQueuePage {
  metadataKeys: string[];
  scanned: number;
  listComplete: boolean;
  nextCursor?: string;
}

export interface CacheRefresherConfig {
  enabled: boolean;
  metarRefreshIntervalSeconds: number;
  airportRefreshIntervalSeconds: number;
  inactivityTtlSeconds: number;
  maxItemsPerRun: number;
}

const HOT_QUEUE_SCHEMA_VERSION = 5;
const LEGACY_HOT_QUEUE_SCHEMA_VERSIONS = new Set([2, 3, 4]);
const HOT_QUEUE_KEY_PREFIX = 'v2:hot:';
const HOT_QUEUE_CURSOR_SCHEMA_VERSION = 1;
const HOT_QUEUE_CURSOR_KEY_PREFIX = 'v2:control:hot-refresh-cursor:';
const KV_LIST_PAGE_LIMIT = 1000;
const MIN_REFRESH_ITEMS_PER_RUN = 2;

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

function hasValidHotCacheIdentity(entry: Partial<HotCacheEntry>, metadataKey: string): boolean {
  if (entry.schemaVersion !== HOT_QUEUE_SCHEMA_VERSION && !LEGACY_HOT_QUEUE_SCHEMA_VERSIONS.has(entry.schemaVersion ?? -1)) {
    return false;
  }
  if (!isHotResource(entry.resource) || typeof entry.normalizedKey !== 'string' || entry.normalizedKey.length === 0) {
    return false;
  }
  if (!parseDate(entry.lastAccessedAt)) {
    return false;
  }
  return metadataKey === hotQueueKey(entry.resource, entry.normalizedKey);
}

function parseHotCacheEntry(candidate: unknown, metadataKey: string): HotCacheQueueEntry | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const entry = candidate as Partial<HotCacheEntry>;
  if (!hasValidHotCacheIdentity(entry, metadataKey)) {
    return null;
  }
  const validatedEntry = entry as HotCacheEntry;
  const lastAccessedAt = validatedEntry.lastAccessedAt;

  return {
    schemaVersion: validatedEntry.schemaVersion,
    resource: validatedEntry.resource,
    normalizedKey: validatedEntry.normalizedKey,
    cacheKey: buildCacheKey(validatedEntry.resource, validatedEntry.normalizedKey),
    lastAccessedAt,
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

export function isInvalidHotCacheQueueCursorError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /\b(?:invalid|malformed|expired)\s+cursor\b|\bcursor\s+(?:is\s+)?(?:invalid|malformed|expired)\b/i.test(
    error.message
  );
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
    maxItemsPerRun: Math.max(
      MIN_REFRESH_ITEMS_PER_RUN,
      readPositiveNumber(env.CACHE_REFRESH_MAX_ITEMS_PER_RUN, DEFAULT_CONFIG.maxItemsPerRun)
    )
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

export async function readHotCacheQueueCursor(
  env: CacheEngineEnv,
  resource: HotCacheResource
): Promise<string | undefined> {
  const checkpointText = await env.METAR_CACHE.get(hotQueueCursorKey(resource), 'text');
  if (checkpointText === null) {
    return undefined;
  }

  let checkpointRaw: unknown;
  try {
    checkpointRaw = typeof checkpointText === 'string' ? JSON.parse(checkpointText) : null;
  } catch {
    checkpointRaw = null;
  }
  const cursor = parseCursorCheckpoint(checkpointRaw);
  if (cursor) {
    return cursor;
  }

  await clearHotQueueCursor(env, resource);
  logCursorRecovery(resource, 'malformed');
  return undefined;
}

export async function recoverRejectedHotCacheQueueCursor(
  env: CacheEngineEnv,
  resource: HotCacheResource
): Promise<void> {
  await clearHotQueueCursor(env, resource);
  logCursorRecovery(resource, 'rejected');
}

export async function listHotCacheQueuePage(
  env: CacheEngineEnv,
  resource: HotCacheResource,
  cursor: string | undefined,
  maxScanEntries: number
): Promise<HotCacheQueuePage> {
  if (!env.METAR_CACHE.list || maxScanEntries <= 0) {
    return { metadataKeys: [], scanned: 0, listComplete: true };
  }

  const page: KvListPage = await env.METAR_CACHE.list({
    prefix: hotQueueResourcePrefix(resource),
    cursor,
    limit: Math.min(KV_LIST_PAGE_LIMIT, maxScanEntries)
  });
  if (!page.list_complete && (typeof page.cursor !== 'string' || page.cursor.length === 0)) {
    throw new Error('KV returned an incomplete hot-cache queue page without a cursor.');
  }

  return {
    metadataKeys: page.keys.map((key) => key.name),
    scanned: page.keys.length,
    listComplete: page.list_complete,
    nextCursor: page.cursor
  };
}

export async function loadHotCacheQueueEntries(
  env: CacheEngineEnv,
  page: HotCacheQueuePage
): Promise<HotCacheQueueEntry[]> {
  const parsedEntries = await Promise.all(
    page.metadataKeys.map(async (metadataKey) => {
      const text = await env.METAR_CACHE.get(metadataKey, 'text');
      if (text === null) return null;
      let raw: unknown;
      try {
        raw = typeof text === 'string' ? JSON.parse(text) : text;
      } catch {
        if (env.METAR_CACHE.delete) await env.METAR_CACHE.delete(metadataKey);
        console.warn('Malformed hot cache demand entry removed.', { resource: metadataKey.split(':')[2] });
        return null;
      }
      const entry = parseHotCacheEntry(raw, metadataKey);
      if (!entry && env.METAR_CACHE.delete) await env.METAR_CACHE.delete(metadataKey);
      return entry;
    })
  );

  return parsedEntries.filter((entry): entry is HotCacheQueueEntry => entry !== null);
}

export async function commitHotCacheQueueCursor(
  env: CacheEngineEnv,
  resource: HotCacheResource,
  page: HotCacheQueuePage
): Promise<void> {
  if (page.listComplete) {
    await clearHotQueueCursor(env, resource);
    return;
  }

  if (!page.nextCursor) {
    throw new Error('Cannot commit an incomplete hot-cache queue page without a cursor.');
  }

  await saveHotQueueCursor(env, resource, page.nextCursor);
}

export async function readHotCacheQueueEntry(
  env: CacheEngineEnv,
  metadataKey: string
): Promise<HotCacheQueueEntry | null> {
  const text = await env.METAR_CACHE.get(metadataKey, 'text');
  if (text === null) return null;
  try {
    const raw = typeof text === 'string' ? JSON.parse(text) : text;
    return parseHotCacheEntry(raw, metadataKey);
  } catch {
    if (env.METAR_CACHE.delete) await env.METAR_CACHE.delete(metadataKey);
    return null;
  }
}

export async function touchHotCacheEntry(params: {
  env: CacheEngineEnv;
  resource: HotCacheResource;
  normalizedKey: string;
  /** Legacy caller input; demand records never persist cache lifecycle state. */
  cache?: CacheProvenance;
  lastAccessedAt: string;
  expirationTtl?: number;
}): Promise<void> {
  const metadataKey = hotQueueKey(params.resource, params.normalizedKey);
  const existing = await readHotCacheQueueEntry(params.env, metadataKey);
  const entry: HotCacheEntry = existing
    ? {
      schemaVersion: HOT_QUEUE_SCHEMA_VERSION,
      resource: existing.resource,
      normalizedKey: existing.normalizedKey,
      lastAccessedAt: params.lastAccessedAt,
    }
    : {
      schemaVersion: HOT_QUEUE_SCHEMA_VERSION,
      resource: params.resource,
      normalizedKey: params.normalizedKey,
      lastAccessedAt: params.lastAccessedAt,
    };

  await params.env.METAR_CACHE.put(
    metadataKey,
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
  void cache;
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
  }
}

export async function recordHotCacheRefreshFailure(
  env: CacheEngineEnv,
  entry: HotCacheQueueEntry,
  expirationTtl?: number
): Promise<{ consecutiveRefreshFailures: number; dropped: boolean }> {
  const existing = await readHotCacheQueueEntry(env, entry.metadataKey);
  if (!existing) {
    return { consecutiveRefreshFailures: 0, dropped: false };
  }

  void existing;
  void expirationTtl;
  // Failure ownership moved to CACHE_COORDINATOR. Kept as a compatibility no-op
  // until callers on old worker versions age out.
  return { consecutiveRefreshFailures: 0, dropped: false };
}

export function readIsoTimestamp(value: string): number {
  const parsed = parseDate(value);
  if (!parsed) {
    return 0;
  }

  return parsed.getTime();
}
