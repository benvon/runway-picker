import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __cacheRefreshHelpers,
  default as workerEntrypoint,
  extractMetarRaw,
  handleAirportRequest,
  handleMetarRequest,
  MetarWorkerError,
  normalizeAirportIcao,
  normalizeIcao,
  runScheduledCacheRefresh
} from './index';
import type { CacheRefresherConfig, HotCacheQueueEntry } from './cache/hotQueue';
import type { CacheEngineEnv } from './cache/types';

class MemoryKv {
  private values = new Map<string, unknown>();

  async get(key: string, _type: 'json'): Promise<unknown> {
    void _type;
    return this.values.get(key) ?? null;
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
    runways: [
      {
        closed: '0',
        length_ft: '12000',
        le_ident: '04L',
        he_ident: '22R'
      },
      {
        closed: '1',
        length_ft: '10000',
        le_ident: '13',
        he_ident: '31'
      }
    ],
    frequencies: [
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
  kv.seed(`v1:hot:${entry.resource}:${entry.normalizedKey}`, {
    schemaVersion: 1,
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
      schemaVersion: 1,
      resource: 'metar',
      normalizedKey: 'KMCI',
      cacheKey: 'v1:metar:KMCI',
      lastAccessedAt: '2026-03-07T11:59:00.000Z',
      lastRefreshedAt: '2026-03-07T11:30:00.000Z',
      metadataKey: 'v1:hot:metar:KMCI'
    };

    const airportEntry: HotCacheQueueEntry = {
      schemaVersion: 1,
      resource: 'airport',
      normalizedKey: 'KJFK',
      cacheKey: 'v1:airport:KJFK',
      lastAccessedAt: '2026-03-07T11:59:00.000Z',
      lastRefreshedAt: '2026-03-06T12:00:00.000Z',
      metadataKey: 'v1:hot:airport:KJFK'
    };

    expect(__cacheRefreshHelpers.isRefreshDue(metarEntry, nowMs, config)).toBe(true);
    expect(__cacheRefreshHelpers.isRefreshDue(airportEntry, nowMs, config)).toBe(true);

    const freshMetar = { ...metarEntry, lastRefreshedAt: '2026-03-07T11:45:01.000Z' };
    expect(__cacheRefreshHelpers.isRefreshDue(freshMetar, nowMs, config)).toBe(false);

    const invalidTimestamp = { ...metarEntry, lastRefreshedAt: 'invalid' };
    expect(__cacheRefreshHelpers.isRefreshDue(invalidTimestamp, nowMs, config)).toBe(true);
  });

  it('keeps active entries and evicts inactive entries in keepOrEvictQueueEntry', async () => {
    const nowMs = Date.parse('2026-03-07T12:00:00.000Z');
    const ttlMs = 5 * 24 * 60 * 60 * 1000;
    const kv = new MemoryKv();
    const env: CacheEngineEnv = { METAR_CACHE: kv };

    const activeEntry: HotCacheQueueEntry = {
      schemaVersion: 1,
      resource: 'metar',
      normalizedKey: 'KMSN',
      cacheKey: 'v1:metar:KMSN',
      lastAccessedAt: '2026-03-07T11:59:00.000Z',
      lastRefreshedAt: '2026-03-07T11:30:00.000Z',
      metadataKey: 'v1:hot:metar:KMSN'
    };

    const activeResult = await __cacheRefreshHelpers.keepOrEvictQueueEntry(env, activeEntry, nowMs, ttlMs);
    expect(activeResult).toEqual(activeEntry);

    seedHotQueueEntry(kv, {
      resource: 'metar',
      normalizedKey: 'KDEN',
      cacheKey: 'v1:metar:KDEN',
      lastAccessedAt: '2026-02-28T11:00:00.000Z',
      lastRefreshedAt: '2026-03-07T10:00:00.000Z'
    });
    kv.seed('v1:metar:KDEN', { cached: true });

    const inactiveEntry: HotCacheQueueEntry = {
      schemaVersion: 1,
      resource: 'metar',
      normalizedKey: 'KDEN',
      cacheKey: 'v1:metar:KDEN',
      lastAccessedAt: '2026-02-28T11:00:00.000Z',
      lastRefreshedAt: '2026-03-07T10:00:00.000Z',
      metadataKey: 'v1:hot:metar:KDEN'
    };

    const inactiveResult = await __cacheRefreshHelpers.keepOrEvictQueueEntry(
      env,
      inactiveEntry,
      nowMs,
      ttlMs
    );
    expect(inactiveResult).toBeNull();
    expect(kv.has('v1:hot:metar:KDEN')).toBe(false);
    expect(kv.has('v1:metar:KDEN')).toBe(false);
  });
});

