import type { RunwayEnd } from './types';

const RUNWAY_END_REGEX = /^(0?[1-9]|[12][0-9]|3[0-6])([LCR])?$/i;

export class RunwayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunwayValidationError';
  }
}

function normalizeRunwayNumber(value: string): string {
  return value.padStart(2, '0');
}

export function parseRunwayEnd(input: string): RunwayEnd {
  const normalizedInput = input.trim().toUpperCase();
  const match = normalizedInput.match(RUNWAY_END_REGEX);

  if (!match) {
    throw new RunwayValidationError(
      `Invalid runway end "${input}". Use values like 09, 27, 18L, or 36R.`
    );
  }

  const runwayNumber = Number.parseInt(match[1], 10);
  const suffix = match[2] ?? '';
  const formattedNumber = normalizeRunwayNumber(String(runwayNumber));
  const headingDegMag = runwayNumber === 36 ? 360 : runwayNumber * 10;

  return {
    id: `${formattedNumber}${suffix}`,
    headingDegMag
  };
}

export function parseRunwayEndsInput(input: string): RunwayEnd[] {
  const parts = input
    .split(/[\s,;/]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new RunwayValidationError('Enter at least one runway end.');
  }

  const deduped = new Map<string, RunwayEnd>();
  for (const part of parts) {
    const runway = parseRunwayEnd(part);
    deduped.set(runway.id, runway);
  }

  return [...deduped.values()];
}
