import { describe, expect, it, vi } from 'vitest';
import { onRequestGet } from './airport-location';

describe('pages airport location proxy', () => {
  it('proxies a validated location lookup to its dedicated Worker resource', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({ icao: 'KLOC', coordinates: { latitudeDeg: 41.8781, longitudeDeg: -87.6298 } })
    );

    const response = await onRequestGet({
      request: new Request('https://example.com/api/airport-location?icao=kloc'),
      env: { METAR_API: { fetch } },
      params: {},
      data: {},
      waitUntil: () => {},
      next: async () => new Response('')
    });

    expect(response.status).toBe(200);
    const proxiedRequest = fetch.mock.calls[0]?.[0] as Request;
    expect(new URL(proxiedRequest.url).pathname).toBe('/api/airport-location');
    expect(new URL(proxiedRequest.url).searchParams.get('icao')).toBe('KLOC');
  });

  it('rejects malformed ICAO values before proxying', async () => {
    const fetch = vi.fn();
    const response = await onRequestGet({
      request: new Request('https://example.com/api/airport-location?icao=A1'),
      env: { METAR_API: { fetch } },
      params: {},
      data: {},
      waitUntil: () => {},
      next: async () => new Response('')
    });

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
