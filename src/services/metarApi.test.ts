import { describe, expect, it, vi } from 'vitest';
import { fetchMetarByIcao, MetarLookupError } from './metarApi';

describe('metarApi service', () => {
  it('rejects invalid ICAO values', async () => {
    await expect(fetchMetarByIcao('KSF')).rejects.toBeInstanceOf(MetarLookupError);
  });

  it('calls local API and returns payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          icao: 'KJFK',
          metarRaw: 'METAR KJFK 022051Z 12008KT 10SM FEW040 05/M02 A3016',
          source: 'aviationweather',
          fetchedAt: '2026-03-02T00:00:00.000Z'
        })
      )
    );

    const payload = await fetchMetarByIcao('kjfk');
    expect(fetch).toHaveBeenCalledWith('/api/metar?icao=KJFK', {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    expect(payload.icao).toBe('KJFK');
    vi.unstubAllGlobals();
  });
});
