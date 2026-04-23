import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAirportByIcao } from './airportApi';

describe('airportApi service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects invalid ICAO values', async () => {
    await expect(fetchAirportByIcao('KSF')).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_ICAO'
    });
  });

  it('calls local API and returns structured runway and cache metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            requestedIcao: 'KJFK',
            icao: 'KJFK',
            name: 'John F Kennedy International Airport',
            municipality: 'New York',
            countryCode: 'US',
            countryName: 'United States',
            elevationFt: 13,
            runwayEnds: [
              { id: '04L', headingDegMag: 40, lengthFt: 12079 },
              { id: '22R', headingDegMag: 220, lengthFt: 12079 }
            ],
            frequencies: [
              { type: 'APP', description: 'NORTH APPROACH', frequencyMhz: '125.7' },
              { type: 'TWR', description: 'TOWER', frequencyMhz: '119.1' }
            ],
            source: 'airportdb',
            fetchedAt: '2026-03-02T00:00:00.000Z',
            cache: {
              status: 'kv_hit',
              source: 'kv',
              ageSeconds: 90,
              fetchedAt: '2026-03-02T00:00:00.000Z',
              servedAt: '2026-03-02T00:01:30.000Z',
              ttlSeconds: 86400,
              key: 'v1:airport:KJFK',
              resource: 'airport'
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

    const payload = await fetchAirportByIcao('kjfk');
    expect(fetch).toHaveBeenCalledWith('/api/airport?icao=KJFK', {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
    expect(payload.requestedIcao).toBe('KJFK');
    expect(payload.icao).toBe('KJFK');
    expect(payload.runwayEnds).toEqual([
      { id: '04L', headingDegMag: 40, isClosed: false, lengthFt: 12079 },
      { id: '22R', headingDegMag: 220, isClosed: false, lengthFt: 12079 }
    ]);
    expect(payload.frequencies).toEqual([
      { type: 'APP', description: 'NORTH APPROACH', frequencyMhz: '125.7' },
      { type: 'TWR', description: 'TOWER', frequencyMhz: '119.1' }
    ]);
    expect(payload.cache.status).toBe('kv_hit');
    expect(payload.cache.source).toBe('kv');
    expect(payload.cache.key).toBe('v1:airport:KJFK');
  });

  it('falls back to cache header when cache payload is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            requestedIcao: 'KMCI',
            icao: 'KMCI',
            name: 'Kansas City International Airport',
            municipality: 'Kansas City',
            countryCode: 'US',
            countryName: 'United States',
            elevationFt: 1026,
            runwayEnds: [
              { id: '01L', headingDegMag: 10, isClosed: false, lengthFt: 8000 },
              { id: '19R', headingDegMag: 190, isClosed: true, lengthFt: 8000 }
            ],
            frequencies: [{ type: 'TWR', description: 'TOWER', frequencyMhz: '123.9' }],
            source: 'airportdb',
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

    const payload = await fetchAirportByIcao('kmci');
    expect(payload.runwayEnds[0]).toMatchObject({
      id: '01L',
      isClosed: false,
      lengthFt: 8000
    });
    expect(payload.cache.status).toBe('upstream_refresh');
    expect(payload.cache.source).toBe('upstream');
  });

  it('ignores malformed frequency entries and defaults to empty frequency list when missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          requestedIcao: 'KDSM',
          icao: 'KDSM',
          name: 'Des Moines International Airport',
          municipality: 'Des Moines',
          countryCode: 'US',
          countryName: 'United States',
          elevationFt: 958,
          runwayEnds: [{ id: '05', headingDegMag: 50, isClosed: false, lengthFt: 9000 }],
          frequencies: [
            { type: 'APP', description: 'DES MOINES APPROACH', frequencyMhz: '118.3' },
            { type: 'TWR', frequencyMhz: '126.8' },
            null
          ],
          source: 'airportdb',
          fetchedAt: '2026-03-02T00:00:00.000Z'
        })
      )
    );

    const payload = await fetchAirportByIcao('kdsm');
    expect(payload.frequencies).toEqual([{ type: 'APP', description: 'DES MOINES APPROACH', frequencyMhz: '118.3' }]);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          requestedIcao: 'KOTG',
          icao: 'KOTG',
          name: 'Worthington Municipal',
          municipality: 'Worthington',
          countryCode: 'US',
          countryName: 'United States',
          elevationFt: 1574,
          runwayEnds: [{ id: '11', headingDegMag: 110, isClosed: false, lengthFt: 5500 }],
          source: 'airportdb',
          fetchedAt: '2026-03-02T00:00:00.000Z'
        })
      )
    );

    const fallbackPayload = await fetchAirportByIcao('kotg');
    expect(fallbackPayload.frequencies).toEqual([]);
  });

  it('throws when response lacks runway fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            requestedIcao: 'KMCI',
            icao: 'KMCI',
            name: 'Kansas City International Airport',
            source: 'airportdb',
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

    await expect(fetchAirportByIcao('kmci')).rejects.toMatchObject({
      message: 'Airport response is missing runway data.',
      status: 502
    });
  });

  it('surfaces user-friendly message for unknown ICAO', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: 'ICAO code XXXX was not found in airport database.',
            code: 'ICAO_NOT_FOUND'
          },
          { status: 404 }
        )
      )
    );

    await expect(fetchAirportByIcao('XXXX')).rejects.toMatchObject({
      message: 'ICAO code XXXX was not found in airport database.',
      status: 404,
      code: 'ICAO_NOT_FOUND'
    });
  });
});
