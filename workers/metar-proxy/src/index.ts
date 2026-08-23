import {
  CacheEngineError,
  getOrRefreshCached,
  inspectCachedPayloadForMaintenance,
  isUpstreamAttemptError
} from './cache/engine';
import { provenanceAtResponseTime } from './cache/freshness';
import {
  deleteHotCacheEntryAndPayload,
  isInvalidHotCacheQueueCursorError,
  listHotCacheQueuePage,
  loadHotCacheQueueEntries,
  parseCacheRefresherConfig,
  readHotCacheQueueEntry,
  readIsoTimestamp,
  refreshIntervalSecondsForResource,
  touchHotCacheEntry,
  type HotCacheQueuePage,
  type HotCacheResource,
  type HotCacheQueueEntry
} from './cache/hotQueue';
import { getAdapterOrThrow } from './cache/registry';
import {
  abortSchedulerRun,
  beginSchedulerRun,
  CacheSingleFlightCoordinator,
  commitSchedulerRun,
  processSchedulerDequeues,
  recordSchedulerDemand,
  renewSchedulerRun,
  type SchedulerMaintenanceOutcome
} from './cache/singleFlight';
import type { CacheEngineEnv, CacheProvenance } from './cache/types';
import { createResourceRegistry } from './resources';
import {
  airportResourceAdapter,
  AirportWorkerError,
  type AirportLocationResourceData,
  normalizeAirportIcao,
  type AirportResourceData,
  type AirportResourceInput
} from './resources/airport/adapter';
import {
  airportLocationResourceAdapter
} from './resources/airport/locationAdapter';
import {
  extractMetarRaw,
  MetarWorkerError,
  metarResourceAdapter,
  normalizeIcao,
  type MetarResourceData,
  type MetarResourceInput
} from './resources/metar/adapter';
import {
  ApiRateLimiter,
  enforceRateLimit,
  noteInvalidIcao,
  type RateLimitHeaders
} from './security/rateLimiter';

const RESOURCE_REGISTRY = createResourceRegistry();
const METAR_ADAPTER = getAdapterOrThrow(RESOURCE_REGISTRY, 'metar') as typeof metarResourceAdapter;
const AIRPORT_ADAPTER = getAdapterOrThrow(RESOURCE_REGISTRY, 'airport') as typeof airportResourceAdapter;
const AIRPORT_LOCATION_ADAPTER = getAdapterOrThrow(RESOURCE_REGISTRY, 'airport-location') as typeof airportLocationResourceAdapter;

const API_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
};
const RATE_LIMITER_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;
const SCHEDULED_UPSTREAM_TIMEOUT_MS = 10_000;

interface MetarApiSuccessPayload extends MetarResourceData {
  cache: CacheProvenance;
}

interface AirportApiSuccessPayload extends AirportResourceData {
  cache: CacheProvenance;
}

interface AirportLocationApiSuccessPayload extends AirportLocationResourceData {
  cache: CacheProvenance;
}

type Endpoint = 'metar' | 'airport';

interface ResponseOptions {
  requestId: string;
  cache?: CacheProvenance;
  rateLimit?: RateLimitHeaders;
  retryAfterSeconds?: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

function createRequestId(existing: string | null): string {
  if (typeof existing === 'string' && UUID_PATTERN.test(existing.trim())) {
    return existing.trim();
  }

  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getClientIdentifier(request: Request): string {
  const candidates = [request.headers.get('X-Client-IP'), request.headers.get('CF-Connecting-IP')];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const first = candidate.split(',')[0]?.trim() ?? '';
    if (/^[A-Fa-f0-9:.]{3,45}$/.test(first)) {
      return first;
    }
  }

  return 'unknown';
}

function shouldIncludeDebug(env: CacheEngineEnv): boolean {
  const explicit = env.ENABLE_DEBUG_ERRORS?.trim().toLowerCase();
  if (explicit === 'true') {
    return true;
  }

  if (explicit === 'false') {
    return false;
  }

  const appEnv = env.APP_ENV?.trim().toLowerCase();
  return appEnv === 'preview' || appEnv === 'development' || appEnv === 'dev';
}

function buildSuccessCacheControl(cache: CacheProvenance | undefined): string {
  if (!cache) {
    return 'no-store';
  }

  const responseCache = provenanceAtResponseTime(cache);
  if (
    responseCache.freshnessRemainingSeconds <= 0 ||
    responseCache.status === 'stale_while_refresh' ||
    responseCache.status === 'stale_on_error'
  ) {
    return 'no-store';
  }

  const sharedMaxAge = responseCache.freshnessRemainingSeconds;
  return `public, max-age=${Math.min(60, sharedMaxAge)}, s-maxage=${sharedMaxAge}`;
}

function withApiHeaders(status: number, options: ResponseOptions): Headers {
  const headers = new Headers({
    'Cache-Control': status === 200 ? buildSuccessCacheControl(options.cache) : 'no-store',
    'X-Request-Id': options.requestId
  });

  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
    headers.set(name, value);
  }

