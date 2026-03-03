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
  source: 'aviationweather';
  fetchedAt: string;
  cache: MetarCacheMetadata;
}

export class MetarLookupError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'MetarLookupError';
    this.status = status;
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

function statusFromLegacyHeader(headers: Headers): MetarCacheStatus {
  const runwayHeader = headers.get('X-Runway-Cache-Status')?.trim();
  if (runwayHeader && isCacheStatus(runwayHeader)) {
    return runwayHeader;
  }

  const cacheHeader = headers.get('X-Cache')?.trim().toUpperCase();
  if (cacheHeader === 'HIT') {
    return 'kv_hit';
  }

  if (cacheHeader === 'MISS') {
    return 'upstream_refresh';
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
    const status = isCacheStatus(candidate.status) ? candidate.status : statusFromLegacyHeader(headers);
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

  const status = statusFromLegacyHeader(headers);
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

export async function fetchMetarByIcao(icaoInput: string): Promise<MetarLookupResponse> {
  const icao = normalizeIcaoInput(icaoInput);
  if (!/^[A-Z0-9]{4}$/.test(icao)) {
    throw new MetarLookupError('Enter a valid 4-character ICAO code, for example KJFK.', 400);
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

    try {
      const errorPayload = (await response.json()) as { error?: string; message?: string };
      message = errorPayload.error ?? errorPayload.message ?? message;
    } catch {
      // Keep default message when body isn't JSON.
    }

    throw new MetarLookupError(message, response.status);
  }

  const payload = (await response.json()) as Omit<MetarLookupResponse, 'cache'> & {
    cache?: unknown;
  };

  return {
    icao: payload.icao,
    metarRaw: payload.metarRaw,
    source: payload.source,
    fetchedAt: payload.fetchedAt,
    cache: normalizeCacheMetadata(payload.cache, response.headers, payload.fetchedAt)
  };
}
