import { describe, expect, it, vi } from 'vitest';
import { onRequestGet } from './metar';
import { handleMetarRequest } from '../../workers/metar-proxy/src/index';
import { ApiRateLimiter } from '../../workers/metar-proxy/src/security/rateLimiter';
import type { CacheEngineEnv, DurableObjectNamespaceLike } from '../../workers/metar-proxy/src/cache/types';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function createRateLimiterNamespace(): DurableObjectNamespaceLike {
  const limiter = new ApiRateLimiter({ storage: new MemoryStorage() });
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input.toString(), init);
        return limiter.fetch(request);
      }
    })
  };
}

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
      code: 'SERVICE_NOT_CONFIGURED',
      requestId: expect.any(String)
    });
    expect(response.headers.get('X-Request-Id')).toEqual(expect.any(String));
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
            expiresAt: '2026-03-02T00:00:17.000Z',
            freshnessRemainingSeconds: 5,
            servedAt: '2026-03-02T00:00:12.000Z',
            ttlSeconds: 1800,
            key: 'v1:metar:KMCI',
            resource: 'metar'
          }
        },
        {
          headers: {
            'Cache-Control': 'public, max-age=5, s-maxage=5',
            'X-Runway-Cache-Status': 'kv_hit'
          }
        }
      )
    );

    const response = await onRequestGet({
      request: new Request('https://example.com/api/metar?icao=KMCI', {
        headers: {
          'CF-Connecting-IP': '203.0.113.10'
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
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=5, s-maxage=5');
    expect(response.headers.get('X-Request-Id')).toEqual(expect.any(String));
    const proxiedRequest = fetch.mock.calls[0]?.[0];
    expect(proxiedRequest).toBeInstanceOf(Request);
    expect((proxiedRequest as Request).headers.get('X-Client-IP')).toBe('203.0.113.10');
    expect((proxiedRequest as Request).headers.get('X-Request-Id')).toEqual(expect.any(String));
  });

  it('preserves no-store for stale worker responses', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json(
        { cache: { status: 'stale_on_error', freshnessRemainingSeconds: 0 } },
        { headers: { 'Cache-Control': 'no-store', 'X-Runway-Cache-Status': 'stale_on_error' } }
      )
    );

    const response = await onRequestGet({
      request: new Request('https://example.com/api/metar?icao=KMCI'),
      env: { METAR_API: { fetch } },
      params: {},
      data: {},
      waitUntil: () => {},
      next: async () => new Response('')
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Runway-Cache-Status')).toBe('stale_on_error');
  });

  it('forwards malformed input to the trusted Worker so invalid attempts are rate limited', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json(
        { error: 'Invalid ICAO code. Expected 4 alphanumeric characters.', code: 'INVALID_ICAO' },
        { status: 400 }
      )
    );

    const response = await onRequestGet({
      request: new Request('https://example.com/api/metar?icao=ABC', {
        headers: { 'CF-Connecting-IP': '203.0.113.12' }
      }),
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
      code: 'INVALID_ICAO'
    });
    expect(response.headers.get('X-Request-Id')).toEqual(expect.any(String));
    expect(fetch).toHaveBeenCalledOnce();
    const proxiedRequest = fetch.mock.calls[0]?.[0] as Request;
    expect(new URL(proxiedRequest.url).searchParams.get('icao')).toBe('ABC');
    expect(proxiedRequest.headers.get('X-Client-IP')).toBe('203.0.113.12');
  });

  it('enforces the real Worker invalid-ICAO penalty through the Pages boundary', async () => {
    const workerEnv: CacheEngineEnv = {
      METAR_CACHE: {
        get: async () => null,
        put: async () => {}
      },
      API_RATE_LIMITER: createRateLimiterNamespace()
    };
    const serviceBinding = {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input.toString(), init);
        return handleMetarRequest(request, workerEnv);
      }
    };
    const responses: Response[] = [];

    for (let attempt = 0; attempt < 9; attempt += 1) {
      responses.push(await onRequestGet({
        request: new Request('https://example.com/api/metar?icao=ABC', {
          headers: { 'CF-Connecting-IP': '203.0.113.14' }
        }),
        env: { METAR_API: serviceBinding },
        params: {},
        data: {},
        waitUntil: () => {},
        next: async () => new Response('')
      }));
    }

    expect(responses.slice(0, 8).every((response) => response.status === 400)).toBe(true);
    expect(responses[8]?.status).toBe(429);
    expect(responses[8]?.headers.get('Retry-After')).toEqual(expect.any(String));
    await expect(responses[8]?.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
  });
});
