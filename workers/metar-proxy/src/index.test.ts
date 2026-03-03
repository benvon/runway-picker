import { describe, expect, it, vi } from 'vitest';
import { extractMetarRaw, handleMetarRequest, MetarWorkerError, normalizeIcao } from './index';

describe('metar worker helpers', () => {
  it('normalizes ICAO values', () => {
    expect(normalizeIcao(' kjfk ')).toBe('KJFK');
  });

  it('rejects invalid ICAO values', () => {
    expect(() => normalizeIcao('ABC')).toThrow(MetarWorkerError);
  });

  it('extracts METAR line from provider payload', () => {
    const payload = '\nMETAR KMCI 021953Z 11010KT 7SM OVC008 04/02 A3014 RMK AO2\n';
    expect(extractMetarRaw(payload)).toBe('METAR KMCI 021953Z 11010KT 7SM OVC008 04/02 A3014 RMK AO2');
  });

  it('returns cached response on KV hit', async () => {
    const get = vi.fn().mockResolvedValue({
      icao: 'KMCI',
      metarRaw: 'METAR KMCI 021953Z 11010KT 7SM OVC008 04/02 A3014 RMK AO2',
      source: 'aviationweather',
      fetchedAt: '2026-03-02T00:00:00.000Z'
    });

    const put = vi.fn();

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KMCI'), {
      METAR_CACHE: { get, put }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Cache')).toBe('HIT');
    expect(response.headers.get('Cache-Control')).toContain('s-maxage=1800');
    expect(put).not.toHaveBeenCalled();
  });

  it('sets Cache-Control: no-store on error responses', async () => {
    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=ABC'), {
      METAR_CACHE: { get: vi.fn().mockResolvedValue(null), put: vi.fn() }
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns user-friendly message when ICAO is not found by provider', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        .mockResolvedValueOnce(Response.json([]))
    );

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=ZZZZ'), {
      METAR_CACHE: { get: vi.fn().mockResolvedValue(null), put: vi.fn() }
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'ICAO code ZZZZ was not found. Check the code and try again.'
    });
    vi.unstubAllGlobals();
  });

  it('returns user-friendly message when METAR is unavailable for valid ICAO', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        .mockResolvedValueOnce(Response.json([{ icaoId: 'KJFK' }]))
    );

    const response = await handleMetarRequest(new Request('https://metar.internal/api/metar?icao=KJFK'), {
      METAR_CACHE: { get: vi.fn().mockResolvedValue(null), put: vi.fn() }
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'No METAR is currently available for ICAO KJFK. Try again later.'
    });
    vi.unstubAllGlobals();
  });
});
