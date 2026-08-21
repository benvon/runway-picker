import { acquireSingleFlightLease, releaseSingleFlightLease } from './singleFlight';
import { buildCacheKey } from './keys';
import type {
  CacheAdapterContext,
  CacheDataSource,
  CacheEngineInput,
  CacheEngineResult,
  CacheEnvelope,
  NegativeCacheEnvelope,
  CacheProvenance,
  CacheResourceAdapter,
  EdgeCacheLike,
  StableNegativeCacheEntry
} from './types';

interface CachedRecord<TData> {
  data: TData;
  fetchedAt: Date;
  expiresAt: Date;
  envelope: CacheEnvelope<TData>;
}

interface CachedNegativeRecord {
  error: Error;
  expiresAt: Date;
  envelope: NegativeCacheEnvelope;
}

interface CacheRecords<TData> {
  data: CachedRecord<TData> | null;
  negative: CachedNegativeRecord | null;
}

const MAX_WAIT_FOR_REFRESH_MS = 2500;
const WAIT_INTERVAL_MS = 150;

export class CacheEngineError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'CacheEngineError';
    this.status = status;
  }
}

function getRuntimeEdgeCache(): EdgeCacheLike | undefined {
  const runtime = globalThis as unknown as { caches?: { default?: EdgeCacheLike } };
  return runtime.caches?.default;
}

function buildEdgeRequest(cacheKey: string): Request {
  return new Request(`https://cache.runway.internal/${encodeURIComponent(cacheKey)}`, {
    method: 'GET'
  });
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function extractFetchedAt<TData>(data: TData): Date | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const fetchedAt = (data as { fetchedAt?: unknown }).fetchedAt;
  return parseIsoDate(fetchedAt);
}

function hasCompatibleEnvelope<TInput, TUpstream, TData>(
  candidate: Partial<CacheEnvelope<TData> | NegativeCacheEnvelope>,
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string
): boolean {
  return (
    typeof candidate.schemaVersion === 'number' &&
    candidate.schemaVersion === adapter.schemaVersion &&
    typeof candidate.resource === 'string' &&
    candidate.resource === adapter.resource &&
    typeof candidate.key === 'string' &&
    candidate.key === cacheKey
  );
}

function toStableNegativeCacheEntry(value: unknown): StableNegativeCacheEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<StableNegativeCacheEntry>;
  if (candidate.status !== 404 || typeof candidate.code !== 'string') {
    return null;
  }

  return { status: 404, code: candidate.code };
}

function toCachedNegativeRecord<TInput, TUpstream, TData>(
  raw: unknown,
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  input: TInput,
  now: Date
): CachedNegativeRecord | null {
  if (!adapter.negativeCache) {
    return null;
  }

  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const candidate = raw as Partial<NegativeCacheEnvelope>;
  if (!hasCompatibleEnvelope(candidate, adapter, cacheKey)) {
    return null;
  }

  const negative = toStableNegativeCacheEntry(candidate.negative);
  if (!negative) {
    return null;
  }

  const error = adapter.negativeCache.toError(negative, input);
  if (!error) {
    return null;
  }

  const fetchedAt = parseIsoDate(candidate.cacheMeta?.fetchedAt) ?? now;
  const expiresAt =
    parseIsoDate(candidate.cacheMeta?.expiresAt) ??
    new Date(fetchedAt.getTime() + adapter.policy.negativeCacheTtlSeconds * 1000);

  return { error, expiresAt, envelope: candidate as NegativeCacheEnvelope };
}

function toCacheRecords<TInput, TUpstream, TData>(
  raw: unknown,
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  input: TInput,
  now: Date
): CacheRecords<TData> {
  return {
    data: toCachedRecord(raw, adapter, cacheKey, now),
    negative: toCachedNegativeRecord(raw, adapter, cacheKey, input, now)
  };
}

function toCachedRecord<TInput, TUpstream, TData>(
  raw: unknown,
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  now: Date
): CachedRecord<TData> | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const candidate = raw as Partial<CacheEnvelope<TData>>;
  if (!hasCompatibleEnvelope(candidate, adapter, cacheKey)) {
    return null;
  }

  const data = adapter.deserialize(raw);
  if (!data) {
    return null;
  }

  const fetchedAt =
    parseIsoDate(candidate?.cacheMeta?.fetchedAt) ?? extractFetchedAt(data) ?? now;

  const expiresAt =
    parseIsoDate(candidate?.cacheMeta?.expiresAt) ??
    new Date(fetchedAt.getTime() + adapter.policy.ttlSeconds * 1000);

  return {
    data,
    fetchedAt,
    expiresAt,
    envelope: candidate as CacheEnvelope<TData>
  };
}

