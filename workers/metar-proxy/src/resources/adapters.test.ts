import { describe, expect, it } from 'vitest';
import { airportResourceAdapter } from './airport/adapter';
import { metarResourceAdapter } from './metar/adapter';

describe('resource adapters', () => {
  it('normalizes and serializes metar resource payloads', () => {
    const normalized = metarResourceAdapter.normalizeKey({ icao: ' kjfk ' });
    expect(normalized).toBe('KJFK');

    const envelope = metarResourceAdapter.serialize(
      {
        icao: 'KJFK',
        metarRaw: 'METAR KJFK 021953Z 11010KT 10SM FEW020 08/03 A3012 RMK AO2',
        source: 'aviationweather',
        fetchedAt: '2026-03-03T12:00:00.000Z'
      },
      'v1:metar:KJFK',
      'metar'
    );

    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.resource).toBe('metar');
    expect(envelope.key).toBe('v1:metar:KJFK');
    expect(envelope.cacheMeta.policyVersion).toBe('metar-v1');
    expect(metarResourceAdapter.deserialize(envelope)?.icao).toBe('KJFK');
    expect(
      metarResourceAdapter.deserialize({
        icao: 'KJFK',
        metarRaw: 'METAR KJFK 021953Z 11010KT 10SM FEW020 08/03 A3012 RMK AO2',
        source: 'aviationweather',
        fetchedAt: '2026-03-03T12:00:00.000Z'
      })
    ).toBeNull();
  });

  it('provides airport adapter contract while upstream implementation is pending', async () => {
    const normalized = airportResourceAdapter.normalizeKey({ icao: ' kden ' });
    expect(normalized).toBe('KDEN');

    await expect(airportResourceAdapter.fetchUpstream({ icao: 'KDEN' }, { request: new Request('https://example.com') })).rejects.toThrow(
      'Airport adapter upstream fetch is not implemented yet.'
    );

    expect(() => airportResourceAdapter.validate({}, { icao: 'KDEN' }, { request: new Request('https://example.com') })).toThrow(
      'Airport adapter validation is not implemented yet.'
    );
  });
});