  if (options.cache && status === 200) {
    headers.set('X-Runway-Cache-Status', options.cache.status);
  }

  if (options.rateLimit) {
    headers.set('X-RateLimit-Limit', `${options.rateLimit.limit}`);
    headers.set('X-RateLimit-Remaining', `${options.rateLimit.remaining}`);
    headers.set('X-RateLimit-Reset', `${options.rateLimit.resetSeconds}`);

    if (typeof options.rateLimit.retryAfterSeconds === 'number' && options.rateLimit.retryAfterSeconds > 0) {
      headers.set('Retry-After', `${options.rateLimit.retryAfterSeconds}`);
    }
  }

  if (typeof options.retryAfterSeconds === 'number' && options.retryAfterSeconds > 0) {
    headers.set('Retry-After', `${options.retryAfterSeconds}`);
  }

  return headers;
}

function buildJsonResponse(payload: unknown, status: number, options: ResponseOptions): Response {
  const responseCache = options.cache ? provenanceAtResponseTime(options.cache) : undefined;
  const responsePayload = responseCache && payload && typeof payload === 'object'
    ? { ...(payload as Record<string, unknown>), cache: responseCache }
    : payload;

  return Response.json(responsePayload, {
    status,
    headers: withApiHeaders(status, { ...options, cache: responseCache })
  });
}

function buildErrorResponse(
  message: string,
  status: number,
  code: string,
  options: ResponseOptions,
  debug?: unknown
): Response {
  const payload: { error: string; code: string; requestId: string; debug?: unknown } = {
    error: message,
    code,
    requestId: options.requestId
  };

  if (typeof debug !== 'undefined') {
    payload.debug = debug;
  }

  return buildJsonResponse(payload, status, options);
}

function toMetarInput(request: Request): MetarResourceInput {
  const url = new URL(request.url);
  return {
    icao: url.searchParams.get('icao') ?? ''
  };
}

function toAirportInput(request: Request): AirportResourceInput {
  const url = new URL(request.url);
  return {
    icao: url.searchParams.get('icao') ?? ''
  };
}

async function applyRateLimit(
  request: Request,
  env: CacheEngineEnv,
  endpoint: Endpoint,
  requestId: string
): Promise<{ allowed: true; headers: RateLimitHeaders } | { allowed: false; response: Response }> {
  const decision = await enforceRateLimit(env.API_RATE_LIMITER, getClientIdentifier(request), endpoint);
  if (decision.status === 'unavailable') {
    console.error('Rate limiter unavailable.', {
      endpoint,
      requestId,
      failureCategory: decision.failureCategory
    });

    return {
      allowed: false,
      response: buildErrorResponse('Service temporarily unavailable. Please retry later.', 503, 'RATE_LIMITER_UNAVAILABLE', {
        requestId,
        retryAfterSeconds: RATE_LIMITER_UNAVAILABLE_RETRY_AFTER_SECONDS
      })
    };
  }

  if (decision.status === 'denied') {
    return {
      allowed: false,
      response: buildErrorResponse('Rate limit exceeded. Please retry later.', 429, 'RATE_LIMITED', {
        requestId,
        rateLimit: decision.headers
      })
    };
  }

  return {
    allowed: true,
    headers: decision.headers
  };
}

