import type { AirportFrequency, RunwayEnd } from '../../domain/types';

export interface AirportInfoSummary {
  approach: string;
  tower: string;
  awosAtis: string;
  ctaf: string;
}

type CardinalDirection = 'north' | 'south' | 'east' | 'west';

const NOT_AVAILABLE = 'N/A';

function normalizeType(value: string): string {
  const normalized = value.trim().toUpperCase();

  if (normalized === 'A/D') {
    return 'APP';
  }

  if (normalized === 'UNIC') {
    return 'CTAF';
  }

  return normalized;
}

function formatFrequencyList(frequencies: AirportFrequency[]): string {
  const unique = [...new Set(frequencies.map((frequency) => frequency.frequencyMhz.trim()).filter(Boolean))];
  return unique.length > 0 ? unique.map((frequency) => `${frequency} MHz`).join(', ') : NOT_AVAILABLE;
}

function hasType(frequency: AirportFrequency, allowedTypes: readonly string[]): boolean {
  return allowedTypes.includes(normalizeType(frequency.type));
}

function findRunwayHeading(runwayEnds: RunwayEnd[], runwayId: string | null): number | null {
  if (!runwayId) {
    return null;
  }

  const matchingRunway = runwayEnds.find((runway) => runway.id === runwayId);
  if (matchingRunway) {
    return matchingRunway.headingDegMag;
  }

  const runwayNumber = Number.parseInt(runwayId.slice(0, 2), 10);
  if (!Number.isFinite(runwayNumber) || runwayNumber < 1 || runwayNumber > 36) {
    return null;
  }

  return runwayNumber === 36 ? 360 : runwayNumber * 10;
}

function reciprocalHeading(headingDegMag: number): number {
  return ((headingDegMag + 180 - 1) % 360) + 1;
}

function toApproachDirection(headingDegMag: number | null): CardinalDirection | null {
  if (!headingDegMag || headingDegMag < 1 || headingDegMag > 360) {
    return null;
  }

  const inboundHeading = reciprocalHeading(headingDegMag);

  if (inboundHeading >= 315 || inboundHeading < 45) {
    return 'north';
  }

  if (inboundHeading >= 45 && inboundHeading < 135) {
    return 'east';
  }

  if (inboundHeading >= 135 && inboundHeading < 225) {
    return 'south';
  }

  return 'west';
}

function extractDirectionalTags(frequency: AirportFrequency): CardinalDirection[] {
  const tokens = `${frequency.type} ${frequency.description}`.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const directions: CardinalDirection[] = [];

  if (tokens.includes('NORTH') || tokens.includes('N')) {
    directions.push('north');
  }

  if (tokens.includes('SOUTH') || tokens.includes('S')) {
    directions.push('south');
  }

  if (tokens.includes('EAST') || tokens.includes('E')) {
    directions.push('east');
  }

  if (tokens.includes('WEST') || tokens.includes('W')) {
    directions.push('west');
  }

  return directions;
}

function selectApproachFrequencies(
  runwayEnds: RunwayEnd[],
  frequencies: AirportFrequency[],
  bestRunwayId: string | null
): AirportFrequency[] {
  const approachFrequencies = frequencies.filter((frequency) => hasType(frequency, ['APP', 'APCH', 'ARR']));
  if (approachFrequencies.length === 0) {
    return [];
  }

  const approachDirection = toApproachDirection(findRunwayHeading(runwayEnds, bestRunwayId));
  if (!approachDirection) {
    return approachFrequencies;
  }

  const tagged = approachFrequencies.map((frequency) => ({
    frequency,
    directions: extractDirectionalTags(frequency)
  }));
  const hasDirectionalSplit = tagged.some((entry) => entry.directions.length > 0);
  if (!hasDirectionalSplit) {
    return approachFrequencies;
  }

  const matched = tagged
    .filter((entry) => entry.directions.includes(approachDirection))
    .map((entry) => entry.frequency);

  return matched.length > 0 ? matched : approachFrequencies;
}

function selectFrequencies(frequencies: AirportFrequency[], allowedTypes: readonly string[]): AirportFrequency[] {
  return frequencies.filter((frequency) => hasType(frequency, allowedTypes));
}

export function summarizeAirportFrequencies(
  runwayEnds: RunwayEnd[],
  frequencies: AirportFrequency[],
  bestRunwayId: string | null
): AirportInfoSummary {
  return {
    approach: formatFrequencyList(selectApproachFrequencies(runwayEnds, frequencies, bestRunwayId)),
    tower: formatFrequencyList(selectFrequencies(frequencies, ['TWR'])),
    awosAtis: formatFrequencyList(selectFrequencies(frequencies, ['ATIS', 'AWOS', 'ASOS'])),
    ctaf: formatFrequencyList(selectFrequencies(frequencies, ['CTAF']))
  };
}
