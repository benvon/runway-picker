import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __cacheRefreshHelpers,
  default as workerEntrypoint,
  extractMetarRaw,
  handleAirportRequest as handleAirportRequestFromWorker,
  handleAirportLocationRequest as handleAirportLocationRequestFromWorker,
  handleMetarRequest as handleMetarRequestFromWorker,
  MetarWorkerError,
  normalizeAirportIcao,
  normalizeIcao,
  runScheduledCacheRefresh as runScheduledCacheRefreshFromWorker
} from './index';
import type { CacheRefresherConfig, HotCacheQueueEntry } from './cache/hotQueue';
import type { CacheEngineEnv } from './cache/types';
import { CacheSingleFlightCoordinator } from './cache/singleFlight';

class CoordinatorStorage {
  private readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
}

const schedulerCoordinators = new WeakMap<object, CacheEngineEnv['CACHE_COORDINATOR']>();

function schedulerCoordinator(env: CacheEngineEnv): NonNullable<CacheEngineEnv['CACHE_COORDINATOR']> {
  const storage = new CoordinatorStorage();
  let coordinator: CacheSingleFlightCoordinator | undefined;
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input.toString(), init);
        coordinator ??= new CacheSingleFlightCoordinator({ storage }, env);
        return coordinator.fetch(request);
      }
    })
  };
}

function withSchedulerCoordinator(env: CacheEngineEnv): CacheEngineEnv {
  const key = env.METAR_CACHE as object;
  let coordinator = schedulerCoordinators.get(key);
  if (!coordinator) {
    coordinator = schedulerCoordinator(env);
    schedulerCoordinators.set(key, coordinator);
  }
  return { ...env, CACHE_COORDINATOR: coordinator };
}

function runScheduledCacheRefresh(env: CacheEngineEnv, clock?: () => Date): Promise<void> {
  return runScheduledCacheRefreshFromWorker(withSchedulerCoordinator(env), clock);
}

class MemoryKv {
  private values = new Map<string, unknown>();

  async get(key: string, type: 'json' | 'text'): Promise<unknown> {
    const value = this.values.get(key) ?? null;
    if (type !== 'text' || value === null) {
      return value;
    }

    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  async put(key: string, value: string, _options?: { expirationTtl?: number }): Promise<void> {
    void _options;
    this.values.set(key, JSON.parse(value) as unknown);
  }

  async list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix ?? '';
    const limit = Math.max(1, options?.limit ?? 1000);
    const start = Number.parseInt(options?.cursor ?? '0', 10);
    const offset = Number.isFinite(start) && start >= 0 ? start : 0;
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort((left, right) => left.localeCompare(right));
    const page = keys.slice(offset, offset + limit);
    const nextCursor = offset + page.length;

    return {
      keys: page.map((name) => ({ name })),
      list_complete: nextCursor >= keys.length,
      cursor: nextCursor >= keys.length ? undefined : `${nextCursor}`
    };
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  seed(key: string, value: unknown): void {
    this.values.set(key, value);
  }

  read<T>(key: string): T | null {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  has(key: string): boolean {
    return this.values.has(key);
  }
}

function setCacheTimestamps(kv: MemoryKv, key: string, fetchedAt: Date, expiresAt: Date): void {
  const cached = kv.read<{ cacheMeta?: Record<string, unknown> }>(key);
  if (!cached?.cacheMeta) {
    throw new Error(`Expected cached payload for ${key}.`);
  }
  kv.seed(key, {
    ...cached,
    cacheMeta: {
      ...cached.cacheMeta,
      fetchedAt: fetchedAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    }
  });
}

function alwaysBlockedRateLimiter() {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () =>
        Response.json({
          allowed: false,
          limit: 60,
          remaining: 0,
          resetSeconds: 10,
          retryAfterSeconds: 10
        })
    })
  };
}

function alwaysAllowedRateLimiter() {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () =>
        Response.json({
          allowed: true,
          limit: 60,
          remaining: 59,
          resetSeconds: 60,
          retryAfterSeconds: null
        })
    })
  };
}

function rateLimiterWithCheck(fetchCheck: () => Promise<Response>) {
  return {
    idFromName: (name: string) => name,
    get: () => ({ fetch: fetchCheck })
  };
}

function withHealthyRateLimiter(env: CacheEngineEnv): CacheEngineEnv {
  return env.API_RATE_LIMITER ? env : { ...env, API_RATE_LIMITER: alwaysAllowedRateLimiter() };
}

function handleMetarRequest(request: Request, env: CacheEngineEnv, ctx?: { waitUntil(promise: Promise<unknown>): void }) {
  return handleMetarRequestFromWorker(request, withSchedulerCoordinator(withHealthyRateLimiter(env)), ctx);
}

function handleAirportRequest(request: Request, env: CacheEngineEnv, ctx?: { waitUntil(promise: Promise<unknown>): void }) {
  return handleAirportRequestFromWorker(request, withSchedulerCoordinator(withHealthyRateLimiter(env)), ctx);
}

function handleAirportLocationRequest(request: Request, env: CacheEngineEnv) {
  return handleAirportLocationRequestFromWorker(request, withHealthyRateLimiter(env));
}

function capturingRateLimiter(capturedNames: string[]) {
  return {
    idFromName: (name: string) => {
      capturedNames.push(name);
      return name;
    },
    get: () => ({
      fetch: async () =>
        Response.json({
          allowed: true,
          limit: 60,
          remaining: 59,
          resetSeconds: 60,
          retryAfterSeconds: null
        })
    })
  };
}

function buildMetarReport(icao: string, wind: { wdir: string | number; wspd: number; wgst?: number | null }) {
  return {
    icaoId: icao,
    rawOb: `METAR ${icao} 021953Z ${typeof wind.wdir === 'string' ? wind.wdir : `${wind.wdir}`.padStart(3, '0')}${wind.wspd
      .toString()
      .padStart(2, '0')}${wind.wgst ? `G${wind.wgst.toString().padStart(2, '0')}` : ''}KT 10SM FEW020 08/03 A3012 RMK AO2`,
    wdir: wind.wdir,
    wspd: wind.wspd,
    wgst: wind.wgst ?? null
  };
}

function buildAirportReport(icao: string): Record<string, unknown> {
  return {
    ident: icao,
    icao_code: icao,
    name: `${icao} Test Airport`,
    municipality: 'Testville',
    iso_country: 'US',
    country: { name: 'United States' },
    elevation_ft: '100',
    latitude_deg: '39.0997',
    longitude_deg: '-94.5786',
    home_link: `https://${icao.toLowerCase()}.example.com`,
    runways: [
      {
        closed: '0',
        length_ft: '12000',
        le_ident: '04L',
        he_ident: '22R',
        le_heading_degT: 47,
        he_heading_degT: 227
      },
      {
        closed: '1',
        length_ft: '10000',
        le_ident: '13',
        he_ident: '31',
        le_heading_degT: 137,
        he_heading_degT: 317
      }
    ],
    freqs: [
      { type: 'APP', description: 'NORTH APP', frequency_mhz: '125.7' },
      { type: 'TWR', description: 'TOWER', frequency_mhz: '119.1' },
      { type: 'ATIS', description: 'ATIS', frequency_mhz: '128.725' },
      { type: 'CTAF', description: 'CTAF', frequency_mhz: '123.0' }
    ]
  };
}

