import { describe, expect, it } from 'vitest';
import { ApiRateLimiter } from './rateLimiter';

class MemoryStorage {
  private values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function createLimiter(): ApiRateLimiter {
  return new ApiRateLimiter({
    storage: new MemoryStorage()
  });
}

describe('api rate limiter durable object', () => {
  it('allows requests under burst and sustained limits', async () => {
    const limiter = createLimiter();

    for (let index = 0; index < 20; index += 1) {
      const response = await limiter.fetch(
        new Request('https://rate-limiter.internal/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nowMs: 1_000 })
        })
      );
      const payload = (await response.json()) as { allowed: boolean };
      expect(payload.allowed).toBe(true);
    }
  });

  it('blocks when burst limit is exceeded', async () => {
    const limiter = createLimiter();

    for (let index = 0; index < 20; index += 1) {
      await limiter.fetch(
        new Request('https://rate-limiter.internal/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nowMs: 2_000 })
        })
      );
    }

    const response = await limiter.fetch(
      new Request('https://rate-limiter.internal/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nowMs: 2_000 })
      })
    );

    const payload = (await response.json()) as {
      allowed: boolean;
      retryAfterSeconds: number | null;
    };

    expect(payload.allowed).toBe(false);
    expect(payload.retryAfterSeconds).not.toBeNull();
  });

  it('blocks when sustained limit is exceeded', async () => {
    const limiter = createLimiter();

    for (let index = 0; index < 60; index += 1) {
      const nowMs = 10_000 + index * 1_000;
      await limiter.fetch(
        new Request('https://rate-limiter.internal/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nowMs })
        })
      );
    }

    const response = await limiter.fetch(
      new Request('https://rate-limiter.internal/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nowMs: 69_000 })
      })
    );

    const payload = (await response.json()) as {
      allowed: boolean;
      retryAfterSeconds: number | null;
    };

    expect(payload.allowed).toBe(false);
    expect(payload.retryAfterSeconds).not.toBeNull();
  });

  it('applies temporary penalty after repeated invalid ICAO signals', async () => {
    const limiter = createLimiter();

    for (let index = 0; index < 8; index += 1) {
      await limiter.fetch(
        new Request('https://rate-limiter.internal/invalid-icao', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nowMs: 50_000 })
        })
      );
    }

    const response = await limiter.fetch(
      new Request('https://rate-limiter.internal/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nowMs: 50_000 })
      })
    );

    const payload = (await response.json()) as {
      allowed: boolean;
      retryAfterSeconds: number | null;
    };

    expect(payload.allowed).toBe(false);
    expect(payload.retryAfterSeconds).not.toBeNull();
  });
});
