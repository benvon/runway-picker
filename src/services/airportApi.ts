import type { AirportFrequency, RunwayEnd } from '../domain/types';
import {
  normalizeCacheMetadata as normalizeSharedCacheMetadata,
  type NormalizedCacheMetadata
} from './cacheMetadata';

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
  frequencies: AirportFrequency[];
  source: 'airportdb';
  fetchedAt: string;
  cache: AirportCacheMetadata;
}

export type AirportLookupErrorCode =
  | 'INVALID_ICAO'
  | 'RATE_LIMITED'
  | 'SERVICE_NOT_CONFIGURED'
  | 'AUTH_ERROR'
  | 'ICAO_NOT_FOUND'
  | 'RUNWAY_DATA_UNAVAILABLE'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_PAYLOAD_INVALID'
  | 'CACHE_ERROR'
  | 'UNEXPECTED'
  | 'UNKNOWN';

export class AirportLookupError extends Error {
  status: number;
  code: AirportLookupErrorCode;

  constructor(message: string, status: number, code: AirportLookupErrorCode = 'UNKNOWN') {
    super(message);
    this.name = 'AirportLookupError';
    this.status = status;
    this.code = code;
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

function normalizeCacheMetadataValue(
  cacheCandidate: unknown,
  headers: Headers,
  fallbackFetchedAt: string
): AirportCacheMetadata {
  return normalizeSharedCacheMetadata({
    cacheCandidate,
    headers,
    fallbackFetchedAt,
    resource: 'airport',
    statusFromHeaders,
    sourceFromStatus,
    isStatus: isCacheStatus,
    isSource: isCacheSource
  }) as NormalizedCacheMetadata<AirportCacheStatus, AirportCacheSource>;
}

function readAirportErrorPayload(
  payload: { error?: string; message?: string; code?: unknown },
  fallbackMessage: string
): { message: string; code: AirportLookupErrorCode } {
  const message = payload.error ?? payload.message ?? fallbackMessage;
  const code = typeof payload.code === 'string' ? (payload.code as AirportLookupErrorCode) : 'UNKNOWN';
  return { message, code };
}

async function throwAirportLookupError(response: Response, icao: string): Promise<never> {
  const fallbackMessage = `Unable to load airport data for ${icao}.`;
  const parsedPayload = await response
    .json()
    .then((payload) => payload as { error?: string; message?: string; code?: unknown })
    .catch(() => null);
  if (!parsedPayload) {
    throw new AirportLookupError(fallbackMessage, response.status, 'UNKNOWN');
  }

  const { message, code } = readAirportErrorPayload(parsedPayload, fallbackMessage);
  throw new AirportLookupError(message, response.status, code);
}

function assertAirportPayloadShape(
  payload: Omit<AirportLookupResponse, 'cache' | 'runwayEnds'> & {
    cache?: unknown;
    runwayEnds?: unknown;
  }
): void {
  if (typeof payload.icao !== 'string' || typeof payload.requestedIcao !== 'string' || typeof payload.name !== 'string') {
    throw new AirportLookupError('Airport response contains invalid airport fields.', 502, 'UNEXPECTED');
  }
}

function normalizeRunwayEnds(runwayCandidate: unknown): RunwayEnd[] {
  if (!Array.isArray(runwayCandidate)) {
    throw new AirportLookupError('Airport response is missing runway data.', 502, 'UNEXPECTED');
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
    throw new AirportLookupError('Airport response does not contain usable runway ends.', 502, 'UNEXPECTED');
  }

  return parsed;
}

function normalizeFrequencies(frequencyCandidate: unknown): AirportFrequency[] {
  if (!Array.isArray(frequencyCandidate)) {
    return [];
  }

  return frequencyCandidate
    .filter((frequency): frequency is AirportFrequency => {
      return (
        Boolean(frequency) &&
        typeof frequency === 'object' &&
        typeof (frequency as { type?: unknown }).type === 'string' &&
        typeof (frequency as { description?: unknown }).description === 'string' &&
        typeof (frequency as { frequencyMhz?: unknown }).frequencyMhz === 'string'
      );
    })
    .map((frequency) => ({
      type: frequency.type,
      description: frequency.description,
      frequencyMhz: frequency.frequencyMhz
    }));
}

export async function fetchAirportByIcao(icaoInput: string): Promise<AirportLookupResponse> {
  const icao = normalizeIcaoInput(icaoInput);
  if (!/^[A-Z0-9]{4}$/.test(icao)) {
    throw new AirportLookupError('Enter a valid 4-character ICAO code, for example KJFK.', 400, 'INVALID_ICAO');
  }

  const response = await fetch(`/api/airport?icao=${encodeURIComponent(icao)}`, {
    method: 'GET',
    cache: 'no-store',
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    return throwAirportLookupError(response, icao);
  }

  const payload = (await response.json()) as Omit<AirportLookupResponse, 'cache' | 'runwayEnds'> & {
    cache?: unknown;
    runwayEnds?: unknown;
    frequencies?: unknown;
  };
  assertAirportPayloadShape(payload);

  return {
    requestedIcao: payload.requestedIcao,
    icao: payload.icao,
    name: payload.name,
    municipality: typeof payload.municipality === 'string' ? payload.municipality : '',
    countryCode: typeof payload.countryCode === 'string' ? payload.countryCode : '',
    countryName: typeof payload.countryName === 'string' ? payload.countryName : '',
    elevationFt: typeof payload.elevationFt === 'number' ? payload.elevationFt : null,
    runwayEnds: normalizeRunwayEnds(payload.runwayEnds),
    frequencies: normalizeFrequencies(payload.frequencies),
    source: payload.source,
    fetchedAt: payload.fetchedAt,
    cache: normalizeCacheMetadataValue(payload.cache, response.headers, payload.fetchedAt)
  };
}
