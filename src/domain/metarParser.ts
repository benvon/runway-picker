import type { ParsedWindResult } from './types';

const WIND_TOKEN_REGEX = /\b(?:\d{3}\d{2,3}(?:G\d{2,3})?KT|VRB\d{2,3}(?:G\d{2,3})?KT|00000KT)\b/g;
const FIXED_WIND_REGEX = /^(\d{3})(\d{2,3})(?:G(\d{2,3}))?KT$/;
const VARIABLE_WIND_REGEX = /^VRB(\d{2,3})(?:G(\d{2,3}))?KT$/;
const DIRECTION_VARIATION_AFTER_WIND_REGEX = /^\s+(\d{3})V(\d{3})(?=\s|$)/;

export class MetarValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetarValidationError';
  }
}

function parseInteger(value: string | undefined): number | null {
  return value ? Number.parseInt(value, 10) : null;
}

function parseDirectionVariationAfterWind(input: string, windTokenEnd: number): { fromDegTrue: number; toDegTrue: number } | null {
  const match = input.slice(windTokenEnd).match(DIRECTION_VARIATION_AFTER_WIND_REGEX);
  if (!match) {
    return null;
  }

  const fromDegTrue = Number.parseInt(match[1], 10);
  const toDegTrue = Number.parseInt(match[2], 10);
  if (fromDegTrue > 360 || toDegTrue > 360 || fromDegTrue % 360 === toDegTrue % 360) {
    return null;
  }

  return { fromDegTrue, toDegTrue };
}

export function parseWindInput(rawInput: string): ParsedWindResult {
  const input = rawInput.trim().toUpperCase();
  if (!input) {
    throw new MetarValidationError('Enter a METAR string or wind group like 22012G20KT.');
  }

  const matches = [...input.matchAll(WIND_TOKEN_REGEX)];

  if (matches.length === 0) {
    throw new MetarValidationError(
      'No valid wind group found. Expected formats like 22012KT, 22012G20KT, VRB05KT, or 00000KT.'
    );
  }

  const matchedToken = matches[0]?.[0];
  if (!matchedToken) {
    throw new MetarValidationError('No valid wind group found.');
  }
  const notes: string[] = [];

  if (matches.length > 1) {
    notes.push('Multiple wind groups detected; using the first group.');
  }

  const source = input === matchedToken ? 'wind_group' : 'metar';

  if (matchedToken === '00000KT') {
    notes.push('Calm winds reported.');
    return {
      wind: {
        raw: matchedToken,
        directionType: 'calm',
        directionDegTrue: null,
        directionVariation: null,
        speedKt: 0,
        gustKt: null,
        source
      },
      notes,
      matchedToken
    };
  }

  const variableMatch = matchedToken.match(VARIABLE_WIND_REGEX);
  if (variableMatch) {
    notes.push('Variable wind direction: runway ranking is not deterministic.');
    return {
      wind: {
        raw: matchedToken,
        directionType: 'variable',
        directionDegTrue: null,
        directionVariation: null,
        speedKt: Number.parseInt(variableMatch[1], 10),
        gustKt: parseInteger(variableMatch[2]),
        source
      },
      notes,
      matchedToken
    };
  }

  const fixedMatch = matchedToken.match(FIXED_WIND_REGEX);
  if (!fixedMatch) {
    throw new MetarValidationError(`Unable to parse wind group: ${matchedToken}`);
  }

  return {
    wind: {
      raw: matchedToken,
      directionType: 'fixed',
      directionDegTrue: Number.parseInt(fixedMatch[1], 10),
      directionVariation: parseDirectionVariationAfterWind(input, (matches[0]?.index ?? 0) + matchedToken.length),
      speedKt: Number.parseInt(fixedMatch[2], 10),
      gustKt: parseInteger(fixedMatch[3]),
      source
    },
    notes,
    matchedToken
  };
}
