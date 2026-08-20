import type {
  EvaluationResult,
  ParsedWind,
  RunwayEnd,
  RunwayWindComponent,
  RunwayWindComponentRange,
  RunwayWindComponentValue,
  WindDirectionVariation
} from './types';
import { calculateWindComponent } from './windMath';

interface RankedRunway {
  runwayId: string;
  headwindKt: number;
  crosswindKt: number;
  runwayLengthFt: number;
  runwayNumber: number;
}

const CLOSED_RUNWAY_NOTE = 'Runway is closed; excluded from recommendation.';

function sortRunwaysForBest(a: RankedRunway, b: RankedRunway): number {
  if (b.headwindKt !== a.headwindKt) {
    return b.headwindKt - a.headwindKt;
  }

  if (a.crosswindKt !== b.crosswindKt) {
    return a.crosswindKt - b.crosswindKt;
  }

  if (b.runwayLengthFt !== a.runwayLengthFt) {
    return b.runwayLengthFt - a.runwayLengthFt;
  }

  if (a.runwayNumber !== b.runwayNumber) {
    return a.runwayNumber - b.runwayNumber;
  }

  return a.runwayId.localeCompare(b.runwayId);
}

function zeroComponent(): RunwayWindComponentValue {
  return {
    headwindKt: 0,
    crosswindKt: 0,
    crosswindFrom: 'none'
  };
}

function toComponentValue(component: ReturnType<typeof calculateWindComponent>): RunwayWindComponentValue {
  return {
    headwindKt: component.headwindKt,
    crosswindKt: component.crosswindKt,
    crosswindFrom: component.crosswindFrom
  };
}

function directionsInVariation(variation: WindDirectionVariation): number[] {
  const directions: number[] = [];
  let direction = variation.fromDegTrue % 360;
  const destination = variation.toDegTrue % 360;

  do {
    directions.push(direction);
    direction = (direction + 1) % 360;
  } while (direction !== destination);

  directions.push(destination);
  return directions;
}

function componentRangeForVariation(
  speedKt: number,
  runwayHeadingDegTrue: number,
  variation: WindDirectionVariation
): RunwayWindComponentRange {
  const components = directionsInVariation(variation).map((directionDegTrue) =>
    calculateWindComponent(speedKt, directionDegTrue, runwayHeadingDegTrue)
  );

  return {
    minimumHeadwindKt: Math.min(...components.map((component) => component.headwindKt)),
    maximumHeadwindKt: Math.max(...components.map((component) => component.headwindKt)),
    minimumCrosswindKt: Math.min(...components.map((component) => component.crosswindKt)),
    maximumCrosswindKt: Math.max(...components.map((component) => component.crosswindKt))
  };
}

function runwayLengthForSort(runway: RunwayEnd): number {
  if (typeof runway.lengthFt !== 'number' || runway.lengthFt <= 0) {
    return 0;
  }

  return runway.lengthFt;
}

function runwayNumberForSort(runwayId: string): number {
  const match = runwayId.match(/^(\d{2})/);
  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }

  const number = Number.parseInt(match[1], 10);
  if (Number.isNaN(number)) {
    return Number.MAX_SAFE_INTEGER;
  }

  return number === 0 ? 36 : number;
}

function buildNoRunwayResult(wind: ParsedWind, globalNotes: string[]): EvaluationResult {
  return {
    parsedWind: wind,
    runwayResults: [],
    bestRunwayId: null,
    bestReason: 'No runways available.',
    globalNotes
  };
}

function buildAllClosedResult(runways: RunwayEnd[], wind: ParsedWind, globalNotes: string[]): EvaluationResult {
  const runwayResults: RunwayWindComponent[] = runways.map((runway) => ({
    runwayId: runway.id,
    isClosed: true,
    sustained: null,
    gust: null,
    sustainedRange: null,
    gustRange: null,
    notes: [CLOSED_RUNWAY_NOTE]
  }));

  return {
    parsedWind: wind,
    runwayResults,
    bestRunwayId: null,
    bestReason: 'No open runways available for selection.',
    globalNotes
  };
}

function buildVariableWindResult(
  runways: RunwayEnd[],
  wind: ParsedWind,
  globalNotes: string[]
): EvaluationResult {
  const variableSpeedNote =
    wind.gustKt !== null
      ? `Variable wind direction (VRB) at ${wind.speedKt} kt with gusts to ${wind.gustKt} kt prevents per-runway component calculations.`
      : `Variable wind direction (VRB) at ${wind.speedKt} kt prevents per-runway component calculations.`;

  const runwayResults: RunwayWindComponent[] = runways.map((runway) => ({
    runwayId: runway.id,
    isClosed: Boolean(runway.isClosed),
    sustained: null,
    gust: null,
    sustainedRange: null,
    gustRange: null,
    notes: runway.isClosed ? [CLOSED_RUNWAY_NOTE] : [variableSpeedNote]
  }));

  return {
    parsedWind: wind,
    runwayResults,
    bestRunwayId: null,
    bestReason: `Variable winds reported at ${wind.speedKt} kt; no deterministic best runway.`,
    globalNotes
  };
}

