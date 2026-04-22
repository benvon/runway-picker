import { describe, expect, it } from 'vitest';
import { AirportLookupError } from '../../services/airportApi';
import { MetarLookupError } from '../../services/metarApi';
import {
  createPrimaryState,
  normalizeIcaoInput,
  runAlternateLookup,
  runPrimaryLookup,
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
      runwayEnds: [{ id: '18', headingDegMag: 180, isClosed: false, lengthFt: 8000 }],
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
    fetchMetarByIcao: async (icao) => ({
      icao,
      metarRaw: `METAR ${icao} 010000Z 18010KT 10SM CLR 10/05 A3000`,
      wind: {
        raw: '18010KT',
        directionType: 'fixed',
        directionDegTrue: 180,
        speedKt: 10,
        gustKt: null
      },
      source: 'aviationweather',
      fetchedAt: '2026-03-01T00:00:00.000Z',
      cache: {
        status: 'upstream_refresh',
        source: 'upstream',
        ageSeconds: 0,
        fetchedAt: '2026-03-01T00:00:00.000Z',
        servedAt: '2026-03-01T00:00:00.000Z',
        ttlSeconds: 1800,
        key: `v1:metar:${icao}`,
        resource: 'metar'
      }
    }),
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
    }
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
  });
});