async function noteInvalidIcaoAttempt(
  request: Request,
  env: CacheEngineEnv,
  endpoint: Endpoint,
  requestId: string
): Promise<void> {
  const result = await noteInvalidIcao(env.API_RATE_LIMITER, getClientIdentifier(request), endpoint);
  if (!result.delivered) {
    console.error('Rate limiter invalid ICAO signal failed.', {
      endpoint,
      requestId,
      failureCategory: result.failureCategory
    });
  }
}

async function noteSuccessfulCacheAccess(
  env: CacheEngineEnv,
  resource: Endpoint,
  normalizedKey: string
): Promise<void> {
  try {
    const config = parseCacheRefresherConfig(env);
    await recordSchedulerDemand(env.CACHE_COORDINATOR, {
      resource,
      normalizedKey,
      lastAccessedAt: new Date().toISOString(),
      expirationTtl: config.inactivityTtlSeconds
    });
  } catch {
    // Do not fail user requests when queue metadata writes fail.
  }
}

function toRefreshRequest(resource: Endpoint, normalizedKey: string): Request {
  return new Request(
    `https://cache-refresh.internal/api/${resource}?icao=${encodeURIComponent(normalizedKey)}`,
    { method: 'GET' }
  );
}

async function refreshQueueEntry(entry: HotCacheQueueEntry, env: CacheEngineEnv): Promise<CacheProvenance> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCHEDULED_UPSTREAM_TIMEOUT_MS);
  try {
  if (entry.resource === 'metar') {
    const result = await getOrRefreshCached({
      adapter: METAR_ADAPTER,
      input: { icao: entry.normalizedKey },
      request: toRefreshRequest('metar', entry.normalizedKey),
      env,
      upstreamSignal: controller.signal
    });
    return result.cache;
  }

  const result = await getOrRefreshCached({
    adapter: AIRPORT_ADAPTER,
    input: { icao: entry.normalizedKey },
    request: toRefreshRequest('airport', entry.normalizedKey),
    env,
    upstreamSignal: controller.signal
  });
  return result.cache;
  } finally {
    clearTimeout(timeout);
  }
}

async function purgeEdgeCacheForKey(cacheKey: string): Promise<void> {
  const runtime = globalThis as unknown as {
    caches?: {
      default?: { delete?: (request: Request) => Promise<boolean> };
    };
  };

  const edgeCache = runtime.caches?.default;
  if (!edgeCache || typeof edgeCache.delete !== 'function') {
    return;
  }

  try {
    await edgeCache.delete(
      new Request(`https://cache.runway.internal/${encodeURIComponent(cacheKey)}`, {
        method: 'GET'
      })
    );
  } catch {
    // Best-effort edge cache purge.
  }
}

function isInactive(lastAccessedAtMs: number, nowMs: number, inactivityTtlMs: number): boolean {
  return lastAccessedAtMs <= 0 || nowMs - lastAccessedAtMs > inactivityTtlMs;
}

async function isRefreshDue(
  entry: HotCacheQueueEntry,
  env: CacheEngineEnv,
  now: Date,
  config: ReturnType<typeof parseCacheRefresherConfig>
): Promise<boolean> {
  const refreshIntervalMs = refreshIntervalSecondsForResource(entry.resource, config) * 1000;
  if (entry.schemaVersion < 4) {
    const legacyTimestamp = readIsoTimestamp(entry.lastRefreshedAt ?? '');
    return legacyTimestamp <= 0 || now.getTime() - legacyTimestamp >= refreshIntervalMs;
  }
  const inspection = entry.resource === 'metar'
    ? await inspectCachedPayloadForMaintenance({
      adapter: METAR_ADAPTER,
      input: { icao: entry.normalizedKey },
      env,
      now
    })
    : await inspectCachedPayloadForMaintenance({
      adapter: AIRPORT_ADAPTER,
      input: { icao: entry.normalizedKey },
      env,
      now
    });
  if (inspection.kind !== 'valid') {
    if (inspection.kind === 'negative') {
      return false;
    }
    return true;
  }
  return now.getTime() - readIsoTimestamp(inspection.fetchedAt) >= refreshIntervalMs;
}

