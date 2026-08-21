import { describe, expect, it } from 'vitest';
import { AirportLookupError } from '../../services/airportApi';
import { MetarLookupError } from '../../services/metarApi';
import {
  createPrimaryState,
  normalizeIcaoInput,
  runAlternateLookup,
  runPrimaryLookup,
  MAX_ALTERNATE_METAR_DISTANCE_NM,
  type LookupGateway
} from './useCase';

function buildGateway(overrides?: Partial<LookupGateway>): LookupGateway {
  return {
    fetchAirportByIcao: async (icao) => ({
      requestedIcao: icao,
      icao,
      name: `${icao} Airport`,
      municipality: '',
      countryCode: 'US',
      countryName: 'United States',
      elevationFt: null,
      coordinates: { latitudeDeg: 39.1, longitudeDeg: -94.6 },
      runwayEnds: [{ id: '18', headingDegTrue: 180, isClosed: false, lengthFt: 8000 }],
      frequencies: [],
      source: 'airportdb',
      fetchedAt: '2026-03-01T00:00:00.000Z',
      cache: {
        status: 'upstream_refresh',
        source: 'upstream',
        ageSeconds: 0,
        fetchedAt: '2026-03-01T00:00:00.000Z',
        servedAt: '2026-03-01T00:00:00.000Z',
        ttlSeconds: 86400,
        key: `v1:airport:${icao}`,
        resource: 'airport'
      }
    }),
    fetchAirportCoordinatesByIcao: async (icao) => ({
      icao,
      coordinates: { latitudeDeg: 39.1, longitudeDeg: -94.6 }
    }),
    fetchMetarByIcao: async (icao) => {
      const servedAt = new Date().toISOString();
      return {
      icao,
      metarRaw: `METAR ${icao} 010000Z 18010KT 10SM CLR 10/05 A3000`,
      wind: {
        raw: '18010KT',
        directionType: 'fixed',
        directionDegTrue: 180,
        directionVariation: null,
        speedKt: 10,
        gustKt: null
      },
      source: 'aviationweather',
      fetchedAt: '2026-03-01T00:00:00.000Z',
      observedAt: servedAt,
      cache: {
        status: 'upstream_refresh',
        source: 'upstream',
        ageSeconds: 0,
        fetchedAt: '2026-03-01T00:00:00.000Z',
        servedAt,
        ttlSeconds: 1800,
        key: `v1:metar:${icao}`,
        resource: 'metar'
      }
      };
    },
    ...overrides
  };
}

