import type { CacheEnvelope, CacheResourceAdapter } from '../../cache/types';

const AIRPORT_DB_BASE_URL = 'https://airportdb.io/api/v1/airport';
const USER_AGENT = 'benvon-runway-picker';

export const AIRPORT_SCHEMA_VERSION = 4;

export interface AirportResourceInput {
  icao: string;
}

export interface AirportRunwayEnd {
  id: string;
  headingDegMag: number;
  isClosed: boolean;
}

export interface AirportResourceData {
  requestedIcao: string;
  icao: string;
  name: string;
  municipality: string;
  countryCode: string;
  countryName: string;
  elevationFt: number | null;
  runwayEnds: AirportRunwayEnd[];
  source: 'airportdb';
  fetchedAt: string;
}

interface AirportDbPayload {
  ident?: unknown;
  icao_code?: unknown;
  name?: unknown;
  municipality?: unknown;
  iso_country?: unknown;
  country?: unknown;
  elevation_ft?: unknown;
  runways?: unknown;
}

interface AirportDbRunway {
  closed?: unknown;
  le_ident?: unknown;
  he_ident?: unknown;
}

export class AirportWorkerError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'AirportWorkerError';
    this.status = status;
  }
}

export function normalizeAirportIcao(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(normalized)) {
    throw new AirportWorkerError('Invalid ICAO code. Expected 4 alphanumeric characters.', 400);
  }

  return normalized;
}

function toStringValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toIntegerValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }

  return Number.parseInt(trimmed, 10);
}

