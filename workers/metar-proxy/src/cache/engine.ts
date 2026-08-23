import { acquireSingleFlightLease, releaseSingleFlightLease } from './singleFlight';
import { buildCacheKey } from './keys';
import { remainingFreshnessSeconds } from './freshness';
import type {
  CacheAdapterContext,
  CacheDataSource,
  CacheEngineInput,
  CacheEngineEnv,
  CacheEngineResult,
  CacheEnvelope,
  NegativeCacheEnvelope,
  CacheProvenance,
  CachePolicy,
  CacheResourceAdapter,
  EdgeCacheLike,
  StableNegativeCacheEntry
} from './types';

interface CachedRecord<TData> {
  data: TData;
  fetchedAt: Date;
  hasTrustedFetchedAt: boolean;
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

// The scheduler must distinguish a provider failure from a failure in its own
// cache/coordination path. Keep that classification private to this module so
// API callers continue to receive the adapter's original error.
const upstreamAttemptErrors = new WeakSet<object>();

function markUpstreamAttemptError(error: unknown): Error {
  const normalized = error instanceof Error
    ? error
    : new CacheEngineError('Unexpected cache refresh failure.', 500);
  upstreamAttemptErrors.add(normalized);
  return normalized;
}

/** True only when the provider fetch or provider-payload validation was attempted. */
export function isUpstreamAttemptError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && upstreamAttemptErrors.has(error);
}

export type CacheMaintenanceInspection =
  | { kind: 'missing' }
  | { kind: 'valid'; fetchedAt: string }
  | { kind: 'negative'; expiresAt: string }
  | { kind: 'expired' };

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

function parseCanonicalTimestamp(value: unknown, now: Date): Date | null {
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = parseIsoDate(value);
  if (!parsed || parsed.toISOString() !== value || parsed.getTime() > now.getTime()) {
    return null;
  }
  return parsed;
}

function hasBoundedCanonicalExpiry(
  value: unknown,
  fetchedAt: Date,
  expiresAt: Date | null,
  ttlSeconds: number
): boolean {
  return Boolean(
    expiresAt &&
    expiresAt.toISOString() === value &&
    expiresAt.getTime() >= fetchedAt.getTime() &&
    expiresAt.getTime() <= fetchedAt.getTime() + ttlSeconds * 1000
  );
}

function hasValidCacheMeta(
  meta: Partial<CacheEnvelope<unknown>['cacheMeta']> | undefined,
  policy: CachePolicy,
  now: Date,
  ttlSeconds = policy.ttlSeconds
): boolean {
  const fetchedAt = parseCanonicalTimestamp(meta?.fetchedAt, now);
  const expiresAt = parseIsoDate(meta?.expiresAt);
  return Boolean(
    fetchedAt &&
    hasBoundedCanonicalExpiry(meta?.expiresAt, fetchedAt, expiresAt, ttlSeconds) &&
    meta?.policyVersion === policy.policyVersion &&
    meta?.source === 'upstream'
  );
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

function hasValidNegativeCacheMeta(
  meta: Partial<CacheEnvelope<unknown>['cacheMeta']> | undefined,
  policy: CachePolicy,
  now: Date
): boolean {
  if (!hasValidCacheMeta(meta, policy, now, policy.negativeCacheTtlSeconds)) {
    return false;
  }
  const fetchedAt = parseCanonicalTimestamp(meta?.fetchedAt, now);
  const expiresAt = parseIsoDate(meta?.expiresAt);
  if (!fetchedAt || !expiresAt || expiresAt.toISOString() !== meta?.expiresAt) {
    return false;
  }
  const maxExpiryMs = fetchedAt.getTime() + policy.negativeCacheTtlSeconds * 1000;
  return expiresAt.getTime() >= fetchedAt.getTime() && expiresAt.getTime() <= maxExpiryMs;
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
  if (!hasCompatibleEnvelope(candidate, adapter, cacheKey) || !hasValidNegativeCacheMeta(candidate.cacheMeta, adapter.policy, now)) {
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
  if (!hasCompatibleEnvelope(candidate, adapter, cacheKey) || !hasValidCacheMeta(candidate.cacheMeta, adapter.policy, now)) {
    return null;
  }

  const data = adapter.deserialize(raw);
  if (!data) {
    return null;
  }

  const trustedFetchedAt = parseCanonicalTimestamp(candidate.cacheMeta?.fetchedAt, now);
  const fetchedAt = trustedFetchedAt ?? new Date(0);

  const expiresAt =
    parseIsoDate(candidate?.cacheMeta?.expiresAt) ??
    new Date(fetchedAt.getTime() + adapter.policy.ttlSeconds * 1000);

  return {
    data,
    fetchedAt,
    hasTrustedFetchedAt: trustedFetchedAt !== null,
    expiresAt,
    envelope: candidate as CacheEnvelope<TData>
  };
}

function isWithinPayloadAge(record: CachedRecord<unknown>, now: Date, policy: CachePolicy): boolean {
  if (!record.hasTrustedFetchedAt) {
    return false;
  }

  return now.getTime() < record.fetchedAt.getTime() + policy.maxPayloadAgeSeconds * 1000;
}

function isFresh(
  record: CachedRecord<unknown>,
  now: Date,
  policy: CachePolicy
): boolean {
  return isWithinPayloadAge(record, now, policy) && record.expiresAt.getTime() > now.getTime();
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

function isWithinStaleWindow(
  record: CachedRecord<unknown>,
  now: Date,
  staleWindowSeconds: number,
  policy: CachePolicy
): boolean {
  return (
    isWithinPayloadAge(record, now, policy) &&
    now.getTime() <= record.expiresAt.getTime() + staleWindowSeconds * 1000
  );
}

function buildProvenance(
  status: CacheProvenance['status'],
  source: CacheDataSource,
  record: CachedRecord<unknown>,
  now: Date,
  cacheKey: string,
  resource: string,
  ttlSeconds: number,
  maxPayloadAgeSeconds: number
): CacheProvenance {
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - record.fetchedAt.getTime()) / 1000));

  return {
    status,
    source,
    ageSeconds,
    fetchedAt: record.fetchedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    freshnessRemainingSeconds: remainingFreshnessSeconds(record.expiresAt, now, ttlSeconds),
    servedAt: now.toISOString(),
    ttlSeconds,
    maxPayloadAgeSeconds,
    key: cacheKey,
    resource
  };
}