function isFresh(record: CachedRecord<unknown>, now: Date): boolean {
  return record.expiresAt.getTime() > now.getTime();
}

async function throwIfFreshNegative(
  record: CachedNegativeRecord | null,
  now: Date,
  beforeThrow?: () => Promise<void>
): Promise<void> {
  if (!record || record.expiresAt.getTime() <= now.getTime()) {
    return;
  }

  await beforeThrow?.();
  throw record.error;
}

function isWithinStaleWindow(record: CachedRecord<unknown>, now: Date, staleWindowSeconds: number): boolean {
  return now.getTime() <= record.expiresAt.getTime() + staleWindowSeconds * 1000;
}

function buildProvenance(
  status: CacheProvenance['status'],
  source: CacheDataSource,
  record: CachedRecord<unknown>,
  now: Date,
  cacheKey: string,
  resource: string,
  ttlSeconds: number
): CacheProvenance {
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - record.fetchedAt.getTime()) / 1000));

  return {
    status,
    source,
    ageSeconds,
    fetchedAt: record.fetchedAt.toISOString(),
    servedAt: now.toISOString(),
    ttlSeconds,
    key: cacheKey,
    resource
  };
}

async function writeEdgeEnvelope<TData>(
  edgeCache: EdgeCacheLike | undefined,
  cacheKey: string,
  envelope: CacheEnvelope<TData> | NegativeCacheEnvelope,
  ttlSeconds: number
): Promise<void> {
  if (!edgeCache) {
    return;
  }

  const request = buildEdgeRequest(cacheKey);
  const response = Response.json(envelope, {
    headers: {
      'Cache-Control': `public, max-age=60, s-maxage=${ttlSeconds}`
    }
  });

  await edgeCache.put(request, response);
}

async function readEdgeCacheRecords<TInput, TUpstream, TData>(
  edgeCache: EdgeCacheLike | undefined,
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  input: TInput,
  now: Date
): Promise<CacheRecords<TData>> {
  if (!edgeCache) {
    return { data: null, negative: null };
  }

  const cachedResponse = await edgeCache.match(buildEdgeRequest(cacheKey));
  return toCacheRecords(cachedResponse ? await cachedResponse.json() : null, adapter, cacheKey, input, now);
}

async function readKvCacheRecords<TInput, TUpstream, TData>(
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  input: TInput,
  now: Date,
  readKv: (cacheKey: string) => Promise<unknown>
): Promise<CacheRecords<TData>> {
  return toCacheRecords(await readKv(cacheKey), adapter, cacheKey, input, now);
}

function toEnvelope<TInput, TUpstream, TData>(
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  data: TData,
  cacheKey: string,
  now: Date,
  upstream?: TUpstream
): CacheEnvelope<TData> {
  const candidate = adapter.serialize(data, cacheKey, adapter.resource, upstream);
  const serializedData = candidate.data;
  const fetchedAt = parseIsoDate(candidate?.cacheMeta?.fetchedAt) ?? extractFetchedAt(serializedData) ?? now;
  const expiresAt =
    parseIsoDate(candidate?.cacheMeta?.expiresAt) ??
    new Date(fetchedAt.getTime() + adapter.policy.ttlSeconds * 1000);

  return {
    ...((candidate as unknown) as Record<string, unknown>),
    schemaVersion: adapter.schemaVersion,
    resource: adapter.resource,
    key: cacheKey,
    data: serializedData,
    cacheMeta: {
      fetchedAt: fetchedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      policyVersion: adapter.policy.policyVersion,
      source: 'upstream'
    }
  };
}

function toNegativeEnvelope<TInput, TUpstream, TData>(
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  error: unknown,
  cacheKey: string,
  now: Date
): NegativeCacheEnvelope | null {
  const negative = adapter.negativeCache?.toEntry(error);
  if (!negative) {
    return null;
  }

  return {
    schemaVersion: adapter.schemaVersion,
    resource: adapter.resource,
    key: cacheKey,
    negative,
    cacheMeta: {
      fetchedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + adapter.policy.negativeCacheTtlSeconds * 1000).toISOString(),
      policyVersion: adapter.policy.policyVersion,
      source: 'upstream'
    }
  };
}

