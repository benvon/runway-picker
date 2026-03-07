import { describe, expect, it } from 'vitest';
import {
  listHotCacheQueueEntries,
  parseCacheRefresherConfig,
  readHotCacheQueueEntry,
  refreshIntervalSecondsForResource,
  touchHotCacheEntry,
  updateHotCacheEntryAfterRefresh,
  type HotCacheQueueEntry
} from './hotQueue';
import type { CacheEngineEnv, CacheProvenance } from './types';

function createEnv(overrides?: Partial<CacheEngineEnv>): CacheEngineEnv {
  return {
    METAR_CACHE: {
      get: async () => null,
      put: async () => {},
      list: async () => ({ keys: [], list_complete: true }),
      delete: async () => {}
    },
    ...overrides
  };
}

describe('hot queue refresher config', () => {
  it('uses defaults when vars are not set', () => {
    const config = parseCacheRefresherConfig(createEnv());

    expect(config.enabled).toBe(true);
    expect(config.metarRefreshIntervalSeconds).toBe(1800);
    expect(config.airportRefreshIntervalSeconds).toBe(86400);
    expect(config.inactivityTtlSeconds).toBe(432000);
    expect(config.maxItemsPerRun).toBe(25);
  });

  it('falls back to defaults for invalid values', () => {
    const config = parseCacheRefresherConfig(
      createEnv({
        CACHE_REFRESH_ENABLED: 'not-bool',
        CACHE_REFRESH_METAR_INTERVAL_SECONDS: '-1',
        CACHE_REFRESH_AIRPORT_INTERVAL_SECONDS: '0',
        CACHE_REFRESH_INACTIVITY_TTL_SECONDS: 'abc',
        CACHE_REFRESH_MAX_ITEMS_PER_RUN: '0'
      })
    );

    expect(config.enabled).toBe(true);
    expect(config.metarRefreshIntervalSeconds).toBe(1800);
    expect(config.airportRefreshIntervalSeconds).toBe(86400);
    expect(config.inactivityTtlSeconds).toBe(432000);
    expect(config.maxItemsPerRun).toBe(25);
  });

  it('parses explicit overrides', () => {
    const config = parseCacheRefresherConfig(
      createEnv({
        CACHE_REFRESH_ENABLED: 'false',
        CACHE_REFRESH_METAR_INTERVAL_SECONDS: '900',
        CACHE_REFRESH_AIRPORT_INTERVAL_SECONDS: '43200',
        CACHE_REFRESH_INACTIVITY_TTL_SECONDS: '86400',
        CACHE_REFRESH_MAX_ITEMS_PER_RUN: '50'
      })
    );

    expect(config.enabled).toBe(false);
    expect(config.metarRefreshIntervalSeconds).toBe(900);
    expect(config.airportRefreshIntervalSeconds).toBe(43200);
    expect(config.inactivityTtlSeconds).toBe(86400);
    expect(config.maxItemsPerRun).toBe(50);
    expect(refreshIntervalSecondsForResource('metar', config)).toBe(900);
    expect(refreshIntervalSecondsForResource('airport', config)).toBe(43200);
  });
});

function fakeProvenance(key: string, fetchedAt: string): CacheProvenance {
  return {
    status: 'upstream_refresh',
    source: 'upstream',
    ageSeconds: 0,
    fetchedAt,
    servedAt: fetchedAt,
    ttlSeconds: 1800,
    key,
    resource: 'metar'
  };
}

function buildValidEntry(
  resource: 'metar' | 'airport',
  normalizedKey: string,
  metadataKey: string
): HotCacheQueueEntry {
  return {
    schemaVersion: 1,
    resource,
    normalizedKey,
    cacheKey: `v1:${resource}:${normalizedKey}`,
    lastAccessedAt: '2026-03-06T11:00:00.000Z',
    lastRefreshedAt: '2026-03-06T10:00:00.000Z',
    metadataKey
  };
}