async function writeEdgeEnvelope<TData>(
  edgeCache: EdgeCacheLike | undefined,
  cacheKey: string,
  envelope: CacheEnvelope<TData> | NegativeCacheEnvelope,
  ttlSeconds: number,
  clock: () => Date
): Promise<void> {
  if (!edgeCache) {
    return;
  }

  const request = buildEdgeRequest(cacheKey);
  const expiresAt = parseIsoDate(envelope.cacheMeta.expiresAt);
  const responseTime = clock();
  const remainingSeconds = expiresAt ? remainingFreshnessSeconds(expiresAt, responseTime, ttlSeconds) : 0;
  if (remainingSeconds === 0) {
    return;
  }

  const response = Response.json(envelope, {
    headers: {
      'Cache-Control': `public, max-age=${Math.min(60, remainingSeconds)}, s-maxage=${remainingSeconds}`,
      // Anchor the relative lifetime even if Cache.put completes after an I/O delay.
      Date: responseTime.toUTCString()
    }
  });

  try {
    await edgeCache.put(request, response);
  } catch {
    // KV is authoritative. An edge promotion failure must not turn a
    // successfully committed refresh into a scheduler infrastructure failure.
    console.warn('Edge cache promotion failed.', { cacheKey });
  }
}

async function readEdgeCacheRecords<TInput, TUpstream, TData>(
  edgeCache: EdgeCacheLike | undefined,
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  input: TInput,
  clock: () => Date
): Promise<CacheRecords<TData>> {
  if (!edgeCache) {
    return { data: null, negative: null };
  }

  const cachedResponse = await edgeCache.match(buildEdgeRequest(cacheKey));
  let raw: unknown = null;
  try {
    raw = cachedResponse ? await cachedResponse.json() : null;
  } catch {
    await edgeCache.delete?.(buildEdgeRequest(cacheKey));
  }
  return toCacheRecords(raw, adapter, cacheKey, input, clock());
}

async function readKvCacheRecords<TInput, TUpstream, TData>(
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  input: TInput,
  clock: () => Date,
  readKv: (cacheKey: string) => Promise<unknown>
): Promise<CacheRecords<TData>> {
  const raw = await readKv(cacheKey);
  return toCacheRecords(raw, adapter, cacheKey, input, clock());
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
  const fetchedAt = now;
  const expiresAt = new Date(fetchedAt.getTime() + adapter.policy.ttlSeconds * 1000);

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
    cache: buildProvenance(
      status,
      source,
      record,
      now,
      cacheKey,
      adapter.resource,
      adapter.policy.ttlSeconds,
      adapter.policy.maxPayloadAgeSeconds
    )
  };
}

