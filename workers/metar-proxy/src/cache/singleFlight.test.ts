import { describe, expect, it } from 'vitest';
import {
  CacheSingleFlightCoordinator,
  acquireSingleFlightLease,
  abortSchedulerRun,
  acknowledgeSchedulerDequeues,
  beginSchedulerRun,
  commitSchedulerRun,
  processSchedulerDequeues,
  recordSchedulerDemand,
  renewSchedulerRun,
  releaseSingleFlightLease
} from './singleFlight';
import type { DurableObjectNamespaceLike } from './types';

interface LockRecord {
  token: string;
  expiresAtMs: number;
}

class MemoryStorage {
  private values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}

class MemoryKv {
  private readonly values = new Map<string, unknown>();

  async get(key: string, type: 'json' | 'text'): Promise<unknown> {
    const value = this.values.get(key) ?? null;
    if (type === 'text' && value !== null) return JSON.stringify(value);
    return value;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, JSON.parse(value) as unknown);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  read<T>(key: string): T | null {
    return (this.values.get(key) as T | undefined) ?? null;
  }
}

class InMemoryCoordinatorNamespace implements DurableObjectNamespaceLike {
  private readonly storage = new MemoryStorage();

  constructor(private readonly cache?: MemoryKv) {}

  idFromName(name: string): string {
    return name;
  }

  get(_id: unknown): { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } {
    void _id;
    const coordinator = new CacheSingleFlightCoordinator(
      { storage: this.storage },
      this.cache ? { METAR_CACHE: this.cache } : undefined
    );
    return {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request
            ? input
            : new Request(input.toString(), {
                method: init?.method,
                headers: init?.headers,
                body: init?.body
              });
        return coordinator.fetch(request);
      }
    };
  }
}

describe('singleFlight coordinator', () => {
  it('returns 405 when request method is not POST', async () => {
    const coordinator = new CacheSingleFlightCoordinator({ storage: new MemoryStorage() });
    const response = await coordinator.fetch(new Request('https://cache.local/acquire', { method: 'GET' }));
    expect(response.status).toBe(405);
  });

  it('returns 400 for invalid acquire payload', async () => {
    const coordinator = new CacheSingleFlightCoordinator({ storage: new MemoryStorage() });
    const response = await coordinator.fetch(
      new Request('https://cache.local/acquire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: '', holdSeconds: 'bad' })
      })
    );
    expect(response.status).toBe(400);
  });

  it('acquires then blocks duplicate lock acquisitions before release', async () => {
    const storage = new MemoryStorage();
    const coordinator = new CacheSingleFlightCoordinator({ storage });
    const first = await coordinator.fetch(
      new Request('https://cache.local/acquire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'demo', holdSeconds: 5 })
      })
    );
    const second = await coordinator.fetch(
      new Request('https://cache.local/acquire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'demo', holdSeconds: 5 })
      })
    );

    const firstBody = (await first.json()) as { acquired: boolean; token: string };
    const secondBody = (await second.json()) as { acquired: boolean };
    expect(firstBody.acquired).toBe(true);
    expect(typeof firstBody.token).toBe('string');
    expect(secondBody.acquired).toBe(false);

    const lock = await storage.get<LockRecord>('demo');
    expect(lock?.token).toBe(firstBody.token);
  });

  it('releases lock when token matches and tolerates mismatched token', async () => {
    const storage = new MemoryStorage();
    await storage.put('demo', { token: 'abc', expiresAtMs: Date.now() + 5000 } satisfies LockRecord);
    const coordinator = new CacheSingleFlightCoordinator({ storage });

    const wrongRelease = await coordinator.fetch(
      new Request('https://cache.local/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'demo', token: 'bad' })
      })
    );
    expect(wrongRelease.status).toBe(204);
    expect(await storage.get('demo')).toBeTruthy();

    const correctRelease = await coordinator.fetch(
      new Request('https://cache.local/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'demo', token: 'abc' })
      })
    );
    expect(correctRelease.status).toBe(204);
    expect(await storage.get('demo')).toBeUndefined();
  });

  it('returns 404 for unknown routes', async () => {
    const coordinator = new CacheSingleFlightCoordinator({ storage: new MemoryStorage() });
    const response = await coordinator.fetch(
      new Request('https://cache.local/unknown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      })
    );
    expect(response.status).toBe(404);
  });
});

