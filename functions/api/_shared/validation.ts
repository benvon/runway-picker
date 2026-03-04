const ICAO_REGEX = /^[A-Z0-9]{4}$/;

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