function selectRoundRobinDueEntries(
  dueEntries: Record<'metar' | 'airport', HotCacheQueueEntry[]>,
  maxItems: number
): HotCacheQueueEntry[] {
  const remaining = {
    metar: [...dueEntries.metar].sort(
      (left, right) => readIsoTimestamp(left.lastAccessedAt) - readIsoTimestamp(right.lastAccessedAt)
    ),
    airport: [...dueEntries.airport].sort(
      (left, right) => readIsoTimestamp(left.lastAccessedAt) - readIsoTimestamp(right.lastAccessedAt)
    )
  };
  const queues = [remaining.metar, remaining.airport];
  const selected: HotCacheQueueEntry[] = [];
  let nextQueueIndex =
    readIsoTimestamp(remaining.metar[0]?.lastAccessedAt ?? '') <=
    readIsoTimestamp(remaining.airport[0]?.lastAccessedAt ?? '')
      ? 0
      : 1;

  while (selected.length < maxItems) {
    const entry = queues[nextQueueIndex]?.shift() ?? queues[1 - nextQueueIndex]?.shift();
    if (!entry) {
      break;
    }

    selected.push(entry);
    nextQueueIndex = 1 - nextQueueIndex;
  }

  return selected;
}

interface ResourceScan {
  resource: HotCacheResource;
  entries: HotCacheQueueEntry[];
  scanned: number;
  finalPage: HotCacheQueuePage;
}

async function startResourceScan(
  env: CacheEngineEnv,
  resource: HotCacheResource,
  savedCursor: string | undefined,
  scanBudget: number
): Promise<ResourceScan> {
  let page: HotCacheQueuePage;
  try {
    page = await listHotCacheQueuePage(env, resource, savedCursor, scanBudget);
  } catch (error) {
    if (!savedCursor || !isInvalidHotCacheQueueCursorError(error)) {
      throw error;
    }

    page = await listHotCacheQueuePage(env, resource, undefined, scanBudget);
  }

  return {
    resource,
    entries: await loadHotCacheQueueEntries(env, page),
    scanned: page.scanned,
    finalPage: page
  };
}

async function extendResourceScan(
  env: CacheEngineEnv,
  scan: ResourceScan,
  scanBudget: number
): Promise<void> {
  if (scan.finalPage.listComplete || scanBudget <= 0) {
    return;
  }

  const page = await listHotCacheQueuePage(env, scan.resource, scan.finalPage.nextCursor, scanBudget);
  scan.entries.push(...(await loadHotCacheQueueEntries(env, page)));
  scan.scanned += page.scanned;
  scan.finalPage = page;
}

async function scanHotQueueEntries(
  env: CacheEngineEnv,
  cursors: Partial<Record<HotCacheResource, string>>,
  scanCap: number
): Promise<Record<'metar' | 'airport', ResourceScan>> {
  const metarBudget = Math.ceil(scanCap / 2);
  const airportBudget = scanCap - metarBudget;
  const [metarPage, airportPage] = await Promise.all([
    startResourceScan(env, 'metar', cursors.metar, metarBudget),
    startResourceScan(env, 'airport', cursors.airport, airportBudget)
  ]);
  const scans = { metar: metarPage, airport: airportPage };
  const unusedBudget = scanCap - metarPage.scanned - airportPage.scanned;

  if (unusedBudget <= 0) {
    return scans;
  }

  if (metarPage.scanned < metarBudget && !airportPage.finalPage.listComplete) {
    await extendResourceScan(env, airportPage, unusedBudget);
  } else if (airportPage.scanned < airportBudget && !metarPage.finalPage.listComplete) {
    await extendResourceScan(env, metarPage, unusedBudget);
  }

  return scans;
}