function seedHotQueueEntry(
  kv: MemoryKv,
  entry: {
    resource: 'metar' | 'airport';
    normalizedKey: string;
    cacheKey: string;
    lastAccessedAt: string;
    lastRefreshedAt: string;
  }
): void {
  kv.seed(`v2:hot:${entry.resource}:${entry.normalizedKey}`, {
    schemaVersion: 2,
    resource: entry.resource,
    normalizedKey: entry.normalizedKey,
    cacheKey: entry.cacheKey,
    lastAccessedAt: entry.lastAccessedAt,
    lastRefreshedAt: entry.lastRefreshedAt
  });
}

describe('cache refresh helpers', () => {
  it('computes inactivity with strict greater-than ttl boundary', () => {
    const nowMs = Date.parse('2026-03-07T12:00:00.000Z');
    const ttlMs = 5 * 24 * 60 * 60 * 1000;
    const exactlyAtBoundary = nowMs - ttlMs;
    const justBeyondBoundary = nowMs - ttlMs - 1;

    expect(__cacheRefreshHelpers.isInactive(exactlyAtBoundary, nowMs, ttlMs)).toBe(false);
    expect(__cacheRefreshHelpers.isInactive(justBeyondBoundary, nowMs, ttlMs)).toBe(true);
    expect(__cacheRefreshHelpers.isInactive(0, nowMs, ttlMs)).toBe(true);
  });

  it('computes refresh due by resource-specific interval and timestamp validity', () => {
    const config: CacheRefresherConfig = {
      enabled: true,
      metarRefreshIntervalSeconds: 1800,
      airportRefreshIntervalSeconds: 86400,
      inactivityTtlSeconds: 432000,
      maxItemsPerRun: 25
    };

    const nowMs = Date.parse('2026-03-07T12:00:00.000Z');
    const metarEntry: HotCacheQueueEntry = {
      schemaVersion: 3,
      resource: 'metar',
      normalizedKey: 'KMCI',
      cacheKey: 'v1:metar:KMCI',
      lastAccessedAt: '2026-03-07T11:59:00.000Z',
      lastRefreshedAt: '2026-03-07T11:30:00.000Z',
      metadataKey: 'v2:hot:metar:KMCI'
    };

    const airportEntry: HotCacheQueueEntry = {
      schemaVersion: 3,
      resource: 'airport',
      normalizedKey: 'KJFK',
      cacheKey: 'v1:airport:KJFK',
      lastAccessedAt: '2026-03-07T11:59:00.000Z',
      lastRefreshedAt: '2026-03-06T12:00:00.000Z',
      metadataKey: 'v2:hot:airport:KJFK'
    };

    expect(__cacheRefreshHelpers.isRefreshDue(metarEntry, nowMs, config)).toBe(true);
    expect(__cacheRefreshHelpers.isRefreshDue(airportEntry, nowMs, config)).toBe(true);

    const freshMetar = { ...metarEntry, lastRefreshedAt: '2026-03-07T11:45:01.000Z' };
    expect(__cacheRefreshHelpers.isRefreshDue(freshMetar, nowMs, config)).toBe(false);

    const invalidTimestamp = { ...metarEntry, lastRefreshedAt: 'invalid' };
    expect(__cacheRefreshHelpers.isRefreshDue(invalidTimestamp, nowMs, config)).toBe(true);
  });

  it('preserves coordinator order within each resource while round-robining between resources', () => {
    const entry = (resource: 'metar' | 'airport', normalizedKey: string, lastRefreshedAt: string): HotCacheQueueEntry => ({
      schemaVersion: 2,
      resource,
      normalizedKey,
      cacheKey: `v1:${resource}:${normalizedKey}`,
      lastAccessedAt: '2026-03-07T11:59:00.000Z',
      lastRefreshedAt,
      metadataKey: `v2:hot:${resource}:${normalizedKey}`
    });

    const selected = __cacheRefreshHelpers.selectRoundRobinDueEntries(
      {
        metar: [entry('metar', 'KNEW', '2026-03-07T10:00:00.000Z'), entry('metar', 'KOLD', '2026-03-07T09:00:00.000Z')],
        airport: [entry('airport', 'KJFK', '2026-03-07T09:30:00.000Z'), entry('airport', 'KORD', '2026-03-07T09:45:00.000Z')]
      },
      4
    );

    expect(selected.map((item) => `${item.resource}:${item.normalizedKey}`)).toEqual([
      'metar:KNEW',
      'airport:KJFK',
      'metar:KOLD',
      'airport:KORD'
    ]);
  });

  it('does not move a wrapped coordinator prefix ahead of the continuation position', () => {
    const entry = (normalizedKey: string, lastAccessedAt: string): HotCacheQueueEntry => ({
      schemaVersion: 5,
      resource: 'metar',
      normalizedKey,
      cacheKey: `v1:metar:${normalizedKey}`,
      lastAccessedAt,
      metadataKey: `scheduler:metar:${normalizedKey}`
    });

    const selected = __cacheRefreshHelpers.selectRoundRobinDueEntries({
      metar: [
        entry('KAFTER', '2026-03-07T12:00:00.000Z'),
        entry('KWRAPPED', '2026-03-07T10:00:00.000Z')
      ],
      airport: []
    }, 2);

    expect(selected.map((item) => item.normalizedKey)).toEqual(['KAFTER', 'KWRAPPED']);
  });

  it('keeps active entries and evicts inactive entries in keepOrEvictQueueEntry', async () => {
    const nowMs = Date.parse('2026-03-07T12:00:00.000Z');
    const ttlMs = 5 * 24 * 60 * 60 * 1000;
    const kv = new MemoryKv();
    const env: CacheEngineEnv = { METAR_CACHE: kv };

    const activeEntry: HotCacheQueueEntry = {
      schemaVersion: 4,
      resource: 'metar',
      normalizedKey: 'KMSN',
      cacheKey: 'v1:metar:KMSN',
      lastAccessedAt: '2026-03-07T11:59:00.000Z',
      lastRefreshedAt: '2026-03-07T11:30:00.000Z',
      metadataKey: 'v2:hot:metar:KMSN'
    };

    const activeResult = await __cacheRefreshHelpers.keepOrEvictQueueEntry(env, activeEntry, nowMs, ttlMs);
    expect(activeResult).toMatchObject({
      schemaVersion: 5,
      resource: activeEntry.resource,
      normalizedKey: activeEntry.normalizedKey,
      lastAccessedAt: activeEntry.lastAccessedAt
    });

    seedHotQueueEntry(kv, {
      resource: 'metar',
      normalizedKey: 'KDEN',
      cacheKey: 'v1:metar:KDEN',
      lastAccessedAt: '2026-02-28T11:00:00.000Z',
      lastRefreshedAt: '2026-03-07T10:00:00.000Z'
    });
    kv.seed('v1:metar:KDEN', { cached: true });

    const inactiveEntry: HotCacheQueueEntry = {
      schemaVersion: 2,
      resource: 'metar',
      normalizedKey: 'KDEN',
      cacheKey: 'v1:metar:KDEN',
      lastAccessedAt: '2026-02-28T11:00:00.000Z',
      lastRefreshedAt: '2026-03-07T10:00:00.000Z',
      metadataKey: 'v2:hot:metar:KDEN'
    };

    const inactiveResult = await __cacheRefreshHelpers.keepOrEvictQueueEntry(
      env,
      inactiveEntry,
      nowMs,
      ttlMs
    );
    expect(inactiveResult).toBeNull();
    expect(kv.has('v2:hot:metar:KDEN')).toBe(false);
    expect(kv.has('v1:metar:KDEN')).toBe(false);
  });
});

