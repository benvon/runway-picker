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

export interface CacheObservability {
  labels: Record<string, string>;
}

export interface CacheAdapterContext {
  request: Request;
}

export interface CacheResourceAdapter<TInput, TUpstream, TData> {
  resource: string;
  schemaVersion: number;
  normalizeKey: (input: TInput) => string;
  fetchUpstream: (input: TInput, ctx: CacheAdapterContext) => Promise<TUpstream>;
  validate: (upstream: TUpstream, input: TInput, ctx: CacheAdapterContext) => Promise<TData> | TData;
  serialize: (data: TData, key: string, resource: string) => CacheEnvelope<TData>;
  deserialize: (cached: unknown) => TData | null;
  policy: CachePolicy;
  observability: (input: TInput, key: string) => CacheObservability;
}

export interface CacheProvenance {
  status: CacheStatus;
  source: CacheDataSource;
  ageSeconds: number;
  fetchedAt: string;
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
}

export interface CacheEngineEnv {
  METAR_CACHE: KvNamespaceLike;
  CACHE_COORDINATOR?: DurableObjectNamespaceLike;
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
