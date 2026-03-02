import { describe, expect, it } from 'vitest';
import { calculateWindComponent, normalizeDeltaDegrees } from '../windMath';

describe('windMath', () => {
  it('normalizes angle deltas to [-180,180]', () => {
    expect(normalizeDeltaDegrees(190)).toBe(-170);
    expect(normalizeDeltaDegrees(-200)).toBe(160);
  });

  it('computes direct headwind at delta 0', () => {
    const result = calculateWindComponent(12, 180, 180);
    expect(result.headwindKt).toBe(12);
    expect(result.crosswindKt).toBe(0);
    expect(result.crosswindFrom).toBe('none');
  });

  it('computes full crosswind from the right at delta 90', () => {
    const result = calculateWindComponent(20, 180, 90);
    expect(result.headwindKt).toBe(0);
    expect(result.crosswindKt).toBe(20);
    expect(result.crosswindFrom).toBe('right');
  });

  it('computes tailwind at delta 180', () => {
    const result = calculateWindComponent(15, 180, 360);
    expect(result.headwindKt).toBe(-15);
  });
});