async function keepOrEvictQueueEntry(
  env: CacheEngineEnv,
  entry: HotCacheQueueEntry,
  nowMs: number,
  inactivityTtlMs: number
): Promise<HotCacheQueueEntry | null> {
  let effectiveEntry: HotCacheQueueEntry = entry;
  let lastAccessedAtMs = readIsoTimestamp(effectiveEntry.lastAccessedAt);

  if (!isInactive(lastAccessedAtMs, nowMs, inactivityTtlMs)) {
    if (effectiveEntry.schemaVersion < 5) {
      await touchHotCacheEntry({
        env,
        resource: effectiveEntry.resource,
        normalizedKey: effectiveEntry.normalizedKey,
        lastAccessedAt: effectiveEntry.lastAccessedAt,
        expirationTtl: Math.ceil(inactivityTtlMs / 1000)
      });
      const migrated = await readHotCacheQueueEntry(env, effectiveEntry.metadataKey);
      if (migrated) effectiveEntry = migrated;
    }
    return effectiveEntry;
  }

  // Re-read latest metadata before evicting to avoid racing with concurrent user requests.
  const latest = await readHotCacheQueueEntry(env, entry.metadataKey);
  if (!latest) {
    return null;
  }

  effectiveEntry = latest;
  lastAccessedAtMs = readIsoTimestamp(effectiveEntry.lastAccessedAt);
  if (!isInactive(lastAccessedAtMs, nowMs, inactivityTtlMs)) {
    return effectiveEntry;
  }

  await deleteHotCacheEntryAndPayload(env, effectiveEntry);
  await purgeEdgeCacheForKey(effectiveEntry.cacheKey);
  return null;
}

// Test-only export surface for targeted unit tests of scheduler helpers.
export const __cacheRefreshHelpers = {
  isInactive,
  isRefreshDue: (entry: HotCacheQueueEntry, nowMs: number, config: ReturnType<typeof parseCacheRefresherConfig>) => {
    const intervalMs = refreshIntervalSecondsForResource(entry.resource, config) * 1000;
    const legacyTimestamp = readIsoTimestamp(entry.lastRefreshedAt ?? '');
    return legacyTimestamp <= 0 || nowMs - legacyTimestamp >= intervalMs;
  },
  keepOrEvictQueueEntry,
  selectRoundRobinDueEntries
};

async function processScheduledRefreshEntry(
  env: CacheEngineEnv,
  entry: HotCacheQueueEntry
): Promise<SchedulerMaintenanceOutcome> {
  let refreshedCache: CacheProvenance;
  try {
    refreshedCache = await refreshQueueEntry(entry, env);
  } catch (error) {
    if (isUpstreamAttemptError(error)) {
      console.error('Scheduled cache refresh upstream attempt failed.', { resource: entry.resource });
      return 'upstream_failed';
    }
    throw error;
  }
  if (refreshedCache.status === 'stale_on_error') {
    console.error('Scheduled cache refresh upstream attempt fell back to stale data.', { resource: entry.resource });
    return 'upstream_failed';
  }
  if (refreshedCache.status !== 'upstream_refresh') {
    return 'neutral';
  }
  return 'refreshed';
}

