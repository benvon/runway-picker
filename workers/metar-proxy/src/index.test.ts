import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractMetarRaw,
  handleAirportRequest,
  handleMetarRequest,
  MetarWorkerError,
  normalizeAirportIcao,
  normalizeIcao
} from './index';

class MemoryKv {
  private values = new Map<string, unknown>();

  async get(key: string, _type: 'json'): Promise<unknown> {
    void _type;
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, JSON.parse(value) as unknown);
  }

  seed(key: string, value: unknown): void {
    this.values.set(key, value);
  }
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
    ]
  };
}

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
      METAR_CACHE: new MemoryKv()
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
    expect(payload.cache.source).toBe('upstream');
    expect(payload.cache.status).toBe('upstream_refresh');
  });

  it('returns 500 when airportdb token is missing', async () => {
    const response = await handleAirportRequest(new Request('https://metar.internal/api/airport?icao=KJFK'), {
      METAR_CACHE: new MemoryKv()
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Airport lookup service is not configured.'
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
      error: 'No runway data is available for ICAO KHEL.'
    });
  });
});
