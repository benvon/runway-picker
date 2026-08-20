const RUNWAY_END_REGEX = /^(0?[1-9]|[12][0-9]|3[0-6])([LCR])?$/i;

export class RunwayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunwayValidationError';
  }
}

export interface ParsedMagneticRunwayEnd {
  id: string;
  headingDegMag: number;
  isClosed: false;
}

function normalizeRunwayNumber(value: string): string {
  return value.padStart(2, '0');
}

/** Parses a magnetic runway designator; it is not a true-heading RunwayEnd. */
export function parseRunwayEnd(input: string): ParsedMagneticRunwayEnd {
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
  return {
    id: `${formattedNumber}${suffix}`,
    headingDegMag: runwayNumber === 36 ? 360 : runwayNumber * 10,
    isClosed: false
  };
}

export function parseRunwayEndsInput(input: string): ParsedMagneticRunwayEnd[] {
  const parts = input
    .split(/[\s,;/]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new RunwayValidationError('Enter at least one runway end.');
  }

  const deduped = new Map<string, ParsedMagneticRunwayEnd>();
  for (const part of parts) {
    const runway = parseRunwayEnd(part);
    deduped.set(runway.id, runway);
  }

  return [...deduped.values()];
}