// eslint-disable-next-line complexity
export async function runScheduledCacheRefresh(env: CacheEngineEnv, now = new Date()): Promise<void> {
  const config = parseCacheRefresherConfig(env);
  if (!config.enabled) {
    return;
  }
  if (!env.METAR_CACHE.list) {
    return;
  }
  // A bounded 300-second run lease covers the default 25 sequential 10-second
  // upstream attempts, while each attempt remains strictly shorter than the lease.
  const lease = await beginSchedulerRun(env.CACHE_COORDINATOR, 300);
  if (!lease) {
    console.error('Scheduled cache refresh coordinator unavailable or busy.');
    return;
  }
  try {
  const scans = await scanHotQueueEntries(env, lease.cursors, config.maxItemsPerRun * 10);

  const nowMs = now.getTime();
  const inactivityTtlMs = config.inactivityTtlSeconds * 1000;
  const dueEntries: Record<'metar' | 'airport', HotCacheQueueEntry[]> = {
    metar: [],
    airport: []
  };

  for (const entry of [...scans.metar.entries, ...scans.airport.entries]) {
    const effectiveEntry = await keepOrEvictQueueEntry(env, entry, nowMs, inactivityTtlMs);
    if (!effectiveEntry) {
      continue;
    }

    if (await isRefreshDue(effectiveEntry, env, now, config)) {
      dueEntries[effectiveEntry.resource].push(effectiveEntry);
    }
  }

  const candidateCount = dueEntries.metar.length + dueEntries.airport.length;
  const toRefresh = selectRoundRobinDueEntries(dueEntries, candidateCount);
  let attemptedRefreshes = 0;
  const outcomes: Array<{ identity: string; outcome: SchedulerMaintenanceOutcome; lastAccessedAt: string; demandVersion?: number }> = [];
  for (const entry of toRefresh) {
    if (attemptedRefreshes >= config.maxItemsPerRun) {
      break;
    }
    const outcome = await processScheduledRefreshEntry(env, entry);
    outcomes.push({
      identity: entry.metadataKey,
      outcome,
      lastAccessedAt: entry.lastAccessedAt,
      demandVersion: entry.demandVersion
    });
    if (outcome !== 'neutral') attemptedRefreshes += 1;
    if (!(await renewSchedulerRun(env.CACHE_COORDINATOR, lease.runId, 60))) {
      throw new Error('Scheduled cache refresh coordinator lease renewal failed.');
    }
  }
  const committed = await commitSchedulerRun(env.CACHE_COORDINATOR, {
    runId: lease.runId,
    cursors: {
      metar: scans.metar.finalPage.listComplete ? undefined : scans.metar.finalPage.nextCursor,
      airport: scans.airport.finalPage.listComplete ? undefined : scans.airport.finalPage.nextCursor
    },
    outcomes,
    inactivityTtlSeconds: config.inactivityTtlSeconds
  });
  if (!committed) throw new Error('Scheduled cache refresh coordinator commit failed.');
  if (committed.dequeueIdentities.length > 0 && !(await processSchedulerDequeues(env.CACHE_COORDINATOR))) {
    console.error('Scheduled cache refresh demand deletion will retry.');
  }
  if (env.METAR_CACHE.delete) {
    await Promise.allSettled([
      env.METAR_CACHE.delete('v2:control:hot-refresh-cursor:metar'),
      env.METAR_CACHE.delete('v2:control:hot-refresh-cursor:airport')
    ]);
  }
  } catch (error) {
    await abortSchedulerRun(env.CACHE_COORDINATOR, lease.runId);
    throw error;
  }
}

export async function handleMetarRequest(request: Request, env: CacheEngineEnv, ctx?: WorkerExecutionContext): Promise<Response> {
  const requestId = createRequestId(request.headers.get('X-Request-Id'));

  if (request.method !== 'GET') {
    return buildErrorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED', {
      requestId
    });
  }

  const url = new URL(request.url);
  if (url.pathname !== '/api/metar' && url.pathname !== '/') {
    return buildErrorResponse('Not found.', 404, 'NOT_FOUND', {
      requestId
    });
  }

  const rateResult = await applyRateLimit(request, env, 'metar', requestId);
  if (!rateResult.allowed) {
    return rateResult.response;
  }

  try {
    const input = toMetarInput(request);
    const result = await getOrRefreshCached({
      adapter: METAR_ADAPTER,
      input,
      request,
      env
    });
    const accessPromise = noteSuccessfulCacheAccess(env, 'metar', normalizeIcao(input.icao));
    if (ctx) {
      ctx.waitUntil(accessPromise);
    } else {
      await accessPromise;
    }

    const payload: MetarApiSuccessPayload = {
      ...result.payload,
      cache: result.cache
    };

    return buildJsonResponse(payload, 200, {
      requestId,
      cache: result.cache,
      rateLimit: rateResult.headers
    });
  } catch (error) {
    if (error instanceof MetarWorkerError) {
      if (error.code === 'INVALID_ICAO') {
        await noteInvalidIcaoAttempt(request, env, 'metar', requestId);
      }

      return buildErrorResponse(error.message, error.status, error.code, {
        requestId,
        rateLimit: rateResult.headers
      }, shouldIncludeDebug(env) ? error.debug : undefined);
    }

    if (error instanceof CacheEngineError) {
      return buildErrorResponse(error.message, error.status, 'CACHE_ERROR', {
        requestId,
        rateLimit: rateResult.headers
      });
    }

    return buildErrorResponse('Unexpected error while loading METAR.', 500, 'UNEXPECTED', {
      requestId,
      rateLimit: rateResult.headers
    });
  }
}

