import { describe, expect, it } from 'vitest';
import { MetarValidationError, parseWindInput } from '../metarParser';

describe('metarParser', () => {
  it('extracts wind from a full METAR', () => {
    const parsed = parseWindInput('KJFK 021651Z 22012G20KT 10SM CLR 07/M01 A3012');
    expect(parsed.wind).toMatchObject({
      raw: '22012G20KT',
      directionType: 'fixed',
      directionDegTrue: 220,
      speedKt: 12,
      gustKt: 20,
      source: 'metar'
    });
  });

  it('parses a standalone wind group', () => {
    const parsed = parseWindInput('18008KT');
    expect(parsed.wind).toMatchObject({
      raw: '18008KT',
      directionType: 'fixed',
      directionDegTrue: 180,
      speedKt: 8,
      gustKt: null,
      source: 'wind_group'
    });
  });

  it('supports variable winds', () => {
    const parsed = parseWindInput('VRB05G15KT');
    expect(parsed.wind).toMatchObject({
      directionType: 'variable',
      directionDegTrue: null,
      speedKt: 5,
      gustKt: 15
    });
  });

  it('supports calm winds', () => {
    const parsed = parseWindInput('00000KT');
    expect(parsed.wind).toMatchObject({
      directionType: 'calm',
      speedKt: 0,
      gustKt: null
    });
  });

  it('rejects malformed input', () => {
    expect(() => parseWindInput('THIS IS NOT A METAR')).toThrow(MetarValidationError);
  });
});