function isRunwayClosed(value: unknown): boolean {
  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function toRunwayEnd(identCandidate: unknown, isClosed: boolean): AirportRunwayEnd | null {
  const ident = toStringValue(identCandidate)?.toUpperCase() ?? null;
  if (!ident) {
    return null;
  }

  const match = ident.match(/^(0?[1-9]|[12][0-9]|3[0-6])([LCR])?$/i);
  if (!match) {
    return null;
  }

  const runwayNumber = Number.parseInt(match[1], 10);
  const suffix = match[2] ?? '';

  return {
    id: `${String(runwayNumber).padStart(2, '0')}${suffix}`,
    headingDegMag: runwayNumber === 36 ? 360 : runwayNumber * 10,
    isClosed
  };
}

function toAirportData(candidate: unknown): AirportResourceData | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const asData = candidate as Partial<AirportResourceData>;
  if (
    typeof asData.requestedIcao !== 'string' ||
    typeof asData.icao !== 'string' ||
    typeof asData.name !== 'string' ||
    typeof asData.municipality !== 'string' ||
    typeof asData.countryCode !== 'string' ||
    typeof asData.countryName !== 'string' ||
    !Array.isArray(asData.runwayEnds) ||
    typeof asData.fetchedAt !== 'string' ||
    asData.source !== 'airportdb'
  ) {
    return null;
  }

  const runwayEnds = asData.runwayEnds
    .filter((runway): runway is AirportRunwayEnd => {
      return (
        Boolean(runway) &&
        typeof runway === 'object' &&
        typeof (runway as { id?: unknown }).id === 'string' &&
        typeof (runway as { headingDegMag?: unknown }).headingDegMag === 'number' &&
        typeof (runway as { isClosed?: unknown }).isClosed === 'boolean'
      );
    })
    .map((runway) => ({
      id: runway.id,
      headingDegMag: runway.headingDegMag,
      isClosed: runway.isClosed
    }));

  if (runwayEnds.length === 0) {
    return null;
  }

  return {
    requestedIcao: asData.requestedIcao,
    icao: asData.icao,
    name: asData.name,
    municipality: asData.municipality,
    countryCode: asData.countryCode,
    countryName: asData.countryName,
    elevationFt: typeof asData.elevationFt === 'number' ? asData.elevationFt : null,
    runwayEnds,
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

function buildAirportDbUrl(icao: string, token: string): string {
  const url = new URL(`${AIRPORT_DB_BASE_URL}/${encodeURIComponent(icao)}`);
  url.searchParams.set('apiToken', token);
  return url.toString();
}

function toAirportDbPayload(candidate: unknown): AirportDbPayload {
  if (!candidate || typeof candidate !== 'object') {
    throw new AirportWorkerError('Airport provider returned an invalid payload.', 502);
  }

  return candidate as AirportDbPayload;
}

function toCountryName(payload: AirportDbPayload): string {
  const direct = toStringValue((payload.country as { name?: unknown } | undefined)?.name);
  if (direct) {
    return direct;
  }

  return '';
}

export const airportResourceAdapter: CacheResourceAdapter<AirportResourceInput, unknown, AirportResourceData> = {
  resource: 'airport',
  schemaVersion: AIRPORT_SCHEMA_VERSION,
  normalizeKey: (input) => normalizeAirportIcao(input.icao),
  fetchUpstream: async (input, ctx) => {
    const icao = normalizeAirportIcao(input.icao);
    const token = ctx.env.AIRPORTDB_API_TOKEN?.trim();

    if (!token) {
      throw new AirportWorkerError('Airport lookup service is not configured.', 500);
    }

    const response = await fetch(buildAirportDbUrl(icao, token), {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json'
      }
    });

    if (response.status === 401 || response.status === 403) {
      throw new AirportWorkerError('Airport lookup service token is invalid or missing privileges.', 502);
    }

    if (response.status === 404) {
      throw new AirportWorkerError(`ICAO code ${icao} was not found in airport database.`, 404);
    }

    if (!response.ok) {
      throw new AirportWorkerError(`Airport provider returned status ${response.status}.`, 502);
    }

    return response.json();
  },
  validate: (upstream, input) => {
    const requestedIcao = normalizeAirportIcao(input.icao);
    const payload = toAirportDbPayload(upstream);

    const payloadIcao =
      toStringValue(payload.icao_code)?.toUpperCase() ??
      toStringValue(payload.ident)?.toUpperCase() ??
      requestedIcao;

    const runways = Array.isArray(payload.runways) ? (payload.runways as AirportDbRunway[]) : [];
    const runwayMap = new Map<string, AirportRunwayEnd>();

    for (const runway of runways) {
      if (!runway || typeof runway !== 'object') {
        continue;
      }

      const runwayClosed = isRunwayClosed(runway.closed);
      const le = toRunwayEnd(runway.le_ident, runwayClosed);
      const he = toRunwayEnd(runway.he_ident, runwayClosed);

      if (le) {
        const existing = runwayMap.get(le.id);
        if (!existing || (existing.isClosed && !le.isClosed)) {
          runwayMap.set(le.id, le);
        }
      }

      if (he) {
        const existing = runwayMap.get(he.id);
        if (!existing || (existing.isClosed && !he.isClosed)) {
          runwayMap.set(he.id, he);
        }
      }
    }

    const runwayEnds = [...runwayMap.values()].sort((a, b) => a.id.localeCompare(b.id));
    if (runwayEnds.length === 0) {
      throw new AirportWorkerError(`No runway data is available for ICAO ${requestedIcao}.`, 404);
    }

    return {
      requestedIcao,
      icao: payloadIcao,
      name: toStringValue(payload.name) ?? requestedIcao,
      municipality: toStringValue(payload.municipality) ?? '',
      countryCode: toStringValue(payload.iso_country) ?? '',
      countryName: toCountryName(payload),
      elevationFt: toIntegerValue(payload.elevation_ft),
      runwayEnds,
      source: 'airportdb',
      fetchedAt: new Date().toISOString()
    };
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
    staleWhileRevalidateSeconds: 43200,
    staleOnErrorSeconds: 259200,
    negativeCacheTtlSeconds: 3600,
    policyVersion: 'airport-v2'
  },
  observability: (input, key) => ({
    labels: {
      resource: 'airport',
      key,
      icao: normalizeAirportIcao(input.icao)
    }
  })
};
