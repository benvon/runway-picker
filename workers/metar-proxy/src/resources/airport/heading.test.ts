import { describe, expect, it } from 'vitest';
import { initialBearingDegTrue } from './heading';

describe('initialBearingDegTrue', () => {
  it('computes southbound bearing for Cottonwood 18/36 endpoints', () => {
    // OurAirports 1C8: le=18 north of he=36
    const bearing = initialBearingDegTrue(
      { latitudeDeg: 42.295501708984375, longitudeDeg: -89.13610076904297 },
      { latitudeDeg: 42.28850173950195, longitudeDeg: -89.13610076904297 }
    );
    expect(bearing).not.toBeNull();
    expect(bearing!).toBeGreaterThan(170);
    expect(bearing!).toBeLessThan(190);
  });

  it('computes the reciprocal northbound bearing', () => {
    const bearing = initialBearingDegTrue(
      { latitudeDeg: 42.28850173950195, longitudeDeg: -89.13610076904297 },
      { latitudeDeg: 42.295501708984375, longitudeDeg: -89.13610076904297 }
    );
    expect(bearing).not.toBeNull();
    expect(bearing!).toBeGreaterThanOrEqual(350);
    expect(bearing!).toBeLessThanOrEqual(360);
  });

  it('returns null for coincident points', () => {
    expect(
      initialBearingDegTrue(
        { latitudeDeg: 42.29, longitudeDeg: -89.13 },
        { latitudeDeg: 42.29, longitudeDeg: -89.13 }
      )
    ).toBeNull();
  });
});
