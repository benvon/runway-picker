import { describe, expect, it } from 'vitest';
import { normalizeCacheMetadata } from './cacheMetadata';

type DemoStatus = 'hit' | 'miss' | 'unknown';
type DemoSource = 'edge' | 'upstream' | 'unknown';

function statusFromHeaders(headers: Headers): DemoStatus {
  const value = headers.get('X-Demo-Status');
  if (value === 'hit' || value === 'miss') {
    return value;
  }

  return 'unknown';
}

function sourceFromStatus(status: DemoStatus): DemoSource {
  if (status === 'hit') {
    return 'edge';
  }

  if (status === 'miss') {
    return 'upstream';
  }

  return 'unknown';
}

function isStatus(value: unknown): value is DemoStatus {
  return value === 'hit' || value === 'miss' || value === 'unknown';
}

function isSource(value: unknown): value is DemoSource {
  return value === 'edge' || value === 'upstream' || value === 'unknown';
}

describe('cache metadata normalization', () => {
  it('builds fallback metadata when candidate is missing', () => {
    const headers = new Headers({ 'X-Demo-Status': 'hit' });
    const normalized = normalizeCacheMetadata({
      cacheCandidate: null,
      headers,
      fallbackFetchedAt: '2026-03-01T00:00:00.000Z',
      resource: 'demo',
      statusFromHeaders,
      sourceFromStatus,
      isStatus,
      isSource
    });

    expect(normalized.status).toBe('hit');
    expect(normalized.source).toBe('edge');
    expect(normalized.ageSeconds).toBe(0);
    expect(normalized.resource).toBe('demo');
  });

  it('normalizes candidate values and falls back per-field when invalid', () => {
    const headers = new Headers({ 'X-Demo-Status': 'miss' });
    const normalized = normalizeCacheMetadata({
      cacheCandidate: {
        status: 'bad-status',
        source: 'bad-source',
        ageSeconds: -10,
        fetchedAt: '2026-03-01T01:00:00.000Z',
        servedAt: 123,
        ttlSeconds: 50,
        key: 99,
        resource: 'custom'
      },
      headers,
      fallbackFetchedAt: '2026-03-01T00:00:00.000Z',
      resource: 'demo',
      statusFromHeaders,
      sourceFromStatus,
      isStatus,
      isSource
    });

    expect(normalized.status).toBe('miss');
    expect(normalized.source).toBe('upstream');
    expect(normalized.ageSeconds).toBe(0);
    expect(normalized.fetchedAt).toBe('2026-03-01T01:00:00.000Z');
    expect(normalized.ttlSeconds).toBe(50);
    expect(normalized.key).toBe('');
    expect(normalized.resource).toBe('custom');
  });

  it('keeps explicitly valid candidate status and source values', () => {
    const normalized = normalizeCacheMetadata({
      cacheCandidate: {
        status: 'hit',
        source: 'edge',
        ageSeconds: 4,
        fetchedAt: '2026-03-01T00:00:00.000Z',
        servedAt: '2026-03-01T00:00:04.000Z',
        ttlSeconds: 30,
        key: 'k',
        resource: 'demo'
      },
      headers: new Headers(),
      fallbackFetchedAt: '2026-03-01T00:00:00.000Z',
      resource: 'demo',
      statusFromHeaders,
      sourceFromStatus,
      isStatus,
      isSource
    });

    expect(normalized.status).toBe('hit');
    expect(normalized.source).toBe('edge');
    expect(normalized.ageSeconds).toBe(4);
    expect(normalized.key).toBe('k');
  });
});