describe('lookup use case', () => {
  it('normalizes ICAO input', () => {
    expect(normalizeIcaoInput(' kjfk ')).toBe('KJFK');
  });

  it('returns success for primary lookup', async () => {
    const result = await runPrimaryLookup('KJFK', buildGateway());
    expect(result.type).toBe('success');
    if (result.type === 'success') {
      expect(result.state.stage).toBe('primary');
      expect(result.resolution.weatherSourceIcao).toBe('KJFK');
      expect(result.resolution.recommendation.allowed).toBe(true);
    }
  });

  it('suppresses a recommendation for stale-cache and old METAR observations', async () => {
    const gateway = buildGateway({
      fetchMetarByIcao: async (icao) => ({
        icao,
        metarRaw: `METAR ${icao} 010000Z 18010KT 10SM CLR 10/05 A3000`,
        wind: { raw: '18010KT', directionType: 'fixed', directionDegTrue: 180, directionVariation: null, speedKt: 10, gustKt: null },
        source: 'aviationweather',
        fetchedAt: new Date().toISOString(),
        observedAt: new Date(Date.now() - 61 * 60_000).toISOString(),
        cache: {
          status: 'stale_on_error', source: 'stale', ageSeconds: 3600, fetchedAt: new Date().toISOString(),
          servedAt: new Date().toISOString(), ttlSeconds: 1800, key: `v1:metar:${icao}`, resource: 'metar'
        }
      })
    });

    const result = await runPrimaryLookup('KJFK', gateway);
    if (result.type !== 'success') {
      throw new Error('Expected a successful lookup.');
    }

    expect(result.resolution.recommendation).toMatchObject({
      allowed: false,
      observationAgeMinutes: 61,
      reasons: expect.arrayContaining(['STALE_METAR_CACHE', 'METAR_OBSERVATION_TOO_OLD'])
    });
    expect(result.resolution.recommendation.reasons).not.toContain('METAR_CACHE_PROVENANCE_UNAVAILABLE');
  });

  it('allows the 60-minute recency boundary but rejects observations just beyond it', async () => {
    const servedAt = new Date().toISOString();
    const gateway = buildGateway({
      fetchMetarByIcao: async (icao) => ({
        icao, metarRaw: `METAR ${icao} 010000Z 18010KT 10SM CLR 10/05 A3000`,
        wind: { raw: '18010KT', directionType: 'fixed', directionDegTrue: 180, directionVariation: null, speedKt: 10, gustKt: null },
        source: 'aviationweather', fetchedAt: servedAt, observedAt: new Date(Date.parse(servedAt) - 60 * 60_000).toISOString(),
        cache: { status: 'upstream_refresh', source: 'upstream', ageSeconds: 0, fetchedAt: servedAt, servedAt, ttlSeconds: 1800, key: `v1:metar:${icao}`, resource: 'metar' }
      })
    });
    const atBoundary = await runPrimaryLookup('KJFK', gateway);
    if (atBoundary.type !== 'success') {
      throw new Error('Expected a successful lookup.');
    }
    expect(atBoundary.resolution.recommendation.allowed).toBe(true);

    const justOverBoundary = await runPrimaryLookup('KJFK', buildGateway({
      fetchMetarByIcao: async (icao) => ({
        ...(await gateway.fetchMetarByIcao(icao)),
        observedAt: new Date(Date.parse(servedAt) - 60 * 60_000 - 1).toISOString()
      })
    }));
    if (justOverBoundary.type !== 'success') {
      throw new Error('Expected a successful lookup.');
    }
    expect(justOverBoundary.resolution.recommendation.reasons).toContain('METAR_OBSERVATION_TOO_OLD');

    const missingTime = await runPrimaryLookup('KJFK', buildGateway({
      fetchMetarByIcao: async (icao) => ({
        ...(await gateway.fetchMetarByIcao(icao)), observedAt: null
      })
    }));
    if (missingTime.type !== 'success') {
      throw new Error('Expected a successful lookup.');
    }
    expect(missingTime.resolution.recommendation.reasons).toContain('METAR_OBSERVATION_TIME_UNAVAILABLE');
  });

  it('uses the Worker-provided served timestamp instead of the device clock for observation age', async () => {
    const servedAt = '2026-03-03T12:00:00.000Z';
    const result = await runPrimaryLookup('KJFK', buildGateway({
      fetchMetarByIcao: async (icao) => ({
        ...(await buildGateway().fetchMetarByIcao(icao)),
        observedAt: '2026-03-03T10:40:00.000Z',
        cache: {
          status: 'upstream_refresh', source: 'upstream', ageSeconds: 0, fetchedAt: servedAt,
          servedAt, ttlSeconds: 1800, key: `v1:metar:${icao}`, resource: 'metar'
        }
      })
    }));
    if (result.type !== 'success') {
      throw new Error('Expected a successful lookup.');
    }

    expect(result.resolution.recommendation).toMatchObject({
      allowed: false,
      observationAgeMinutes: 80,
      reasons: ['METAR_OBSERVATION_TOO_OLD']
    });
  });

  it('suppresses a recommendation when the worker cache provenance is unavailable', async () => {
    const gateway = buildGateway();
    const metar = await gateway.fetchMetarByIcao('KJFK');
    const result = await runPrimaryLookup('KJFK', buildGateway({
      fetchMetarByIcao: async () => ({
        ...metar,
        cache: {
          ...metar.cache,
          status: 'unknown',
          source: 'unknown',
          servedAt: null
        }
      })
    }));
    if (result.type !== 'success') {
      throw new Error('Expected a successful lookup.');
    }

    expect(result.resolution.recommendation).toMatchObject({
      allowed: false,
      observationAgeMinutes: null,
      reasons: expect.arrayContaining([
        'METAR_CACHE_PROVENANCE_UNAVAILABLE',
        'METAR_OBSERVATION_TIME_UNAVAILABLE'
      ])
    });
  });

  it('returns alternate prompt when METAR is unavailable', async () => {
    const gateway = buildGateway({
      fetchMetarByIcao: async () => {
        throw new MetarLookupError('No METAR available.', 404, undefined, 'METAR_UNAVAILABLE');
      }
    });

    const result = await runPrimaryLookup('KJFK', gateway);
    expect(result.type).toBe('prompt-alternate');
    if (result.type === 'prompt-alternate') {
      expect(result.state.stage).toBe('alternate-metar');
      expect(result.message).toContain('No METAR is currently available for ICAO KJFK');
    }
  });

  it('throws friendly airport-not-found message for invalid airport lookup', async () => {
    const gateway = buildGateway({
      fetchAirportByIcao: async () => {
        throw new AirportLookupError('not found', 404, 'ICAO_NOT_FOUND');
      }
    });

    await expect(runPrimaryLookup('KXYZ', gateway)).rejects.toThrow(
      "We couldn't find airport KXYZ. Check the code and try again."
    );
  });

  it('throws when alternate lookup is attempted without primary state context', async () => {
    await expect(
      runAlternateLookup(createPrimaryState(), 'KLGA', buildGateway())
    ).rejects.toThrow('Primary airport context is missing. Submit a primary ICAO code first.');
  });

  it('returns success for alternate lookup using existing primary airport context', async () => {
    const primary = await runPrimaryLookup(
      'KJFK',
      buildGateway({
        fetchMetarByIcao: async () => {
          throw new MetarLookupError('No METAR available.', 404, undefined, 'METAR_UNAVAILABLE');
        }
      })
    );

    if (primary.type !== 'prompt-alternate') {
      throw new Error('Expected alternate prompt state.');
    }

    const alternate = await runAlternateLookup(primary.state, 'KLGA', buildGateway());
    expect(alternate.type).toBe('success');
    expect(alternate.resolution.runwaySourceIcao).toBe('KJFK');
    expect(alternate.resolution.weatherSourceIcao).toBe('KLGA');
    expect(alternate.resolution.recommendation.allowed).toBe(true);
  });

  it('uses a coordinate-only alternate lookup when the weather station has no runway data', async () => {
    const primaryGateway = buildGateway({
      fetchMetarByIcao: async () => {
        throw new MetarLookupError('No METAR available.', 404, undefined, 'METAR_UNAVAILABLE');
      }
    });
    const primary = await runPrimaryLookup('KJFK', primaryGateway);
    if (primary.type !== 'prompt-alternate') {
      throw new Error('Expected alternate prompt state.');
    }

    const alternate = await runAlternateLookup(primary.state, 'KLOC', buildGateway({
      fetchAirportByIcao: async (icao) => {
        if (icao === 'KLOC') {
          throw new AirportLookupError('No runway data.', 404, 'RUNWAY_DATA_UNAVAILABLE');
        }
        return buildGateway().fetchAirportByIcao(icao);
      },
      fetchAirportCoordinatesByIcao: async () => ({
        icao: 'KLOC',
        coordinates: { latitudeDeg: 39.2, longitudeDeg: -94.7 }
      }),
      fetchMetarByIcao: async () => ({
        ...(await buildGateway().fetchMetarByIcao('KLOC')),
        icao: 'KLOC'
      })
    }));

    expect(alternate.resolution.recommendation.allowed).toBe(true);
    expect(alternate.resolution.recommendation.alternateDistanceNm).not.toBeNull();
  });

  it('suppresses an alternate-station recommendation beyond the proximity limit', async () => {
    const primary = await runPrimaryLookup(
      'KJFK',
      buildGateway({
        fetchMetarByIcao: async () => {
          throw new MetarLookupError('No METAR available.', 404, undefined, 'METAR_UNAVAILABLE');
        }
      })
    );
    if (primary.type !== 'prompt-alternate') {
      throw new Error('Expected alternate prompt state.');
    }

    const gateway = buildGateway({
      fetchAirportCoordinatesByIcao: async (icao) => ({
        icao,
        coordinates: icao === 'PHNL' ? { latitudeDeg: 21.3, longitudeDeg: -157.9 } : { latitudeDeg: 40.6, longitudeDeg: -73.8 }
      }),
      fetchMetarByIcao: async () => ({
        icao: 'PHNL', metarRaw: 'METAR PHNL 010000Z 18010KT 10SM CLR 10/05 A3000',
        wind: { raw: '18010KT', directionType: 'fixed', directionDegTrue: 180, directionVariation: null, speedKt: 10, gustKt: null },
        source: 'aviationweather', fetchedAt: new Date().toISOString(), observedAt: new Date().toISOString(),
        cache: { status: 'upstream_refresh', source: 'upstream', ageSeconds: 0, fetchedAt: new Date().toISOString(), servedAt: new Date().toISOString(), ttlSeconds: 1800, key: 'v1:metar:PHNL', resource: 'metar' }
      })
    });

    const alternate = await runAlternateLookup(primary.state, 'PHNL', gateway);
    expect(alternate.resolution.recommendation.allowed).toBe(false);
    expect(alternate.resolution.recommendation.alternateDistanceNm).toBeGreaterThan(MAX_ALTERNATE_METAR_DISTANCE_NM);
    expect(alternate.resolution.recommendation.reasons).toContain('ALTERNATE_STATION_TOO_FAR');
  });

  it('suppresses an alternate-station recommendation when its location cannot be verified', async () => {
    const primary = await runPrimaryLookup(
      'KJFK',
      buildGateway({ fetchMetarByIcao: async () => { throw new MetarLookupError('No METAR available.', 404, undefined, 'METAR_UNAVAILABLE'); } })
    );
    if (primary.type !== 'prompt-alternate') {
      throw new Error('Expected alternate prompt state.');
    }

    const alternate = await runAlternateLookup(primary.state, 'KLGA', buildGateway({
      fetchAirportCoordinatesByIcao: async () => {
        throw new AirportLookupError('station unavailable', 502, 'PROVIDER_ERROR');
      }
    }));
    expect(alternate.resolution.recommendation.reasons).toContain('ALTERNATE_STATION_LOCATION_UNAVAILABLE');
  });
});
