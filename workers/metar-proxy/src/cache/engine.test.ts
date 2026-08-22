import { describe, expect, it, vi } from 'vitest';
import { getOrRefreshCached } from './engine';
import type {
  CacheEnvelope,
  CacheEngineEnv,
  CacheResourceAdapter,
  DurableObjectNamespaceLike,
  EdgeCacheLike,
  KvNamespaceLike,
  NegativeCachePolicy
} from './types';

interface DemoInput {
  key: string;
}

interface DemoData {
  value: string;
  fetchedAt: string;
}

class DemoStableMissError extends Error {
  status = 404 as const;
  code = 'DEMO_NOT_FOUND';

  constructor() {
    super('Demo resource was not found.');
    this.name = 'DemoStableMissError';
  }
}

class MemoryKv implements KvNamespaceLike {
  private values = new Map<string, unknown>();
  private writeOptions = new Map<string, { expirationTtl?: number } | undefined>();

  async get(key: string): Promise<unknown> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.values.set(key, JSON.parse(value) as unknown);
    this.writeOptions.set(key, options);
  }

  seed(key: string, value: unknown): void {
    this.values.set(key, value);
  }

  getWriteOptions(key: string): { expirationTtl?: number } | undefined {
    return this.writeOptions.get(key);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  has(key: string): boolean {
    return this.values.has(key);
  }
}

class MemoryEdgeCache implements EdgeCacheLike {
  private values = new Map<string, Response>();

  async match(request: Request): Promise<Response | undefined> {
    const value = this.values.get(request.url);
    return value ? value.clone() : undefined;
  }

  async put(request: Request, response: Response): Promise<void> {
    this.values.set(request.url, response.clone());
  }

  async delete(request: Request): Promise<boolean> {
    return this.values.delete(request.url);
  }

  seed(cacheKey: string, response: Response): void {
    this.values.set(`https://cache.runway.internal/${encodeURIComponent(cacheKey)}`, response);
  }

  has(cacheKey: string): boolean {
    return this.values.has(`https://cache.runway.internal/${encodeURIComponent(cacheKey)}`);
  }
}

function createCoordinatorNamespace(): DurableObjectNamespaceLike {
  let lock: { token: string; expiresAtMs: number } | null = null;

  return {
    idFromName: (name) => name,
    get: () => ({
      fetch: async (input, init) => {
        const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const url = new URL(requestUrl);
        const body = JSON.parse(init?.body ? String(init.body) : '{}') as {
          key?: string;
          holdSeconds?: number;
          token?: string;
        };

        if (url.pathname === '/acquire') {
          const now = Date.now();
          if (lock && lock.expiresAtMs > now) {
            return Response.json({ acquired: false });
          }

          lock = {
            token: `${now}`,
            expiresAtMs: now + Math.max(1, body.holdSeconds ?? 1) * 1000
          };

          return Response.json({ acquired: true, token: lock.token });
        }

        if (url.pathname === '/release') {
          if (lock && lock.token === body.token && body.key) {
            lock = null;
          }

          return new Response(null, { status: 204 });
        }

        return Response.json({ error: 'not found' }, { status: 404 });
      }
    })
  };
}

function createBlockedCoordinatorNamespace(): DurableObjectNamespaceLike {
  return {
    idFromName: (name) => name,
    get: () => ({
      fetch: async () => Response.json({ acquired: false })
    })
  };
}

