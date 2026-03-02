export type WindDirectionType = 'fixed' | 'variable' | 'calm';

export interface RunwayEnd {
  id: string;
  headingDegMag: number;
}

export interface ParsedWind {
  raw: string;
  directionType: WindDirectionType;
  directionDegTrue: number | null;
  speedKt: number;
  gustKt: number | null;
  source: 'metar' | 'wind_group';
}

export interface RunwayWindComponentValue {
  headwindKt: number;
  crosswindKt: number;
  crosswindFrom: 'left' | 'right' | 'none';
}

export interface RunwayWindComponent {
  runwayId: string;
  sustained: RunwayWindComponentValue | null;
  gust: RunwayWindComponentValue | null;
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
