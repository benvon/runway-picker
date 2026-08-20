import { describe, expect, it } from 'vitest';
import { evaluateRunways } from '../evaluateRunways';
import type { ParsedWind, RunwayEnd } from '../types';

const runways: RunwayEnd[] = [
  { id: '09', headingDegTrue: 90 },
  { id: '27', headingDegTrue: 270 }
];

describe('evaluateRunways', () => {
  it('selects best runway by headwind', () => {
    const wind: ParsedWind = {
      raw: '09010KT',
      directionType: 'fixed',
      directionDegTrue: 90,
      directionVariation: null,
      speedKt: 10,
      gustKt: null,
      source: 'wind_group'
    };

    const result = evaluateRunways(runways, wind);
    expect(result.bestRunwayId).toBe('09');
  });

  it('uses the true runway heading instead of its magnetic designator heading', () => {
    const result = evaluateRunways(
      [{ id: '09', headingDegTrue: 100 }],
      {
        raw: '10010KT',
        directionType: 'fixed',
        directionDegTrue: 100,
        directionVariation: null,
        speedKt: 10,
        gustKt: null,
        source: 'metar'
      }
    );

    expect(result.runwayResults[0]?.sustained).toMatchObject({ headwindKt: 10, crosswindKt: 0 });
  });

  it('shows sector component extremes and withholds a recommendation when the sector changes the best runway', () => {
    const result = evaluateRunways(
      [
        { id: '18', headingDegTrue: 180 },
        { id: '27', headingDegTrue: 270 }
      ],
      {
        raw: '22015G25KT 180V260',
        directionType: 'fixed',
        directionDegTrue: 220,
        directionVariation: { fromDegTrue: 180, toDegTrue: 260 },
        speedKt: 15,
        gustKt: 25,
        source: 'metar'
      }
    );

    expect(result.bestRunwayId).toBeNull();
    expect(result.bestReason).toContain('no deterministic recommendation');
    expect(result.runwayResults[0]?.sustainedRange).toEqual({
      minimumHeadwindKt: 3,
      maximumHeadwindKt: 15,
      minimumCrosswindKt: 0,
      maximumCrosswindKt: 15
    });
    expect(result.runwayResults[0]?.gustRange?.maximumCrosswindKt).toBe(25);
  });

  it('includes directional sectors that cross true north when calculating extremes', () => {
    const result = evaluateRunways(
      [{ id: '36', headingDegTrue: 360 }],
      {
        raw: '01020KT 350V020',
        directionType: 'fixed',
        directionDegTrue: 10,
        directionVariation: { fromDegTrue: 350, toDegTrue: 20 },
        speedKt: 20,
        gustKt: null,
        source: 'metar'
      }
    );

    expect(result.runwayResults[0]?.sustainedRange).toEqual({
      minimumHeadwindKt: 19,
      maximumHeadwindKt: 20,
      minimumCrosswindKt: 0,
      maximumCrosswindKt: 7
    });
  });

  it('handles tie-break by crosswind then alphanumeric', () => {
    const symmetricRunways: RunwayEnd[] = [
      { id: '18L', headingDegTrue: 180 },
      { id: '18R', headingDegTrue: 180 }
    ];

    const wind: ParsedWind = {
      raw: '18010KT',
      directionType: 'fixed',
      directionDegTrue: 180,
      directionVariation: null,
      speedKt: 10,
      gustKt: null,
      source: 'wind_group'
    };

    const result = evaluateRunways(symmetricRunways, wind);
    expect(result.bestRunwayId).toBe('18L');
  });

  it('uses runway length tie-break when wind components are equal', () => {
    const sameHeadingRunways: RunwayEnd[] = [
      { id: '18L', headingDegTrue: 180, lengthFt: 7000 },
      { id: '18R', headingDegTrue: 180, lengthFt: 9000 }
    ];

    const wind: ParsedWind = {
      raw: '18010KT',
      directionType: 'fixed',
      directionDegTrue: 180,
      directionVariation: null,
      speedKt: 10,
      gustKt: null,
      source: 'wind_group'
    };

    const result = evaluateRunways(sameHeadingRunways, wind);
    expect(result.bestRunwayId).toBe('18R');
  });

  it('uses smallest runway number when wind and length tie', () => {
    const equalRunways: RunwayEnd[] = [
      { id: '09', headingDegTrue: 90, lengthFt: 8000 },
      { id: '27', headingDegTrue: 270, lengthFt: 8000 }
    ];

    const wind: ParsedWind = {
      raw: '00000KT',
      directionType: 'calm',
      directionDegTrue: null,
      directionVariation: null,
      speedKt: 0,
      gustKt: null,
      source: 'wind_group'
    };

    const result = evaluateRunways(equalRunways, wind);
    expect(result.bestRunwayId).toBe('09');
  });

  it('returns null best runway for variable winds', () => {
    const wind: ParsedWind = {
      raw: 'VRB05KT',
      directionType: 'variable',
      directionDegTrue: null,
      directionVariation: null,
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
      directionVariation: null,
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
      directionVariation: null,
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
      { id: '09', headingDegTrue: 90, isClosed: true },
      { id: '27', headingDegTrue: 270, isClosed: false }
    ];

    const wind: ParsedWind = {
      raw: '09012KT',
      directionType: 'fixed',
      directionDegTrue: 90,
      directionVariation: null,
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
      { id: '09', headingDegTrue: 90, isClosed: true },
      { id: '27', headingDegTrue: 270, isClosed: true }
    ];

    const wind: ParsedWind = {
      raw: '09010KT',
      directionType: 'fixed',
      directionDegTrue: 90,
      directionVariation: null,
      speedKt: 10,
      gustKt: null,
      source: 'wind_group'
    };

    const result = evaluateRunways(closedRunways, wind);
    expect(result.bestRunwayId).toBeNull();
    expect(result.bestReason).toBe('No open runways available for selection.');
  });
});
