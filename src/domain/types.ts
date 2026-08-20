export type WindDirectionType = 'fixed' | 'variable' | 'calm';

export interface RunwayEnd {
  id: string;
  /** Physical runway heading referenced to true north. */
  headingDegTrue: number;
  isClosed?: boolean;
  lengthFt?: number | null;
}

export interface AirportFrequency {
  type: string;
  description: string;
  frequencyMhz: string;
}

export interface ParsedWind {
  raw: string;
  directionType: WindDirectionType;
  directionDegTrue: number | null;
  directionVariation: WindDirectionVariation | null;
  speedKt: number;
  gustKt: number | null;
  source: 'metar' | 'wind_group' | 'metar_api';
}

/**
 * Inclusive clockwise directional-variation sector reported in a METAR
 * (for example, 180V260). METAR directions are referenced to true north.
 */
export interface WindDirectionVariation {
  fromDegTrue: number;
  toDegTrue: number;
}

export interface RunwayWindComponentValue {
  headwindKt: number;
  crosswindKt: number;
  crosswindFrom: 'left' | 'right' | 'none';
}

export interface RunwayWindComponentRange {
  minimumHeadwindKt: number;
  maximumHeadwindKt: number;
  minimumCrosswindKt: number;
  maximumCrosswindKt: number;
}

export interface RunwayWindComponent {
  runwayId: string;
  isClosed: boolean;
  sustained: RunwayWindComponentValue | null;
  gust: RunwayWindComponentValue | null;
  sustainedRange: RunwayWindComponentRange | null;
  gustRange: RunwayWindComponentRange | null;
  notes: string[];
}

export interface EvaluationResult {
  parsedWind: ParsedWind;
  runwayResults: RunwayWindComponent[];
  bestRunwayId: string | null;
  bestReason: string;
  globalNotes: string[];
}

export interface ParsedWindResult {
  wind: ParsedWind;
  notes: string[];
  matchedToken: string;
}

export interface WindSource {
  getCurrentWind(icao: string): Promise<ParsedWind>;
}

export interface AirportSource {
  getRunwayEnds(icao: string): Promise<RunwayEnd[]>;
}