function toStaleCandidate<TData>(
  edgeRecord: CachedRecord<TData> | null,
  kvRecord: CachedRecord<TData> | null,
  now: Date,
  policy: CachePolicy
): CachedRecord<TData> | null {
  const staleEdge = edgeRecord && isWithinPayloadAge(edgeRecord, now, policy) && !isFresh(edgeRecord, now, policy)
    ? edgeRecord
    : null;
  const staleKv = kvRecord && isWithinPayloadAge(kvRecord, now, policy) && !isFresh(kvRecord, now, policy)
    ? kvRecord
    : null;
  return chooseFresher(staleKv, staleEdge);
}

async function purgeInvalidPayloadCopies(
  env: CacheEngineEnv,
  edgeCache: EdgeCacheLike | undefined,
  cacheKey: string,
  purgeKv: boolean,
  purgeEdge: boolean
): Promise<void> {
  const cleanups: Array<Promise<unknown>> = [];
  if (purgeKv && env.METAR_CACHE.delete) {
    cleanups.push(env.METAR_CACHE.delete(cacheKey));
  }
  if (purgeEdge && edgeCache?.delete) {
    cleanups.push(edgeCache.delete(buildEdgeRequest(cacheKey)));
  }
  await Promise.allSettled(cleanups);
}

/** Scheduler-only KV inspection. It shares the request-path validation and never repairs untrusted metadata. */
export async function inspectCachedPayloadForMaintenance<TInput, TUpstream, TData>(params: {
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>;
  input: TInput;
  env: CacheEngineEnv;
  now?: Date;
}): Promise<CacheMaintenanceInspection> {
  const cacheKey = buildCacheKey(params.adapter.resource, params.adapter.normalizeKey(params.input));
  const now = params.now ?? new Date();
  let text: unknown;
  try {
    text = await params.env.METAR_CACHE.get(cacheKey, 'text');
  } catch (error) {
    throw new CacheEngineError(error instanceof Error ? error.message : 'Cache payload inspection failed.', 503);
  }
  if (text === null) {
    return { kind: 'missing' };
  }
  let raw: unknown;
  try {
    raw = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    await purgeInvalidPayloadCopies(params.env, undefined, cacheKey, true, false);
    return { kind: 'missing' };
  }
  const record = toCachedRecord(raw, params.adapter, cacheKey, now);
  if (record) {
    if (!isWithinPayloadAge(record, now, params.adapter.policy)) {
      await purgeInvalidPayloadCopies(params.env, undefined, cacheKey, true, false);
      return { kind: 'expired' };
    }
    return { kind: 'valid', fetchedAt: record.fetchedAt.toISOString() };
  }

  const negative = toCachedNegativeRecord(raw, params.adapter, cacheKey, params.input, now);
  if (negative) {
    if (negative.expiresAt.getTime() > now.getTime()) {
      return { kind: 'negative', expiresAt: negative.expiresAt.toISOString() };
    }
    await purgeInvalidPayloadCopies(params.env, undefined, cacheKey, true, false);
    return { kind: 'expired' };
  }
  await purgeInvalidPayloadCopies(params.env, undefined, cacheKey, true, false);
  return { kind: 'missing' };
}

async function discardPayloadOutsideValidity<TData>(
  record: CachedRecord<TData> | null,
  source: 'edge' | 'kv',
  now: Date,
  policy: CachePolicy,
  env: CacheEngineEnv,
  edgeCache: EdgeCacheLike | undefined,
  cacheKey: string
): Promise<CachedRecord<TData> | null> {
  if (!record || isWithinPayloadAge(record, now, policy)) {
    return record;
  }

  await purgeInvalidPayloadCopies(env, edgeCache, cacheKey, source === 'kv', source === 'edge');
  return null;
}

interface CachedReadDecision<TData> {
  fresh: CacheEngineResult<TData> | null;
  staleCandidate: CachedRecord<TData> | null;
}

