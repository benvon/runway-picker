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
  });

  it('proxies request to METAR_API service binding', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        icao: 'KMCI',
        metarRaw: 'METAR KMCI 021953Z 11010KT 7SM OVC008 04/02 A3014 RMK AO2',
        source: 'aviationweather',
        fetchedAt: '2026-03-02T00:00:00.000Z'
      })
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
  });
});
