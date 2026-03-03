import { describe, expect, it, vi } from 'vitest';
import { onRequestGet } from './metar';

describe('pages metar proxy', () => {
  it('returns 500 when METAR_API binding is missing', async () => {
    const response = await onRequestGet({
      request: new Request('https://example.com/api/metar?icao=KMCI'),
      env: {},
      params: {},
      data: {},
      waitUntil: () => {},
      next: async () => new Response('')
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: 'SERVICE_NOT_CONFIGURED'
    });
  });

  it('proxies request to METAR_API service binding and preserves cache headers', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json(
        {
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
          fetchedAt: '2026-03-02T00:00:00.000Z',
          cache: {
            status: 'kv_hit',
            source: 'kv',
            ageSeconds: 12,
            fetchedAt: '2026-03-02T00:00:00.000Z',
            servedAt: '2026-03-02T00:00:12.000Z',
            ttlSeconds: 1800,
            key: 'v1:metar:KMCI',
            resource: 'metar'
          }
        },
        {
          headers: {
            'Cache-Control': 'public, max-age=60, s-maxage=1800',
            'X-Runway-Cache-Status': 'kv_hit'
          }
        }
      )
    );

    const response = await onRequestGet({
      request: new Request('https://example.com/api/metar?icao=KMCI'),
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
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=1800');
  });
});
