const ICAO_REGEX = /^[A-Z0-9]{4}$/;
const AIRPORT_IDENT_REGEX = /^[A-Z0-9]{3,4}$/;

export interface IcaoValidationSuccess {
  ok: true;
  icao: string;
}

export interface IcaoValidationFailure {
  ok: false;
  code: 'INVALID_ICAO';
  error: string;
}

export type IcaoValidationResult = IcaoValidationSuccess | IcaoValidationFailure;

export function validateIcaoParam(value: string | null): IcaoValidationResult {
  const normalized = value?.trim().toUpperCase() ?? '';
  if (!ICAO_REGEX.test(normalized)) {
    return {
      ok: false,
      code: 'INVALID_ICAO',
      error: 'Invalid ICAO code. Expected 4 alphanumeric characters.'
    };
  }

  return {
    ok: true,
    icao: normalized
  };
}

export function validateAirportIdentParam(value: string | null): IcaoValidationResult {
  const normalized = value?.trim().toUpperCase() ?? '';
  if (!AIRPORT_IDENT_REGEX.test(normalized)) {
    return {
      ok: false,
      code: 'INVALID_ICAO',
      error: 'Invalid airport code. Expected 3–4 alphanumeric characters.'
    };
  }

  return {
    ok: true,
    icao: normalized
  };
}
