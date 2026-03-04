import { describe, expect, it, vi } from 'vitest';
import { onRequestGet } from './airport';

describe('pages airport proxy', () => {
  it('returns 500 when METAR_API binding is missing', async () => {
    const response = await onRequestGet({
      request: new Request('https://example.com/api/airport?icao=KMCI'),
      env: {},
      params: {},
      data: {},
      waitUntil: () => {},
      next: async () => new Response('')
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: 'SERVICE_NOT_CONFIGURED',
      requestId: expect.any(String)
    });
    expect(response.headers.get('X-Request-Id')).toEqual(expect.any(String));
  });

  it('proxies request to METAR_API service binding and preserves cache headers', async () => {
    const fetch = vi.fn().mockResolvedValue(
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
            { id: '01L', headingDegMag: 10 },
            { id: '19R', headingDegMag: 190 }
          ],
          source: 'airportdb',
          fetchedAt: '2026-03-03T00:00:00.000Z',
          cache: {
            status: 'kv_hit',
            source: 'kv',
            ageSeconds: 240,
            fetchedAt: '2026-03-03T00:00:00.000Z',
            servedAt: '2026-03-03T00:04:00.000Z',
            ttlSeconds: 86400,
            key: 'v1:airport:KMCI',
            resource: 'airport'
          }
        },
        {
          headers: {
            'Cache-Control': 'public, max-age=60, s-maxage=86400',
            'X-Runway-Cache-Status': 'kv_hit'
          }
        }
      )
    );

    const response = await onRequestGet({
      request: new Request('https://example.com/api/airport?icao=KMCI', {
        headers: {
          'CF-Connecting-IP': '203.0.113.11'
        }
      }),
      env: {
        METAR_API: { fetch }
      },
      params: {},
      data: {},
      waitUntil: () => {},
      next: async () => new Response('')
    });

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalled();
    expect(response.headers.get('X-Runway-Cache-Status')).toBe('kv_hit');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=86400');
    expect(response.headers.get('X-Request-Id')).toEqual(expect.any(String));
    const proxiedRequest = fetch.mock.calls[0]?.[0];
    expect(proxiedRequest).toBeInstanceOf(Request);
    expect((proxiedRequest as Request).headers.get('X-Client-IP')).toBe('203.0.113.11');
    expect((proxiedRequest as Request).headers.get('X-Request-Id')).toEqual(expect.any(String));
  });

  it('returns INVALID_ICAO for malformed input before proxying', async () => {
    const fetch = vi.fn();

    const response = await onRequestGet({
      request: new Request('https://example.com/api/airport?icao=A1'),
      env: {
        METAR_API: { fetch }
      },
      params: {},
      data: {},
      waitUntil: () => {},
      next: async () => new Response('')
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'INVALID_ICAO',
      requestId: expect.any(String)
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
