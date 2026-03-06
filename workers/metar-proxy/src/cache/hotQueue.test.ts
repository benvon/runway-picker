import { describe, expect, it } from 'vitest';
import { parseCacheRefresherConfig, refreshIntervalSecondsForResource } from './hotQueue';
import type { CacheEngineEnv } from './types';

function createEnv(overrides?: Partial<CacheEngineEnv>): CacheEngineEnv {
  return {
    METAR_CACHE: {
      get: async () => null,
      put: async () => {},
      list: async () => ({ keys: [], list_complete: true }),
      delete: async () => {}
    },
    ...overrides
  };
}

describe('hot queue refresher config', () => {
  it('uses defaults when vars are not set', () => {
    const config = parseCacheRefresherConfig(createEnv());

    expect(config.enabled).toBe(true);
    expect(config.metarRefreshIntervalSeconds).toBe(1800);
    expect(config.airportRefreshIntervalSeconds).toBe(86400);
    expect(config.inactivityTtlSeconds).toBe(432000);
    expect(config.maxItemsPerRun).toBe(25);
  });

  it('falls back to defaults for invalid values', () => {
    const config = parseCacheRefresherConfig(
      createEnv({
        CACHE_REFRESH_ENABLED: 'not-bool',
        CACHE_REFRESH_METAR_INTERVAL_SECONDS: '-1',
        CACHE_REFRESH_AIRPORT_INTERVAL_SECONDS: '0',
        CACHE_REFRESH_INACTIVITY_TTL_SECONDS: 'abc',
        CACHE_REFRESH_MAX_ITEMS_PER_RUN: '0'
      })
    );

    expect(config.enabled).toBe(true);
    expect(config.metarRefreshIntervalSeconds).toBe(1800);
    expect(config.airportRefreshIntervalSeconds).toBe(86400);
    expect(config.inactivityTtlSeconds).toBe(432000);
    expect(config.maxItemsPerRun).toBe(25);
  });

  it('parses explicit overrides', () => {
    const config = parseCacheRefresherConfig(
      createEnv({
        CACHE_REFRESH_ENABLED: 'false',
        CACHE_REFRESH_METAR_INTERVAL_SECONDS: '900',
        CACHE_REFRESH_AIRPORT_INTERVAL_SECONDS: '43200',
        CACHE_REFRESH_INACTIVITY_TTL_SECONDS: '86400',
        CACHE_REFRESH_MAX_ITEMS_PER_RUN: '50'
      })
    );

    expect(config.enabled).toBe(false);
    expect(config.metarRefreshIntervalSeconds).toBe(900);
    expect(config.airportRefreshIntervalSeconds).toBe(43200);
    expect(config.inactivityTtlSeconds).toBe(86400);
    expect(config.maxItemsPerRun).toBe(50);
    expect(refreshIntervalSecondsForResource('metar', config)).toBe(900);
    expect(refreshIntervalSecondsForResource('airport', config)).toBe(43200);
  });
});
