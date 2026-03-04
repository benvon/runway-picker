import { describe, expect, it } from 'vitest';
import { onRequestGet } from './health';

describe('pages health endpoint', () => {
  it('returns 200 with status, service, timestamp, and requestId', async () => {
    const response = await onRequestGet({
      request: new Request('https://example.com/api/health'),
      env: {},
      params: {},
      data: {},
      waitUntil: () => {},
      next: async () => new Response('')
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; service: string; timestamp: string; requestId: string };
    expect(body).toMatchObject({
      status: 'ok',
      service: 'runway-picker',
      requestId: expect.any(String)
    });
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('includes X-Request-Id and security headers', async () => {
    const response = await onRequestGet({
      request: new Request('https://example.com/api/health'),
      env: {},
      params: {},
      data: {},
      waitUntil: () => {},
      next: async () => new Response('')
    });

    expect(response.headers.get('X-Request-Id')).toEqual(expect.any(String));
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Permissions-Policy')).toBe('geolocation=(), microphone=(), camera=()');
    expect(response.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