describe('readHotCacheQueueEntry', () => {
  it('returns null when the key is absent from KV', async () => {
    const env = createEnv();
    const result = await readHotCacheQueueEntry(env, 'v1:hot:metar:KJFK');
    expect(result).toBeNull();
  });

  it('returns a parsed entry when a valid entry is stored', async () => {
    const store = new Map<string, unknown>();
    const env = createEnv({
      METAR_CACHE: {
        get: async (key) => store.get(key) ?? null,
        put: async (key, value) => {
          store.set(key, JSON.parse(value) as unknown);
        },
        list: async () => ({ keys: [], list_complete: true }),
        delete: async () => {}
      }
    });

    await touchHotCacheEntry({
      env,
      resource: 'metar',
      normalizedKey: 'KJFK',
      cache: fakeProvenance('v1:metar:KJFK', '2026-03-06T11:00:00.000Z'),
      lastAccessedAt: '2026-03-06T11:30:00.000Z'
    });

    const result = await readHotCacheQueueEntry(env, 'v1:hot:metar:KJFK');
    expect(result).not.toBeNull();
    expect(result?.resource).toBe('metar');
    expect(result?.normalizedKey).toBe('KJFK');
    expect(result?.metadataKey).toBe('v1:hot:metar:KJFK');
  });

  it('returns null when stored data is malformed', async () => {
    const env = createEnv({
      METAR_CACHE: {
        get: async () => ({ notAValidEntry: true }),
        put: async () => {},
        list: async () => ({ keys: [], list_complete: true }),
        delete: async () => {}
      }
    });
    const result = await readHotCacheQueueEntry(env, 'v1:hot:metar:KJFK');
    expect(result).toBeNull();
  });
});

describe('touchHotCacheEntry', () => {
  it('forwards expirationTtl to the KV put call', async () => {
    const puts: Array<[string, string, { expirationTtl?: number } | undefined]> = [];
    const env = createEnv({
      METAR_CACHE: {
        get: async () => null,
        put: async (key, value, options) => {
          puts.push([key, value, options]);
        },
        list: async () => ({ keys: [], list_complete: true }),
        delete: async () => {}
      }
    });

    await touchHotCacheEntry({
      env,
      resource: 'metar',
      normalizedKey: 'KJFK',
      cache: fakeProvenance('v1:metar:KJFK', '2026-03-06T11:00:00.000Z'),
      lastAccessedAt: '2026-03-06T11:30:00.000Z',
      expirationTtl: 432000
    });

    expect(puts).toHaveLength(1);
    expect(puts[0]?.[2]).toEqual({ expirationTtl: 432000 });
  });

  it('omits the options argument when expirationTtl is not provided', async () => {
    const puts: Array<[string, string, unknown]> = [];
    const env = createEnv({
      METAR_CACHE: {
        get: async () => null,
        put: async (key, value, options) => {
          puts.push([key, value, options]);
        },
        list: async () => ({ keys: [], list_complete: true }),
        delete: async () => {}
      }
    });

    await touchHotCacheEntry({
      env,
      resource: 'metar',
      normalizedKey: 'KJFK',
      cache: fakeProvenance('v1:metar:KJFK', '2026-03-06T11:00:00.000Z'),
      lastAccessedAt: '2026-03-06T11:30:00.000Z'
    });

    expect(puts[0]?.[2]).toBeUndefined();
  });
});

