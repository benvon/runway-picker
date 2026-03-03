import { describe, expect, it } from 'vitest';
import { evaluateRunways } from '../evaluateRunways';
import type { ParsedWind, RunwayEnd } from '../types';

const runways: RunwayEnd[] = [
  { id: '09', headingDegMag: 90 },
  { id: '27', headingDegMag: 270 }
];

describe('evaluateRunways', () => {
  it('selects best runway by headwind', () => {
    const wind: ParsedWind = {
      raw: '09010KT',
      directionType: 'fixed',
      directionDegTrue: 90,
      speedKt: 10,
      gustKt: null,
      source: 'wind_group'
    };

    const result = evaluateRunways(runways, wind);
    expect(result.bestRunwayId).toBe('09');
  });

  it('handles tie-break by crosswind then alphanumeric', () => {
    const symmetricRunways: RunwayEnd[] = [
      { id: '18L', headingDegMag: 180 },
      { id: '18R', headingDegMag: 180 }
    ];

    const wind: ParsedWind = {
      raw: '18010KT',
      directionType: 'fixed',
      directionDegTrue: 180,
      speedKt: 10,
      gustKt: null,
      source: 'wind_group'
    };

    const result = evaluateRunways(symmetricRunways, wind);
    expect(result.bestRunwayId).toBe('18L');
  });

  it('returns null best runway for variable winds', () => {
    const wind: ParsedWind = {
      raw: 'VRB05KT',
      directionType: 'variable',
      directionDegTrue: null,
      speedKt: 5,
      gustKt: null,
      source: 'wind_group'
    };

    const result = evaluateRunways(runways, wind);
    expect(result.bestRunwayId).toBeNull();
    expect(result.runwayResults[0].sustained).toBeNull();
  });

  it('handles calm winds without error', () => {
    const wind: ParsedWind = {
      raw: '00000KT',
      directionType: 'calm',
      directionDegTrue: null,
      speedKt: 0,
      gustKt: null,
      source: 'wind_group'
    };

    const result = evaluateRunways(runways, wind);
    expect(result.runwayResults).toHaveLength(runways.length);
  });

  it('considers gusts for fixed winds while selecting best runway', () => {
    const wind: ParsedWind = {
      raw: '09010G20KT',
      directionType: 'fixed',
      directionDegTrue: 90,
      speedKt: 10,
      gustKt: 20,
      source: 'wind_group'
    };

    const result = evaluateRunways(runways, wind);

    // Ensure gust components are calculated and present in runway results
    for (const runwayResult of result.runwayResults) {
      expect(runwayResult.gust).not.toBeNull();
    }
    expect(result.bestRunwayId).toBe('09');
  });

  it('never selects a closed runway even if winds favor it', () => {
    const runwaysWithClosed: RunwayEnd[] = [
      { id: '09', headingDegMag: 90, isClosed: true },
      { id: '27', headingDegMag: 270, isClosed: false }
    ];

    const wind: ParsedWind = {
      raw: '09012KT',
      directionType: 'fixed',
      directionDegTrue: 90,
      speedKt: 12,
      gustKt: null,
      source: 'wind_group'
    };

    const result = evaluateRunways(runwaysWithClosed, wind);
    expect(result.bestRunwayId).toBe('27');
    expect(result.runwayResults.find((runway) => runway.runwayId === '09')?.notes).toContain(
      'Runway is closed; excluded from recommendation.'
    );
  });

  it('returns no best runway when all runways are closed', () => {
    const closedRunways: RunwayEnd[] = [
      { id: '09', headingDegMag: 90, isClosed: true },
      { id: '27', headingDegMag: 270, isClosed: true }
    ];

    const wind: ParsedWind = {
      raw: '09010KT',
      directionType: 'fixed',
      directionDegTrue: 90,
      speedKt: 10,
      gustKt: null,
      source: 'wind_group'
    };

    const result = evaluateRunways(closedRunways, wind);
    expect(result.bestRunwayId).toBeNull();
    expect(result.bestReason).toBe('No open runways available for selection.');
  });
});
