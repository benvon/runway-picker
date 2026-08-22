import { describe, expect, it, vi } from 'vitest';
import {
  commitHotCacheQueueCursor,
  listHotCacheQueuePage,
  loadHotCacheQueueEntries,
  parseCacheRefresherConfig,
  readHotCacheQueueCursor,
  readHotCacheQueueEntry,
  recordHotCacheRefreshFailure,
  recoverRejectedHotCacheQueueCursor,
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

  it('normalizes a configured refresh cap below two to the effective floor', () => {
    const config = parseCacheRefresherConfig(createEnv({ CACHE_REFRESH_MAX_ITEMS_PER_RUN: '1' }));
    expect(config.maxItemsPerRun).toBe(2);
  });
});

function fakeProvenance(key: string, fetchedAt: string): CacheProvenance {
  return {
    status: 'upstream_refresh',
    source: 'upstream',
    ageSeconds: 0,
    fetchedAt,
    expiresAt: new Date(new Date(fetchedAt).getTime() + 1_800_000).toISOString(),
    freshnessRemainingSeconds: 1800,
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
    schemaVersion: 2,
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
    const result = await readHotCacheQueueEntry(env, 'v2:hot:metar:KJFK');
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

    const result = await readHotCacheQueueEntry(env, 'v2:hot:metar:KJFK');
    expect(result).not.toBeNull();
    expect(result?.resource).toBe('metar');
    expect(result?.normalizedKey).toBe('KJFK');
    expect(result?.metadataKey).toBe('v2:hot:metar:KJFK');
    expect(result?.cacheKey).toBe('v1:metar:KJFK');
    expect(store.get('v2:hot:metar:KJFK')).not.toHaveProperty('cacheKey');
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
    const result = await readHotCacheQueueEntry(env, 'v2:hot:metar:KJFK');
    expect(result).toBeNull();
  });
});

