import { afterEach, describe, expect, it, vi } from 'vitest';
import { airportResourceAdapter } from './airport/adapter';
import { metarResourceAdapter } from './metar/adapter';

describe('resource adapters', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes and serializes metar resource payloads', () => {
    const normalized = metarResourceAdapter.normalizeKey({ icao: ' kjfk ' });
    expect(normalized).toBe('KJFK');

    const envelope = metarResourceAdapter.serialize(
      {
        icao: 'KJFK',
        metarRaw: 'METAR KJFK 021953Z 11010KT 10SM FEW020 08/03 A3012 RMK AO2',
        wind: {
          raw: '11010KT',
          directionType: 'fixed',
          directionDegTrue: 110,
          speedKt: 10,
          gustKt: null
        },
        source: 'aviationweather',
        fetchedAt: '2026-03-03T12:00:00.000Z'
      },
      'v1:metar:KJFK',
      'metar'
    );

    expect(envelope.schemaVersion).toBe(3);
    expect(envelope.resource).toBe('metar');
    expect(envelope.key).toBe('v1:metar:KJFK');
    expect(envelope.cacheMeta.policyVersion).toBe('metar-v1');
    expect(metarResourceAdapter.deserialize(envelope)?.icao).toBe('KJFK');
    expect(metarResourceAdapter.deserialize(envelope)?.wind.directionType).toBe('fixed');
    expect(
      metarResourceAdapter.deserialize({
        icao: 'KJFK',
        metarRaw: 'METAR KJFK 021953Z 11010KT 10SM FEW020 08/03 A3012 RMK AO2',
        source: 'aviationweather',
        fetchedAt: '2026-03-03T12:00:00.000Z'
      })
    ).toBeNull();
  });

  it('parses provider JSON wind objects during validation', async () => {
    const validated = await metarResourceAdapter.validate(
      [
        {
          rawOb: 'METAR KARR 031652Z VRB03KT 4SM HZ OVC013 05/00 A3011 RMK AO2',
          wdir: { repr: 'VRB' },
          wspd: { value: 3 },
          wgst: null
        }
      ],
      { icao: 'KARR' },
      { request: new Request('https://example.com'), env: { METAR_CACHE: { get: async () => null, put: async () => {} } } }
    );

    expect(validated.wind.directionType).toBe('variable');
    expect(validated.wind.speedKt).toBe(3);
    expect(validated.wind.raw).toBe('VRB03KT');
  });

  it('handles calm winds when provider omits explicit wind fields', async () => {
    const validated = await metarResourceAdapter.validate(
      [
        {
          rawOb: 'METAR KJVL 031845Z 0000KT 7SM OVC013 04/M01 A3012'
        }
      ],
      { icao: 'KJVL' },
      { request: new Request('https://example.com'), env: { METAR_CACHE: { get: async () => null, put: async () => {} } } }
    );

    expect(validated.wind.directionType).toBe('calm');
    expect(validated.wind.speedKt).toBe(0);
    expect(validated.wind.gustKt).toBeNull();
    expect(validated.wind.raw).toBe('00000KT');
  });

  it('requires airportdb token for airport fetches', async () => {
    await expect(
      airportResourceAdapter.fetchUpstream(
        { icao: 'KDEN' },
        {
          request: new Request('https://example.com'),
          env: { METAR_CACHE: { get: async () => null, put: async () => {} } }
        }
      )
    ).rejects.toMatchObject({
      message: 'Airport lookup service is not configured.',
      status: 500
    });
  });

  it('maps airport provider auth and not-found responses to stable errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('unauthorized', { status: 401 })));
    await expect(
      airportResourceAdapter.fetchUpstream(
        { icao: 'KDEN' },
        {
          request: new Request('https://example.com'),
          env: { METAR_CACHE: { get: async () => null, put: async () => {} }, AIRPORTDB_API_TOKEN: 'token' }
        }
      )
    ).rejects.toMatchObject({ status: 502, code: 'AUTH_ERROR' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('not-found', { status: 404 })));
    await expect(
      airportResourceAdapter.fetchUpstream(
        { icao: 'ZZZZ' },
        {
          request: new Request('https://example.com'),
          env: { METAR_CACHE: { get: async () => null, put: async () => {} }, AIRPORTDB_API_TOKEN: 'token' }
        }
      )
    ).rejects.toMatchObject({ status: 404, code: 'ICAO_NOT_FOUND' });
  });

  it('maps generic airport provider errors and invalid payloads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('upstream-failure', { status: 503 })));
    await expect(
      airportResourceAdapter.fetchUpstream(
        { icao: 'KJFK' },
        {
          request: new Request('https://example.com'),
          env: { METAR_CACHE: { get: async () => null, put: async () => {} }, AIRPORTDB_API_TOKEN: 'token' }
        }
      )
    ).rejects.toMatchObject({ status: 502, code: 'PROVIDER_ERROR' });

    try {
      airportResourceAdapter.validate(
        null,
        { icao: 'KJFK' },
        {
          request: new Request('https://example.com'),
          env: { METAR_CACHE: { get: async () => null, put: async () => {} }, AIRPORTDB_API_TOKEN: 'token' }
        }
      );
      throw new Error('Expected validation to throw for invalid payload.');
    } catch (error) {
      expect(error).toMatchObject({ status: 502, code: 'PROVIDER_PAYLOAD_INVALID' });
    }
  });

  it('parses runway ends and preserves closed-runway status', async () => {
    const validated = await airportResourceAdapter.validate(
      {
        ident: 'KJFK',
        icao_code: 'KJFK',
        name: 'John F Kennedy International Airport',
        municipality: 'New York',
        iso_country: 'US',
        country: { name: 'United States' },
        elevation_ft: '13',
        runways: [
          {
            closed: '0',
            length_ft: '12079',
            le_ident: '04L',
            he_ident: '22R'
          },
          {
            closed: '1',
            length_ft: '14511',
            le_ident: '13R',
            he_ident: '31L'
          },
          {
            closed: '0',
            length_ft: '12079',
            le_ident: '04L',
            he_ident: '22R'
          }
        ],
        frequencies: [
          { type: 'APP', description: 'NORTH APP', frequency_mhz: '125.7' },
          { type: 'TWR', description: 'KENNEDY TWR', frequency_mhz: '119.1' },
          { type: 'ATIS', description: 'ATIS', frequency_mhz: '128.725' },
          { type: 'ATIS', description: 'ATIS', frequency_mhz: '128.725' },
          { type: 'CTAF', description: 'CTAF', frequency_mhz: '123.0' },
          { type: 'APP', description: 'BROKEN' }
        ]
      },
      { icao: 'KJFK' },
      {
        request: new Request('https://example.com'),
        env: {
          METAR_CACHE: { get: async () => null, put: async () => {} },
          AIRPORTDB_API_TOKEN: 'token'
        }
      }
    );

    expect(validated.requestedIcao).toBe('KJFK');
    expect(validated.icao).toBe('KJFK');
    expect(validated.name).toContain('John F Kennedy');
    expect(validated.countryCode).toBe('US');
    expect(validated.countryName).toBe('United States');
    expect(validated.elevationFt).toBe(13);
    expect(validated.runwayEnds).toEqual([
      { id: '04L', headingDegMag: 40, isClosed: false, lengthFt: 12079 },
      { id: '13R', headingDegMag: 130, isClosed: true, lengthFt: 14511 },
      { id: '22R', headingDegMag: 220, isClosed: false, lengthFt: 12079 },
      { id: '31L', headingDegMag: 310, isClosed: true, lengthFt: 14511 }
    ]);
    expect(validated.frequencies).toEqual([
      { type: 'APP', description: 'NORTH APP', frequencyMhz: '125.7' },
      { type: 'ATIS', description: 'ATIS', frequencyMhz: '128.725' },
      { type: 'CTAF', description: 'CTAF', frequencyMhz: '123.0' },
      { type: 'TWR', description: 'KENNEDY TWR', frequencyMhz: '119.1' }
    ]);
  });

  it('supports airports where all runways are closed', async () => {
    const validated = await airportResourceAdapter.validate(
      {
        ident: 'KHEL',
        runways: [{ closed: '1', le_ident: '13', he_ident: '31' }]
      },
      { icao: 'KHEL' },
      {
        request: new Request('https://example.com'),
        env: {
          METAR_CACHE: { get: async () => null, put: async () => {} },
          AIRPORTDB_API_TOKEN: 'token'
        }
      }
    );

    expect(validated.runwayEnds).toEqual([
      { id: '13', headingDegMag: 130, isClosed: true, lengthFt: null },
      { id: '31', headingDegMag: 310, isClosed: true, lengthFt: null }
    ]);
  });

  it('returns null for malformed cached airport and metar shapes', () => {
    expect(airportResourceAdapter.deserialize(null)).toBeNull();
    expect(airportResourceAdapter.deserialize({ data: { requestedIcao: 'KJFK' } })).toBeNull();
    expect(metarResourceAdapter.deserialize({ data: { icao: 'KJFK', source: 'aviationweather' } })).toBeNull();
  });

  it('deserializes valid cached airport payloads', () => {
    const cached = {
      data: {
        requestedIcao: 'KJFK',
        icao: 'KJFK',
        name: 'John F Kennedy International Airport',
        municipality: 'New York',
        countryCode: 'US',
        countryName: 'United States',
        elevationFt: 13,
        runwayEnds: [
          { id: '04L', headingDegMag: 40, isClosed: false, lengthFt: 12079 }
        ],
        frequencies: [
          { type: 'TWR', description: 'KENNEDY TWR', frequencyMhz: '119.1' }
        ],
        source: 'airportdb',
        fetchedAt: '2026-03-03T12:00:00.000Z'
      }
    };

    const parsed = airportResourceAdapter.deserialize(cached);
    expect(parsed?.icao).toBe('KJFK');
    expect(parsed?.runwayEnds[0]?.id).toBe('04L');
    expect(parsed?.frequencies).toEqual([{ type: 'TWR', description: 'KENNEDY TWR', frequencyMhz: '119.1' }]);
  });

  it('deserializes cached airport payloads without frequencies as an empty list', () => {
    const cached = {
      data: {
        requestedIcao: 'KMSP',
        icao: 'KMSP',
        name: 'Minneapolis-Saint Paul International Airport',
        municipality: 'Minneapolis',
        countryCode: 'US',
        countryName: 'United States',
        elevationFt: 841,
        runwayEnds: [{ id: '12L', headingDegMag: 120, isClosed: false, lengthFt: 10000 }],
        source: 'airportdb',
        fetchedAt: '2026-03-03T12:00:00.000Z'
      }
    };

    const parsed = airportResourceAdapter.deserialize(cached);
    expect(parsed?.icao).toBe('KMSP');
    expect(parsed?.frequencies).toEqual([]);
  });

  it('ignores invalid runway entries and exposes observability labels', async () => {
    const validated = await airportResourceAdapter.validate(
      {
        ident: 'KABC',
        runways: [null, { closed: false, le_ident: '18', he_ident: '36', length_ft: '5000' }]
      },
      { icao: 'KABC' },
      {
        request: new Request('https://example.com'),
        env: {
          METAR_CACHE: { get: async () => null, put: async () => {} },
          AIRPORTDB_API_TOKEN: 'token'
        }
      }
    );

    expect(validated.runwayEnds).toEqual([
      { id: '18', headingDegMag: 180, isClosed: false, lengthFt: 5000 },
      { id: '36', headingDegMag: 360, isClosed: false, lengthFt: 5000 }
    ]);
    expect(validated.countryName).toBe('');

    const labels = airportResourceAdapter.observability({ icao: ' kabc ' }, 'v1:airport:KABC');
    expect(labels.labels).toMatchObject({
      resource: 'airport',
      key: 'v1:airport:KABC',
      icao: 'KABC'
    });
  });

  it('prefers open runway entries over closed duplicates and ignores null runway-end candidates', async () => {
    const validated = await airportResourceAdapter.validate(
      {
        ident: 'KDUP',
        runways: [
          { closed: '1', le_ident: '09', he_ident: '27', length_ft: '4000' },
          { closed: '0', le_ident: '09', he_ident: '27', length_ft: '5000' },
          { closed: '0', le_ident: 'XX', he_ident: null, length_ft: '3000' }
        ]
      },
      { icao: 'KDUP' },
      {
        request: new Request('https://example.com'),
        env: {
          METAR_CACHE: { get: async () => null, put: async () => {} },
          AIRPORTDB_API_TOKEN: 'token'
        }
      }
    );

    expect(validated.runwayEnds).toEqual([
      { id: '09', headingDegMag: 90, isClosed: false, lengthFt: 5000 },
      { id: '27', headingDegMag: 270, isClosed: false, lengthFt: 5000 }
    ]);
  });
});