function buildCalmWindResult(
  runways: RunwayEnd[],
  openRunways: RunwayEnd[],
  wind: ParsedWind,
  globalNotes: string[]
): EvaluationResult {
  const calmRanking: RankedRunway[] = openRunways.map((runway) => ({
    runwayId: runway.id,
    headwindKt: 0,
    crosswindKt: 0,
    runwayLengthFt: runwayLengthForSort(runway),
    runwayNumber: runwayNumberForSort(runway.id)
  }));
  calmRanking.sort(sortRunwaysForBest);
  const bestRunwayId = calmRanking[0]?.runwayId ?? null;

  const runwayResults: RunwayWindComponent[] = runways.map((runway) => ({
    runwayId: runway.id,
    isClosed: Boolean(runway.isClosed),
    sustained: runway.isClosed ? null : zeroComponent(),
    gust: null,
    sustainedRange: null,
    gustRange: null,
    notes: runway.isClosed ? [CLOSED_RUNWAY_NOTE] : ['Calm winds: runway choice is not wind-limited.']
  }));

  return {
    parsedWind: wind,
    runwayResults,
    bestRunwayId,
    bestReason: 'Calm winds; selected by tie-break among open runways (longest runway, then smallest runway number).',
    globalNotes
  };
}

function toFixedRunwayComponent(runway: RunwayEnd, wind: ParsedWind, ranking: RankedRunway[]): RunwayWindComponent {
  if (runway.isClosed) {
    return {
      runwayId: runway.id,
      isClosed: true,
      sustained: null,
      gust: null,
      sustainedRange: null,
      gustRange: null,
      notes: [CLOSED_RUNWAY_NOTE]
    };
  }

  const directionDegTrue = wind.directionDegTrue as number;
  const sustainedRaw = calculateWindComponent(wind.speedKt, directionDegTrue, runway.headingDegTrue);
  ranking.push({
    runwayId: runway.id,
    headwindKt: sustainedRaw.headwindKt,
    crosswindKt: sustainedRaw.crosswindKt,
    runwayLengthFt: runwayLengthForSort(runway),
    runwayNumber: runwayNumberForSort(runway.id)
  });

  const gustRaw =
    wind.gustKt !== null ? calculateWindComponent(wind.gustKt, directionDegTrue, runway.headingDegTrue) : null;

  return {
    runwayId: runway.id,
    isClosed: false,
    sustained: toComponentValue(sustainedRaw),
    gust: gustRaw ? toComponentValue(gustRaw) : null,
    sustainedRange:
      wind.directionVariation === null
        ? null
        : componentRangeForVariation(wind.speedKt, runway.headingDegTrue, wind.directionVariation),
    gustRange:
      wind.gustKt === null || wind.directionVariation === null
        ? null
        : componentRangeForVariation(wind.gustKt, runway.headingDegTrue, wind.directionVariation),
    notes: []
  };
}

function bestRunwayForDirection(openRunways: RunwayEnd[], wind: ParsedWind, directionDegTrue: number): string | null {
  const ranking: RankedRunway[] = openRunways.map((runway) => {
    const component = calculateWindComponent(wind.speedKt, directionDegTrue, runway.headingDegTrue);
    return {
      runwayId: runway.id,
      headwindKt: component.headwindKt,
      crosswindKt: component.crosswindKt,
      runwayLengthFt: runwayLengthForSort(runway),
      runwayNumber: runwayNumberForSort(runway.id)
    };
  });

  ranking.sort(sortRunwaysForBest);
  return ranking[0]?.runwayId ?? null;
}

function variationChangesBestRunway(openRunways: RunwayEnd[], wind: ParsedWind): boolean {
  if (wind.directionVariation === null) {
    return false;
  }

  const bestRunways = new Set(
    directionsInVariation(wind.directionVariation).map((directionDegTrue) =>
      bestRunwayForDirection(openRunways, wind, directionDegTrue)
    )
  );
  return bestRunways.size > 1;
}

function buildFixedWindResult(
  runways: RunwayEnd[],
  openRunways: RunwayEnd[],
  wind: ParsedWind,
  globalNotes: string[]
): EvaluationResult {
  if (wind.directionDegTrue === null) {
    throw new Error('Fixed wind calculation requires a valid direction.');
  }

  const ranking: RankedRunway[] = [];
  const runwayResults = runways.map((runway) => toFixedRunwayComponent(runway, wind, ranking));

  ranking.sort(sortRunwaysForBest);
  const best = ranking[0] ?? null;
  const sectorChangesBestRunway = variationChangesBestRunway(openRunways, wind);
  if (wind.directionVariation !== null) {
    globalNotes.push(
      `Wind direction varies from ${wind.directionVariation.fromDegTrue}\u00b0 to ${wind.directionVariation.toDegTrue}\u00b0 true; component ranges include every reported direction in the sector.`
    );
  }

  return {
    parsedWind: wind,
    runwayResults,
    bestRunwayId: sectorChangesBestRunway ? null : (best?.runwayId ?? null),
    bestReason: sectorChangesBestRunway
      ? `Wind direction varies across ${wind.directionVariation?.fromDegTrue}\u00b0V${wind.directionVariation?.toDegTrue}\u00b0; the best runway changes within the reported sector, so no deterministic recommendation is shown.`
      : best
      ? 'Highest headwind; tie-break by lowest crosswind, longest runway, smallest runway number, then runway ID.'
      : 'No open runways available for selection.',
    globalNotes
  };
}

export function evaluateRunways(runways: RunwayEnd[], wind: ParsedWind, parserNotes: string[] = []): EvaluationResult {
  const globalNotes = [...parserNotes];
  if (runways.length === 0) {
    return buildNoRunwayResult(wind, globalNotes);
  }

  const openRunways = runways.filter((runway) => !runway.isClosed);
  if (openRunways.length === 0) {
    return buildAllClosedResult(runways, wind, globalNotes);
  }

  if (wind.directionType === 'variable') {
    return buildVariableWindResult(runways, wind, globalNotes);
  }

  if (wind.directionType === 'calm') {
    return buildCalmWindResult(runways, openRunways, wind, globalNotes);
  }

  return buildFixedWindResult(runways, openRunways, wind, globalNotes);
}