describe('metar worker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
      schemaVersion: 3,
      resource: 'metar',
      key: 'v1:metar:KMCI',
      data: {
        icao: 'KMCI',
        metarRaw: 'METAR KMCI 021953Z 11010KT 7SM OVC008 04/02 A3014 RMK AO2',
        wind: {
          raw: '11010KT',
          directionType: 'fixed',
          directionDegTrue: 110,
          speedKt: 10,
          gustKt: null
        },
        source: 'aviationweather',
        fetchedAt: fetchedAt.toISOString()
      },
      cacheMeta: {
        fetchedAt: fetchedAt.toISOString(),
        expiresAt: new Date(fetchedAt.getTime() + 30 * 60 * 1000).toISOString(),
        policyVersion: 'metar-v1',
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
      cache: { source: string; status: string };
    };

    expect(payload.icao).toBe('KMCI');
    expect(payload.wind.directionType).toBe('fixed');
    expect(payload.wind.speedKt).toBe(10);
    expect(payload.cache.source).toBe('kv');
    expect(payload.cache.status).toBe('kv_hit');
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

  it('tracks successful metar lookups in the hot queue metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json([buildMetarReport('KMCI', { wdir: 180, wspd: 12 })])));

    const kv = new MemoryKv();
    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KMCI'), {
      METAR_CACHE: kv
    });

    expect(response.status).toBe(200);
    const queueEntry = kv.read<{
      resource: string;
      normalizedKey: string;
      cacheKey: string;
      lastAccessedAt: string;
      lastRefreshedAt: string;
      schemaVersion: number;
    }>('v1:hot:metar:KMCI');

    expect(queueEntry).toMatchObject({
      schemaVersion: 1,
      resource: 'metar',
      normalizedKey: 'KMCI',
      cacheKey: 'v1:metar:KMCI'
    });
    expect(typeof queueEntry?.lastAccessedAt).toBe('string');
    expect(typeof queueEntry?.lastRefreshedAt).toBe('string');
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

  it('writes hot queue metadata with the inactivity TTL as expirationTtl on metar success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json([buildMetarReport('KMCI', { wdir: 180, wspd: 10 })])));

    const kv = new MemoryKv();
    const putSpy = vi.spyOn(kv, 'put');

    await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KMCI'), { METAR_CACHE: kv });

    const hotQueuePut = putSpy.mock.calls.find(([key]) => key.startsWith('v1:hot:'));
    expect(hotQueuePut).toBeDefined();
    expect(hotQueuePut?.[2]).toEqual({ expirationTtl: 432000 });
  });
});