function buildAdapter(overrides?: {
  fetchUpstream?: CacheResourceAdapter<DemoInput, string, DemoData>['fetchUpstream'];
  validate?: CacheResourceAdapter<DemoInput, string, DemoData>['validate'];
  serialize?: CacheResourceAdapter<DemoInput, string, DemoData>['serialize'];
  ttlSeconds?: number;
  maxPayloadAgeSeconds?: number;
  staleWhileRevalidateSeconds?: number;
  staleOnErrorSeconds?: number;
  negativeCache?: NegativeCachePolicy<DemoInput>;
}): CacheResourceAdapter<DemoInput, string, DemoData> {
  return {
    resource: 'demo',
    schemaVersion: 2,
    normalizeKey: (input) => input.key.trim().toLowerCase(),
    fetchUpstream:
      overrides?.fetchUpstream ??
      (async () => {
        return 'upstream';
      }),
    validate:
      overrides?.validate ??
      ((value) => ({
        value,
        fetchedAt: new Date().toISOString()
      })),
    serialize:
      overrides?.serialize ??
      ((data, key, resource) => ({
        schemaVersion: 2,
        resource,
        key,
        data,
        cacheMeta: {
          fetchedAt: data.fetchedAt,
          expiresAt: new Date(
            new Date(data.fetchedAt).getTime() + (overrides?.ttlSeconds ?? 30) * 1000
          ).toISOString(),
          policyVersion: 'demo-v1',
          source: 'upstream'
        }
      })),
    deserialize: (cached) => {
      if (!cached || typeof cached !== 'object') {
        return null;
      }

      const data = (cached as { data?: unknown }).data ?? cached;
      if (!data || typeof data !== 'object') {
        return null;
      }

      const candidate = data as Partial<DemoData>;
      if (typeof candidate.value !== 'string' || typeof candidate.fetchedAt !== 'string') {
        return null;
      }

      return {
        value: candidate.value,
        fetchedAt: candidate.fetchedAt
      };
    },
    policy: {
      ttlSeconds: overrides?.ttlSeconds ?? 30,
      maxPayloadAgeSeconds: overrides?.maxPayloadAgeSeconds ?? 150,
      staleWhileRevalidateSeconds: overrides?.staleWhileRevalidateSeconds ?? 10,
      staleOnErrorSeconds: overrides?.staleOnErrorSeconds ?? 120,
      negativeCacheTtlSeconds: 5,
      policyVersion: 'demo-v1'
    },
    negativeCache: overrides?.negativeCache,
    observability: (input, key) => ({
      labels: {
        resource: 'demo',
        key,
        input: input.key
      }
    })
  };
}

function buildEnvelope(cacheKey: string, value: string, fetchedAt: string, ttlSeconds = 30): CacheEnvelope<DemoData> {
  return {
    schemaVersion: 2,
    resource: 'demo',
    key: cacheKey,
    data: {
      value,
      fetchedAt
    },
    cacheMeta: {
      fetchedAt,
      expiresAt: new Date(new Date(fetchedAt).getTime() + ttlSeconds * 1000).toISOString(),
      policyVersion: 'demo-v1',
      source: 'upstream'
    }
  };
}

