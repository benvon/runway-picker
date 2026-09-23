export interface GeographicCoordinate {
  latitudeDeg: number;
  longitudeDeg: number;
}

/**
 * Initial true bearing from `from` to `to`, in degrees [0, 360].
 * Returns null when the points are coincident or coordinates are invalid.
 */
export function initialBearingDegTrue(
  from: GeographicCoordinate,
  to: GeographicCoordinate
): number | null {
  if (
    !Number.isFinite(from.latitudeDeg) ||
    !Number.isFinite(from.longitudeDeg) ||
    !Number.isFinite(to.latitudeDeg) ||
    !Number.isFinite(to.longitudeDeg) ||
    Math.abs(from.latitudeDeg) > 90 ||
    Math.abs(to.latitudeDeg) > 90 ||
    Math.abs(from.longitudeDeg) > 180 ||
    Math.abs(to.longitudeDeg) > 180
  ) {
    return null;
  }

  if (from.latitudeDeg === to.latitudeDeg && from.longitudeDeg === to.longitudeDeg) {
    return null;
  }

  const fromLat = (from.latitudeDeg * Math.PI) / 180;
  const toLat = (to.latitudeDeg * Math.PI) / 180;
  const deltaLon = ((to.longitudeDeg - from.longitudeDeg) * Math.PI) / 180;

  const y = Math.sin(deltaLon) * Math.cos(toLat);
  const x =
    Math.cos(fromLat) * Math.sin(toLat) - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLon);
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  const normalized = ((bearing % 360) + 360) % 360;
  return normalized === 0 ? 360 : normalized;
}
