import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractMetarRaw, handleMetarRequest, MetarWorkerError, normalizeIcao } from './index';

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

  it('returns 400 and no-store on invalid ICAO', async () => {
    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=ABC'), {
      METAR_CACHE: new MemoryKv()
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
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
      error: 'METAR provider returned status 503.'
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
      error: 'ICAO code ZZZZ was not found. Check the code and try again.'
    });
  });
});
