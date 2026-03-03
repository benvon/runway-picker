import { describe, expect, it } from 'vitest';
import { registerResourceAdapters } from './registry';
import type { CacheResourceAdapter } from './types';

describe('cache adapter registry', () => {
  it('throws when adapter methods are missing', () => {
    const brokenAdapter = {
      resource: 'broken'
    } as CacheResourceAdapter<unknown, unknown, unknown>;

    expect(() => registerResourceAdapters([brokenAdapter])).toThrow(
      'Cache adapter broken is missing required methods.'
    );
  });

  it('throws on duplicate resource ids', () => {
    const baseAdapter: CacheResourceAdapter<{ key: string }, string, { value: string }> = {
      resource: 'demo',
      schemaVersion: 2,
      normalizeKey: (input) => input.key,
      fetchUpstream: async () => 'value',
      validate: (value) => ({ value }),
      serialize: (data, key, resource) => ({
        schemaVersion: 2,
        resource,
        key,
        data,
        cacheMeta: {
          fetchedAt: new Date(0).toISOString(),
          expiresAt: new Date(1).toISOString(),
          policyVersion: 'demo-v1',
          source: 'upstream'
        }
      }),
      deserialize: (cached) => (cached as { value: string }) ?? null,
      policy: {
        ttlSeconds: 10,
        staleWhileRevalidateSeconds: 1,
        staleOnErrorSeconds: 20,
        negativeCacheTtlSeconds: 2,
        policyVersion: 'demo-v1'
      },
      observability: () => ({ labels: { resource: 'demo' } })
    };

    expect(() =>
      registerResourceAdapters([
        baseAdapter as CacheResourceAdapter<unknown, unknown, unknown>,
        baseAdapter as CacheResourceAdapter<unknown, unknown, unknown>
      ])
    ).toThrow('Duplicate cache adapter registration for resource demo.');
  });
});
