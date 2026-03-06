export interface NormalizedCacheMetadata<TStatus extends string, TSource extends string> {
  status: TStatus;
  source: TSource;
  ageSeconds: number;
  fetchedAt: string;
  servedAt: string;
  ttlSeconds: number;
  key: string;
  resource: string;
}

interface NormalizeCacheMetadataOptions<TStatus extends string, TSource extends string> {
  cacheCandidate: unknown;
  headers: Headers;
  fallbackFetchedAt: string;
  resource: string;
  statusFromHeaders: (headers: Headers) => TStatus;
  sourceFromStatus: (status: TStatus) => TSource;
  isStatus: (value: unknown) => value is TStatus;
  isSource: (value: unknown) => value is TSource;
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && value >= 0 ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export function normalizeCacheMetadata<TStatus extends string, TSource extends string>(
  options: NormalizeCacheMetadataOptions<TStatus, TSource>
): NormalizedCacheMetadata<TStatus, TSource> {
  const nowIso = new Date().toISOString();
  const headerStatus = options.statusFromHeaders(options.headers);
  const fallback = {
    status: headerStatus,
    source: options.sourceFromStatus(headerStatus)
  };

  if (!options.cacheCandidate || typeof options.cacheCandidate !== 'object') {
    return {
      ...fallback,
      ageSeconds: 0,
      fetchedAt: options.fallbackFetchedAt,
      servedAt: nowIso,
      ttlSeconds: 0,
      key: '',
      resource: options.resource
    };
  }

  const candidate = options.cacheCandidate as Record<string, unknown>;
  const status = options.isStatus(candidate.status) ? candidate.status : fallback.status;
  const source = options.isSource(candidate.source) ? candidate.source : options.sourceFromStatus(status);

  return {
    status,
    source,
    ageSeconds: readNonNegativeNumber(candidate.ageSeconds, 0),
    fetchedAt: readString(candidate.fetchedAt, options.fallbackFetchedAt),
    servedAt: readString(candidate.servedAt, nowIso),
    ttlSeconds: readNonNegativeNumber(candidate.ttlSeconds, 0),
    key: readString(candidate.key, ''),
    resource: readString(candidate.resource, options.resource)
  };
}
