import type { CacheEnvelope, CacheResourceAdapter } from '../../cache/types';

export interface AirportResourceInput {
  icao: string;
}

export interface AirportResourceData {
  icao: string;
  name: string;
  elevationFt: number;
  timezone: string;
  fetchedAt: string;
  source: 'placeholder';
}

function normalizeAirportIcao(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(normalized)) {
    throw new Error('Invalid ICAO code. Expected 4 alphanumeric characters.');
  }

  return normalized;
}

function toAirportData(candidate: unknown): AirportResourceData | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const asData = candidate as Partial<AirportResourceData>;
  if (
    typeof asData.icao !== 'string' ||
    typeof asData.name !== 'string' ||
    typeof asData.elevationFt !== 'number' ||
    typeof asData.timezone !== 'string' ||
    typeof asData.fetchedAt !== 'string' ||
    asData.source !== 'placeholder'
  ) {
    return null;
  }

  return {
    icao: asData.icao,
    name: asData.name,
    elevationFt: asData.elevationFt,
    timezone: asData.timezone,
    fetchedAt: asData.fetchedAt,
    source: asData.source
  };
}

function serializeAirport(data: AirportResourceData, key: string, resource: string): CacheEnvelope<AirportResourceData> {
  const fetchedAt = new Date(data.fetchedAt);
  const fallbackFetchedAt = Number.isNaN(fetchedAt.getTime()) ? new Date() : fetchedAt;

  return {
    schemaVersion: airportResourceAdapter.schemaVersion,
    resource,
    key,
    data,
    cacheMeta: {
      fetchedAt: fallbackFetchedAt.toISOString(),
      expiresAt: new Date(
        fallbackFetchedAt.getTime() + airportResourceAdapter.policy.ttlSeconds * 1000
      ).toISOString(),
      policyVersion: airportResourceAdapter.policy.policyVersion,
      source: 'upstream'
    }
  };
}

export const airportResourceAdapter: CacheResourceAdapter<AirportResourceInput, unknown, AirportResourceData> = {
  resource: 'airport',
  schemaVersion: 2,
  normalizeKey: (input) => normalizeAirportIcao(input.icao),
  fetchUpstream: async () => {
    throw new Error('Airport adapter upstream fetch is not implemented yet.');
  },
  validate: () => {
    throw new Error('Airport adapter validation is not implemented yet.');
  },
  serialize: serializeAirport,
  deserialize: (cached) => {
    if (!cached || typeof cached !== 'object') {
      return null;
    }

    const envelopeData = (cached as { data?: unknown }).data;
    return toAirportData(envelopeData ?? cached);
  },
  policy: {
    ttlSeconds: 86400,
    staleWhileRevalidateSeconds: 21600,
    staleOnErrorSeconds: 172800,
    negativeCacheTtlSeconds: 600,
    policyVersion: 'airport-v1'
  },
  observability: (input, key) => ({
    labels: {
      resource: 'airport',
      key,
      icao: normalizeAirportIcao(input.icao)
    }
  })
};
