export type CacheDataSource = 'edge' | 'kv' | 'upstream' | 'stale';

export type CacheStatus =
  | 'edge_hit'
  | 'kv_hit'
  | 'upstream_refresh'
  | 'stale_while_refresh'
  | 'stale_on_error';

export interface CachePolicy {
  ttlSeconds: number;
  staleWhileRevalidateSeconds: number;
  staleOnErrorSeconds: number;
  negativeCacheTtlSeconds: number;
  policyVersion: string;
}

export interface CacheEnvelopeMeta {
  fetchedAt: string;
  expiresAt: string;
  policyVersion: string;
  source: 'upstream';
}

export interface CacheEnvelope<TData> {
  schemaVersion: number;
  resource: string;
  key: string;
  data: TData;
  cacheMeta: CacheEnvelopeMeta;
}

/** A stable adapter-approved 404 that may be retained briefly. */
export interface StableNegativeCacheEntry {
  status: 404;
  code: string;
}

export interface NegativeCacheEnvelope {
  schemaVersion: number;
  resource: string;
  key: string;
  negative: StableNegativeCacheEntry;
  cacheMeta: CacheEnvelopeMeta;
}

export interface NegativeCachePolicy<TInput> {
  toEntry: (error: unknown) => StableNegativeCacheEntry | null;
  toError: (entry: StableNegativeCacheEntry, input: TInput) => Error | null;
}

export interface CacheObservability {
  labels: Record<string, string>;
}

export interface CacheAdapterContext {
  request: Request;
  env: CacheEngineEnv;
}

export interface CacheResourceAdapter<TInput, TUpstream, TData> {
  resource: string;
  schemaVersion: number;
  normalizeKey: (input: TInput) => string;
  fetchUpstream: (input: TInput, ctx: CacheAdapterContext) => Promise<TUpstream>;
  validate: (upstream: TUpstream, input: TInput, ctx: CacheAdapterContext) => Promise<TData> | TData;
  serialize: (data: TData, key: string, resource: string, upstream?: TUpstream) => CacheEnvelope<TData>;
  deserialize: (cached: unknown) => TData | null;
  policy: CachePolicy;
  negativeCache?: NegativeCachePolicy<TInput>;
  observability: (input: TInput, key: string) => CacheObservability;
}

export interface CacheProvenance {
  status: CacheStatus;
  source: CacheDataSource;
  ageSeconds: number;
  fetchedAt: string;
  /** Exact record expiry selected by the cache engine. */
  expiresAt: string;
  /**
   * Whole seconds for which this response may still be treated as fresh.
   * This is bounded to the adapter policy TTL and never negative.
   */
  freshnessRemainingSeconds: number;
  servedAt: string;
  ttlSeconds: number;
  key: string;
  resource: string;
}

export interface CacheEngineResult<TData> {
  payload: TData;
  cache: CacheProvenance;
}

export interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

export interface KvNamespaceLike {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  list?(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
  delete?(key: string): Promise<void>;
}

export interface CacheEngineEnv {
  METAR_CACHE: KvNamespaceLike;
  CACHE_COORDINATOR?: DurableObjectNamespaceLike;
  API_RATE_LIMITER?: DurableObjectNamespaceLike;
  AIRPORTDB_API_TOKEN?: string;
  APP_ENV?: string;
  ENABLE_DEBUG_ERRORS?: string;
  CACHE_REFRESH_ENABLED?: string;
  CACHE_REFRESH_METAR_INTERVAL_SECONDS?: string;
  CACHE_REFRESH_AIRPORT_INTERVAL_SECONDS?: string;
  CACHE_REFRESH_INACTIVITY_TTL_SECONDS?: string;
  CACHE_REFRESH_MAX_ITEMS_PER_RUN?: string;
}

export interface EdgeCacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface CacheEngineInput<TInput, TUpstream, TData> {
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>;
  input: TInput;
  request: Request;
  env: CacheEngineEnv;
  edgeCache?: EdgeCacheLike;
  now?: Date;
}