describe('metar worker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('normalizes ICAO values', () => {
    expect(normalizeIcao(' kjfk ')).toBe('KJFK');
  });

  it('rejects invalid ICAO values', () => {
    expect(() => normalizeIcao('ABC')).toThrow(MetarWorkerError);
  });

  it('extracts METAR line from provider payload', () => {
    const payload = '\nMETAR KMCI 021953Z 11010KT 7SM OVC008 04/02 A3014 RMK AO2\n';
    expect(extractMetarRaw(payload)).toBe('METAR KMCI 021953Z 11010KT 7SM OVC008 04/02 A3014 RMK AO2');
  });

  it('returns kv cache hit including provenance metadata', async () => {
    const kv = new MemoryKv();
    const fetchedAt = new Date(Date.now() - 30_000);
    kv.seed('v1:metar:KMCI', {
      schemaVersion: 5,
      resource: 'metar',
      key: 'v1:metar:KMCI',
      data: {
        icao: 'KMCI',
        metarRaw: 'METAR KMCI 021953Z 11010KT 7SM OVC008 04/02 A3014 RMK AO2',
        wind: {
          raw: '11010KT',
          directionType: 'fixed',
          directionDegTrue: 110,
          directionVariation: null,
          speedKt: 10,
          gustKt: null
        },
        source: 'aviationweather',
        fetchedAt: fetchedAt.toISOString(),
        observedAt: fetchedAt.toISOString()
      },
      cacheMeta: {
        fetchedAt: fetchedAt.toISOString(),
        expiresAt: new Date(fetchedAt.getTime() + 30 * 60 * 1000).toISOString(),
        policyVersion: 'metar-v2',
        source: 'upstream'
      }
    });

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KMCI'), {
      METAR_CACHE: kv
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Runway-Cache-Status')).toBe('kv_hit');

    const payload = (await response.json()) as {
      icao: string;
      wind: { directionType: string; speedKt: number };
      observedAt: string | null;
      cache: { source: string; status: string };
    };

    expect(payload.icao).toBe('KMCI');
    expect(payload.wind.directionType).toBe('fixed');
    expect(typeof payload.observedAt).toBe('string');
    expect(payload.wind.speedKt).toBe(10);
    expect(payload.cache.source).toBe('kv');
    expect(payload.cache.status).toBe('kv_hit');
  });

  it('refreshes upstream when cached METAR identities disagree', async () => {
    const kv = new MemoryKv();
    const fetchedAt = new Date(Date.now() - 30_000);
    kv.seed('v1:metar:KMCI', {
      schemaVersion: 5,
      resource: 'metar',
      key: 'v1:metar:KMCI',
      data: {
        icao: 'KORD',
        metarRaw: 'METAR KORD 021953Z 11010KT 7SM OVC008 04/02 A3014 RMK AO2',
        wind: {
          raw: '11010KT',
          directionType: 'fixed',
          directionDegTrue: 110,
          directionVariation: null,
          speedKt: 10,
          gustKt: null
        },
        source: 'aviationweather',
        fetchedAt: fetchedAt.toISOString(),
        observedAt: fetchedAt.toISOString()
      },
      cacheMeta: {
        fetchedAt: fetchedAt.toISOString(),
        expiresAt: new Date(fetchedAt.getTime() + 30 * 60 * 1000).toISOString(),
        policyVersion: 'metar-v2',
        source: 'upstream'
      }
    });
    const fetchUpstream = vi.fn().mockResolvedValueOnce(Response.json([buildMetarReport('KMCI', { wdir: 110, wspd: 10 })]));
    vi.stubGlobal('fetch', fetchUpstream);

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KMCI'), {
      METAR_CACHE: kv
    });

    expect(response.status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledOnce();
    expect(response.headers.get('X-Runway-Cache-Status')).toBe('upstream_refresh');
  });

  it('derives public METAR cache lifetime from the cached record remaining freshness', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-03T12:00:00.000Z'));
    const kv = new MemoryKv();
    const fetchedAt = new Date('2026-03-03T11:59:30.000Z');
    const expiresAt = new Date('2026-03-03T12:00:05.000Z');
    kv.seed('v1:metar:KMCI', {
      schemaVersion: 5,
      resource: 'metar',
      key: 'v1:metar:KMCI',
      data: {
        icao: 'KMCI',
        metarRaw: 'METAR KMCI 021953Z 11010KT 7SM OVC008 04/02 A3014 RMK AO2',
        wind: {
          raw: '11010KT',
          directionType: 'fixed',
          directionDegTrue: 110,
          directionVariation: null,
          speedKt: 10,
          gustKt: null
        },
        source: 'aviationweather',
        fetchedAt: fetchedAt.toISOString(),
        observedAt: fetchedAt.toISOString()
      },
      cacheMeta: {
        fetchedAt: fetchedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        policyVersion: 'metar-v2',
        source: 'upstream'
      }
    });

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KMCI'), {
      METAR_CACHE: kv
    });

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=5, s-maxage=5');
    await expect(response.json()).resolves.toMatchObject({
      cache: {
        expiresAt: expiresAt.toISOString(),
        freshnessRemainingSeconds: 5
      }
    });
  });

  it('does not let downstream caches retain stale METAR data', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-03T12:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('provider unavailable')));
    const kv = new MemoryKv();
    const fetchedAt = new Date('2026-03-03T11:29:00.000Z');
    kv.seed('v1:metar:KMCI', {
      schemaVersion: 5,
      resource: 'metar',
      key: 'v1:metar:KMCI',
      data: {
        icao: 'KMCI',
        metarRaw: 'METAR KMCI 021953Z 11010KT 7SM OVC008 04/02 A3014 RMK AO2',
        wind: {
          raw: '11010KT',
          directionType: 'fixed',
          directionDegTrue: 110,
          directionVariation: null,
          speedKt: 10,
          gustKt: null
        },
        source: 'aviationweather',
        fetchedAt: fetchedAt.toISOString(),
        observedAt: fetchedAt.toISOString()
      },
      cacheMeta: {
        fetchedAt: fetchedAt.toISOString(),
        expiresAt: '2026-03-03T11:59:00.000Z',
        policyVersion: 'metar-v2',
        source: 'upstream'
      }
    });

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KMCI'), {
      METAR_CACHE: kv
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({
      cache: { status: 'stale_on_error', freshnessRemainingSeconds: 0 }
    });
  });

  it('does not emit cache lifetime after a delayed KV read passes record expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-03T12:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('provider unavailable')));
    const kv = new MemoryKv();
    const fetchedAt = new Date('2026-03-03T11:30:05.000Z');
    kv.seed('v1:metar:KMCI', {
      schemaVersion: 5,
      resource: 'metar',
      key: 'v1:metar:KMCI',
      data: {
        icao: 'KMCI',
        metarRaw: 'METAR KMCI 021953Z 11010KT 7SM OVC008 04/02 A3014 RMK AO2',
        wind: {
          raw: '11010KT',
          directionType: 'fixed',
          directionDegTrue: 110,
          directionVariation: null,
          speedKt: 10,
          gustKt: null
        },
        source: 'aviationweather',
        fetchedAt: fetchedAt.toISOString(),
        observedAt: fetchedAt.toISOString()
      },
      cacheMeta: {
        fetchedAt: fetchedAt.toISOString(),
        expiresAt: '2026-03-03T12:00:05.000Z',
        policyVersion: 'metar-v2',
        source: 'upstream'
      }
    });
    const get = kv.get.bind(kv);
    vi.spyOn(kv, 'get').mockImplementation(async (key, type) => {
      vi.setSystemTime(new Date('2026-03-03T12:00:06.000Z'));
      return get(key, type);
    });

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KMCI'), {
      METAR_CACHE: kv
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({
      cache: { status: 'stale_on_error', freshnessRemainingSeconds: 0 }
    });
  });

  it('returns variable wind with non-zero speed using structured upstream fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json([buildMetarReport('KARR', { wdir: 'VRB', wspd: 3 })])));

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KARR'), {
      METAR_CACHE: new MemoryKv()
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      wind: { directionType: string; speedKt: number; raw: string };
    };

    expect(payload.wind.directionType).toBe('variable');
    expect(payload.wind.speedKt).toBe(3);
    expect(payload.wind.raw).toBe('VRB03KT');
  });

  it('returns calm wind when upstream omits wind fields but METAR is 0000KT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        Response.json([
          {
            icaoId: 'KJVL',
            rawOb: 'METAR KJVL 031845Z 0000KT 7SM OVC013 04/M01 A3012'
          }
        ])
      )
    );

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KJVL'), {
      METAR_CACHE: new MemoryKv()
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      wind: { directionType: string; speedKt: number; gustKt: number | null; raw: string };
    };

    expect(payload.wind.directionType).toBe('calm');
    expect(payload.wind.speedKt).toBe(0);
    expect(payload.wind.gustKt).toBeNull();
    expect(payload.wind.raw).toBe('00000KT');
  });

  it('returns 400 and no-store on invalid ICAO', async () => {
    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=ABC'), {
      METAR_CACHE: new MemoryKv()
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({
      code: 'INVALID_ICAO'
    });
  });

  it('returns 405 for non-GET requests', async () => {
    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KMCI', { method: 'POST' }), {
      METAR_CACHE: new MemoryKv()
    });

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({
      code: 'METHOD_NOT_ALLOWED'
    });
  });

  it('returns 404 for unknown metar paths', async () => {
    const response = await handleMetarRequest(new Request('https://metar.internal/api/unknown?icao=KMCI'), {
      METAR_CACHE: new MemoryKv()
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: 'NOT_FOUND'
    });
  });

  it('uses client headers when deriving rate-limit keys', async () => {
    const capturedNames: string[] = [];

    await handleMetarRequest(
      new Request('https://metar.internal/api/metar?icao=ABC', {
        headers: { 'X-Client-IP': '203.0.113.10' }
      }),
      {
        METAR_CACHE: new MemoryKv(),
        API_RATE_LIMITER: capturingRateLimiter(capturedNames)
      }
    );

    await handleMetarRequest(
      new Request('https://metar.internal/api/metar?icao=ABC', {
        headers: { 'CF-Connecting-IP': '198.51.100.2' }
      }),
      {
        METAR_CACHE: new MemoryKv(),
        API_RATE_LIMITER: capturingRateLimiter(capturedNames)
      }
    );

    await handleMetarRequest(
      new Request('https://metar.internal/api/metar?icao=ABC', {
        headers: { 'X-Client-IP': 'invalid-ip' }
      }),
      {
        METAR_CACHE: new MemoryKv(),
        API_RATE_LIMITER: capturingRateLimiter(capturedNames)
      }
    );

    expect(capturedNames).toContain('rl:203.0.113.10:metar');
    expect(capturedNames).toContain('rl:198.51.100.2:metar');
    expect(capturedNames).toContain('rl:unknown:metar');
  });

  it('returns 429 when rate limiter blocks the request', async () => {
    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KMCI'), {
      METAR_CACHE: new MemoryKv(),
      API_RATE_LIMITER: alwaysBlockedRateLimiter()
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('10');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED'
    });
  });

  it('returns a generic, non-cacheable 503 and logs bounded metadata when the rate limiter binding is missing', async () => {
    const requestId = '95cac136-65e0-4cce-8ecc-02a66a98b75d';
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleMetarRequestFromWorker(
      new Request('https://metar.internal/api/metar?icao=KMCI', {
        headers: { 'X-Request-Id': requestId, 'X-Client-IP': '203.0.113.10' }
      }),
      { METAR_CACHE: new MemoryKv() }
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(response.headers.get('X-RateLimit-Limit')).toBeNull();
    expect(response.headers.get('X-RateLimit-Remaining')).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: 'Service temporarily unavailable. Please retry later.',
      code: 'RATE_LIMITER_UNAVAILABLE',
      requestId
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith('Rate limiter unavailable.', {
      endpoint: 'metar',
      requestId,
      failureCategory: 'binding_missing'
    });
    consoleErrorSpy.mockRestore();
  });

  it('returns 503 when the rate limiter is unhealthy or its decision is malformed', async () => {
    const validDecision = {
      allowed: true,
      limit: 60,
      remaining: 59,
      resetSeconds: 60,
      retryAfterSeconds: null
    };
    const malformedDecisions = [
      { ...validDecision, allowed: 'true' },
      { ...validDecision, limit: 0 },
      { ...validDecision, remaining: -1 },
      { ...validDecision, resetSeconds: 0 },
      { ...validDecision, retryAfterSeconds: 1 }
    ];
    const unhealthyLimiters = [
      { idFromName: () => { throw new Error('unavailable'); }, get: () => ({ fetch: async () => Response.json(validDecision) }) },
      rateLimiterWithCheck(async () => { throw new Error('unavailable'); }),
      rateLimiterWithCheck(async () => new Response(null, { status: 502 })),
      rateLimiterWithCheck(async () => new Response('{', { headers: { 'Content-Type': 'application/json' } })),
      ...malformedDecisions.map((decision) => rateLimiterWithCheck(async () => Response.json(decision)))
    ];
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    for (const limiter of unhealthyLimiters) {
      const response = await handleMetarRequestFromWorker(
        new Request('https://metar.internal/api/metar?icao=KMCI'),
        { METAR_CACHE: new MemoryKv(), API_RATE_LIMITER: limiter }
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('X-RateLimit-Limit')).toBeNull();
      await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITER_UNAVAILABLE' });
    }

    consoleErrorSpy.mockRestore();
  });

  it('records bounded health metadata when an invalid ICAO penalty signal fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const limiter = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (input: RequestInfo | URL) =>
          new URL(typeof input === 'string' ? input : input.toString()).pathname === '/check'
            ? Response.json({
              allowed: true,
              limit: 60,
              remaining: 59,
              resetSeconds: 60,
              retryAfterSeconds: null
            })
            : new Response(null, { status: 502 })
      })
    };

    const response = await handleMetarRequestFromWorker(
      new Request('https://metar.internal/api/metar?icao=ABC', {
        headers: { 'X-Client-IP': '203.0.113.10' }
      }),
      { METAR_CACHE: new MemoryKv(), API_RATE_LIMITER: limiter }
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { requestId: string };
    expect(consoleErrorSpy).toHaveBeenCalledWith('Rate limiter invalid ICAO signal failed.', {
      endpoint: 'metar',
      requestId: payload.requestId,
      failureCategory: 'non_success_response'
    });
    consoleErrorSpy.mockRestore();
  });

  it('fetches from upstream on miss then returns cached on repeated request', async () => {
    const fetchUpstream = vi.fn().mockResolvedValueOnce(Response.json([buildMetarReport('KJFK', { wdir: 180, wspd: 15 })]));
    vi.stubGlobal('fetch', fetchUpstream);

    const kv = new MemoryKv();
    const firstResponse = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KJFK'), {
      METAR_CACHE: kv
    });
    const secondResponse = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KJFK'), {
      METAR_CACHE: kv
    });

    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    expect(firstResponse.headers.get('X-Runway-Cache-Status')).toBe('upstream_refresh');
    expect(secondResponse.headers.get('X-Runway-Cache-Status')).toBe('kv_hit');

    const firstPayload = (await firstResponse.json()) as { wind: { source?: string; speedKt: number }; cache: { source: string } };
    expect(firstPayload.wind.speedKt).toBe(15);
    expect(firstPayload.cache.source).toBe('upstream');

    const secondPayload = (await secondResponse.json()) as { cache: { source: string } };
    expect(secondPayload.cache.source).toBe('kv');
  });

  it('records successful metar lookups with the coordinator, not a KV hot key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json([buildMetarReport('KMCI', { wdir: 180, wspd: 12 })])));

    const kv = new MemoryKv();
    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KMCI'), {
      METAR_CACHE: kv
    });

    expect(response.status).toBe(200);
    expect(kv.has('v2:hot:metar:KMCI')).toBe(false);
    await runScheduledCacheRefresh({ METAR_CACHE: kv }, () => new Date(Date.now() + 31 * 60 * 1000));
    expect(kv.has('v1:metar:KMCI')).toBe(true);
  });

  it('hard-cuts legacy cache entry shapes and refreshes upstream', async () => {
    const kv = new MemoryKv();
    kv.seed('v1:metar:KDEN', {
      icao: 'KDEN',
      metarRaw: 'METAR KDEN 021953Z 11010KT 10SM FEW020 08/03 A3012 RMK AO2',
      source: 'aviationweather',
      fetchedAt: new Date(Date.now() - 30_000).toISOString()
    });

    const fetchUpstream = vi.fn().mockResolvedValueOnce(Response.json([buildMetarReport('KDEN', { wdir: 180, wspd: 12 })]));
    vi.stubGlobal('fetch', fetchUpstream);

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KDEN'), {
      METAR_CACHE: kv
    });

    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Runway-Cache-Status')).toBe('upstream_refresh');
  });

  it('returns 502 when upstream provider responds with non-2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 })));

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KJFK'), {
      METAR_CACHE: new MemoryKv()
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: 'METAR provider returned status 503.',
      code: 'PROVIDER_ERROR'
    });
  });

  it('returns debug payload when wind parsing fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        Response.json([
          {
            icaoId: 'KABC',
            rawOb: 'METAR KABC 021953Z 10SM FEW020 08/03 A3012 RMK AO2'
          }
        ])
      )
    );

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KABC'), {
      METAR_CACHE: new MemoryKv(),
      APP_ENV: 'preview'
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Unable to parse wind data from METAR provider for ICAO KABC.',
      code: 'WIND_PARSE_ERROR',
      debug: {
        rawObPresent: true
      }
    });
  });

  it('omits debug payload in production mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        Response.json([
          {
            icaoId: 'KABC',
            rawOb: 'METAR KABC 021953Z 10SM FEW020 08/03 A3012 RMK AO2'
          }
        ])
      )
    );

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KABC'), {
      METAR_CACHE: new MemoryKv(),
      APP_ENV: 'production',
      ENABLE_DEBUG_ERRORS: 'false'
    });

    const payload = (await response.json()) as { debug?: unknown; code: string };
    expect(response.status).toBe(502);
    expect(payload.code).toBe('WIND_PARSE_ERROR');
    expect(payload.debug).toBeUndefined();
  });

  it('returns user-friendly message when ICAO is not found by provider', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json([]))
        .mockResolvedValueOnce(Response.json([]))
    );

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=ZZZZ'), {
      METAR_CACHE: new MemoryKv()
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'ICAO code ZZZZ was not found. Check the code and try again.',
      code: 'ICAO_NOT_FOUND'
    });
  });

  it('negative-caches stable METAR ICAO misses for the adapter-specific TTL', async () => {
    const fetchUpstream = vi
      .fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal('fetch', fetchUpstream);
    const kv = new MemoryKv();
    const request = new Request('https://metar.internal/api/metar?icao=ZZZZ');

    const first = await handleMetarRequest(request, { METAR_CACHE: kv });
    const second = await handleMetarRequest(request, { METAR_CACHE: kv });

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(fetchUpstream).toHaveBeenCalledTimes(2);
    const cached = kv.read<{ negative: { code: string }; cacheMeta: { fetchedAt: string; expiresAt: string } }>('v1:metar:ZZZZ');
    expect(cached?.negative).toEqual({ status: 404, code: 'ICAO_NOT_FOUND' });
    expect(Date.parse(cached!.cacheMeta.expiresAt) - Date.parse(cached!.cacheMeta.fetchedAt)).toBe(180_000);
  });

  it('returns METAR_UNAVAILABLE code when station exists but no METAR report is present', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json([]))
        .mockResolvedValueOnce(Response.json([{ icaoId: 'KDKB' }]))
    );

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KDKB'), {
      METAR_CACHE: new MemoryKv()
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'No METAR is currently available for ICAO KDKB. Try again later.',
      code: 'METAR_UNAVAILABLE'
    });
  });

  it('does not negative-cache temporary METAR unavailability', async () => {
    const fetchUpstream = vi
      .fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json([{ icaoId: 'KDKB' }]))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json([{ icaoId: 'KDKB' }]));
    vi.stubGlobal('fetch', fetchUpstream);
    const kv = new MemoryKv();
    const request = new Request('https://metar.internal/api/metar?icao=KDKB');

    expect((await handleMetarRequest(request, { METAR_CACHE: kv })).status).toBe(404);
    expect((await handleMetarRequest(request, { METAR_CACHE: kv })).status).toBe(404);

    expect(fetchUpstream).toHaveBeenCalledTimes(4);
    expect(kv.read('v1:metar:KDKB')).toBeNull();
  });

  it('returns METAR_UNAVAILABLE code when provider responds with 204 and station exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(Response.json([{ icaoId: 'KDKB' }]))
    );

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KDKB'), {
      METAR_CACHE: new MemoryKv()
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'No METAR is currently available for ICAO KDKB. Try again later.',
      code: 'METAR_UNAVAILABLE'
    });
  });

  it('returns METAR_UNAVAILABLE code when provider responds 200 with empty payload body', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('   ', { status: 200 }))
        .mockResolvedValueOnce(Response.json([{ icaoId: 'KDKB' }]))
    );

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KDKB'), {
      METAR_CACHE: new MemoryKv()
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'No METAR is currently available for ICAO KDKB. Try again later.',
      code: 'METAR_UNAVAILABLE'
    });
  });

  it('returns PROVIDER_PAYLOAD_INVALID when provider returns malformed JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response('not-json', { status: 200 }))
    );

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KDKB'), {
      METAR_CACHE: new MemoryKv()
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: 'METAR provider returned an invalid payload.',
      code: 'PROVIDER_PAYLOAD_INVALID'
    });
  });

  it('defers hot queue write via ctx.waitUntil when ctx is provided on metar request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json([buildMetarReport('KMCI', { wdir: 180, wspd: 10 })])));

    const waitUntilCalls: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waitUntilCalls.push(p); } };

    const response = await handleMetarRequest(
      new Request('https://metar.internal/api/metar?icao=KMCI'),
      { METAR_CACHE: new MemoryKv() },
      ctx
    );

    expect(response.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(1);
  });

  it('does not write legacy hot metadata on metar success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json([buildMetarReport('KMCI', { wdir: 180, wspd: 10 })])));

    const kv = new MemoryKv();
    const putSpy = vi.spyOn(kv, 'put');

    await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KMCI'), { METAR_CACHE: kv });

    expect(putSpy.mock.calls.some(([key]) => key.startsWith('v2:hot:'))).toBe(false);
  });
});

