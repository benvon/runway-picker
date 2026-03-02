import { describe, expect, it } from 'vitest';
import { parseRunwayEnd, parseRunwayEndsInput, RunwayValidationError } from '../runwayParser';

describe('runwayParser', () => {
  it('parses runway with suffix and heading', () => {
    expect(parseRunwayEnd('18L')).toEqual({ id: '18L', headingDegMag: 180 });
  });

  it('normalizes single digit runway numbers', () => {
    expect(parseRunwayEnd('9')).toEqual({ id: '09', headingDegMag: 90 });
  });

  it('deduplicates runway input list', () => {
    expect(parseRunwayEndsInput('09, 27 09')).toEqual([
      { id: '09', headingDegMag: 90 },
      { id: '27', headingDegMag: 270 }
    ]);
  });

  it('throws a validation error on invalid runway value', () => {
    expect(() => parseRunwayEnd('44')).toThrow(RunwayValidationError);
  });
});
