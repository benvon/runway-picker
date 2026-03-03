import type { RunwayEnd } from '../domain/types';

export type AirportCacheStatus =
  | 'edge_hit'
  | 'kv_hit'
  | 'upstream_refresh'
  | 'stale_while_refresh'
  | 'stale_on_error'
  | 'unknown';

export type AirportCacheSource = 'edge' | 'kv' | 'upstream' | 'stale' | 'unknown';

export interface AirportCacheMetadata {
  status: AirportCacheStatus;
  source: AirportCacheSource;
  ageSeconds: number;
  fetchedAt: string;
  servedAt: string;
  ttlSeconds: number;
  key: string;
  resource: string;
}

export interface AirportLookupResponse {
  requestedIcao: string;
  icao: string;
  name: string;
  municipality: string;
  countryCode: string;
  countryName: string;
  elevationFt: number | null;
  runwayEnds: RunwayEnd[];
  source: 'airportdb';
  fetchedAt: string;
  cache: AirportCacheMetadata;
}

export class AirportLookupError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'AirportLookupError';
    this.status = status;
  }
}

function normalizeIcaoInput(value: string): string {
  return value.trim().toUpperCase();
}

function isCacheStatus(value: unknown): value is AirportCacheStatus {
  return (
    value === 'edge_hit' ||
    value === 'kv_hit' ||
    value === 'upstream_refresh' ||
    value === 'stale_while_refresh' ||
    value === 'stale_on_error' ||
    value === 'unknown'
  );
}

function isCacheSource(value: unknown): value is AirportCacheSource {
  return value === 'edge' || value === 'kv' || value === 'upstream' || value === 'stale' || value === 'unknown';
}

function statusFromHeaders(headers: Headers): AirportCacheStatus {
  const runwayHeader = headers.get('X-Runway-Cache-Status')?.trim();
  if (runwayHeader && isCacheStatus(runwayHeader)) {
    return runwayHeader;
  }

  return 'unknown';
}

function sourceFromStatus(status: AirportCacheStatus): AirportCacheSource {
  if (status === 'edge_hit') {
    return 'edge';
  }

  if (status === 'kv_hit') {
    return 'kv';
  }

  if (status === 'upstream_refresh') {
    return 'upstream';
  }

  if (status === 'stale_on_error' || status === 'stale_while_refresh') {
    return 'stale';
  }

  return 'unknown';
}

function normalizeCacheMetadata(
  cacheCandidate: unknown,
  headers: Headers,
  fallbackFetchedAt: string
): AirportCacheMetadata {
  const nowIso = new Date().toISOString();

  if (cacheCandidate && typeof cacheCandidate === 'object') {
    const candidate = cacheCandidate as Partial<AirportCacheMetadata>;
    const status = isCacheStatus(candidate.status) ? candidate.status : statusFromHeaders(headers);
    const source = isCacheSource(candidate.source) ? candidate.source : sourceFromStatus(status);

    return {
      status,
      source,
      ageSeconds: typeof candidate.ageSeconds === 'number' && candidate.ageSeconds >= 0 ? candidate.ageSeconds : 0,
      fetchedAt: typeof candidate.fetchedAt === 'string' ? candidate.fetchedAt : fallbackFetchedAt,
      servedAt: typeof candidate.servedAt === 'string' ? candidate.servedAt : nowIso,
      ttlSeconds: typeof candidate.ttlSeconds === 'number' && candidate.ttlSeconds >= 0 ? candidate.ttlSeconds : 0,
      key: typeof candidate.key === 'string' ? candidate.key : '',
      resource: typeof candidate.resource === 'string' ? candidate.resource : 'airport'
    };
  }

  const status = statusFromHeaders(headers);
  return {
    status,
    source: sourceFromStatus(status),
    ageSeconds: 0,
    fetchedAt: fallbackFetchedAt,
    servedAt: nowIso,
    ttlSeconds: 0,
    key: '',
    resource: 'airport'
  };
}

function normalizeRunwayEnds(runwayCandidate: unknown): RunwayEnd[] {
  if (!Array.isArray(runwayCandidate)) {
    throw new AirportLookupError('Airport response is missing runway data.', 502);
  }

  const parsed = runwayCandidate
    .filter((runway): runway is RunwayEnd => {
      return (
        Boolean(runway) &&
        typeof runway === 'object' &&
        typeof (runway as { id?: unknown }).id === 'string' &&
        typeof (runway as { headingDegMag?: unknown }).headingDegMag === 'number'
      );
    })
    .map((runway) => ({
      id: runway.id,
      headingDegMag: runway.headingDegMag,
      isClosed: typeof (runway as { isClosed?: unknown }).isClosed === 'boolean' ? runway.isClosed : false,
      lengthFt:
        typeof (runway as { lengthFt?: unknown }).lengthFt === 'number'
          ? runway.lengthFt
          : null
    }));

  if (parsed.length === 0) {
    throw new AirportLookupError('Airport response does not contain usable runway ends.', 502);
  }

  return parsed;
}

export async function fetchAirportByIcao(icaoInput: string): Promise<AirportLookupResponse> {
  const icao = normalizeIcaoInput(icaoInput);
  if (!/^[A-Z0-9]{4}$/.test(icao)) {
    throw new AirportLookupError('Enter a valid 4-character ICAO code, for example KJFK.', 400);
  }

  const response = await fetch(`/api/airport?icao=${encodeURIComponent(icao)}`, {
    method: 'GET',
    cache: 'no-store',
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    let message = `Unable to load airport data for ${icao}.`;

    try {
      const errorPayload = (await response.json()) as { error?: string; message?: string };
      message = errorPayload.error ?? errorPayload.message ?? message;
    } catch {
      // Keep default message when body isn't JSON.
    }

    throw new AirportLookupError(message, response.status);
  }

  const payload = (await response.json()) as Omit<AirportLookupResponse, 'cache' | 'runwayEnds'> & {
    cache?: unknown;
    runwayEnds?: unknown;
  };

  if (typeof payload.icao !== 'string' || typeof payload.requestedIcao !== 'string' || typeof payload.name !== 'string') {
    throw new AirportLookupError('Airport response contains invalid airport fields.', 502);
  }

  return {
    requestedIcao: payload.requestedIcao,
    icao: payload.icao,
    name: payload.name,
    municipality: typeof payload.municipality === 'string' ? payload.municipality : '',
    countryCode: typeof payload.countryCode === 'string' ? payload.countryCode : '',
    countryName: typeof payload.countryName === 'string' ? payload.countryName : '',
    elevationFt: typeof payload.elevationFt === 'number' ? payload.elevationFt : null,
    runwayEnds: normalizeRunwayEnds(payload.runwayEnds),
    source: payload.source,
    fetchedAt: payload.fetchedAt,
    cache: normalizeCacheMetadata(payload.cache, response.headers, payload.fetchedAt)
  };
}