describe('airport worker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('normalizes airport ICAO values', () => {
    expect(normalizeAirportIcao(' kjfk ')).toBe('KJFK');
  });

  it('returns airport payload with runway ends and cache metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-03T12:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(buildAirportReport('KJFK'))));

    const response = await handleAirportRequest(new Request('https://metar.internal/api/airport?icao=KJFK'), {
      METAR_CACHE: new MemoryKv(),
      AIRPORTDB_API_TOKEN: 'token'
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Runway-Cache-Status')).toBe('upstream_refresh');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=86400');

    const payload = (await response.json()) as {
      requestedIcao: string;
      icao: string;
      source: string;
      coordinates: { latitudeDeg: number; longitudeDeg: number } | null;
      runwayEnds: Array<{ id: string; headingDegTrue: number; isClosed: boolean; lengthFt: number | null }>;
      frequencies: Array<{ type: string; description: string; frequencyMhz: string }>;
      cache: { source: string; status: string };
    };

    expect(payload.requestedIcao).toBe('KJFK');
    expect(payload.icao).toBe('KJFK');
    expect(payload.source).toBe('airportdb');
    expect(payload.coordinates).toEqual({ latitudeDeg: 39.0997, longitudeDeg: -94.5786 });
    expect(payload.runwayEnds).toEqual([
      { id: '04L', headingDegTrue: 47, isClosed: false, lengthFt: 12000 },
      { id: '13', headingDegTrue: 137, isClosed: true, lengthFt: 10000 },
      { id: '22R', headingDegTrue: 227, isClosed: false, lengthFt: 12000 },
      { id: '31', headingDegTrue: 317, isClosed: true, lengthFt: 10000 }
    ]);
    expect(payload.frequencies).toEqual([
      { type: 'APP', description: 'NORTH APP', frequencyMhz: '125.7' },
      { type: 'ATIS', description: 'ATIS', frequencyMhz: '128.725' },
      { type: 'CTAF', description: 'CTAF', frequencyMhz: '123.0' },
      { type: 'TWR', description: 'TOWER', frequencyMhz: '119.1' }
    ]);
    expect('upstreamPayload' in payload).toBe(false);
    expect(payload.cache.source).toBe('upstream');
    expect(payload.cache.status).toBe('upstream_refresh');
  });

  it('negative-caches stable airport ICAO misses for the adapter-specific TTL', async () => {
    const fetchUpstream = vi.fn().mockResolvedValueOnce(new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchUpstream);
    const kv = new MemoryKv();
    const request = new Request('https://metar.internal/api/airport?icao=ZZZZ');
    const env = { METAR_CACHE: kv, AIRPORTDB_API_TOKEN: 'token' };

    const first = await handleAirportRequest(request, env);
    const second = await handleAirportRequest(request, env);

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    const cached = kv.read<{ negative: { code: string }; cacheMeta: { fetchedAt: string; expiresAt: string } }>('v1:airport:ZZZZ');
    expect(cached?.negative).toEqual({ status: 404, code: 'ICAO_NOT_FOUND' });
    expect(Date.parse(cached!.cacheMeta.expiresAt) - Date.parse(cached!.cacheMeta.fetchedAt)).toBe(3_600_000);
  });

  it('does not negative-cache airport authentication or configuration errors', async () => {
    const authFailure = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', authFailure);
    const authenticatedKv = new MemoryKv();
    const request = new Request('https://metar.internal/api/airport?icao=KJFK');

    expect((await handleAirportRequest(request, { METAR_CACHE: authenticatedKv, AIRPORTDB_API_TOKEN: 'token' })).status).toBe(502);
    expect((await handleAirportRequest(request, { METAR_CACHE: authenticatedKv, AIRPORTDB_API_TOKEN: 'token' })).status).toBe(502);
    expect(authFailure).toHaveBeenCalledTimes(2);
    expect(authenticatedKv.read('v1:airport:KJFK')).toBeNull();

    const unconfiguredKv = new MemoryKv();
    expect((await handleAirportRequest(request, { METAR_CACHE: unconfiguredKv })).status).toBe(500);
    expect((await handleAirportRequest(request, { METAR_CACHE: unconfiguredKv })).status).toBe(500);
    expect(unconfiguredKv.read('v1:airport:KJFK')).toBeNull();
  });

  it('invalidates previously cached airport frequency payloads when the schema changes', async () => {
    const kv = new MemoryKv();
    kv.seed('v1:airport:KJFK', {
      schemaVersion: 6,
      resource: 'airport',
      key: 'v1:airport:KJFK',
      data: {
        requestedIcao: 'KJFK',
        icao: 'KJFK',
        name: 'John F Kennedy International Airport',
        municipality: 'New York',
        countryCode: 'US',
        countryName: 'United States',
        elevationFt: 13,
        runwayEnds: [{ id: '04L', headingDegTrue: 47, isClosed: false, lengthFt: 12079 }],
        frequencies: [],
        source: 'airportdb',
        fetchedAt: '2026-03-03T12:00:00.000Z'
      },
      cacheMeta: {
        fetchedAt: '2026-03-03T12:00:00.000Z',
        expiresAt: '2099-03-03T12:00:00.000Z',
        policyVersion: 'airport-v4',
        source: 'upstream'
      }
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(buildAirportReport('KJFK'))));

    const response = await handleAirportRequest(new Request('https://metar.internal/api/airport?icao=KJFK'), {
      METAR_CACHE: kv,
      AIRPORTDB_API_TOKEN: 'token'
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Runway-Cache-Status')).toBe('upstream_refresh');

    const payload = (await response.json()) as {
      frequencies: Array<{ type: string; description: string; frequencyMhz: string }>;
    };

    expect(payload.frequencies).toEqual([
      { type: 'APP', description: 'NORTH APP', frequencyMhz: '125.7' },
      { type: 'ATIS', description: 'ATIS', frequencyMhz: '128.725' },
      { type: 'CTAF', description: 'CTAF', frequencyMhz: '123.0' },
      { type: 'TWR', description: 'TOWER', frequencyMhz: '119.1' }
    ]);
    expect('upstreamPayload' in payload).toBe(false);
  });

  it('records successful airport lookups without legacy hot metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(buildAirportReport('KJFK'))));

    const kv = new MemoryKv();
    const response = await handleAirportRequest(new Request('https://metar.internal/api/airport?icao=KJFK'), {
      METAR_CACHE: kv,
      AIRPORTDB_API_TOKEN: 'token'
    });

    expect(response.status).toBe(200);
    expect(kv.has('v2:hot:airport:KJFK')).toBe(false);
  });

  it('uses an independent long-lived location cache without enrolling it in the hot queue', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-03T12:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({
      ident: 'KLOC',
      latitude_deg: '41.8781',
      longitude_deg: '-87.6298',
      runways: []
    })));

    const kv = new MemoryKv();
    const response = await handleAirportLocationRequest(
      new Request('https://metar.internal/api/airport-location?icao=KLOC'),
      { METAR_CACHE: kv, AIRPORTDB_API_TOKEN: 'token' }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=2592000');
    await expect(response.json()).resolves.toMatchObject({
      icao: 'KLOC',
      coordinates: { latitudeDeg: 41.8781, longitudeDeg: -87.6298 },
      cache: { resource: 'airport-location', ttlSeconds: 2_592_000 }
    });
    expect(kv.has('v1:airport-location:KLOC')).toBe(true);
    expect(kv.has('v2:hot:airport-location:KLOC')).toBe(false);
  });

  it('does not return the raw airport provider snapshot to clients', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(buildAirportReport('KJFK'))));

    const kv = new MemoryKv();
    const response = await handleAirportRequest(new Request('https://metar.internal/api/airport?icao=KJFK'), {
      METAR_CACHE: kv,
      AIRPORTDB_API_TOKEN: 'token'
    });

    expect(response.status).toBe(200);
    expect(kv.has('v1:airport:KJFK')).toBe(true);
    const cached = kv.read<{
      upstreamSnapshot?: { ident?: string; home_link?: string; freqs?: Array<{ type: string; description: string }> };
    }>('v1:airport:KJFK');
    expect(cached?.upstreamSnapshot?.ident).toBe('KJFK');
    expect(cached?.upstreamSnapshot?.home_link).toBe('https://kjfk.example.com');
    expect(cached?.upstreamSnapshot?.freqs?.[0]).toMatchObject({ type: 'APP', description: 'NORTH APP' });

    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.upstreamPayload).toBeUndefined();
  });

  it('returns 500 when airportdb token is missing', async () => {
    const response = await handleAirportRequest(new Request('https://metar.internal/api/airport?icao=KJFK'), {
      METAR_CACHE: new MemoryKv()
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Airport lookup service is not configured.',
      code: 'SERVICE_NOT_CONFIGURED'
    });
  });

  it('returns INVALID_ICAO code when airport ICAO format is invalid', async () => {
    const response = await handleAirportRequest(new Request('https://metar.internal/api/airport?icao=ABC'), {
      METAR_CACHE: new MemoryKv(),
      AIRPORTDB_API_TOKEN: 'token'
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'INVALID_ICAO'
    });
  });

  it('returns 429 when airport endpoint is rate limited', async () => {
    const response = await handleAirportRequest(new Request('https://metar.internal/api/airport?icao=KJFK'), {
      METAR_CACHE: new MemoryKv(),
      AIRPORTDB_API_TOKEN: 'token',
      API_RATE_LIMITER: alwaysBlockedRateLimiter()
    });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED'
    });
  });

  it('returns 405 for non-GET airport requests', async () => {
    const response = await handleAirportRequest(new Request('https://metar.internal/api/airport?icao=KJFK', { method: 'POST' }), {
      METAR_CACHE: new MemoryKv(),
      AIRPORTDB_API_TOKEN: 'token'
    });

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({
      code: 'METHOD_NOT_ALLOWED'
    });
  });

  it('returns 404 for unknown airport paths', async () => {
    const response = await handleAirportRequest(new Request('https://metar.internal/api/nope?icao=KJFK'), {
      METAR_CACHE: new MemoryKv(),
      AIRPORTDB_API_TOKEN: 'token'
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: 'NOT_FOUND'
    });
  });

  it('returns 404 when airport has no usable runway data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        Response.json({
          ident: 'KHEL',
          icao_code: 'KHEL',
          name: 'Heliport',
          runways: []
        })
      )
    );

    const response = await handleAirportRequest(new Request('https://metar.internal/api/airport?icao=KHEL'), {
      METAR_CACHE: new MemoryKv(),
      AIRPORTDB_API_TOKEN: 'token'
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'No runway data is available for ICAO KHEL.',
      code: 'RUNWAY_DATA_UNAVAILABLE'
    });
  });

  it('uses coordinator-owned demand records and never scans legacy hot keys', async () => {
    const fetchUpstream = vi.fn().mockResolvedValue(Response.json([buildMetarReport('KMCI', { wdir: 180, wspd: 12 })]));
    vi.stubGlobal('fetch', fetchUpstream);
    const kv = new MemoryKv();
    const listSpy = vi.spyOn(kv, 'list');
    await expect(handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KMCI'), { METAR_CACHE: kv })).resolves.toMatchObject({ status: 200 });
    setCacheTimestamps(kv, 'v1:metar:KMCI', new Date(Date.now() - 31 * 60 * 1000), new Date(Date.now() - 60 * 1000));
    expect(kv.has('v2:hot:metar:KMCI')).toBe(false);
    await runScheduledCacheRefresh({ METAR_CACHE: kv });
    expect(fetchUpstream).toHaveBeenCalledTimes(2);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('uses the current inspection time for a foreground-refreshed payload', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-07T12:10:00.000Z'));
    const fetchUpstream = vi.fn().mockResolvedValue(Response.json([buildMetarReport('KMCI', { wdir: 180, wspd: 12 })]));
    vi.stubGlobal('fetch', fetchUpstream);
    const kv = new MemoryKv();
    await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KMCI'), { METAR_CACHE: kv });

    await runScheduledCacheRefresh({ METAR_CACHE: kv }, () => new Date('2026-03-07T12:10:00.000Z'));

    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    expect(kv.has('v1:metar:KMCI')).toBe(true);
  });

  it('refreshes bounded work fairly across METAR and airport demand', async () => {
    const fetchUpstream = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return Promise.resolve(url.includes('airportdb') || url.includes('/api/airport') ? Response.json(buildAirportReport('KJFK')) : Response.json([buildMetarReport('KMCI', { wdir: 180, wspd: 12 })]));
    });
    vi.stubGlobal('fetch', fetchUpstream);
    const kv = new MemoryKv();
    const env = { METAR_CACHE: kv, AIRPORTDB_API_TOKEN: 'token', CACHE_REFRESH_MAX_ITEMS_PER_RUN: '2' };
    await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KMCI'), env);
    await handleAirportRequest(new Request('https://metar.internal/api/airport?icao=KJFK'), env);
    setCacheTimestamps(kv, 'v1:metar:KMCI', new Date(Date.now() - 31 * 60 * 1000), new Date(Date.now() - 60 * 1000));
    setCacheTimestamps(kv, 'v1:airport:KJFK', new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), new Date(Date.now() - 60 * 1000));
    await runScheduledCacheRefresh(env);
    expect(fetchUpstream).toHaveBeenCalledTimes(4);
    expect(kv.has('v2:hot:metar:KMCI')).toBe(false);
    expect(kv.has('v2:hot:airport:KJFK')).toBe(false);
  });

  it('does not refresh a valid negative airport payload', async () => {
    const fetchUpstream = vi.fn().mockResolvedValue(Response.json(buildAirportReport('KJFK')));
    vi.stubGlobal('fetch', fetchUpstream);
    const kv = new MemoryKv();
    const env = { METAR_CACHE: kv, AIRPORTDB_API_TOKEN: 'token' };
    await handleAirportRequest(new Request('https://metar.internal/api/airport?icao=KJFK'), env);
    kv.seed('v1:airport:KJFK', { schemaVersion: 9, resource: 'airport', key: 'v1:airport:KJFK', negative: { status: 404, code: 'ICAO_NOT_FOUND' }, cacheMeta: { fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), policyVersion: 'airport-v6', source: 'upstream' } });
    await runScheduledCacheRefresh(env);
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    expect(kv.has('v1:airport:KJFK')).toBe(true);
  });

  it('suppresses a demand after three upstream failures without deleting its payload', async () => {
    const fetchUpstream = vi.fn().mockResolvedValue(Response.json([buildMetarReport('KMCI', { wdir: 180, wspd: 12 })]));
    vi.stubGlobal('fetch', fetchUpstream);
    const kv = new MemoryKv();
    const env = { METAR_CACHE: kv };
    await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KMCI'), env);
    setCacheTimestamps(kv, 'v1:metar:KMCI', new Date(Date.now() - 31 * 60 * 1000), new Date(Date.now() - 60 * 1000));
    fetchUpstream.mockRejectedValue(new Error('provider unavailable'));
    await runScheduledCacheRefresh(env);
    await runScheduledCacheRefresh(env);
    await runScheduledCacheRefresh(env);
    await runScheduledCacheRefresh(env);
    expect(fetchUpstream).toHaveBeenCalledTimes(4);
    expect(kv.has('v1:metar:KMCI')).toBe(true);
  });

  it('aborts safely when cache infrastructure fails during a scheduled refresh', async () => {
    const fetchUpstream = vi.fn().mockResolvedValue(Response.json([buildMetarReport('KMCI', { wdir: 180, wspd: 12 })]));
    vi.stubGlobal('fetch', fetchUpstream);
    const kv = new MemoryKv();
    const env = { METAR_CACHE: kv };
    await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KMCI'), env);
    setCacheTimestamps(kv, 'v1:metar:KMCI', new Date(Date.now() - 31 * 60 * 1000), new Date(Date.now() - 60 * 1000));
    const originalGet = kv.get.bind(kv);
    const getSpy = vi.spyOn(kv, 'get').mockImplementation(async (key, type) => {
      if (key === 'v1:metar:KMCI') throw new Error('temporary KV read failure');
      return originalGet(key, type);
    });
    await expect(runScheduledCacheRefresh(env)).rejects.toThrow('temporary KV read failure');
    getSpy.mockRestore();
    expect(kv.has('v1:metar:KMCI')).toBe(true);
  });


  it('routes airport and metar requests through the worker entrypoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([buildMetarReport('KMCI', { wdir: 180, wspd: 10 })])));

    const airportResponse = await workerEntrypoint.fetch(new Request('https://metar.internal/api/airport?icao=ABC'), withHealthyRateLimiter({
      METAR_CACHE: new MemoryKv(),
      AIRPORTDB_API_TOKEN: 'token'
    }));
    const metarResponse = await workerEntrypoint.fetch(new Request('https://metar.internal/api/metar?icao=KMCI'), withHealthyRateLimiter({
      METAR_CACHE: new MemoryKv()
    }));

    expect(airportResponse.status).toBe(400);
    expect(metarResponse.status).toBe(200);
  });

  it('defers hot queue write via ctx.waitUntil when ctx is provided on airport request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(buildAirportReport('KJFK'))));

    const waitUntilCalls: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waitUntilCalls.push(p); } };

    const response = await handleAirportRequest(
      new Request('https://metar.internal/api/airport?icao=KJFK'),
      { METAR_CACHE: new MemoryKv(), AIRPORTDB_API_TOKEN: 'token' },
      ctx
    );

    expect(response.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(1);
  });

  it('does not write legacy hot metadata on airport success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(buildAirportReport('KJFK'))));

    const kv = new MemoryKv();
    const putSpy = vi.spyOn(kv, 'put');

    await handleAirportRequest(
      new Request('https://metar.internal/api/airport?icao=KJFK'),
      { METAR_CACHE: kv, AIRPORTDB_API_TOKEN: 'token' }
    );

    expect(putSpy.mock.calls.some(([key]) => key.startsWith('v2:hot:'))).toBe(false);
  });

});