function chooseFresher<TData>(
  candidate: CachedRecord<TData> | null,
  current: CachedRecord<TData> | null
): CachedRecord<TData> | null {
  if (!candidate) {
    return current;
  }

  if (!current) {
    return candidate;
  }

  if (candidate.fetchedAt.getTime() >= current.fetchedAt.getTime()) {
    return candidate;
  }

  return current;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheResultFromRecord<TInput, TUpstream, TData>(
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  record: CachedRecord<TData>,
  now: Date,
  status: CacheProvenance['status'],
  source: CacheDataSource
): CacheEngineResult<TData> {
  return {
    payload: record.data,
    cache: buildProvenance(status, source, record, now, cacheKey, adapter.resource, adapter.policy.ttlSeconds)
  };
}

function toStaleCandidate<TData>(
  edgeRecord: CachedRecord<TData> | null,
  kvRecord: CachedRecord<TData> | null,
  now: Date
): CachedRecord<TData> | null {
  const staleEdge = edgeRecord && !isFresh(edgeRecord, now) ? edgeRecord : null;
  const staleKv = kvRecord && !isFresh(kvRecord, now) ? kvRecord : null;
  return chooseFresher(staleKv, staleEdge);
}

async function waitForFreshKvRecords<TInput, TUpstream, TData>(
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  input: TInput,
  readKv: (cacheKey: string) => Promise<unknown>,
  timeoutMs: number
): Promise<CacheRecords<TData> | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(WAIT_INTERVAL_MS);
    const now = new Date();
    const records = await readKvCacheRecords(adapter, cacheKey, input, now, readKv);
    if (
      (records.data && isFresh(records.data, now)) ||
      (records.negative && records.negative.expiresAt.getTime() > now.getTime())
    ) {
      return records;
    }
  }

  return null;
}

async function waitForLeaderOrServeStale<TInput, TUpstream, TData>(
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  input: TInput,
  now: Date,
  staleCandidate: CachedRecord<TData> | null,
  readKv: (cacheKey: string) => Promise<unknown>
): Promise<CacheEngineResult<TData>> {
  if (
    staleCandidate &&
    isWithinStaleWindow(staleCandidate, now, adapter.policy.staleWhileRevalidateSeconds)
  ) {
    return cacheResultFromRecord(adapter, cacheKey, staleCandidate, now, 'stale_while_refresh', 'stale');
  }

  const waitedRecords = await waitForFreshKvRecords(adapter, cacheKey, input, readKv, MAX_WAIT_FOR_REFRESH_MS);
  if (waitedRecords?.negative) {
    await throwIfFreshNegative(waitedRecords.negative, new Date());
  }
  if (waitedRecords?.data) {
    return cacheResultFromRecord(adapter, cacheKey, waitedRecords.data, new Date(), 'kv_hit', 'kv');
  }

  if (staleCandidate && isWithinStaleWindow(staleCandidate, now, adapter.policy.staleOnErrorSeconds)) {
    return cacheResultFromRecord(adapter, cacheKey, staleCandidate, now, 'stale_on_error', 'stale');
  }

  throw new CacheEngineError('Cache refresh is already in progress.', 503);
}

async function refreshFromUpstream<TInput, TUpstream, TData>(
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  input: TInput,
  context: CacheAdapterContext,
  env: CacheEngineInput<TInput, TUpstream, TData>['env'],
  edgeCache: EdgeCacheLike | undefined
): Promise<CacheEngineResult<TData>> {
  const upstreamPayload = await adapter.fetchUpstream(input, context);
  const validatedData = await adapter.validate(upstreamPayload, input, context);
  const envelope = toEnvelope(adapter, validatedData, cacheKey, new Date(), upstreamPayload);
  const retentionTtl =
    adapter.policy.ttlSeconds +
    Math.max(adapter.policy.staleWhileRevalidateSeconds, adapter.policy.staleOnErrorSeconds);

  await env.METAR_CACHE.put(cacheKey, JSON.stringify(envelope), {
    expirationTtl: retentionTtl
  });

  await writeEdgeEnvelope(edgeCache, cacheKey, envelope, adapter.policy.ttlSeconds);

  const record: CachedRecord<TData> = {
    data: envelope.data,
    fetchedAt: new Date(envelope.cacheMeta.fetchedAt),
    expiresAt: new Date(envelope.cacheMeta.expiresAt),
    envelope
  };

  return cacheResultFromRecord(adapter, cacheKey, record, new Date(), 'upstream_refresh', 'upstream');
}

