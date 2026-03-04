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
  | 'PROVIDER_ERROR'
  | 'PROVIDER_PAYLOAD_INVALID'
  | 'PROVIDER_VALIDATION_ERROR'
  | 'ICAO_NOT_FOUND'
  | 'METAR_UNAVAILABLE'
  | 'WIND_PARSE_ERROR'
  | 'CACHE_ERROR'
  | 'UNEXPECTED'
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

function normalizeCacheMetadata(
  cacheCandidate: unknown,
  headers: Headers,
  fallbackFetchedAt: string
): MetarCacheMetadata {
  const nowIso = new Date().toISOString();

  if (cacheCandidate && typeof cacheCandidate === 'object') {
    const candidate = cacheCandidate as Partial<MetarCacheMetadata>;
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
      resource: typeof candidate.resource === 'string' ? candidate.resource : 'metar'
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
    resource: 'metar'
  };
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
    let message = `Unable to load METAR for ${icao}.`;
    let debug: unknown;
    let code: MetarLookupErrorCode = 'UNKNOWN';

    try {
      const errorPayload = (await response.json()) as {
        error?: string;
        message?: string;
        debug?: unknown;
        code?: unknown;
      };
      message = errorPayload.error ?? errorPayload.message ?? message;
      debug = errorPayload.debug;
      if (typeof errorPayload.code === 'string') {
        code = errorPayload.code as MetarLookupErrorCode;
      }
    } catch {
      // Keep default message when body isn't JSON.
    }

    throw new MetarLookupError(message, response.status, debug, code);
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
    cache: normalizeCacheMetadata(payload.cache, response.headers, payload.fetchedAt)
  };
}