async function readCachedData<TInput, TUpstream, TData>(
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  input: TInput,
  env: CacheEngineInput<TInput, TUpstream, TData>['env'],
  edgeCache: EdgeCacheLike | undefined,
  readKv: (cacheKey: string) => Promise<unknown>,
  clock: () => Date
): Promise<CachedReadDecision<TData>> {
  const edgeRecords = await readEdgeCacheRecords(edgeCache, adapter, cacheKey, input, clock);
  const edgeDecisionTime = clock();
  await throwIfFreshNegative(edgeRecords.negative, edgeDecisionTime);
  const edgeRecord = await discardPayloadOutsideValidity(
    edgeRecords.data,
    'edge',
    edgeDecisionTime,
    adapter.policy,
    env,
    edgeCache,
    cacheKey
  );
  if (edgeRecord && isFresh(edgeRecord, edgeDecisionTime, adapter.policy)) {
    return { fresh: cacheResultFromRecord(adapter, cacheKey, edgeRecord, edgeDecisionTime, 'edge_hit', 'edge'), staleCandidate: null };
  }

  const kvRecords = await readKvCacheRecords(adapter, cacheKey, input, clock, readKv);
  const kvDecisionTime = clock();
  const kvRecord = await discardPayloadOutsideValidity(
    kvRecords.data,
    'kv',
    kvDecisionTime,
    adapter.policy,
    env,
    edgeCache,
    cacheKey
  );
  if (kvRecord && isFresh(kvRecord, kvDecisionTime, adapter.policy)) {
    await writeEdgeEnvelope(edgeCache, cacheKey, kvRecord.envelope, adapter.policy.ttlSeconds, clock);
    const kvResponseTime = clock();
    if (isFresh(kvRecord, kvResponseTime, adapter.policy)) {
      return { fresh: cacheResultFromRecord(adapter, cacheKey, kvRecord, kvResponseTime, 'kv_hit', 'kv'), staleCandidate: null };
    }
  }

  await throwIfFreshNegative(kvRecords.negative, kvDecisionTime, async () => {
    if (kvRecords.negative) {
      await Promise.allSettled([
        writeEdgeEnvelope(edgeCache, cacheKey, kvRecords.negative.envelope, adapter.policy.negativeCacheTtlSeconds, clock)
      ]);
    }
  });

  return { fresh: null, staleCandidate: toStaleCandidate(edgeRecord, kvRecord, clock(), adapter.policy) };
}

async function waitForFreshKvRecords<TInput, TUpstream, TData>(
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  input: TInput,
  readKv: (cacheKey: string) => Promise<unknown>,
  timeoutMs: number,
  clock: () => Date
): Promise<CacheRecords<TData> | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(WAIT_INTERVAL_MS);
    const records = await readKvCacheRecords(adapter, cacheKey, input, clock, readKv);
    const now = clock();
    if (
      (records.data && isFresh(records.data, now, adapter.policy)) ||
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
  staleCandidate: CachedRecord<TData> | null,
  readKv: (cacheKey: string) => Promise<unknown>,
  clock: () => Date
): Promise<CacheEngineResult<TData>> {
  const staleWhileRefreshNow = clock();
  if (
    staleCandidate &&
    isWithinStaleWindow(staleCandidate, staleWhileRefreshNow, adapter.policy.staleWhileRevalidateSeconds, adapter.policy)
  ) {
    return cacheResultFromRecord(adapter, cacheKey, staleCandidate, staleWhileRefreshNow, 'stale_while_refresh', 'stale');
  }

  const waitedRecords = await waitForFreshKvRecords(adapter, cacheKey, input, readKv, MAX_WAIT_FOR_REFRESH_MS, clock);
  if (waitedRecords?.negative) {
    await throwIfFreshNegative(waitedRecords.negative, clock());
  }
  if (waitedRecords?.data) {
    return cacheResultFromRecord(adapter, cacheKey, waitedRecords.data, clock(), 'kv_hit', 'kv');
  }

  const staleOnErrorNow = clock();
  if (
    staleCandidate &&
    isWithinStaleWindow(staleCandidate, staleOnErrorNow, adapter.policy.staleOnErrorSeconds, adapter.policy)
  ) {
    return cacheResultFromRecord(adapter, cacheKey, staleCandidate, staleOnErrorNow, 'stale_on_error', 'stale');
  }

  throw new CacheEngineError('Cache refresh is already in progress.', 503);
}

async function refreshFromUpstream<TInput, TUpstream, TData>(
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  input: TInput,
  context: CacheAdapterContext,
  env: CacheEngineInput<TInput, TUpstream, TData>['env'],
  edgeCache: EdgeCacheLike | undefined,
  clock: () => Date
): Promise<CacheEngineResult<TData>> {
  let upstreamPayload: TUpstream;
  let validatedData: TData;
  try {
    upstreamPayload = await adapter.fetchUpstream(input, context);
    validatedData = await adapter.validate(upstreamPayload, input, context);
  } catch (error) {
    throw markUpstreamAttemptError(error);
  }
  const envelope = toEnvelope(adapter, validatedData, cacheKey, clock(), upstreamPayload);
  const retentionTtl = Math.min(
    adapter.policy.maxPayloadAgeSeconds,
    adapter.policy.ttlSeconds + Math.max(adapter.policy.staleWhileRevalidateSeconds, adapter.policy.staleOnErrorSeconds)
  );

  await env.METAR_CACHE.put(cacheKey, JSON.stringify(envelope), {
    expirationTtl: retentionTtl
  });

  await writeEdgeEnvelope(edgeCache, cacheKey, envelope, adapter.policy.ttlSeconds, clock);

  const record: CachedRecord<TData> = {
    data: envelope.data,
    fetchedAt: new Date(envelope.cacheMeta.fetchedAt),
    hasTrustedFetchedAt: true,
    expiresAt: new Date(envelope.cacheMeta.expiresAt),
    envelope
  };

  return cacheResultFromRecord(adapter, cacheKey, record, clock(), 'upstream_refresh', 'upstream');
}

