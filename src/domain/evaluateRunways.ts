import type {
  EvaluationResult,
  ParsedWind,
  RunwayEnd,
  RunwayWindComponent,
  RunwayWindComponentValue
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

export function evaluateRunways(runways: RunwayEnd[], wind: ParsedWind, parserNotes: string[] = []): EvaluationResult {
  const globalNotes = [...parserNotes];
  const hasRunways = runways.length > 0;
  const openRunways = runways.filter((runway) => !runway.isClosed);

  if (!hasRunways) {
    return {
      parsedWind: wind,
      runwayResults: [],
      bestRunwayId: null,
      bestReason: 'No runways available.',
      globalNotes
    };
  }

  if (openRunways.length === 0) {
    const runwayResults: RunwayWindComponent[] = runways.map((runway) => ({
      runwayId: runway.id,
      isClosed: true,
      sustained: null,
      gust: null,
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

  if (wind.directionType === 'variable') {
    const variableSpeedNote =
      wind.gustKt !== null
        ? `Variable wind direction (VRB) at ${wind.speedKt} kt with gusts to ${wind.gustKt} kt prevents per-runway component calculations.`
        : `Variable wind direction (VRB) at ${wind.speedKt} kt prevents per-runway component calculations.`;

    const runwayResults: RunwayWindComponent[] = runways.map((runway) => ({
      runwayId: runway.id,
      isClosed: Boolean(runway.isClosed),
      sustained: null,
      gust: null,
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

  if (wind.directionType === 'calm') {
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

  if (wind.directionDegTrue === null) {
    throw new Error('Fixed wind calculation requires a valid direction.');
  }

  const ranking: RankedRunway[] = [];

  const runwayResults: RunwayWindComponent[] = runways.map((runway) => {
    if (runway.isClosed) {
      return {
        runwayId: runway.id,
        isClosed: true,
        sustained: null,
        gust: null,
        notes: [CLOSED_RUNWAY_NOTE]
      };
    }

    const sustainedRaw = calculateWindComponent(wind.speedKt, wind.directionDegTrue!, runway.headingDegMag);
    ranking.push({
      runwayId: runway.id,
      headwindKt: sustainedRaw.headwindKt,
      crosswindKt: sustainedRaw.crosswindKt,
      runwayLengthFt: runwayLengthForSort(runway),
      runwayNumber: runwayNumberForSort(runway.id)
    });

    const gustRaw = wind.gustKt !== null
      ? calculateWindComponent(wind.gustKt, wind.directionDegTrue!, runway.headingDegMag)
      : null;

    return {
      runwayId: runway.id,
      isClosed: false,
      sustained: {
        headwindKt: sustainedRaw.headwindKt,
        crosswindKt: sustainedRaw.crosswindKt,
        crosswindFrom: sustainedRaw.crosswindFrom
      },
      gust: gustRaw
        ? {
            headwindKt: gustRaw.headwindKt,
            crosswindKt: gustRaw.crosswindKt,
            crosswindFrom: gustRaw.crosswindFrom
          }
        : null,
      notes: []
    };
  });

  ranking.sort(sortRunwaysForBest);
  const best = ranking[0] ?? null;

  return {
    parsedWind: wind,
    runwayResults,
    bestRunwayId: best?.runwayId ?? null,
    bestReason: best
      ? 'Highest headwind; tie-break by lowest crosswind, longest runway, smallest runway number, then runway ID.'
      : 'No open runways available for selection.',
    globalNotes
  };
}
