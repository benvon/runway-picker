import type { CacheEnvelope, CacheResourceAdapter } from '../../cache/types';
import {
  AirportWorkerError,
  fetchAirportUpstream,
  hasCanonicalAirportIdentity,
  normalizeAirportIcao,
  toAirportLocationData,
  type AirportLocationResourceData,
  type AirportResourceInput
} from './adapter';

export const AIRPORT_LOCATION_SCHEMA_VERSION = 1;

function serializeAirportLocation(
  data: AirportLocationResourceData,
  key: string,
  resource: string
): CacheEnvelope<AirportLocationResourceData> {
  const fetchedAt = new Date(data.fetchedAt);
  const safeFetchedAt = Number.isNaN(fetchedAt.getTime()) ? new Date() : fetchedAt;

  return {
    schemaVersion: AIRPORT_LOCATION_SCHEMA_VERSION,
    resource,
    key,
    data,
    cacheMeta: {
      fetchedAt: safeFetchedAt.toISOString(),
      expiresAt: new Date(
        safeFetchedAt.getTime() + airportLocationResourceAdapter.policy.ttlSeconds * 1000
      ).toISOString(),
      policyVersion: airportLocationResourceAdapter.policy.policyVersion,
      source: 'upstream'
    }
  };
}

function unwrapLocationCandidate(cached: unknown): unknown {
  if (cached && typeof cached === 'object' && 'data' in cached) {
    return (cached as { data?: unknown }).data;
  }

  return cached;
}

function hasRequiredLocationFields(data: Partial<AirportLocationResourceData>): boolean {
  return (
    typeof data.requestedIcao === 'string' &&
    typeof data.icao === 'string' &&
    data.source === 'airportdb' &&
    typeof data.fetchedAt === 'string'
  );
}

function hasValidLocationCoordinates(data: Partial<AirportLocationResourceData>): boolean {
  if (data.coordinates === null || typeof data.coordinates === 'undefined') {
    return true;
  }

  return (
    typeof data.coordinates.latitudeDeg === 'number' &&
    typeof data.coordinates.longitudeDeg === 'number'
  );
}

function deserializeAirportLocation(cached: unknown): AirportLocationResourceData | null {
  const candidate = unwrapLocationCandidate(cached);
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const data = candidate as Partial<AirportLocationResourceData>;
  if (
    !hasRequiredLocationFields(data) ||
    !hasValidLocationCoordinates(data) ||
    !hasCanonicalAirportIdentity(data.requestedIcao, data.icao)
  ) {
    return null;
  }

  const { requestedIcao, icao, coordinates, source, fetchedAt } = data;
  if (
    typeof requestedIcao !== 'string' ||
    typeof icao !== 'string' ||
    source !== 'airportdb' ||
    typeof fetchedAt !== 'string'
  ) {
    return null;
  }

  return {
    requestedIcao,
    icao,
    coordinates: coordinates ?? null,
    source,
    fetchedAt
  };
}

/**
 * Airport coordinates are reference data, not a runway profile variant. They
 * deliberately use an independent, long-lived cache resource and never enter
 * the hot queue, whose entries only reconstruct single-key operational fetches.
 */
export const airportLocationResourceAdapter: CacheResourceAdapter<AirportResourceInput, unknown, AirportLocationResourceData> = {
  resource: 'airport-location',
  schemaVersion: AIRPORT_LOCATION_SCHEMA_VERSION,
  normalizeKey: (input) => normalizeAirportIcao(input.icao),
  fetchUpstream: fetchAirportUpstream,
  validate: toAirportLocationData,
  serialize: serializeAirportLocation,
  deserialize: deserializeAirportLocation,
  policy: {
    ttlSeconds: 2_592_000,
    maxPayloadAgeSeconds: 10_368_000,
    staleWhileRevalidateSeconds: 2_592_000,
    staleOnErrorSeconds: 7_776_000,
    negativeCacheTtlSeconds: 3_600,
    policyVersion: 'airport-location-v1'
  },
  negativeCache: {
    toEntry: (error) =>
      error instanceof AirportWorkerError && error.status === 404 && error.code === 'ICAO_NOT_FOUND'
        ? { status: 404, code: 'ICAO_NOT_FOUND' }
        : null,
    toError: (entry, input) => {
      if (entry.status !== 404 || entry.code !== 'ICAO_NOT_FOUND') {
        return null;
      }

      const icao = normalizeAirportIcao(input.icao);
      return new AirportWorkerError(`ICAO code ${icao} was not found in airport database.`, 404, 'ICAO_NOT_FOUND');
    }
  },
  observability: (input, key) => ({
    labels: {
      resource: 'airport-location',
      key,
      icao: normalizeAirportIcao(input.icao)
    }
  })
};
