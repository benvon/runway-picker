import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMetarByIcao, MetarLookupError } from './metarApi';

describe('metarApi service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects invalid ICAO values', async () => {
    await expect(fetchMetarByIcao('KSF')).rejects.toBeInstanceOf(MetarLookupError);
  });

  it('calls local API and returns structured cache metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            icao: 'KJFK',
            metarRaw: 'METAR KJFK 022051Z 12008KT 10SM FEW040 05/M02 A3016',
            source: 'aviationweather',
            fetchedAt: '2026-03-02T00:00:00.000Z',
            cache: {
              status: 'kv_hit',
              source: 'kv',
              ageSeconds: 18,
              fetchedAt: '2026-03-02T00:00:00.000Z',
              servedAt: '2026-03-02T00:00:18.000Z',
              ttlSeconds: 1800,
              key: 'v1:metar:KJFK',
              resource: 'metar'
            }
          },
          {
            headers: {
              'X-Runway-Cache-Status': 'kv_hit',
              'X-Cache': 'HIT'
            }
          }
        )
      )
    );

    const payload = await fetchMetarByIcao('kjfk');
    expect(fetch).toHaveBeenCalledWith('/api/metar?icao=KJFK', {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
    expect(payload.icao).toBe('KJFK');
    expect(payload.cache.status).toBe('kv_hit');
    expect(payload.cache.source).toBe('kv');
    expect(payload.cache.key).toBe('v1:metar:KJFK');
  });

  it('falls back to legacy cache headers when cache payload is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            icao: 'KMCI',
            metarRaw: 'METAR KMCI 022051Z 12008KT 10SM FEW040 05/M02 A3016',
            source: 'aviationweather',
            fetchedAt: '2026-03-02T00:00:00.000Z'
          },
          {
            headers: {
              'X-Cache': 'MISS'
            }
          }
        )
      )
    );

    const payload = await fetchMetarByIcao('kmci');
    expect(payload.cache.status).toBe('upstream_refresh');
    expect(payload.cache.source).toBe('upstream');
  });

  it('surfaces user-friendly message for unknown ICAO', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: 'ICAO code ZZZZ was not found. Check the code and try again.'
          },
          { status: 404 }
        )
      )
    );

    await expect(fetchMetarByIcao('ZZZZ')).rejects.toMatchObject({
      message: 'ICAO code ZZZZ was not found. Check the code and try again.',
      status: 404
    });
  });

  it('surfaces user-friendly message for missing METAR on valid ICAO', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: 'No METAR is currently available for ICAO KJFK. Try again later.'
          },
          { status: 404 }
        )
      )
    );

    await expect(fetchMetarByIcao('kjfk')).rejects.toMatchObject({
      message: 'No METAR is currently available for ICAO KJFK. Try again later.',
      status: 404
    });
    expect(fetch).toHaveBeenCalledWith('/api/metar?icao=KJFK', {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
  });
});
