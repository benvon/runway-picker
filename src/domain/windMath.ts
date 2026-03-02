import type { RunwayWindComponentValue } from './types';

export interface RawWindComponent extends RunwayWindComponentValue {
  rawHeadwindKt: number;
  rawCrosswindSignedKt: number;
}

export function normalizeDeltaDegrees(deltaDeg: number): number {
  const normalized = ((deltaDeg + 540) % 360) - 180;
  return normalized === -180 ? 180 : normalized;
}

export function roundKnots(value: number): number {
  const rounded = Math.round(value);
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function calculateWindComponent(
  speedKt: number,
  windDirectionDegTrue: number,
  runwayHeadingDegMag: number
): RawWindComponent {
  const deltaDeg = normalizeDeltaDegrees(windDirectionDegTrue - runwayHeadingDegMag);
  const deltaRad = (deltaDeg * Math.PI) / 180;

  const rawHeadwindKt = speedKt * Math.cos(deltaRad);
  const rawCrosswindSignedKt = speedKt * Math.sin(deltaRad);

  const headwindKt = roundKnots(rawHeadwindKt);
  const crosswindKt = roundKnots(Math.abs(rawCrosswindSignedKt));

  let crosswindFrom: 'left' | 'right' | 'none' = 'none';
  if (crosswindKt !== 0) {
    crosswindFrom = rawCrosswindSignedKt > 0 ? 'right' : 'left';
  }

  return {
    headwindKt,
    crosswindKt,
    crosswindFrom,
    rawHeadwindKt,
    rawCrosswindSignedKt
  };
}
