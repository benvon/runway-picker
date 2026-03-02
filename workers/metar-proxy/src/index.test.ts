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
    expect(put).not.toHaveBeenCalled();
  });
});
