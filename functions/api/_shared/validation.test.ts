import { describe, expect, it } from 'vitest';
import { validateIcaoParam } from './validation';

describe('ICAO validation', () => {
  it('accepts normalized ICAO values', () => {
    expect(validateIcaoParam(' kjfk ')).toEqual({ ok: true, icao: 'KJFK' });
  });

  it('rejects null and malformed ICAO values', () => {
    expect(validateIcaoParam(null)).toMatchObject({ ok: false, code: 'INVALID_ICAO' });
    expect(validateIcaoParam('ABC')).toMatchObject({ ok: false, code: 'INVALID_ICAO' });
    expect(validateIcaoParam('ABCDE')).toMatchObject({ ok: false, code: 'INVALID_ICAO' });
  });
});