describe('updateHotCacheEntryAfterRefresh', () => {
  it('preserves a more recent lastAccessedAt found in KV when writing', async () => {
    const concurrentAccessAt = '2026-03-06T11:59:00.000Z';
    const store = new Map<string, unknown>([
      [
        'v1:hot:metar:KJFK',
        {
          schemaVersion: 1,
          resource: 'metar',
          normalizedKey: 'KJFK',
          cacheKey: 'v1:metar:KJFK',
          lastAccessedAt: concurrentAccessAt,
          lastRefreshedAt: '2026-03-06T10:00:00.000Z'
        }
      ]
    ]);
    const env = createEnv({
      METAR_CACHE: {
        get: async (key) => store.get(key) ?? null,
        put: async (key, value) => {
          store.set(key, JSON.parse(value) as unknown);
        },
        list: async () => ({ keys: [], list_complete: true }),
        delete: async () => {}
      }
    });

    // Snapshot has an older lastAccessedAt than what is currently in KV.
    const snapshot = buildValidEntry('metar', 'KJFK', 'v1:hot:metar:KJFK');
    snapshot.lastAccessedAt = '2026-03-06T11:50:00.000Z';

    await updateHotCacheEntryAfterRefresh(
      env,
      snapshot,
      fakeProvenance('v1:metar:KJFK', '2026-03-06T12:00:00.000Z')
    );

    const written = store.get('v1:hot:metar:KJFK') as { lastAccessedAt: string };
    expect(written.lastAccessedAt).toBe(concurrentAccessAt);
  });

  it('keeps snapshot lastAccessedAt when KV has an equal or older value', async () => {
    const snapshotAccessAt = '2026-03-06T11:50:00.000Z';
    const store = new Map<string, unknown>([
      [
        'v1:hot:metar:KJFK',
        {
          schemaVersion: 1,
          resource: 'metar',
          normalizedKey: 'KJFK',
          cacheKey: 'v1:metar:KJFK',
          lastAccessedAt: '2026-03-06T11:40:00.000Z',
          lastRefreshedAt: '2026-03-06T10:00:00.000Z'
        }
      ]
    ]);
    const env = createEnv({
      METAR_CACHE: {
        get: async (key) => store.get(key) ?? null,
        put: async (key, value) => {
          store.set(key, JSON.parse(value) as unknown);
        },
        list: async () => ({ keys: [], list_complete: true }),
        delete: async () => {}
      }
    });

    const snapshot = buildValidEntry('metar', 'KJFK', 'v1:hot:metar:KJFK');
    snapshot.lastAccessedAt = snapshotAccessAt;

    await updateHotCacheEntryAfterRefresh(
      env,
      snapshot,
      fakeProvenance('v1:metar:KJFK', '2026-03-06T12:00:00.000Z')
    );

    const written = store.get('v1:hot:metar:KJFK') as { lastAccessedAt: string };
    expect(written.lastAccessedAt).toBe(snapshotAccessAt);
  });

  it('forwards expirationTtl to the KV put call', async () => {
    const puts: Array<[string, string, unknown]> = [];
    const env = createEnv({
      METAR_CACHE: {
        get: async () => null,
        put: async (key, value, options) => {
          puts.push([key, value, options]);
        },
        list: async () => ({ keys: [], list_complete: true }),
        delete: async () => {}
      }
    });

    const snapshot = buildValidEntry('metar', 'KJFK', 'v1:hot:metar:KJFK');

    await updateHotCacheEntryAfterRefresh(
      env,
      snapshot,
      fakeProvenance('v1:metar:KJFK', '2026-03-06T12:00:00.000Z'),
      432000
    );

    expect(puts[0]?.[2]).toEqual({ expirationTtl: 432000 });
  });

  it('omits the options argument when expirationTtl is not provided', async () => {
    const puts: Array<[string, string, unknown]> = [];
    const env = createEnv({
      METAR_CACHE: {
        get: async () => null,
        put: async (key, value, options) => {
          puts.push([key, value, options]);
        },
        list: async () => ({ keys: [], list_complete: true }),
        delete: async () => {}
      }
    });

    const snapshot = buildValidEntry('metar', 'KJFK', 'v1:hot:metar:KJFK');

    await updateHotCacheEntryAfterRefresh(
      env,
      snapshot,
      fakeProvenance('v1:metar:KJFK', '2026-03-06T12:00:00.000Z')
    );

    expect(puts[0]?.[2]).toBeUndefined();
  });
});

