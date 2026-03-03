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
            wind: {
              raw: '12008KT',
              directionType: 'fixed',
              directionDegTrue: 120,
              speedKt: 8,
              gustKt: null
            },
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
              'X-Runway-Cache-Status': 'kv_hit'
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
    expect(payload.wind.directionType).toBe('fixed');
    expect(payload.wind.speedKt).toBe(8);
    expect(payload.cache.status).toBe('kv_hit');
    expect(payload.cache.source).toBe('kv');
    expect(payload.cache.key).toBe('v1:metar:KJFK');
  });

  it('falls back to X-Runway-Cache-Status when cache payload is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            icao: 'KMCI',
            metarRaw: 'METAR KMCI 022051Z VRB03KT 10SM FEW040 05/M02 A3016',
            wind: {
              raw: 'VRB03KT',
              directionType: 'variable',
              directionDegTrue: null,
              speedKt: 3,
              gustKt: null
            },
            source: 'aviationweather',
            fetchedAt: '2026-03-02T00:00:00.000Z'
          },
          {
            headers: {
              'X-Runway-Cache-Status': 'upstream_refresh'
            }
          }
        )
      )
    );

    const payload = await fetchMetarByIcao('kmci');
    expect(payload.wind.directionType).toBe('variable');
    expect(payload.wind.speedKt).toBe(3);
    expect(payload.cache.status).toBe('upstream_refresh');
    expect(payload.cache.source).toBe('upstream');
  });

  it('throws when response lacks structured wind fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            icao: 'KMCI',
            metarRaw: 'METAR KMCI 022051Z VRB03KT 10SM FEW040 05/M02 A3016',
            source: 'aviationweather',
            fetchedAt: '2026-03-02T00:00:00.000Z'
          },
          {
            headers: {
              'X-Runway-Cache-Status': 'upstream_refresh'
            }
          }
        )
      )
    );

    await expect(fetchMetarByIcao('kmci')).rejects.toMatchObject({
      message: 'METAR response is missing structured wind data.',
      status: 502
    });
  });

  it('surfaces user-friendly message for unknown ICAO', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: 'ICAO code ZZZZ was not found. Check the code and try again.',
            code: 'ICAO_NOT_FOUND'
          },
          { status: 404 }
        )
      )
    );

    await expect(fetchMetarByIcao('ZZZZ')).rejects.toMatchObject({
      message: 'ICAO code ZZZZ was not found. Check the code and try again.',
      status: 404,
      code: 'ICAO_NOT_FOUND'
    });
  });

  it('surfaces user-friendly message for missing METAR on valid ICAO', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: 'No METAR is currently available for ICAO KJFK. Try again later.',
            code: 'METAR_UNAVAILABLE'
          },
          { status: 404 }
        )
      )
    );

    await expect(fetchMetarByIcao('kjfk')).rejects.toMatchObject({
      message: 'No METAR is currently available for ICAO KJFK. Try again later.',
      status: 404,
      code: 'METAR_UNAVAILABLE'
    });
    expect(fetch).toHaveBeenCalledWith('/api/metar?icao=KJFK', {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
  });

  it('includes debug payload details in parse-failure errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: 'Unable to parse wind data from METAR provider for ICAO KJVL.',
            code: 'WIND_PARSE_ERROR',
            debug: {
              rawObPresent: true,
              rawWindToken: null
            }
          },
          { status: 502 }
        )
      )
    );

    await expect(fetchMetarByIcao('KJVL')).rejects.toMatchObject({
      status: 502,
      message: 'Unable to parse wind data from METAR provider for ICAO KJVL.',
      code: 'WIND_PARSE_ERROR',
      debug: {
        rawObPresent: true,
        rawWindToken: null
      }
    });
  });
});
