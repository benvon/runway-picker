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
});
