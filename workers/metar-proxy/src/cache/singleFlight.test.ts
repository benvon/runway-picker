import { describe, expect, it } from 'vitest';
import {
  CacheSingleFlightCoordinator,
  acquireSingleFlightLease,
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

class InMemoryCoordinatorNamespace implements DurableObjectNamespaceLike {
  private readonly storage = new MemoryStorage();

  idFromName(name: string): string {
    return name;
  }

  get(_id: unknown): { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } {
    void _id;
    const coordinator = new CacheSingleFlightCoordinator({ storage: this.storage });
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