describe('singleFlight namespace helpers', () => {
  it('acquireSingleFlightLease returns null when namespace is missing', async () => {
    await expect(acquireSingleFlightLease(undefined, 'demo', 5)).resolves.toBeNull();
  });

  it('acquires and releases a lease against a Durable Object namespace', async () => {
    const namespace = new InMemoryCoordinatorNamespace();
    const lease = await acquireSingleFlightLease(namespace, 'demo', 5);
    expect(lease?.key).toBe('demo');
    expect(typeof lease?.token).toBe('string');

    const second = await acquireSingleFlightLease(namespace, 'demo', 5);
    expect(second).toBeNull();

    await expect(releaseSingleFlightLease(namespace, lease)).resolves.toBeUndefined();
    const third = await acquireSingleFlightLease(namespace, 'demo', 5);
    expect(third).not.toBeNull();
  });

  it('releaseSingleFlightLease no-ops when namespace or lease is missing', async () => {
    await expect(releaseSingleFlightLease(undefined, null)).resolves.toBeUndefined();
    await expect(releaseSingleFlightLease(new InMemoryCoordinatorNamespace(), null)).resolves.toBeUndefined();
  });
});

describe('scheduler coordinator protocol', () => {
  it('serializes a run and persists cursors only with its atomic outcome commit', async () => {
    const namespace = new InMemoryCoordinatorNamespace();
    const first = await beginSchedulerRun(namespace, 30);
    expect(first?.cursors).toEqual({});
    await expect(beginSchedulerRun(namespace, 30)).resolves.toBeNull();
    const committed = await commitSchedulerRun(namespace, {
      runId: first?.runId ?? '',
      cursors: { metar: 'opaque-metAR-cursor' },
      inactivityTtlSeconds: 60,
      outcomes: [{ identity: 'v2:hot:metar:KJFK', outcome: 'upstream_failed', lastAccessedAt: new Date().toISOString() }]
    });
    expect(committed).toEqual({ dequeueIdentities: [] });
    const next = await beginSchedulerRun(namespace, 30);
    expect(next?.cursors).toEqual({ metar: 'opaque-metAR-cursor' });
  });

  it('makes commit idempotent and drops demand only on the third upstream failure', async () => {
    const namespace = new InMemoryCoordinatorNamespace();
    const identity = 'v2:hot:airport:KJFK';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const lease = await beginSchedulerRun(namespace, 30);
      const body = {
        runId: lease?.runId ?? '',
        cursors: {},
        inactivityTtlSeconds: 60,
        outcomes: [{ identity, outcome: 'upstream_failed' as const, lastAccessedAt: new Date().toISOString() }]
      };
      const result = await commitSchedulerRun(namespace, body);
      expect(result?.dequeueIdentities).toEqual(attempt === 3 ? [identity] : []);
      await expect(commitSchedulerRun(namespace, body)).resolves.toEqual(result);
    }
  });

  it('retains a pending dequeue until the worker acknowledges successful KV deletion', async () => {
    const namespace = new InMemoryCoordinatorNamespace();
    const identity = 'v2:hot:metar:KORD';
    let thirdRunId = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const lease = await beginSchedulerRun(namespace, 30);
      thirdRunId = lease?.runId ?? '';
      await commitSchedulerRun(namespace, {
        runId: thirdRunId, cursors: {}, inactivityTtlSeconds: 3600,
        outcomes: [{ identity, outcome: 'upstream_failed', lastAccessedAt: new Date().toISOString() }]
      });
    }
    const retryLease = await beginSchedulerRun(namespace, 30);
    const retry = await commitSchedulerRun(namespace, { runId: retryLease?.runId ?? '', cursors: {}, inactivityTtlSeconds: 3600, outcomes: [] });
    expect(retry?.dequeueIdentities).toContain(identity);
    await expect(acknowledgeSchedulerDequeues(namespace, retryLease?.runId ?? '', [identity])).resolves.toBe(true);
    const afterAck = await beginSchedulerRun(namespace, 30);
    expect(afterAck).not.toBeNull();
    await expect(commitSchedulerRun(namespace, { runId: afterAck?.runId ?? '', cursors: {}, inactivityTtlSeconds: 3600, outcomes: [] })).resolves.toEqual({ dequeueIdentities: [] });
    void thirdRunId;
  });

  it('does not let a stale dequeue remove demand re-enqueued by a client', async () => {
    const cache = new MemoryKv();
    const namespace = new InMemoryCoordinatorNamespace(cache);
    const identity = 'v2:hot:metar:KORD';
    const oldAccess = '2026-03-06T12:00:00.000Z';
    const newAccess = '2026-03-06T12:05:00.000Z';

    await expect(recordSchedulerDemand(namespace, {
      resource: 'metar', normalizedKey: 'KORD', lastAccessedAt: oldAccess, expirationTtl: 3600
    })).resolves.toBe(true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const lease = await beginSchedulerRun(namespace, 30);
      await commitSchedulerRun(namespace, {
        runId: lease?.runId ?? '', cursors: {}, inactivityTtlSeconds: 3600,
        outcomes: [{ identity, outcome: 'upstream_failed', lastAccessedAt: oldAccess }]
      });
    }

    await expect(recordSchedulerDemand(namespace, {
      resource: 'metar', normalizedKey: 'KORD', lastAccessedAt: newAccess, expirationTtl: 3600
    })).resolves.toBe(true);
    await expect(processSchedulerDequeues(namespace)).resolves.toBe(true);
    expect(cache.read<{ lastAccessedAt: string }>(identity)).toMatchObject({ lastAccessedAt: newAccess });

    const afterReenqueue = await beginSchedulerRun(namespace, 30);
    await expect(commitSchedulerRun(namespace, {
      runId: afterReenqueue?.runId ?? '', cursors: {}, inactivityTtlSeconds: 3600, outcomes: []
    })).resolves.toEqual({ dequeueIdentities: [] });
  });

  it('abort releases a run without committing cursor or outcome state', async () => {
    const namespace = new InMemoryCoordinatorNamespace();
    const lease = await beginSchedulerRun(namespace, 30);
    await abortSchedulerRun(namespace, lease?.runId ?? '');
    const next = await beginSchedulerRun(namespace, 30);
    expect(next?.cursors).toEqual({});
  });

  it('renews only the active run token and rejects renewal after abort', async () => {
    const namespace = new InMemoryCoordinatorNamespace();
    const lease = await beginSchedulerRun(namespace, 1);
    await expect(renewSchedulerRun(namespace, lease?.runId ?? '', 30)).resolves.toBe(true);
    await expect(renewSchedulerRun(namespace, 'wrong-token', 30)).resolves.toBe(false);
    await abortSchedulerRun(namespace, lease?.runId ?? '');
    await expect(renewSchedulerRun(namespace, lease?.runId ?? '', 30)).resolves.toBe(false);
  });

  it('keeps a sequential seven-attempt run eligible to commit after repeated renewals', async () => {
    const namespace = new InMemoryCoordinatorNamespace();
    const lease = await beginSchedulerRun(namespace, 1);
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await expect(renewSchedulerRun(namespace, lease?.runId ?? '', 1)).resolves.toBe(true);
    }
    await expect(commitSchedulerRun(namespace, {
      runId: lease?.runId ?? '', cursors: { metar: 'after-seven' }, inactivityTtlSeconds: 60,
      outcomes: Array.from({ length: 7 }, (_, attempt) => ({ identity: `v2:hot:metar:K${attempt}`, outcome: 'upstream_failed' as const, lastAccessedAt: new Date().toISOString() }))
    })).resolves.toEqual({ dequeueIdentities: [] });
  });

  it('fails closed when the scheduler coordinator binding is unavailable', async () => {
    await expect(beginSchedulerRun(undefined, 30)).resolves.toBeNull();
  });
});
