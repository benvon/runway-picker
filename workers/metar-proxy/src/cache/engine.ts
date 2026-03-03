import { acquireSingleFlightLease, releaseSingleFlightLease } from './singleFlight';
import type {
  CacheAdapterContext,
  CacheDataSource,
  CacheEngineInput,
  CacheEngineResult,
  CacheEnvelope,
  CacheProvenance,
  CacheResourceAdapter,
  EdgeCacheLike
} from './types';

interface CachedRecord<TData> {
  data: TData;
  fetchedAt: Date;
  expiresAt: Date;
}

const KEY_VERSION = 'v1';
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

function buildVersionedKey(resource: string, normalizedKey: string): string {
  return `${KEY_VERSION}:${resource}:${normalizedKey}`;
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

function toCachedRecord<TInput, TUpstream, TData>(
  raw: unknown,
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  now: Date
): CachedRecord<TData> | null {
  const data = adapter.deserialize(raw);
  if (!data) {
    return null;
  }

  const candidate = raw as Partial<CacheEnvelope<TData>>;
  if (candidate && typeof candidate === 'object' && 'schemaVersion' in candidate) {
    if (typeof candidate.schemaVersion !== 'number') {
      return null;
    }

    if (candidate.schemaVersion !== adapter.schemaVersion && candidate.schemaVersion !== adapter.schemaVersion - 1) {
      return null;
    }

    if (typeof candidate.resource === 'string' && candidate.resource !== adapter.resource) {
      return null;
    }

    if (typeof candidate.key === 'string' && candidate.key !== cacheKey) {
      return null;
    }
  }

  const fetchedAt =
    parseIsoDate(candidate?.cacheMeta?.fetchedAt) ?? extractFetchedAt(data) ?? now;

  const expiresAt =
    parseIsoDate(candidate?.cacheMeta?.expiresAt) ??
    new Date(fetchedAt.getTime() + adapter.policy.ttlSeconds * 1000);

  return {
    data,
    fetchedAt,
    expiresAt
  };
}

function isFresh(record: CachedRecord<unknown>, now: Date): boolean {
  return record.expiresAt.getTime() > now.getTime();
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
  envelope: CacheEnvelope<TData>,
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

async function readEdgeEnvelope<TInput, TUpstream, TData>(
  edgeCache: EdgeCacheLike | undefined,
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  now: Date
): Promise<CachedRecord<TData> | null> {
  if (!edgeCache) {
    return null;
  }

  const cachedResponse = await edgeCache.match(buildEdgeRequest(cacheKey));
  if (!cachedResponse) {
    return null;
  }

  return toCachedRecord(await cachedResponse.json(), adapter, cacheKey, now);
}

async function readKvEnvelope<TInput, TUpstream, TData>(
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  now: Date,
  readKv: (cacheKey: string) => Promise<unknown>
): Promise<CachedRecord<TData> | null> {
  const raw = await readKv(cacheKey);
  return toCachedRecord(raw, adapter, cacheKey, now);
}

function toEnvelope<TInput, TUpstream, TData>(
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  data: TData,
  cacheKey: string,
  now: Date
): CacheEnvelope<TData> {
  const candidate = adapter.serialize(data, cacheKey, adapter.resource);
  const fetchedAt = parseIsoDate(candidate?.cacheMeta?.fetchedAt) ?? extractFetchedAt(data) ?? now;
  const expiresAt =
    parseIsoDate(candidate?.cacheMeta?.expiresAt) ??
    new Date(fetchedAt.getTime() + adapter.policy.ttlSeconds * 1000);

  return {
    schemaVersion: adapter.schemaVersion,
    resource: adapter.resource,
    key: cacheKey,
    data,
    cacheMeta: {
      fetchedAt: fetchedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
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

async function waitForFreshKvRecord<TInput, TUpstream, TData>(
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  readKv: (cacheKey: string) => Promise<unknown>,
  timeoutMs: number
): Promise<CachedRecord<TData> | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(WAIT_INTERVAL_MS);
    const now = new Date();
    const candidate = await readKvEnvelope(adapter, cacheKey, now, readKv);
    if (candidate && isFresh(candidate, now)) {
      return candidate;
    }
  }

  return null;
}

export async function getOrRefreshCached<TInput, TUpstream, TData>(
  input: CacheEngineInput<TInput, TUpstream, TData>
): Promise<CacheEngineResult<TData>> {
  const { adapter, request, env } = input;
  const now = input.now ?? new Date();
  const normalizedKey = adapter.normalizeKey(input.input);
  const cacheKey = buildVersionedKey(adapter.resource, normalizedKey);
  const edgeCache = input.edgeCache ?? getRuntimeEdgeCache();
  const readKv = async (key: string): Promise<unknown> => env.METAR_CACHE.get(key, 'json');
  const adapterContext: CacheAdapterContext = { request };

  const edgeRecord = await readEdgeEnvelope(edgeCache, adapter, cacheKey, now);
  if (edgeRecord && isFresh(edgeRecord, now)) {
    return {
      payload: edgeRecord.data,
      cache: buildProvenance('edge_hit', 'edge', edgeRecord, now, cacheKey, adapter.resource, adapter.policy.ttlSeconds)
    };
  }

  let staleCandidate = edgeRecord && !isFresh(edgeRecord, now) ? edgeRecord : null;

  const kvRecord = await readKvEnvelope(adapter, cacheKey, now, readKv);
  if (kvRecord && isFresh(kvRecord, now)) {
    await writeEdgeEnvelope(edgeCache, cacheKey, toEnvelope(adapter, kvRecord.data, cacheKey, now), adapter.policy.ttlSeconds);
    return {
      payload: kvRecord.data,
      cache: buildProvenance('kv_hit', 'kv', kvRecord, now, cacheKey, adapter.resource, adapter.policy.ttlSeconds)
    };
  }

  staleCandidate = chooseFresher(kvRecord && !isFresh(kvRecord, now) ? kvRecord : null, staleCandidate);

  const lease = await acquireSingleFlightLease(env.CACHE_COORDINATOR, cacheKey, 20);
  const hasCoordinator = Boolean(env.CACHE_COORDINATOR);
  const refreshLeader = !hasCoordinator || Boolean(lease);

  if (!refreshLeader) {
    if (
      staleCandidate &&
      isWithinStaleWindow(staleCandidate, now, adapter.policy.staleWhileRevalidateSeconds)
    ) {
      return {
        payload: staleCandidate.data,
        cache: buildProvenance(
          'stale_while_refresh',
          'stale',
          staleCandidate,
          now,
          cacheKey,
          adapter.resource,
          adapter.policy.ttlSeconds
        )
      };
    }

    const waitedRecord = await waitForFreshKvRecord(adapter, cacheKey, readKv, MAX_WAIT_FOR_REFRESH_MS);
    if (waitedRecord) {
      return {
        payload: waitedRecord.data,
        cache: buildProvenance(
          'kv_hit',
          'kv',
          waitedRecord,
          new Date(),
          cacheKey,
          adapter.resource,
          adapter.policy.ttlSeconds
        )
      };
    }

    if (staleCandidate && isWithinStaleWindow(staleCandidate, now, adapter.policy.staleOnErrorSeconds)) {
      return {
        payload: staleCandidate.data,
        cache: buildProvenance(
          'stale_on_error',
          'stale',
          staleCandidate,
          now,
          cacheKey,
          adapter.resource,
          adapter.policy.ttlSeconds
        )
      };
    }

    throw new CacheEngineError('Cache refresh is already in progress.', 503);
  }

  try {
    const upstreamPayload = await adapter.fetchUpstream(input.input, adapterContext);
    const validatedData = await adapter.validate(upstreamPayload, input.input, adapterContext);
    const envelope = toEnvelope(adapter, validatedData, cacheKey, new Date());
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
      expiresAt: new Date(envelope.cacheMeta.expiresAt)
    };

    const servedAt = new Date();

    return {
      payload: envelope.data,
      cache: buildProvenance(
        'upstream_refresh',
        'upstream',
        record,
        servedAt,
        cacheKey,
        adapter.resource,
        adapter.policy.ttlSeconds
      )
    };
  } catch (error) {
    if (staleCandidate && isWithinStaleWindow(staleCandidate, now, adapter.policy.staleOnErrorSeconds)) {
      return {
        payload: staleCandidate.data,
        cache: buildProvenance(
          'stale_on_error',
          'stale',
          staleCandidate,
          now,
          cacheKey,
          adapter.resource,
          adapter.policy.ttlSeconds
        )
      };
    }

    if (error instanceof Error) {
      throw error;
    }

    throw new CacheEngineError('Unexpected cache refresh failure.', 500);
  } finally {
    await releaseSingleFlightLease(env.CACHE_COORDINATOR, lease);
  }
}