export async function handleAirportRequest(request: Request, env: CacheEngineEnv, ctx?: WorkerExecutionContext): Promise<Response> {
  const requestId = createRequestId(request.headers.get('X-Request-Id'));

  if (request.method !== 'GET') {
    return buildErrorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED', {
      requestId
    });
  }

  const url = new URL(request.url);
  if (url.pathname !== '/api/airport') {
    return buildErrorResponse('Not found.', 404, 'NOT_FOUND', {
      requestId
    });
  }

  const rateResult = await applyRateLimit(request, env, 'airport', requestId);
  if (!rateResult.allowed) {
    return rateResult.response;
  }

  try {
    const input = toAirportInput(request);
    const result = await getOrRefreshCached({
      adapter: AIRPORT_ADAPTER,
      input,
      request,
      env
    });
    const accessPromise = noteSuccessfulCacheAccess(env, 'airport', normalizeAirportIcao(input.icao));
    if (ctx) {
      ctx.waitUntil(accessPromise);
    } else {
      await accessPromise;
    }

    const payload: AirportApiSuccessPayload = {
      ...result.payload,
      cache: result.cache
    };

    return buildJsonResponse(payload, 200, {
      requestId,
      cache: result.cache,
      rateLimit: rateResult.headers
    });
  } catch (error) {
    if (error instanceof AirportWorkerError) {
      if (error.code === 'INVALID_ICAO') {
        await noteInvalidIcaoAttempt(request, env, 'airport', requestId);
      }

      return buildErrorResponse(error.message, error.status, error.code, {
        requestId,
        rateLimit: rateResult.headers
      });
    }

    if (error instanceof CacheEngineError) {
      return buildErrorResponse(error.message, error.status, 'CACHE_ERROR', {
        requestId,
        rateLimit: rateResult.headers
      });
    }

    return buildErrorResponse('Unexpected error while loading airport data.', 500, 'UNEXPECTED', {
      requestId,
      rateLimit: rateResult.headers
    });
  }
}

export async function handleAirportLocationRequest(request: Request, env: CacheEngineEnv): Promise<Response> {
  const requestId = createRequestId(request.headers.get('X-Request-Id'));

  if (request.method !== 'GET') {
    return buildErrorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED', { requestId });
  }

  if (new URL(request.url).pathname !== '/api/airport-location') {
    return buildErrorResponse('Not found.', 404, 'NOT_FOUND', { requestId });
  }

  const rateResult = await applyRateLimit(request, env, 'airport', requestId);
  if (!rateResult.allowed) {
    return rateResult.response;
  }

  try {
    const input = toAirportInput(request);
    const result = await getOrRefreshCached({
      adapter: AIRPORT_LOCATION_ADAPTER,
      input,
      request,
      env
    });
    const payload: AirportLocationApiSuccessPayload = {
      ...result.payload,
      cache: result.cache
    };

    return buildJsonResponse(payload, 200, {
      requestId,
      cache: result.cache,
      rateLimit: rateResult.headers
    });
  } catch (error) {
    if (error instanceof AirportWorkerError) {
      if (error.code === 'INVALID_ICAO') {
        await noteInvalidIcaoAttempt(request, env, 'airport', requestId);
      }

      return buildErrorResponse(error.message, error.status, error.code, {
        requestId,
        rateLimit: rateResult.headers
      });
    }

    if (error instanceof CacheEngineError) {
      return buildErrorResponse(error.message, error.status, 'CACHE_ERROR', {
        requestId,
        rateLimit: rateResult.headers
      });
    }

    return buildErrorResponse('Unexpected error while loading airport location.', 500, 'UNEXPECTED', {
      requestId,
      rateLimit: rateResult.headers
    });
  }
}

export {
  ApiRateLimiter,
  CacheSingleFlightCoordinator,
  MetarWorkerError,
  normalizeIcao,
  extractMetarRaw,
  normalizeAirportIcao
};

export default {
  async fetch(request: Request, env: CacheEngineEnv, ctx?: WorkerExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (pathname === '/api/airport') {
      return handleAirportRequest(request, env, ctx);
    }

    if (pathname === '/api/airport-location') {
      return handleAirportLocationRequest(request, env);
    }

    return handleMetarRequest(request, env, ctx);
  },

  async scheduled(_controller: unknown, env: CacheEngineEnv): Promise<void> {
    await runScheduledCacheRefresh(env);
  }
};
