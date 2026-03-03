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
}

function sortRunwaysForBest(a: RankedRunway, b: RankedRunway): number {
  if (b.headwindKt !== a.headwindKt) {
    return b.headwindKt - a.headwindKt;
  }

  if (a.crosswindKt !== b.crosswindKt) {
    return a.crosswindKt - b.crosswindKt;
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

export function evaluateRunways(runways: RunwayEnd[], wind: ParsedWind, parserNotes: string[] = []): EvaluationResult {
  const globalNotes = [...parserNotes];

  if (wind.directionType === 'variable') {
    const variableSpeedNote =
      wind.gustKt !== null
        ? `Variable wind direction (VRB) at ${wind.speedKt} kt with gusts to ${wind.gustKt} kt prevents per-runway component calculations.`
        : `Variable wind direction (VRB) at ${wind.speedKt} kt prevents per-runway component calculations.`;

    const runwayResults: RunwayWindComponent[] = runways.map((runway) => ({
      runwayId: runway.id,
      sustained: null,
      gust: null,
      notes: [variableSpeedNote]
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
    const sortedIds = [...runways].map((runway) => runway.id).sort((a, b) => a.localeCompare(b));
    const bestRunwayId = sortedIds[0] ?? null;

    const runwayResults: RunwayWindComponent[] = runways.map((runway) => ({
      runwayId: runway.id,
      sustained: zeroComponent(),
      gust: null,
      notes: ['Calm winds: runway choice is not wind-limited.']
    }));

    return {
      parsedWind: wind,
      runwayResults,
      bestRunwayId,
      bestReason: 'Calm winds; selected by runway ID tie-break.',
      globalNotes
    };
  }

  if (wind.directionDegTrue === null) {
    throw new Error('Fixed wind calculation requires a valid direction.');
  }

  const ranking: RankedRunway[] = [];

  const runwayResults: RunwayWindComponent[] = runways.map((runway) => {
    const sustainedRaw = calculateWindComponent(wind.speedKt, wind.directionDegTrue!, runway.headingDegMag);
    ranking.push({
      runwayId: runway.id,
      headwindKt: sustainedRaw.headwindKt,
      crosswindKt: sustainedRaw.crosswindKt
    });

    const gustRaw = wind.gustKt !== null
      ? calculateWindComponent(wind.gustKt, wind.directionDegTrue!, runway.headingDegMag)
      : null;

    return {
      runwayId: runway.id,
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
      ? 'Highest headwind; tie-break by lowest crosswind, then runway ID.'
      : 'No runways available.',
    globalNotes
  };
}
