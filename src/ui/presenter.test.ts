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
    expect(panels.bestRunway.textContent).toContain('Length unavailable');
    expect(panels.bestRunway.textContent).not.toContain('8,000');
    expect(panels.bestRunway.textContent).toContain('Runway recommendation suppressed');
    expect(panels.bestRunway.textContent).toContain('more than 60 minutes old');
    expect(panels.bestRunway.textContent).toContain('↓ 10 kt');
    expect(panels.bestRunway.textContent).not.toContain('Direction variable');
  });

  it('labels computed runway headings as not surveyed in lookup details', () => {
    const resolution = buildResolution();
    resolution.airport.runwayEnds = [
      { id: '18', headingDegTrue: 180, headingSource: 'computed', isClosed: false, lengthFt: 2540 },
      { id: '36', headingDegTrue: 360, headingSource: 'computed', isClosed: false, lengthFt: 2540 }
    ];

    const panels = renderLookupPanels(resolution);
    expect(panels.details.textContent).toContain('Runway heading source:');
    expect(panels.details.textContent).toContain('Computed from runway-end coordinates (not surveyed)');
    expect(panels.details.textContent).toContain('Heading computed from runway-end coordinates (not surveyed).');
  });

  it('names the best runway only when eligibility is satisfied', () => {
    const panels = renderLookupPanels(buildResolution());
    expect(panels.bestRunway.textContent).toContain('Best runway: 18');
    expect(panels.bestRunway.textContent).not.toContain('Runway recommendation suppressed');
  });

  it('shows the selected runway length beneath its identifier', () => {
    const panels = renderLookupPanels(buildResolution());
    const identifier = panels.bestRunway.querySelector('.best-runway-identifier');
    const length = panels.bestRunway.querySelector('.best-runway-length');

    expect(identifier?.textContent).toBe('Best runway: 18');
    expect(length?.textContent).toBe('Length: 8,000 ft');
    expect(identifier?.compareDocumentPosition(length as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('shows Length unavailable when the selected runway length is missing or invalid', () => {
    const missing = buildResolution();
    missing.airport.runwayEnds = [{ id: '18', headingDegTrue: 180, isClosed: false, lengthFt: null }];
    expect(renderLookupPanels(missing).bestRunway.querySelector('.best-runway-length')?.textContent).toBe(
      'Length unavailable'
    );

    const invalid = buildResolution();
    invalid.airport.runwayEnds = [{ id: '18', headingDegTrue: 180, isClosed: false, lengthFt: Number.NaN }];
    const invalidLength = renderLookupPanels(invalid).bestRunway.querySelector('.best-runway-length');
    expect(invalidLength?.textContent).toBe('Length unavailable');
    expect(invalidLength?.textContent).not.toContain('NaN');

    const nonPositive = buildResolution();
    nonPositive.airport.runwayEnds = [{ id: '18', headingDegTrue: 180, isClosed: false, lengthFt: 0 }];
    expect(renderLookupPanels(nonPositive).bestRunway.querySelector('.best-runway-length')?.textContent).toBe(
      'Length unavailable'
    );
  });

  it('updates the displayed length when the selected runway changes', () => {
    const first = renderLookupPanels(buildResolution());
    expect(first.bestRunway.querySelector('.best-runway-length')?.textContent).toBe('Length: 8,000 ft');

    const next = buildResolution();
    next.airport.runwayEnds = [
      { id: '18', headingDegTrue: 180, isClosed: false, lengthFt: 8000 },
      { id: '36', headingDegTrue: 360, isClosed: false, lengthFt: 6500 }
    ];
    next.metar.wind = {
      raw: '36012KT',
      directionType: 'fixed',
      directionDegTrue: 360,
      directionVariation: null,
      speedKt: 12,
      gustKt: null
    };
    next.metar.metarRaw = 'METAR KJFK 010000Z 36012KT 10SM CLR 10/05 A3000';

    const second = renderLookupPanels(next);
    expect(second.bestRunway.querySelector('.best-runway-identifier')?.textContent).toBe('Best runway: 36');
    expect(second.bestRunway.querySelector('.best-runway-length')?.textContent).toBe('Length: 6,500 ft');
    expect(second.bestRunway.textContent).not.toContain('8,000');
  });

  it('shows unavailable METAR cache provenance without presenting it as a timestamp', () => {
    const resolution = buildResolution({
      allowed: false,
      reasons: ['METAR_OBSERVATION_TIME_UNAVAILABLE'],
      observationAgeMinutes: null
    });
    resolution.metar.cache.servedAt = null;

    const panels = renderLookupPanels(resolution);
    expect(panels.details.textContent).toContain('METAR cache served at: not provided');
    expect(panels.details.textContent).not.toContain('METAR cache served at: null');
  });

  it('shows the verified alternate METAR source and distance beside an allowed recommendation', () => {
    const resolution = buildResolution({ alternateDistanceNm: 12 });
    resolution.weatherSourceIcao = 'KLGA';

    const panels = renderLookupPanels(resolution);
    expect(panels.bestRunway.textContent).toContain('Using METAR from KLGA, 12 NM from KJFK.');
  });
});
