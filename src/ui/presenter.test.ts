// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { LookupResolution } from '../application/lookup/useCase';
import { renderLookupPanels } from './presenter';

function buildResolution(overrides?: Partial<LookupResolution['recommendation']>): LookupResolution {
  const now = new Date().toISOString();
  return {
    airport: {
      requestedIcao: 'KJFK', icao: 'KJFK', name: 'Test Airport', municipality: '', countryCode: 'US', countryName: 'United States',
      elevationFt: null, coordinates: { latitudeDeg: 40.6, longitudeDeg: -73.8 },
      runwayEnds: [{ id: '18', headingDegTrue: 180, isClosed: false, lengthFt: 8000 }], frequencies: [], source: 'airportdb', fetchedAt: now,
      cache: { status: 'upstream_refresh', source: 'upstream', ageSeconds: 0, fetchedAt: now, servedAt: now, ttlSeconds: 86400, key: 'v1:airport:KJFK', resource: 'airport' }
    },
    metar: {
      icao: 'KJFK', metarRaw: 'METAR KJFK 010000Z 18010KT 10SM CLR 10/05 A3000',
      wind: { raw: '18010KT', directionType: 'fixed', directionDegTrue: 180, directionVariation: null, speedKt: 10, gustKt: null },
      source: 'aviationweather', fetchedAt: now, observedAt: now,
      cache: { status: 'upstream_refresh', source: 'upstream', ageSeconds: 0, fetchedAt: now, servedAt: now, ttlSeconds: 1800, key: 'v1:metar:KJFK', resource: 'metar' }
    },
    runwaySourceIcao: 'KJFK', weatherSourceIcao: 'KJFK',
    recommendation: { allowed: true, reasons: [], observationAgeMinutes: 0, alternateDistanceNm: null, ...overrides }
  };
}

describe('lookup presentation safety', () => {
  it('suppresses the runway name and prominently explains when a recommendation is unsafe', () => {
    const panels = renderLookupPanels(buildResolution({
      allowed: false,
      reasons: ['METAR_OBSERVATION_TOO_OLD'],
      observationAgeMinutes: 61
    }));

    expect(panels.bestRunway.textContent).toContain('Best runway: Not determinable');
    expect(panels.bestRunway.textContent).toContain('Runway recommendation suppressed');
    expect(panels.bestRunway.textContent).toContain('more than 60 minutes old');
    expect(panels.bestRunway.textContent).toContain('↓ 10 kt');
    expect(panels.bestRunway.textContent).not.toContain('Direction variable');
  });

  it('names the best runway only when eligibility is satisfied', () => {
    const panels = renderLookupPanels(buildResolution());
    expect(panels.bestRunway.textContent).toContain('Best runway: 18');
    expect(panels.bestRunway.textContent).not.toContain('Runway recommendation suppressed');
  });

  it('shows the verified alternate METAR source and distance beside an allowed recommendation', () => {
    const resolution = buildResolution({ alternateDistanceNm: 12 });
    resolution.weatherSourceIcao = 'KLGA';

    const panels = renderLookupPanels(resolution);
    expect(panels.bestRunway.textContent).toContain('Using METAR from KLGA, 12 NM from KJFK.');
  });
});