describe('touchHotCacheEntry', () => {
  it('updates only demand state on an existing entry', async () => {
    const metadataKey = 'v2:hot:metar:KJFK';
    const store = new Map<string, unknown>([[metadataKey, {
      schemaVersion: 3,
      resource: 'metar',
      normalizedKey: 'KJFK',
      lastAccessedAt: '2026-03-06T11:00:00.000Z',
      lastRefreshedAt: '2026-03-06T10:00:00.000Z',
      consecutiveRefreshFailures: 2
    }]]);
    const env = createEnv({
      METAR_CACHE: {
        get: async (key) => store.get(key) ?? null,
        put: async (key, value) => { store.set(key, JSON.parse(value) as unknown); },
        list: async () => ({ keys: [], list_complete: true }),
        delete: async () => {}
      }
    });

    await touchHotCacheEntry({
      env,
      resource: 'metar',
      normalizedKey: 'KJFK',
      cache: fakeProvenance('v1:metar:KJFK', '2026-03-06T12:00:00.000Z'),
      lastAccessedAt: '2026-03-06T12:05:00.000Z'
    });

    expect(store.get(metadataKey)).toMatchObject({
      lastAccessedAt: '2026-03-06T12:05:00.000Z',
      lastRefreshedAt: '2026-03-06T10:00:00.000Z',
      consecutiveRefreshFailures: 2
    });
  });

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
    expect(JSON.parse(puts[0]?.[1] ?? '{}')).not.toHaveProperty('cacheKey');
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
        'v2:hot:metar:KJFK',
        {
          schemaVersion: 2,
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
    const snapshot = buildValidEntry('metar', 'KJFK', 'v2:hot:metar:KJFK');
    snapshot.lastAccessedAt = '2026-03-06T11:50:00.000Z';

    await updateHotCacheEntryAfterRefresh(
      env,
      snapshot,
      fakeProvenance('v1:metar:KJFK', '2026-03-06T12:00:00.000Z')
    );

    const written = store.get('v2:hot:metar:KJFK') as { lastAccessedAt: string };
    expect(written.lastAccessedAt).toBe(concurrentAccessAt);
  });

  it('keeps snapshot lastAccessedAt when KV has an equal or older value', async () => {
    const snapshotAccessAt = '2026-03-06T11:50:00.000Z';
    const store = new Map<string, unknown>([
      [
        'v2:hot:metar:KJFK',
        {
          schemaVersion: 2,
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

    const snapshot = buildValidEntry('metar', 'KJFK', 'v2:hot:metar:KJFK');
    snapshot.lastAccessedAt = snapshotAccessAt;

    await updateHotCacheEntryAfterRefresh(
      env,
      snapshot,
      fakeProvenance('v1:metar:KJFK', '2026-03-06T12:00:00.000Z')
    );

    const written = store.get('v2:hot:metar:KJFK') as { lastAccessedAt: string };
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

    const snapshot = buildValidEntry('metar', 'KJFK', 'v2:hot:metar:KJFK');

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

    const snapshot = buildValidEntry('metar', 'KJFK', 'v2:hot:metar:KJFK');

    await updateHotCacheEntryAfterRefresh(
      env,
      snapshot,
      fakeProvenance('v1:metar:KJFK', '2026-03-06T12:00:00.000Z')
    );

    expect(puts[0]?.[2]).toBeUndefined();
  });
});

describe('recordHotCacheRefreshFailure', () => {
  it('migrates V2 metadata, resets failures after success, and drops only the queue entry on the third failure', async () => {
    const metadataKey = 'v2:hot:metar:KJFK';
    const payloadKey = 'v1:metar:KJFK';
    const store = new Map<string, unknown>([
      [
        metadataKey,
        {
          schemaVersion: 2,
          resource: 'metar',
          normalizedKey: 'KJFK',
          lastAccessedAt: '2026-03-06T11:00:00.000Z',
          lastRefreshedAt: '2026-03-06T10:00:00.000Z'
        }
      ],
      [payloadKey, { cached: true }]
    ]);
    const env = createEnv({
      METAR_CACHE: {
        get: async (key) => store.get(key) ?? null,
        put: async (key, value) => { store.set(key, JSON.parse(value) as unknown); },
        list: async () => ({ keys: [], list_complete: true }),
        delete: async (key) => { store.delete(key); }
      }
    });
    const entry = buildValidEntry('metar', 'KJFK', metadataKey);

    await expect(recordHotCacheRefreshFailure(env, entry, 432000)).resolves.toEqual({
      consecutiveRefreshFailures: 1,
      dropped: false
    });
    expect(store.get(metadataKey)).toMatchObject({ schemaVersion: 3, consecutiveRefreshFailures: 1 });

    await updateHotCacheEntryAfterRefresh(
      env,
      entry,
      fakeProvenance(payloadKey, '2026-03-06T12:00:00.000Z'),
      432000
    );
    expect(store.get(metadataKey)).toMatchObject({ schemaVersion: 3, consecutiveRefreshFailures: 0 });

    await recordHotCacheRefreshFailure(env, entry, 432000);
    await recordHotCacheRefreshFailure(env, entry, 432000);
    await expect(recordHotCacheRefreshFailure(env, entry, 432000)).resolves.toEqual({
      consecutiveRefreshFailures: 3,
      dropped: true
    });
    expect(store.has(metadataKey)).toBe(false);
    expect(store.get(payloadKey)).toEqual({ cached: true });
  });
});

describe('hot queue scan pages', () => {
  it('returns an empty completed page when KV does not support list', async () => {
    const env = createEnv({
      METAR_CACHE: {
        get: async () => null,
        put: async () => {},
        delete: async () => {}
      }
    });
    const result = await listHotCacheQueuePage(env, 'metar', undefined, 1);
    expect(result).toEqual({ metadataKeys: [], scanned: 0, listComplete: true });
  });

  it('scans only the requested resource namespace so other resources and legacy entries cannot consume its budget', async () => {
    const prefixes: string[] = [];
    const env = createEnv({
      METAR_CACHE: {
        get: async () => null,
        put: async () => {},
        list: async (options) => {
          prefixes.push(options?.prefix ?? '');
          return { keys: [], list_complete: true };
        },
        delete: async () => {}
      }
    });

    await listHotCacheQueuePage(env, 'airport', undefined, 1);

    expect(prefixes).toEqual(['v2:hot:airport:']);
  });

  it('derives the payload key instead of trusting a persisted queue cacheKey', async () => {
    const metadataKey = 'v2:hot:airport:KJFK';
    const env = createEnv({
      METAR_CACHE: {
        get: async () => ({
          schemaVersion: 2,
          resource: 'airport',
          normalizedKey: 'KJFK',
          cacheKey: 'v1:airport:KJFK:location',
          lastAccessedAt: '2026-03-06T11:00:00.000Z',
          lastRefreshedAt: '2026-03-06T10:00:00.000Z'
        }),
        put: async () => {},
        list: async () => ({ keys: [{ name: metadataKey }], list_complete: true }),
        delete: async () => {}
      }
    });

    const page = await listHotCacheQueuePage(env, 'airport', undefined, 1);
    const [entry] = await loadHotCacheQueueEntries(env, page);

    expect(entry?.cacheKey).toBe('v1:airport:KJFK');
  });

  it('keeps page listing and metadata loading free of checkpoint writes', async () => {
    const allKeys = ['v2:hot:metar:KAAA', 'v2:hot:metar:KBBB'];
    const store = new Map<string, unknown>(
      allKeys.map((key) => [
        key,
        {
          schemaVersion: 2,
          resource: 'metar',
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
        put: async (key, value) => {
          store.set(key, JSON.parse(value) as unknown);
        },
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
        delete: async (key) => {
          store.delete(key);
        }
      }
    });

    store.set('v2:control:hot-refresh-cursor:metar', { schemaVersion: 1, cursor: '0' });
    const first = await listHotCacheQueuePage(env, 'metar', '0', 1);
    const firstEntries = await loadHotCacheQueueEntries(env, first);
    expect(firstEntries.map((entry) => entry.normalizedKey)).toEqual(['KAAA']);
    expect(first.scanned).toBe(1);
    expect(first.listComplete).toBe(false);
    expect(store.get('v2:control:hot-refresh-cursor:metar')).toEqual({ schemaVersion: 1, cursor: '0' });

    await commitHotCacheQueueCursor(env, 'metar', first);
    expect(store.get('v2:control:hot-refresh-cursor:metar')).toEqual({ schemaVersion: 1, cursor: '1' });

    const second = await listHotCacheQueuePage(env, 'metar', first.nextCursor, 1);
    expect(second.listComplete).toBe(true);
    await commitHotCacheQueueCursor(env, 'metar', second);
    expect(store.has('v2:control:hot-refresh-cursor:metar')).toBe(false);
  });

  it('skips malformed entries without failing', async () => {
    const store = new Map<string, unknown>([
      [
        'v2:hot:metar:KJFK',
        {
          schemaVersion: 2,
          resource: 'metar',
          normalizedKey: 'KJFK',
          cacheKey: 'v1:metar:KJFK',
          lastAccessedAt: '2026-03-06T11:00:00.000Z',
          lastRefreshedAt: '2026-03-06T10:00:00.000Z'
        }
      ],
      ['v2:hot:metar:BAD', { invalid: true }]
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

    const page = await listHotCacheQueuePage(env, 'metar', undefined, 2);
    const result = await loadHotCacheQueueEntries(env, page);
    expect(result).toHaveLength(1);
    expect(result[0]?.normalizedKey).toBe('KJFK');
  });

  it('bounds each resource page by its scan budget', async () => {
    const allKeys = Array.from({ length: 10 }, (_, i) => `v2:hot:metar:K${String(i).padStart(3, '0')}`);
    const store = new Map<string, unknown>(
      allKeys.map((key) => [
        key,
        {
          schemaVersion: 2,
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
    const result = await listHotCacheQueuePage(env, 'metar', undefined, 3);
    expect(result.metadataKeys).toHaveLength(3);
    // The list call should have been issued with limit=3, not the default 1000.
    expect(listCalls[0]).toBe(3);
    // Only one page call should have been made since 3 entries exhausted the cap.
    expect(listCalls).toHaveLength(1);
  });

  it('clears a malformed saved cursor and starts from the beginning with one bounded diagnostic', async () => {
    const store = new Map<string, unknown>([
      ['v2:control:hot-refresh-cursor:airport', { schemaVersion: 1, cursor: 42 }]
    ]);
    const listCursors: Array<string | undefined> = [];
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = createEnv({
      METAR_CACHE: {
        get: async (key) => store.get(key) ?? null,
        put: async (key, value) => { store.set(key, JSON.parse(value) as unknown); },
        list: async (options) => {
          listCursors.push(options?.cursor);
          return { keys: [], list_complete: true };
        },
        delete: async (key) => { store.delete(key); }
      }
    });

    const cursor = await readHotCacheQueueCursor(env, 'airport');
    await listHotCacheQueuePage(env, 'airport', cursor, 1);

    expect(listCursors).toEqual([undefined]);
    expect(store.has('v2:control:hot-refresh-cursor:airport')).toBe(false);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      'Scheduled cache refresh cursor checkpoint reset.',
      { resource: 'airport', reason: 'malformed' }
    );
    warning.mockRestore();
  });

  it('reads a valid cursor from raw JSON without changing the checkpoint', async () => {
    const store = new Map<string, unknown>([
      ['v2:control:hot-refresh-cursor:metar', { schemaVersion: 1, cursor: 'opaque-cursor' }]
    ]);
    const deleteSpy = vi.fn();
    const env = createEnv({
      METAR_CACHE: {
        get: async (key, type) => {
          const value = store.get(key) ?? null;
          return type === 'text' && value !== null ? JSON.stringify(value) : value;
        },
        put: async () => {},
        list: async () => ({ keys: [], list_complete: true }),
        delete: deleteSpy
      }
    });

    await expect(readHotCacheQueueCursor(env, 'metar')).resolves.toBe('opaque-cursor');
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('clears syntactically invalid raw JSON checkpoints and recovers from the prefix', async () => {
    const deletedKeys: string[] = [];
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = createEnv({
      METAR_CACHE: {
        get: async (_key, type) => (type === 'text' ? '{not-json' : null),
        put: async () => {},
        list: async () => ({ keys: [], list_complete: true }),
        delete: async (key) => { deletedKeys.push(key); }
      }
    });

    await expect(readHotCacheQueueCursor(env, 'airport')).resolves.toBeUndefined();
    expect(deletedKeys).toEqual(['v2:control:hot-refresh-cursor:airport']);
    expect(warning).toHaveBeenCalledWith(
      'Scheduled cache refresh cursor checkpoint reset.',
      { resource: 'airport', reason: 'malformed' }
    );
    warning.mockRestore();
  });

  it('clears a rejected saved cursor without deleting hot-entry or payload data', async () => {
    const store = new Map<string, unknown>([
      ['v2:control:hot-refresh-cursor:metar', { schemaVersion: 1, cursor: 'stale' }],
      ['v2:hot:metar:KJFK', { schemaVersion: 2, resource: 'metar', normalizedKey: 'KJFK', lastAccessedAt: '2026-03-06T11:00:00.000Z', lastRefreshedAt: '2026-03-06T10:00:00.000Z' }],
      ['v1:metar:KJFK', { cached: true }]
    ]);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = createEnv({
      METAR_CACHE: {
        get: async (key) => store.get(key) ?? null,
        put: async (key, value) => { store.set(key, JSON.parse(value) as unknown); },
        list: async () => ({ keys: [{ name: 'v2:hot:metar:KJFK' }], list_complete: true }),
        delete: async (key) => { store.delete(key); }
      }
    });

    await recoverRejectedHotCacheQueueCursor(env, 'metar');

    expect(store.has('v2:hot:metar:KJFK')).toBe(true);
    expect(store.has('v1:metar:KJFK')).toBe(true);
    expect(warning).toHaveBeenCalledWith(
      'Scheduled cache refresh cursor checkpoint reset.',
      { resource: 'metar', reason: 'rejected' }
    );
    warning.mockRestore();
  });
});
