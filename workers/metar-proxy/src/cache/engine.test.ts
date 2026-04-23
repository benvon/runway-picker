import { describe, expect, it, vi } from 'vitest';
import { getOrRefreshCached } from './engine';
import type {
  CacheEnvelope,
  CacheEngineEnv,
  CacheResourceAdapter,
  DurableObjectNamespaceLike,
  EdgeCacheLike,
  KvNamespaceLike
} from './types';

interface DemoInput {
  key: string;
}

interface DemoData {
  value: string;
  fetchedAt: string;
}

class MemoryKv implements KvNamespaceLike {
  private values = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, JSON.parse(value) as unknown);
  }

  seed(key: string, value: unknown): void {
    this.values.set(key, value);
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

  seed(cacheKey: string, response: Response): void {
    this.values.set(`https://cache.runway.internal/${encodeURIComponent(cacheKey)}`, response);
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
  staleWhileRevalidateSeconds?: number;
  staleOnErrorSeconds?: number;
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
      staleWhileRevalidateSeconds: overrides?.staleWhileRevalidateSeconds ?? 10,
      staleOnErrorSeconds: overrides?.staleOnErrorSeconds ?? 120,
      negativeCacheTtlSeconds: 5,
      policyVersion: 'demo-v1'
    },
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
    expect(adapter.fetchUpstream).not.toHaveBeenCalled();
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
});