describe('airport worker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes airport ICAO values', () => {
    expect(normalizeAirportIcao(' kjfk ')).toBe('KJFK');
  });

  it('returns airport payload with runway ends and cache metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(buildAirportReport('KJFK'))));

    const response = await handleAirportRequest(new Request('https://metar.internal/api/airport?icao=KJFK'), {
      METAR_CACHE: new MemoryKv(),
      AIRPORTDB_API_TOKEN: 'token'
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Runway-Cache-Status')).toBe('upstream_refresh');

    const payload = (await response.json()) as {
      requestedIcao: string;
      icao: string;
      source: string;
      runwayEnds: Array<{ id: string; headingDegMag: number; isClosed: boolean; lengthFt: number | null }>;
      frequencies: Array<{ type: string; description: string; frequencyMhz: string }>;
      cache: { source: string; status: string };
    };

    expect(payload.requestedIcao).toBe('KJFK');
    expect(payload.icao).toBe('KJFK');
    expect(payload.source).toBe('airportdb');
    expect(payload.runwayEnds).toEqual([
      { id: '04L', headingDegMag: 40, isClosed: false, lengthFt: 12000 },
      { id: '13', headingDegMag: 130, isClosed: true, lengthFt: 10000 },
      { id: '22R', headingDegMag: 220, isClosed: false, lengthFt: 12000 },
      { id: '31', headingDegMag: 310, isClosed: true, lengthFt: 10000 }
    ]);
    expect(payload.frequencies).toEqual([
      { type: 'APP', description: 'NORTH APP', frequencyMhz: '125.7' },
      { type: 'ATIS', description: 'ATIS', frequencyMhz: '128.725' },
      { type: 'CTAF', description: 'CTAF', frequencyMhz: '123.0' },
      { type: 'TWR', description: 'TOWER', frequencyMhz: '119.1' }
    ]);
    expect(payload.cache.source).toBe('upstream');
    expect(payload.cache.status).toBe('upstream_refresh');
  });

  it('tracks successful airport lookups in the hot queue metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(buildAirportReport('KJFK'))));

    const kv = new MemoryKv();
    const response = await handleAirportRequest(new Request('https://metar.internal/api/airport?icao=KJFK'), {
      METAR_CACHE: kv,
      AIRPORTDB_API_TOKEN: 'token'
    });

    expect(response.status).toBe(200);
    const queueEntry = kv.read<{
      resource: string;
      normalizedKey: string;
      cacheKey: string;
      lastAccessedAt: string;
      lastRefreshedAt: string;
      schemaVersion: number;
    }>('v1:hot:airport:KJFK');

    expect(queueEntry).toMatchObject({
      schemaVersion: 1,
      resource: 'airport',
      normalizedKey: 'KJFK',
      cacheKey: 'v1:airport:KJFK'
    });
    expect(typeof queueEntry?.lastAccessedAt).toBe('string');
    expect(typeof queueEntry?.lastRefreshedAt).toBe('string');
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

  it('scheduled refresh is a no-op when queue is empty', async () => {
    const kv = new MemoryKv();
    await runScheduledCacheRefresh({ METAR_CACHE: kv }, new Date('2026-03-06T12:00:00.000Z'));
    expect(kv.has('v1:hot:metar:KMCI')).toBe(false);
  });

  it('routes scheduled events through the worker entrypoint', async () => {
    const kv = new MemoryKv();
    await workerEntrypoint.scheduled({}, { METAR_CACHE: kv });
    expect(kv.has('v1:hot:metar:KMCI')).toBe(false);
  });

  it('scheduled refresh updates due metar entries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json([buildMetarReport('KMCI', { wdir: 150, wspd: 14 })])));

    const kv = new MemoryKv();
    const now = new Date('2026-03-06T12:00:00.000Z');
    seedHotQueueEntry(kv, {
      resource: 'metar',
      normalizedKey: 'KMCI',
      cacheKey: 'v1:metar:KMCI',
      lastAccessedAt: '2026-03-06T11:50:00.000Z',
      lastRefreshedAt: '2026-03-06T11:00:00.000Z'
    });

    await runScheduledCacheRefresh({ METAR_CACHE: kv }, now);

    const queueEntry = kv.read<{ lastRefreshedAt: string }>('v1:hot:metar:KMCI');
    expect(queueEntry).not.toBeNull();
    expect(new Date(queueEntry?.lastRefreshedAt ?? 0).getTime()).toBeGreaterThan(new Date('2026-03-06T11:00:00.000Z').getTime());
    expect(kv.has('v1:metar:KMCI')).toBe(true);
  });

  it('scheduled refresh updates due airport entries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(buildAirportReport('KJFK'))));

    const kv = new MemoryKv();
    const now = new Date('2026-03-06T12:00:00.000Z');
    seedHotQueueEntry(kv, {
      resource: 'airport',
      normalizedKey: 'KJFK',
      cacheKey: 'v1:airport:KJFK',
      lastAccessedAt: '2026-03-06T11:00:00.000Z',
      lastRefreshedAt: '2026-03-05T10:00:00.000Z'
    });

    await runScheduledCacheRefresh(
      {
        METAR_CACHE: kv,
        AIRPORTDB_API_TOKEN: 'token'
      },
      now
    );

    const queueEntry = kv.read<{ lastRefreshedAt: string }>('v1:hot:airport:KJFK');
    expect(queueEntry).not.toBeNull();
    expect(new Date(queueEntry?.lastRefreshedAt ?? 0).getTime()).toBeGreaterThan(new Date('2026-03-05T10:00:00.000Z').getTime());
    expect(kv.has('v1:airport:KJFK')).toBe(true);
  });

  it('scheduled refresh evicts inactive queue entries and payload cache keys', async () => {
    const kv = new MemoryKv();
    seedHotQueueEntry(kv, {
      resource: 'metar',
      normalizedKey: 'KDEN',
      cacheKey: 'v1:metar:KDEN',
      lastAccessedAt: '2026-02-27T12:00:00.000Z',
      lastRefreshedAt: '2026-03-01T12:00:00.000Z'
    });
    kv.seed('v1:metar:KDEN', { cached: true });

    await runScheduledCacheRefresh({ METAR_CACHE: kv }, new Date('2026-03-06T12:00:00.000Z'));

    expect(kv.has('v1:hot:metar:KDEN')).toBe(false);
    expect(kv.has('v1:metar:KDEN')).toBe(false);
  });

  it('scheduled refresh does not extend lastAccessedAt timestamps', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json([buildMetarReport('KMSN', { wdir: 200, wspd: 11 })])));

    const kv = new MemoryKv();
    seedHotQueueEntry(kv, {
      resource: 'metar',
      normalizedKey: 'KMSN',
      cacheKey: 'v1:metar:KMSN',
      lastAccessedAt: '2026-03-05T12:00:00.000Z',
      lastRefreshedAt: '2026-03-06T10:00:00.000Z'
    });

    await runScheduledCacheRefresh({ METAR_CACHE: kv }, new Date('2026-03-06T12:00:00.000Z'));

    const queueEntry = kv.read<{ lastAccessedAt: string }>('v1:hot:metar:KMSN');
    expect(queueEntry?.lastAccessedAt).toBe('2026-03-05T12:00:00.000Z');
  });

  it('scheduled refresh honors max items per run', async () => {
    const fetchStub = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const icao = new URL(requestUrl).searchParams.get('ids') ?? 'KAAA';
      return Promise.resolve(Response.json([buildMetarReport(icao, { wdir: 220, wspd: 9 })]));
    });
    vi.stubGlobal('fetch', fetchStub);

    const kv = new MemoryKv();
    seedHotQueueEntry(kv, {
      resource: 'metar',
      normalizedKey: 'KAAA',
      cacheKey: 'v1:metar:KAAA',
      lastAccessedAt: '2026-03-06T11:50:00.000Z',
      lastRefreshedAt: '2026-03-06T10:00:00.000Z'
    });
    seedHotQueueEntry(kv, {
      resource: 'metar',
      normalizedKey: 'KBBB',
      cacheKey: 'v1:metar:KBBB',
      lastAccessedAt: '2026-03-06T11:50:00.000Z',
      lastRefreshedAt: '2026-03-06T10:30:00.000Z'
    });

    await runScheduledCacheRefresh(
      {
        METAR_CACHE: kv,
        CACHE_REFRESH_MAX_ITEMS_PER_RUN: '1'
      },
      new Date('2026-03-06T12:00:00.000Z')
    );

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const olderEntry = kv.read<{ lastRefreshedAt: string }>('v1:hot:metar:KAAA');
    const newerEntry = kv.read<{ lastRefreshedAt: string }>('v1:hot:metar:KBBB');
    expect(new Date(olderEntry?.lastRefreshedAt ?? 0).getTime()).toBeGreaterThan(new Date('2026-03-06T10:00:00.000Z').getTime());
    expect(newerEntry?.lastRefreshedAt).toBe('2026-03-06T10:30:00.000Z');
  });

  it('scheduled refresh keeps entries queued when refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 })));

    const kv = new MemoryKv();
    seedHotQueueEntry(kv, {
      resource: 'metar',
      normalizedKey: 'KPHL',
      cacheKey: 'v1:metar:KPHL',
      lastAccessedAt: '2026-03-06T11:50:00.000Z',
      lastRefreshedAt: '2026-03-06T10:00:00.000Z'
    });

    await runScheduledCacheRefresh({ METAR_CACHE: kv }, new Date('2026-03-06T12:00:00.000Z'));

    const queueEntry = kv.read<{ lastRefreshedAt: string }>('v1:hot:metar:KPHL');
    expect(queueEntry).not.toBeNull();
    expect(queueEntry?.lastRefreshedAt).toBe('2026-03-06T10:00:00.000Z');
  });

  it('routes airport and metar requests through the worker entrypoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([buildMetarReport('KMCI', { wdir: 180, wspd: 10 })])));

    const airportResponse = await workerEntrypoint.fetch(new Request('https://metar.internal/api/airport?icao=ABC'), {
      METAR_CACHE: new MemoryKv(),
      AIRPORTDB_API_TOKEN: 'token'
    });
    const metarResponse = await workerEntrypoint.fetch(new Request('https://metar.internal/api/metar?icao=KMCI'), {
      METAR_CACHE: new MemoryKv()
    });

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

  it('writes hot queue metadata with the inactivity TTL as expirationTtl on airport success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(buildAirportReport('KJFK'))));

    const kv = new MemoryKv();
    const putSpy = vi.spyOn(kv, 'put');

    await handleAirportRequest(
      new Request('https://metar.internal/api/airport?icao=KJFK'),
      { METAR_CACHE: kv, AIRPORTDB_API_TOKEN: 'token' }
    );

    const hotQueuePut = putSpy.mock.calls.find(([key]) => key.startsWith('v1:hot:'));
    expect(hotQueuePut).toBeDefined();
    expect(hotQueuePut?.[2]).toEqual({ expirationTtl: 432000 });
  });

  it('scheduled refresh does not evict entry that was recently accessed concurrently', async () => {
    const kv = new MemoryKv();
    // Entry appears inactive in the initial snapshot (lastAccessedAt > inactivity TTL ago)…
    kv.seed('v1:hot:metar:KORD', {
      schemaVersion: 1,
      resource: 'metar',
      normalizedKey: 'KORD',
      cacheKey: 'v1:metar:KORD',
      lastAccessedAt: '2026-02-27T12:00:00.000Z',
      lastRefreshedAt: '2026-03-06T11:55:00.000Z' // recently refreshed, not due for another refresh
    });
    kv.seed('v1:metar:KORD', { cached: true });

    // …but the re-read before eviction sees a fresh lastAccessedAt from a concurrent request.
    const originalGet = kv.get.bind(kv);
    let hotKeyGetCount = 0;
    vi.spyOn(kv, 'get').mockImplementation(async (key, type) => {
      if (key === 'v1:hot:metar:KORD') {
        hotKeyGetCount++;
        if (hotKeyGetCount > 1) {
          return {
            schemaVersion: 1,
            resource: 'metar',
            normalizedKey: 'KORD',
            cacheKey: 'v1:metar:KORD',
            lastAccessedAt: '2026-03-06T11:58:00.000Z',
            lastRefreshedAt: '2026-03-06T11:55:00.000Z'
          };
        }
      }
      return originalGet(key, type);
    });

    await runScheduledCacheRefresh({ METAR_CACHE: kv }, new Date('2026-03-06T12:00:00.000Z'));

    expect(kv.has('v1:hot:metar:KORD')).toBe(true);
    expect(kv.has('v1:metar:KORD')).toBe(true);
  });

  it('scheduled refresh skips eviction when entry was already deleted before the re-read', async () => {
    const kv = new MemoryKv();
    kv.seed('v1:hot:metar:KORD', {
      schemaVersion: 1,
      resource: 'metar',
      normalizedKey: 'KORD',
      cacheKey: 'v1:metar:KORD',
      lastAccessedAt: '2026-02-27T12:00:00.000Z',
      lastRefreshedAt: '2026-03-01T12:00:00.000Z'
    });
    kv.seed('v1:metar:KORD', { cached: true });

    // Simulate concurrent deletion: re-read returns null.
    const originalGet = kv.get.bind(kv);
    let hotKeyGetCount = 0;
    vi.spyOn(kv, 'get').mockImplementation(async (key, type) => {
      if (key === 'v1:hot:metar:KORD') {
        hotKeyGetCount++;
        if (hotKeyGetCount > 1) {
          return null;
        }
      }
      return originalGet(key, type);
    });

    await expect(
      runScheduledCacheRefresh({ METAR_CACHE: kv }, new Date('2026-03-06T12:00:00.000Z'))
    ).resolves.not.toThrow();
    // The payload must not be deleted since the scheduler aborted after the null re-read.
    expect(kv.has('v1:metar:KORD')).toBe(true);
    expect(hotKeyGetCount).toBe(2);
  });

  it('scheduled refresh logs error via console.error when refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 })));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const kv = new MemoryKv();
    seedHotQueueEntry(kv, {
      resource: 'metar',
      normalizedKey: 'KBOS',
      cacheKey: 'v1:metar:KBOS',
      lastAccessedAt: '2026-03-06T11:50:00.000Z',
      lastRefreshedAt: '2026-03-06T10:00:00.000Z'
    });

    await runScheduledCacheRefresh({ METAR_CACHE: kv }, new Date('2026-03-06T12:00:00.000Z'));

    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Scheduled cache refresh failed for hot cache queue entry.',
      expect.objectContaining({ entry: expect.objectContaining({ normalizedKey: 'KBOS' }) })
    );
    consoleErrorSpy.mockRestore();
  });
});