async function refreshAsLeader<TInput, TUpstream, TData>(
  adapter: CacheResourceAdapter<TInput, TUpstream, TData>,
  cacheKey: string,
  input: TInput,
  context: CacheAdapterContext,
  env: CacheEngineInput<TInput, TUpstream, TData>['env'],
  edgeCache: EdgeCacheLike | undefined,
  staleCandidate: CachedRecord<TData> | null,
  clock: () => Date
): Promise<CacheEngineResult<TData>> {
  try {
    return await refreshFromUpstream(adapter, cacheKey, input, context, env, edgeCache, clock);
  } catch (error) {
    // KV writes, coordinator timeouts, and other cache-path failures must
    // propagate. A scheduler run will abort rather than treating them as a
    // provider failure and eventually removing active demand.
    if (!isUpstreamAttemptError(error)) {
      throw error;
    }
    const negativeEnvelope = toNegativeEnvelope(adapter, error, cacheKey, clock());
    if (negativeEnvelope) {
      await Promise.allSettled([
        env.METAR_CACHE.put(cacheKey, JSON.stringify(negativeEnvelope), {
          expirationTtl: adapter.policy.negativeCacheTtlSeconds
        }),
        writeEdgeEnvelope(edgeCache, cacheKey, negativeEnvelope, adapter.policy.negativeCacheTtlSeconds, clock)
      ]);
      throw error;
    }

    const staleOnErrorNow = clock();
    if (
      staleCandidate &&
      isWithinStaleWindow(staleCandidate, staleOnErrorNow, adapter.policy.staleOnErrorSeconds, adapter.policy)
    ) {
      return cacheResultFromRecord(adapter, cacheKey, staleCandidate, staleOnErrorNow, 'stale_on_error', 'stale');
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
  const clock = input.clock ?? (input.now ? () => input.now as Date : () => new Date());
  const normalizedKey = adapter.normalizeKey(input.input);
  const cacheKey = buildCacheKey(adapter.resource, normalizedKey);
  const edgeCache = input.edgeCache ?? getRuntimeEdgeCache();
  const readKv = async (key: string): Promise<unknown> => {
    let raw: unknown;
    try {
      raw = await env.METAR_CACHE.get(key, 'text');
    } catch (error) {
      throw new CacheEngineError(error instanceof Error ? error.message : 'Cache payload read failed.', 503);
    }
    if (raw === null) return null;
    // Cloudflare KV text reads are strings. Preserve object fixtures only for
    // the narrow adapter boundary used by local in-memory test doubles.
    if (typeof raw !== 'string') {
      if (raw && typeof raw === 'object') return raw;
      await purgeInvalidPayloadCopies(env, undefined, key, true, false);
      return null;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      await purgeInvalidPayloadCopies(env, undefined, key, true, false);
      return null;
    }
  };
  const adapterContext: CacheAdapterContext = { request, env, signal: input.upstreamSignal };

  const cached = await readCachedData(adapter, cacheKey, input.input, env, edgeCache, readKv, clock);
  if (cached.fresh) {
    return cached.fresh;
  }
  const { staleCandidate } = cached;

  const lease = await acquireSingleFlightLease(env.CACHE_COORDINATOR, cacheKey, 20);
  const hasCoordinator = Boolean(env.CACHE_COORDINATOR);
  const refreshLeader = !hasCoordinator || Boolean(lease);

  if (!refreshLeader) {
    return waitForLeaderOrServeStale(adapter, cacheKey, input.input, staleCandidate, readKv, clock);
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
      clock
    );
  } finally {
    try {
      await releaseSingleFlightLease(env.CACHE_COORDINATOR, lease);
    } catch {
      // Best-effort cleanup; lock auto-expires. Do not replace successful result.
    }
  }
}