describe('cache engine', () => {
  it('returns edge cache hit when edge entry is fresh', async () => {
    const adapter = buildAdapter({
      fetchUpstream: vi.fn().mockResolvedValue('not-used')
    });
    const kv = new MemoryKv();
    const edge = new MemoryEdgeCache();
    const now = new Date('2026-03-03T12:00:00.000Z');
    edge.seed(
      'v1:demo:alpha',
      Response.json(buildEnvelope('v1:demo:alpha', 'edge-value', '2026-03-03T11:59:45.000Z'))
    );

    const result = await getOrRefreshCached({
      adapter,
      input: { key: 'ALPHA' },
      request: new Request('https://example.com'),
      env: { METAR_CACHE: kv },
      edgeCache: edge,
      now
    });

    expect(result.payload.value).toBe('edge-value');
    expect(result.cache.status).toBe('edge_hit');
    expect(result.cache.source).toBe('edge');
    expect(adapter.fetchUpstream).not.toHaveBeenCalled();
  });

  it('returns kv cache hit when kv entry is fresh', async () => {
    const adapter = buildAdapter({
      fetchUpstream: vi.fn().mockResolvedValue('not-used')
    });
    const kv = new MemoryKv();
    kv.seed(
      'v1:demo:alpha',
      buildEnvelope('v1:demo:alpha', 'kv-value', '2026-03-03T11:59:45.000Z')
    );

    const result = await getOrRefreshCached({
      adapter,
      input: { key: 'alpha' },
      request: new Request('https://example.com'),
      env: { METAR_CACHE: kv },
      edgeCache: new MemoryEdgeCache(),
      now: new Date('2026-03-03T12:00:00.000Z')
    });

    expect(result.payload.value).toBe('kv-value');
    expect(result.cache.status).toBe('kv_hit');
    expect(result.cache.source).toBe('kv');
    expect(result.cache.expiresAt).toBe('2026-03-03T12:00:15.000Z');
    expect(result.cache.freshnessRemainingSeconds).toBe(15);
    expect(adapter.fetchUpstream).not.toHaveBeenCalled();
  });

  it('limits edge-cache promotion to the cached record remaining freshness', async () => {
    const adapter = buildAdapter({ fetchUpstream: vi.fn().mockResolvedValue('not-used') });
    const kv = new MemoryKv();
    const edge = new MemoryEdgeCache();
    kv.seed(
      'v1:demo:alpha',
      buildEnvelope('v1:demo:alpha', 'kv-value', '2026-03-03T11:59:45.000Z', 20)
    );

    const result = await getOrRefreshCached({
      adapter,
      input: { key: 'alpha' },
      request: new Request('https://example.com'),
      env: { METAR_CACHE: kv },
      edgeCache: edge,
      now: new Date('2026-03-03T12:00:00.000Z')
    });

    expect(result.cache.freshnessRemainingSeconds).toBe(5);
    const promoted = await edge.match(new Request('https://cache.runway.internal/v1%3Ademo%3Aalpha'));
    expect(promoted?.headers.get('Cache-Control')).toBe('public, max-age=5, s-maxage=5');
  });

  it('rechecks freshness after a delayed KV read before promoting a cache record', async () => {
    let now = new Date('2026-03-03T12:00:00.000Z');
    const adapter = buildAdapter({
      fetchUpstream: vi.fn().mockResolvedValue('refreshed-value'),
      validate: (value) => ({ value, fetchedAt: now.toISOString() })
    });
    const kv = new MemoryKv();
    const edge = new MemoryEdgeCache();
    kv.seed(
      'v1:demo:alpha',
      buildEnvelope('v1:demo:alpha', 'near-expiry-value', '2026-03-03T11:59:35.000Z', 30)
    );
    const get = kv.get.bind(kv);
    vi.spyOn(kv, 'get').mockImplementation(async (key) => {
      now = new Date('2026-03-03T12:00:06.000Z');
      return get(key);
    });

    const result = await getOrRefreshCached({
      adapter,
      input: { key: 'alpha' },
      request: new Request('https://example.com'),
      env: { METAR_CACHE: kv },
      edgeCache: edge,
      clock: () => now
    });

    expect(result.payload.value).toBe('refreshed-value');
    expect(result.cache.status).toBe('upstream_refresh');
    const promoted = await edge.match(new Request('https://cache.runway.internal/v1%3Ademo%3Aalpha'));
    expect(promoted?.headers.get('Cache-Control')).toBe('public, max-age=30, s-maxage=30');
  });

  it('does not return a KV hit that expires while edge promotion is pending', async () => {
    const adapter = buildAdapter({ fetchUpstream: vi.fn().mockRejectedValue(new Error('upstream unavailable')) });
    const kv = new MemoryKv();
    let now = new Date('2026-03-03T12:00:00.000Z');
    let promoted: Response | undefined;
    const edge: EdgeCacheLike = {
      match: async () => undefined,
      put: async (_request, response) => {
        promoted = response.clone();
        now = new Date('2026-03-03T12:00:06.000Z');
      }
    };
    kv.seed(
      'v1:demo:alpha',
      buildEnvelope('v1:demo:alpha', 'near-expiry-value', '2026-03-03T11:59:35.000Z', 30)
    );

    const result = await getOrRefreshCached({
      adapter,
      input: { key: 'alpha' },
      request: new Request('https://example.com'),
      env: { METAR_CACHE: kv },
      edgeCache: edge,
      clock: () => now
    });

    expect(result.cache.status).toBe('stale_on_error');
    expect(result.cache.freshnessRemainingSeconds).toBe(0);
    expect(promoted?.headers.get('Cache-Control')).toBe('public, max-age=5, s-maxage=5');
    expect(Date.parse(promoted?.headers.get('Date') ?? '') + 5_000).toBeLessThanOrEqual(
      Date.parse('2026-03-03T12:00:05.000Z')
    );
  });

  it('clamps sub-second and future cached expiries without extending edge-cache lifetime', async () => {
    const adapter = buildAdapter({ fetchUpstream: vi.fn().mockResolvedValue('not-used') });
    const now = new Date('2026-03-03T12:00:00.000Z');
    const edge = new MemoryEdgeCache();
    const kv = new MemoryKv();
    kv.seed('v1:demo:alpha', {
      ...buildEnvelope('v1:demo:alpha', 'sub-second', '2026-03-03T11:59:30.000Z'),
      cacheMeta: {
        fetchedAt: '2026-03-03T11:59:30.000Z',
        expiresAt: '2026-03-03T12:00:00.999Z',
        policyVersion: 'demo-v1',
        source: 'upstream'
      }
    });

    const subSecond = await getOrRefreshCached({
      adapter,
      input: { key: 'alpha' },
      request: new Request('https://example.com'),
      env: { METAR_CACHE: kv },
      edgeCache: edge,
      now
    });

    expect(subSecond.cache.freshnessRemainingSeconds).toBe(0);
    expect(await edge.match(new Request('https://cache.runway.internal/v1%3Ademo%3Aalpha'))).toBeUndefined();

    kv.seed('v1:demo:bravo', {
      ...buildEnvelope('v1:demo:bravo', 'future', '2026-03-03T12:00:00.000Z'),
      cacheMeta: {
        fetchedAt: '2026-03-03T12:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        policyVersion: 'demo-v1',
        source: 'upstream'
      }
    });

    const future = await getOrRefreshCached({
      adapter,
      input: { key: 'bravo' },
      request: new Request('https://example.com'),
      env: { METAR_CACHE: kv },
      edgeCache: edge,
      now
    });

    expect(future.cache.freshnessRemainingSeconds).toBe(30);
    const promoted = await edge.match(new Request('https://cache.runway.internal/v1%3Ademo%3Abravo'));
    expect(promoted?.headers.get('Cache-Control')).toBe('public, max-age=30, s-maxage=30');
  });

  it('preserves cache-only envelope fields when promoting a kv hit back into edge cache', async () => {
    const adapter = buildAdapter({
      fetchUpstream: vi.fn().mockResolvedValue('not-used')
    });
    const kv = new MemoryKv();
    const edge = new MemoryEdgeCache();
    kv.seed('v1:demo:alpha', {
      ...buildEnvelope('v1:demo:alpha', 'kv-value', '2026-03-03T11:59:45.000Z'),
      upstreamSnapshot: {
        value: 'raw-provider-value'
      }
    });

    await getOrRefreshCached({
      adapter,
      input: { key: 'alpha' },
      request: new Request('https://example.com'),
      env: { METAR_CACHE: kv },
      edgeCache: edge,
      now: new Date('2026-03-03T12:00:00.000Z')
    });

    const cachedEdgeResponse = await edge.match(
      new Request('https://cache.runway.internal/v1%3Ademo%3Aalpha')
    );
    const cachedEdgeEnvelope = (await cachedEdgeResponse?.json()) as {
      upstreamSnapshot?: { value?: string };
    };

    expect(cachedEdgeEnvelope.upstreamSnapshot?.value).toBe('raw-provider-value');
  });

  it('persists adapter-defined cache-only envelope fields during upstream refresh', async () => {
    const adapter = buildAdapter({
      fetchUpstream: vi.fn().mockResolvedValue('provider-raw-value'),
      serialize: (data, key, resource, upstream) => ({
        schemaVersion: 2,
        resource,
        key,
        data,
        cacheMeta: {
          fetchedAt: data.fetchedAt,
          expiresAt: new Date(new Date(data.fetchedAt).getTime() + 30 * 1000).toISOString(),
          policyVersion: 'demo-v1',
          source: 'upstream'
        },
        upstreamSnapshot: {
          rawValue: upstream
        }
      })
    });
    const kv = new MemoryKv();
    const edge = new MemoryEdgeCache();

    const result = await getOrRefreshCached({
      adapter,
      input: { key: 'alpha' },
      request: new Request('https://example.com'),
      env: { METAR_CACHE: kv },
      edgeCache: edge,
      now: new Date('2026-03-03T12:00:00.000Z')
    });

    expect(result.payload.value).toBe('provider-raw-value');
    expect(result.cache.status).toBe('upstream_refresh');

    const kvEnvelope = (await kv.get('v1:demo:alpha')) as {
      upstreamSnapshot?: { rawValue?: string };
    };
    expect(kvEnvelope.upstreamSnapshot?.rawValue).toBe('provider-raw-value');

    const cachedEdgeResponse = await edge.match(
      new Request('https://cache.runway.internal/v1%3Ademo%3Aalpha')
    );
    const cachedEdgeEnvelope = (await cachedEdgeResponse?.json()) as {
      upstreamSnapshot?: { rawValue?: string };
    };
    expect(cachedEdgeEnvelope.upstreamSnapshot?.rawValue).toBe('provider-raw-value');
  });

  it('uses single-flight so concurrent misses perform one upstream fetch', async () => {
    const fetchUpstream = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return 'fresh-value';
    });

    const adapter = buildAdapter({ fetchUpstream });
    const kv = new MemoryKv();
    const env: CacheEngineEnv = {
      METAR_CACHE: kv,
      CACHE_COORDINATOR: createCoordinatorNamespace()
    };

    const [first, second] = await Promise.all([
      getOrRefreshCached({
        adapter,
        input: { key: 'alpha' },
        request: new Request('https://example.com/a'),
        env,
        edgeCache: new MemoryEdgeCache()
      }),
      getOrRefreshCached({
        adapter,
        input: { key: 'alpha' },
        request: new Request('https://example.com/b'),
        env,
        edgeCache: new MemoryEdgeCache()
      })
    ]);

    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    expect(first.payload.value).toBe('fresh-value');
    expect(second.payload.value).toBe('fresh-value');
    expect([first.cache.status, second.cache.status].sort()).toEqual(['kv_hit', 'upstream_refresh']);
  });

  it('caches adapter-declared stable misses and avoids repeated upstream requests', async () => {
    const fetchUpstream = vi.fn().mockRejectedValue(new DemoStableMissError());
    const adapter = buildAdapter({
      fetchUpstream,
      negativeCache: {
        toEntry: (error) =>
          error instanceof DemoStableMissError ? { status: 404, code: 'DEMO_NOT_FOUND' } : null,
        toError: (entry) => (entry.code === 'DEMO_NOT_FOUND' ? new DemoStableMissError() : null)
      }
    });
    const kv = new MemoryKv();
    const edge = new MemoryEdgeCache();
    const request = new Request('https://example.com');

    await expect(
      getOrRefreshCached({ adapter, input: { key: 'alpha' }, request, env: { METAR_CACHE: kv }, edgeCache: edge })
    ).rejects.toMatchObject({ status: 404, code: 'DEMO_NOT_FOUND' });
    await expect(
      getOrRefreshCached({ adapter, input: { key: 'alpha' }, request, env: { METAR_CACHE: kv }, edgeCache: edge })
    ).rejects.toMatchObject({ status: 404, code: 'DEMO_NOT_FOUND' });

    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    expect(kv.getWriteOptions('v1:demo:alpha')).toEqual({ expirationTtl: 5 });
  });

  it('returns the leader-written stable miss to concurrent single-flight followers', async () => {
    const fetchUpstream = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      throw new DemoStableMissError();
    });
    const adapter = buildAdapter({
      fetchUpstream,
      negativeCache: {
        toEntry: (error) =>
          error instanceof DemoStableMissError ? { status: 404, code: 'DEMO_NOT_FOUND' } : null,
        toError: (entry) => (entry.code === 'DEMO_NOT_FOUND' ? new DemoStableMissError() : null)
      }
    });
    const kv = new MemoryKv();
    const env: CacheEngineEnv = {
      METAR_CACHE: kv,
      CACHE_COORDINATOR: createCoordinatorNamespace()
    };

    const results = await Promise.allSettled([
      getOrRefreshCached({
        adapter,
        input: { key: 'missing' },
        request: new Request('https://example.com/a'),
        env,
        edgeCache: new MemoryEdgeCache()
      }),
      getOrRefreshCached({
        adapter,
        input: { key: 'missing' },
        request: new Request('https://example.com/b'),
        env,
        edgeCache: new MemoryEdgeCache()
      })
    ]);

    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).toMatchObject({
        status: 'rejected',
        reason: { status: 404, code: 'DEMO_NOT_FOUND' }
      });
    }
  });

  it('preserves an adapter-declared stable miss when negative-cache writes fail', async () => {
    const adapter = buildAdapter({
      fetchUpstream: vi.fn().mockRejectedValue(new DemoStableMissError()),
      negativeCache: {
        toEntry: (error) =>
          error instanceof DemoStableMissError ? { status: 404, code: 'DEMO_NOT_FOUND' } : null,
        toError: (entry) => (entry.code === 'DEMO_NOT_FOUND' ? new DemoStableMissError() : null)
      }
    });
    const kv: KvNamespaceLike = {
      get: async () => null,
      put: async () => {
        throw new Error('KV unavailable');
      }
    };
    const edge: EdgeCacheLike = {
      match: async () => undefined,
      put: async () => {
        throw new Error('edge unavailable');
      }
    };

    await expect(
      getOrRefreshCached({
        adapter,
        input: { key: 'missing' },
        request: new Request('https://example.com'),
        env: { METAR_CACHE: kv },
        edgeCache: edge
      })
    ).rejects.toMatchObject({ status: 404, code: 'DEMO_NOT_FOUND' });
  });

  it('preserves a KV stable miss when the edge-cache refill fails', async () => {
    const adapter = buildAdapter({
      fetchUpstream: vi.fn(),
      negativeCache: {
        toEntry: (error) =>
          error instanceof DemoStableMissError ? { status: 404, code: 'DEMO_NOT_FOUND' } : null,
        toError: (entry) => (entry.code === 'DEMO_NOT_FOUND' ? new DemoStableMissError() : null)
      }
    });
    const kv = new MemoryKv();
    const fetchedAt = new Date().toISOString();
    kv.seed('v1:demo:missing', {
      schemaVersion: 2,
      resource: 'demo',
      key: 'v1:demo:missing',
      negative: { status: 404, code: 'DEMO_NOT_FOUND' },
      cacheMeta: {
        fetchedAt,
        expiresAt: new Date(Date.now() + 5_000).toISOString(),
        policyVersion: 'demo-v1',
        source: 'upstream'
      }
    });
    const edge: EdgeCacheLike = {
      match: async () => undefined,
      put: async () => {
        throw new Error('edge unavailable');
      }
    };

    await expect(
      getOrRefreshCached({
        adapter,
        input: { key: 'missing' },
        request: new Request('https://example.com'),
        env: { METAR_CACHE: kv },
        edgeCache: edge
      })
    ).rejects.toMatchObject({ status: 404, code: 'DEMO_NOT_FOUND' });
  });

  it('limits negative-cache edge promotion to its recorded remaining lifetime', async () => {
    const adapter = buildAdapter({
      fetchUpstream: vi.fn(),
      negativeCache: {
        toEntry: (error) =>
          error instanceof DemoStableMissError ? { status: 404, code: 'DEMO_NOT_FOUND' } : null,
        toError: (entry) => (entry.code === 'DEMO_NOT_FOUND' ? new DemoStableMissError() : null)
      }
    });
    const now = new Date('2026-03-03T12:00:00.000Z');
    const kv = new MemoryKv();
    const edge = new MemoryEdgeCache();
    kv.seed('v1:demo:missing', {
      schemaVersion: 2,
      resource: 'demo',
      key: 'v1:demo:missing',
      negative: { status: 404, code: 'DEMO_NOT_FOUND' },
      cacheMeta: {
        fetchedAt: '2026-03-03T11:59:55.000Z',
        expiresAt: '2026-03-03T12:00:03.000Z',
        policyVersion: 'demo-v1',
        source: 'upstream'
      }
    });

    await expect(
      getOrRefreshCached({
        adapter,
        input: { key: 'missing' },
        request: new Request('https://example.com'),
        env: { METAR_CACHE: kv },
        edgeCache: edge,
        now
      })
    ).rejects.toMatchObject({ status: 404, code: 'DEMO_NOT_FOUND' });

    const promoted = await edge.match(new Request('https://cache.runway.internal/v1%3Ademo%3Amissing'));
    expect(promoted?.headers.get('Cache-Control')).toBe('public, max-age=3, s-maxage=3');
  });

  it('does not cache errors an adapter has not explicitly declared stable', async () => {
    const fetchUpstream = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    const adapter = buildAdapter({
      fetchUpstream,
      negativeCache: {
        toEntry: (error) =>
          error instanceof DemoStableMissError ? { status: 404, code: 'DEMO_NOT_FOUND' } : null,
        toError: (entry) => (entry.code === 'DEMO_NOT_FOUND' ? new DemoStableMissError() : null)
      }
    });
    const kv = new MemoryKv();
    const request = new Request('https://example.com');

    await expect(
      getOrRefreshCached({ adapter, input: { key: 'alpha' }, request, env: { METAR_CACHE: kv } })
    ).rejects.toThrow('provider unavailable');
    await expect(
      getOrRefreshCached({ adapter, input: { key: 'alpha' }, request, env: { METAR_CACHE: kv } })
    ).rejects.toThrow('provider unavailable');

    expect(fetchUpstream).toHaveBeenCalledTimes(2);
    expect(kv.getWriteOptions('v1:demo:alpha')).toBeUndefined();
  });

  it('serves stale data on upstream error when stale-on-error window is valid', async () => {
    const adapter = buildAdapter({
      fetchUpstream: vi.fn().mockRejectedValue(new Error('upstream failed')),
      ttlSeconds: 30,
      staleOnErrorSeconds: 180
    });
    const kv = new MemoryKv();
    kv.seed(
      'v1:demo:alpha',
      buildEnvelope('v1:demo:alpha', 'stale-value', '2026-03-03T11:59:00.000Z', 30)
    );

    const result = await getOrRefreshCached({
      adapter,
      input: { key: 'alpha' },
      request: new Request('https://example.com'),
      env: { METAR_CACHE: kv },
      edgeCache: new MemoryEdgeCache(),
      now: new Date('2026-03-03T12:00:10.000Z')
    });

    expect(result.payload.value).toBe('stale-value');
    expect(result.cache.status).toBe('stale_on_error');
    expect(result.cache.source).toBe('stale');
    expect(result.cache.freshnessRemainingSeconds).toBe(0);
  });

  it('ignores schema mismatches and refreshes from upstream', async () => {
    const fetchUpstream = vi.fn().mockResolvedValue('from-upstream');
    const adapter = buildAdapter({ fetchUpstream });
    const kv = new MemoryKv();
    kv.seed('v1:demo:alpha', {
      schemaVersion: 99,
      resource: 'demo',
      key: 'v1:demo:alpha',
      data: {
        value: 'old',
        fetchedAt: '2026-03-03T11:59:00.000Z'
      },
      cacheMeta: {
        fetchedAt: '2026-03-03T11:59:00.000Z',
        expiresAt: '2026-03-03T12:00:00.000Z',
        policyVersion: 'old-v0',
        source: 'upstream'
      }
    });

    const result = await getOrRefreshCached({
      adapter,
      input: { key: 'alpha' },
      request: new Request('https://example.com'),
      env: { METAR_CACHE: kv },
      edgeCache: new MemoryEdgeCache(),
      now: new Date('2026-03-03T12:00:10.000Z')
    });

    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    expect(result.payload.value).toBe('from-upstream');
    expect(result.cache.status).toBe('upstream_refresh');
  });

  it('returns and stores adapter-serialized data when serialize transforms payload', async () => {
    const adapter = buildAdapter({
      fetchUpstream: vi.fn().mockResolvedValue('raw-upstream'),
      validate: () => ({
        value: 'raw-value',
        fetchedAt: 'invalid-timestamp'
      }),
      serialize: (_data, key, resource) => ({
        schemaVersion: 2,
        resource,
        key,
        data: {
          value: 'normalized-value',
          fetchedAt: '2026-03-03T12:00:00.000Z'
        },
        cacheMeta: {
          fetchedAt: '2026-03-03T12:00:00.000Z',
          expiresAt: '2026-03-03T12:00:30.000Z',
          policyVersion: 'demo-v1',
          source: 'upstream'
        }
      })
    });
    const kv = new MemoryKv();

    const result = await getOrRefreshCached({
      adapter,
      input: { key: 'alpha' },
      request: new Request('https://example.com'),
      env: { METAR_CACHE: kv },
      edgeCache: new MemoryEdgeCache(),
      now: new Date('2026-03-03T12:00:01.000Z')
    });

    expect(result.payload.value).toBe('normalized-value');
    expect(result.payload.fetchedAt).toBe('2026-03-03T12:00:00.000Z');

    const stored = (await kv.get('v1:demo:alpha')) as CacheEnvelope<DemoData>;
    expect(stored.data.value).toBe('normalized-value');
    expect(stored.data.fetchedAt).toBe('2026-03-03T12:00:00.000Z');
  });

  it('serves stale-while-refresh for follower requests when stale data exists', async () => {
    const adapter = buildAdapter({
      ttlSeconds: 30,
      staleWhileRevalidateSeconds: 60
    });
    const kv = new MemoryKv();
    kv.seed(
      'v1:demo:alpha',
      buildEnvelope('v1:demo:alpha', 'stale-value', '2026-03-03T11:59:20.000Z', 30)
    );

    const result = await getOrRefreshCached({
      adapter,
      input: { key: 'alpha' },
      request: new Request('https://example.com'),
      env: {
        METAR_CACHE: kv,
        CACHE_COORDINATOR: createBlockedCoordinatorNamespace()
      },
      edgeCache: new MemoryEdgeCache(),
      now: new Date('2026-03-03T12:00:00.000Z')
    });

    expect(result.cache.status).toBe('stale_while_refresh');
    expect(result.payload.value).toBe('stale-value');
    expect(result.cache.freshnessRemainingSeconds).toBe(0);
  });

  it('throws a cache engine error when non-Error values bubble from upstream refresh', async () => {
    const adapter = buildAdapter({
      fetchUpstream: vi.fn().mockRejectedValue('unexpected-string-error')
    });
    const kv = new MemoryKv();

    await expect(
      getOrRefreshCached({
        adapter,
        input: { key: 'alpha' },
        request: new Request('https://example.com'),
        env: { METAR_CACHE: kv },
        edgeCache: new MemoryEdgeCache(),
        now: new Date('2026-03-03T12:00:00.000Z')
      })
    ).rejects.toMatchObject({
      name: 'CacheEngineError',
      message: 'Unexpected cache refresh failure.',
      status: 500
    });
  });

  it('serves stale-on-error for follower requests after waiting for leader refresh', async () => {
    const adapter = buildAdapter({
      ttlSeconds: 30,
      staleWhileRevalidateSeconds: 10,
      staleOnErrorSeconds: 120
    });
    const kv = new MemoryKv();
    kv.seed(
      'v1:demo:alpha',
      buildEnvelope('v1:demo:alpha', 'older-stale', '2026-03-03T12:00:00.000Z', 30)
    );

    const result = await getOrRefreshCached({
      adapter,
      input: { key: 'alpha' },
      request: new Request('https://example.com'),
      env: {
        METAR_CACHE: kv,
        CACHE_COORDINATOR: createBlockedCoordinatorNamespace()
      },
      edgeCache: new MemoryEdgeCache(),
      now: new Date('2026-03-03T12:00:45.000Z')
    });

    expect(result.cache.status).toBe('stale_on_error');
    expect(result.payload.value).toBe('older-stale');
  });

  it('allows stale fallback immediately before the payload age boundary', async () => {
    const adapter = buildAdapter({ maxPayloadAgeSeconds: 5400, staleOnErrorSeconds: 7200, fetchUpstream: vi.fn().mockRejectedValue(new Error('offline')) });
    const kv = new MemoryKv();
    kv.seed('v1:demo:alpha', buildEnvelope('v1:demo:alpha', 'still-valid', '2026-03-03T10:30:01.000Z', 30));

    const result = await getOrRefreshCached({
      adapter,
      input: { key: 'alpha' },
      request: new Request('https://example.com'),
      env: { METAR_CACHE: kv },
      now: new Date('2026-03-03T12:00:00.000Z')
    });

    expect(result.cache.status).toBe('stale_on_error');
    expect(result.payload.value).toBe('still-valid');
  });

  it('purges KV and edge copies at the payload age boundary and never serves stale fallback', async () => {
    const adapter = buildAdapter({ maxPayloadAgeSeconds: 5400, fetchUpstream: vi.fn().mockRejectedValue(new Error('offline')) });
    const kv = new MemoryKv();
    const edge = new MemoryEdgeCache();
    const envelope = buildEnvelope('v1:demo:alpha', 'expired', '2026-03-03T10:30:00.000Z', 30);
    kv.seed('v1:demo:alpha', envelope);
    edge.seed('v1:demo:alpha', Response.json(envelope));

    await expect(getOrRefreshCached({
      adapter,
      input: { key: 'alpha' },
      request: new Request('https://example.com'),
      env: { METAR_CACHE: kv },
      edgeCache: edge,
      now: new Date('2026-03-03T12:00:00.000Z')
    })).rejects.toThrow('offline');

    expect(kv.has('v1:demo:alpha')).toBe(false);
    expect(edge.has('v1:demo:alpha')).toBe(false);
  });

  it('fails closed for a record without a trusted fetched timestamp even when cleanup fails', async () => {
    const adapter = buildAdapter({ maxPayloadAgeSeconds: 5400, fetchUpstream: vi.fn().mockRejectedValue(new Error('offline')) });
    const kv = new MemoryKv();
    const envelope = buildEnvelope('v1:demo:alpha', 'unknown-age', '2026-03-03T11:59:00.000Z', 30);
    envelope.cacheMeta.fetchedAt = 'not-a-date';
    envelope.data.fetchedAt = 'not-a-date';
    kv.seed('v1:demo:alpha', envelope);
    vi.spyOn(kv, 'delete').mockRejectedValue(new Error('cleanup unavailable'));

    await expect(getOrRefreshCached({
      adapter,
      input: { key: 'alpha' },
      request: new Request('https://example.com'),
      env: { METAR_CACHE: kv },
      now: new Date('2026-03-03T12:00:00.000Z')
    })).rejects.toThrow('offline');
  });
});