async function refreshAsLeader<TInput, TUpstream, TData>(
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  input: TInput,
  context: CacheAdapterContext,
  env: CacheEngineInput<TInput, TUpstream, TData>['env'],
  edgeCache: EdgeCacheLike | undefined,
  staleCandidate: CachedRecord<TData> | null,
  now: Date
): Promise<CacheEngineResult<TData>> {
  try {
    return await refreshFromUpstream(adapter, cacheKey, input, context, env, edgeCache);
  } catch (error) {
    const negativeEnvelope = toNegativeEnvelope(adapter, error, cacheKey, new Date());
    if (negativeEnvelope) {
      await Promise.allSettled([
        env.METAR_CACHE.put(cacheKey, JSON.stringify(negativeEnvelope), {
          expirationTtl: adapter.policy.negativeCacheTtlSeconds
        }),
        writeEdgeEnvelope(edgeCache, cacheKey, negativeEnvelope, adapter.policy.negativeCacheTtlSeconds)
      ]);
      throw error;
    }

    if (staleCandidate && isWithinStaleWindow(staleCandidate, now, adapter.policy.staleOnErrorSeconds)) {
      return cacheResultFromRecord(adapter, cacheKey, staleCandidate, now, 'stale_on_error', 'stale');
    }

    if (error instanceof Error) {
      throw error;
    }

    throw new CacheEngineError('Unexpected cache refresh failure.', 500);
  }
}

export async function getOrRefreshCached<TInput, TUpstream, TData>(
  input: CacheEngineInput<TInput, TUpstream, TData>
): Promise<CacheEngineResult<TData>> {
  const { adapter, request, env } = input;
  const now = input.now ?? new Date();
  const normalizedKey = adapter.normalizeKey(input.input);
  const cacheKey = buildCacheKey(adapter.resource, normalizedKey);
  const edgeCache = input.edgeCache ?? getRuntimeEdgeCache();
  const readKv = async (key: string): Promise<unknown> => env.METAR_CACHE.get(key, 'json');
  const adapterContext: CacheAdapterContext = { request, env };

  const edgeRecords = await readEdgeCacheRecords(edgeCache, adapter, cacheKey, input.input, now);
  await throwIfFreshNegative(edgeRecords.negative, now);

  const edgeRecord = edgeRecords.data;
  if (edgeRecord && isFresh(edgeRecord, now)) {
    return cacheResultFromRecord(adapter, cacheKey, edgeRecord, now, 'edge_hit', 'edge');
  }

  const kvRecords = await readKvCacheRecords(adapter, cacheKey, input.input, now, readKv);
  const kvRecord = kvRecords.data;
  if (kvRecord && isFresh(kvRecord, now)) {
    await writeEdgeEnvelope(edgeCache, cacheKey, kvRecord.envelope, adapter.policy.ttlSeconds);
    return cacheResultFromRecord(adapter, cacheKey, kvRecord, now, 'kv_hit', 'kv');
  }

  await throwIfFreshNegative(kvRecords.negative, now, async () => {
    if (kvRecords.negative) {
      await Promise.allSettled([
        writeEdgeEnvelope(edgeCache, cacheKey, kvRecords.negative.envelope, adapter.policy.negativeCacheTtlSeconds)
      ]);
    }
  });

  const staleCandidate = toStaleCandidate(edgeRecord, kvRecord, now);

  const lease = await acquireSingleFlightLease(env.CACHE_COORDINATOR, cacheKey, 20);
  const hasCoordinator = Boolean(env.CACHE_COORDINATOR);
  const refreshLeader = !hasCoordinator || Boolean(lease);

  if (!refreshLeader) {
    return waitForLeaderOrServeStale(adapter, cacheKey, input.input, now, staleCandidate, readKv);
  }

  try {
    return await refreshAsLeader(
      adapter,
      cacheKey,
      input.input,
      adapterContext,
      env,
      edgeCache,
      staleCandidate,
      now
    );
  } finally {
    try {
      await releaseSingleFlightLease(env.CACHE_COORDINATOR, lease);
    } catch {
      // Best-effort cleanup; lock auto-expires. Do not replace successful result.
    }
  }
}