describe('listHotCacheQueueEntries', () => {
  it('returns empty array when KV does not support list', async () => {
    const env = createEnv({
      METAR_CACHE: {
        get: async () => null,
        put: async () => {},
        delete: async () => {}
      }
    });
    const result = await listHotCacheQueueEntries(env);
    expect(result).toHaveLength(0);
  });

  it('returns all entries across multiple KV pages', async () => {
    const allKeys = ['v1:hot:metar:KAAA', 'v1:hot:metar:KBBB', 'v1:hot:airport:KJFK'];
    const store = new Map<string, unknown>(
      allKeys.map((key) => [
        key,
        {
          schemaVersion: 1,
          resource: key.includes(':airport:') ? 'airport' : 'metar',
          normalizedKey: key.split(':').pop(),
          cacheKey: key.replace('hot:', ''),
          lastAccessedAt: '2026-03-06T11:00:00.000Z',
          lastRefreshedAt: '2026-03-06T10:00:00.000Z'
        }
      ])
    );
    const env = createEnv({
      METAR_CACHE: {
        get: async (key) => store.get(key) ?? null,
        put: async () => {},
        list: async (opts) => {
          // Serve one key per page to exercise multi-page pagination.
          const start = Number.parseInt(opts?.cursor ?? '0', 10);
          const pageKey = allKeys[start];
          const listComplete = start + 1 >= allKeys.length;
          return {
            keys: pageKey ? [{ name: pageKey }] : [],
            list_complete: listComplete,
            cursor: listComplete ? undefined : `${start + 1}`
          };
        },
        delete: async () => {}
      }
    });

    const result = await listHotCacheQueueEntries(env);
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.normalizedKey).sort()).toEqual(['KAAA', 'KBBB', 'KJFK']);
  });

  it('skips malformed entries without failing', async () => {
    const store = new Map<string, unknown>([
      [
        'v1:hot:metar:KJFK',
        {
          schemaVersion: 1,
          resource: 'metar',
          normalizedKey: 'KJFK',
          cacheKey: 'v1:metar:KJFK',
          lastAccessedAt: '2026-03-06T11:00:00.000Z',
          lastRefreshedAt: '2026-03-06T10:00:00.000Z'
        }
      ],
      ['v1:hot:metar:BAD', { invalid: true }]
    ]);
    const env = createEnv({
      METAR_CACHE: {
        get: async (key) => store.get(key) ?? null,
        put: async () => {},
        list: async () => ({
          keys: [...store.keys()].map((name) => ({ name })),
          list_complete: true
        }),
        delete: async () => {}
      }
    });

    const result = await listHotCacheQueueEntries(env);
    expect(result).toHaveLength(1);
    expect(result[0]?.normalizedKey).toBe('KJFK');
  });

  it('stops scanning once maxScanEntries is reached', async () => {
    const allKeys = Array.from({ length: 10 }, (_, i) => `v1:hot:metar:K${String(i).padStart(3, '0')}`);
    const store = new Map<string, unknown>(
      allKeys.map((key) => [
        key,
        {
          schemaVersion: 1,
          resource: 'metar',
          normalizedKey: key.split(':').pop(),
          cacheKey: key.replace('hot:', ''),
          lastAccessedAt: '2026-03-06T11:00:00.000Z',
          lastRefreshedAt: '2026-03-06T10:00:00.000Z'
        }
      ])
    );
    const listCalls: number[] = [];
    const env = createEnv({
      METAR_CACHE: {
        get: async (key) => store.get(key) ?? null,
        put: async () => {},
        list: async (opts) => {
          const limit = opts?.limit ?? 1000;
          listCalls.push(limit);
          const start = Number.parseInt(opts?.cursor ?? '0', 10);
          const pageKeys = allKeys.slice(start, start + limit);
          const nextStart = start + pageKeys.length;
          const listComplete = nextStart >= allKeys.length;
          return {
            keys: pageKeys.map((name) => ({ name })),
            list_complete: listComplete,
            cursor: listComplete ? undefined : `${nextStart}`
          };
        },
        delete: async () => {}
      }
    });

    // With maxScanEntries=3, only the first 3 keys should be fetched.
    const result = await listHotCacheQueueEntries(env, 3);
    expect(result).toHaveLength(3);
    // The list call should have been issued with limit=3, not the default 1000.
    expect(listCalls[0]).toBe(3);
    // Only one page call should have been made since 3 entries exhausted the cap.
    expect(listCalls).toHaveLength(1);
  });
});
