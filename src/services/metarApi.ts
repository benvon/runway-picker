import {
  normalizeCacheMetadata as normalizeSharedCacheMetadata,
  type NormalizedCacheMetadata
} from './cacheMetadata';

export type MetarCacheStatus =
  | 'edge_hit'
  | 'kv_hit'
  | 'upstream_refresh'
  | 'stale_while_refresh'
  | 'stale_on_error'
  | 'unknown';

export type MetarCacheSource = 'edge' | 'kv' | 'upstream' | 'stale' | 'unknown';

export interface MetarCacheMetadata {
  status: MetarCacheStatus;
  source: MetarCacheSource;
  ageSeconds: number;
  fetchedAt: string;
  servedAt: string;
  ttlSeconds: number;
  key: string;
  resource: string;
}

export interface MetarLookupResponse {
  icao: string;
  metarRaw: string;
  wind: MetarLookupWind;
  source: 'aviationweather';
  fetchedAt: string;
  cache: MetarCacheMetadata;
}

export interface MetarLookupWind {
  raw: string;
  directionType: 'fixed' | 'variable' | 'calm';
  directionDegTrue: number | null;
  speedKt: number;
  gustKt: number | null;
}

export type MetarLookupErrorCode =
  | 'INVALID_ICAO'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_PAYLOAD_INVALID'
  | 'PROVIDER_VALIDATION_ERROR'
  | 'ICAO_NOT_FOUND'
  | 'METAR_UNAVAILABLE'
  | 'WIND_PARSE_ERROR'
  | 'CACHE_ERROR'
  | 'UNEXPECTED'
  | 'SERVICE_NOT_CONFIGURED'
  | 'UNKNOWN';

export class MetarLookupError extends Error {
  status: number;
  code: MetarLookupErrorCode;
  debug?: unknown;

  constructor(message: string, status: number, debug?: unknown, code: MetarLookupErrorCode = 'UNKNOWN') {
    super(message);
    this.name = 'MetarLookupError';
    this.status = status;
    this.code = code;
    this.debug = debug;
  }
}

function normalizeIcaoInput(value: string): string {
  return value.trim().toUpperCase();
}

function isCacheStatus(value: unknown): value is MetarCacheStatus {
  return (
    value === 'edge_hit' ||
    value === 'kv_hit' ||
    value === 'upstream_refresh' ||
    value === 'stale_while_refresh' ||
    value === 'stale_on_error' ||
    value === 'unknown'
  );
}

function isCacheSource(value: unknown): value is MetarCacheSource {
  return value === 'edge' || value === 'kv' || value === 'upstream' || value === 'stale' || value === 'unknown';
}

function statusFromHeaders(headers: Headers): MetarCacheStatus {
  const runwayHeader = headers.get('X-Runway-Cache-Status')?.trim();
  if (runwayHeader && isCacheStatus(runwayHeader)) {
    return runwayHeader;
  }

  return 'unknown';
}

function sourceFromStatus(status: MetarCacheStatus): MetarCacheSource {
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
): MetarCacheMetadata {
  return normalizeSharedCacheMetadata({
    cacheCandidate,
    headers,
    fallbackFetchedAt,
    resource: 'metar',
    statusFromHeaders,
    sourceFromStatus,
    isStatus: isCacheStatus,
    isSource: isCacheSource
  }) as NormalizedCacheMetadata<MetarCacheStatus, MetarCacheSource>;
}

function readMetarErrorPayload(
  payload: { error?: string; message?: string; debug?: unknown; code?: unknown },
  fallbackMessage: string
): { message: string; debug: unknown; code: MetarLookupErrorCode } {
  const message = payload.error ?? payload.message ?? fallbackMessage;
  const code = typeof payload.code === 'string' ? (payload.code as MetarLookupErrorCode) : 'UNKNOWN';
  return {
    message,
    debug: payload.debug,
    code
  };
}

async function throwMetarLookupError(response: Response, icao: string): Promise<never> {
  const fallbackMessage = `Unable to load METAR for ${icao}.`;
  const parsedPayload = await response
    .json()
    .then((payload) => payload as {
      error?: string;
      message?: string;
      debug?: unknown;
      code?: unknown;
    })
    .catch(() => null);
  if (!parsedPayload) {
    throw new MetarLookupError(fallbackMessage, response.status, undefined, 'UNKNOWN');
  }

  const { message, debug, code } = readMetarErrorPayload(parsedPayload, fallbackMessage);
  throw new MetarLookupError(message, response.status, debug, code);
}

function normalizeWindPayload(windCandidate: unknown): MetarLookupWind {
  if (!windCandidate || typeof windCandidate !== 'object') {
    throw new MetarLookupError('METAR response is missing structured wind data.', 502, undefined, 'UNEXPECTED');
  }

  const candidate = windCandidate as Partial<MetarLookupWind>;
  if (
    typeof candidate.raw !== 'string' ||
    (candidate.directionType !== 'fixed' &&
      candidate.directionType !== 'variable' &&
      candidate.directionType !== 'calm') ||
    typeof candidate.speedKt !== 'number'
  ) {
    throw new MetarLookupError('METAR response contains invalid structured wind data.', 502, undefined, 'UNEXPECTED');
  }

  return {
    raw: candidate.raw,
    directionType: candidate.directionType,
    directionDegTrue: typeof candidate.directionDegTrue === 'number' ? candidate.directionDegTrue : null,
    speedKt: candidate.speedKt,
    gustKt: typeof candidate.gustKt === 'number' ? candidate.gustKt : null
  };
}

export async function fetchMetarByIcao(icaoInput: string): Promise<MetarLookupResponse> {
  const icao = normalizeIcaoInput(icaoInput);
  if (!/^[A-Z0-9]{4}$/.test(icao)) {
    throw new MetarLookupError('Enter a valid 4-character ICAO code, for example KJFK.', 400, undefined, 'INVALID_ICAO');
  }

  const response = await fetch(`/api/metar?icao=${encodeURIComponent(icao)}`, {
    method: 'GET',
    cache: 'no-store',
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    return throwMetarLookupError(response, icao);
  }

  const payload = (await response.json()) as Omit<MetarLookupResponse, 'cache'> & {
    cache?: unknown;
  };

  return {
    icao: payload.icao,
    metarRaw: payload.metarRaw,
    wind: normalizeWindPayload((payload as { wind?: unknown }).wind),
    source: payload.source,
    fetchedAt: payload.fetchedAt,
    cache: normalizeCacheMetadataValue(payload.cache, response.headers, payload.fetchedAt)
  };
}
