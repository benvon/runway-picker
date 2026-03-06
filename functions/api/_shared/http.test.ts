import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApiError, buildProxyResponse, createRequestId, extractClientIp } from './http';

describe('shared HTTP helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates request IDs from crypto when available', () => {
    const id = createRequestId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('falls back to timestamp-random request IDs when crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    const id = createRequestId();
    expect(id).toMatch(/^\d+-[a-z0-9]+$/);
  });

  it('builds API error responses with security headers and request id', async () => {
    const response = buildApiError('Bad input', 400, 'INVALID_INPUT', 'req-123');
    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Request-Id')).toBe('req-123');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');

    await expect(response.json()).resolves.toMatchObject({
      error: 'Bad input',
      code: 'INVALID_INPUT',
      requestId: 'req-123'
    });
  });

  it('builds proxy responses and preserves allowed upstream headers', async () => {
    const upstream = new Response(JSON.stringify({ ok: true }), {
      status: 202,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=10',
        'X-Runway-Cache-Status': 'kv_hit',
        'X-Request-Id': 'upstream-req'
      }
    });
    const response = buildProxyResponse(upstream, 'fallback-req');

    expect(response.status).toBe(202);
    expect(response.headers.get('X-Request-Id')).toBe('upstream-req');
    expect(response.headers.get('X-Runway-Cache-Status')).toBe('kv_hit');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it('injects request id when upstream proxy response omits one', () => {
    const upstream = new Response('ok', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain'
      }
    });
    const response = buildProxyResponse(upstream, 'generated-req');
    expect(response.headers.get('X-Request-Id')).toBe('generated-req');
  });

  it('extracts client IP from CF-Connecting-IP or X-Forwarded-For', () => {
    const cfRequest = new Request('https://example.com', {
      headers: { 'CF-Connecting-IP': '203.0.113.1' }
    });
    expect(extractClientIp(cfRequest)).toBe('203.0.113.1');

    const forwardedRequest = new Request('https://example.com', {
      headers: { 'X-Forwarded-For': '198.51.100.20, 203.0.113.42' }
    });
    expect(extractClientIp(forwardedRequest)).toBe('203.0.113.42');
  });

  it('returns null when client IP headers are missing or invalid', () => {
    const invalid = new Request('https://example.com', {
      headers: {
        'CF-Connecting-IP': 'not-an-ip',
        'X-Forwarded-For': 'also-bad'
      }
    });
    expect(extractClientIp(invalid)).toBeNull();

    const missing = new Request('https://example.com');
    expect(extractClientIp(missing)).toBeNull();
  });
});
