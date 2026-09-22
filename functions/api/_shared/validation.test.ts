import { describe, expect, it } from 'vitest';
import { validateAirportIdentParam, validateIcaoParam } from './validation';

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

describe('airport ident validation', () => {
  it('accepts 3–4 alphanumeric airport codes', () => {
    expect(validateAirportIdentParam('1c8')).toEqual({ ok: true, icao: '1C8' });
    expect(validateAirportIdentParam('c25')).toEqual({ ok: true, icao: 'C25' });
    expect(validateAirportIdentParam(' kjfk ')).toEqual({ ok: true, icao: 'KJFK' });
  });

  it('rejects codes outside 3–4 alphanumeric length', () => {
    expect(validateAirportIdentParam(null)).toMatchObject({ ok: false, code: 'INVALID_ICAO' });
    expect(validateAirportIdentParam('AB')).toMatchObject({
      ok: false,
      code: 'INVALID_ICAO',
      error: 'Invalid airport code. Expected 3–4 alphanumeric characters.'
    });
    expect(validateAirportIdentParam('ABCDE')).toMatchObject({ ok: false, code: 'INVALID_ICAO' });
  });
});
