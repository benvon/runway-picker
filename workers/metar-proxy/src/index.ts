import { CacheEngineError, getOrRefreshCached } from './cache/engine';
import { provenanceAtResponseTime } from './cache/freshness';
import {
  commitHotCacheQueueCursor,
  deleteHotCacheEntryAndPayload,
  isInvalidHotCacheQueueCursorError,
  listHotCacheQueuePage,
  loadHotCacheQueueEntries,
  parseCacheRefresherConfig,
  recordHotCacheRefreshFailure,
  readHotCacheQueueCursor,
  readHotCacheQueueEntry,
  readIsoTimestamp,
  recoverRejectedHotCacheQueueCursor,
  refreshIntervalSecondsForResource,
  touchHotCacheEntry,
  updateHotCacheEntryAfterRefresh,
  type HotCacheQueuePage,
  type HotCacheResource,
  type HotCacheQueueEntry
} from './cache/hotQueue';
import { getAdapterOrThrow } from './cache/registry';
import { CacheSingleFlightCoordinator } from './cache/singleFlight';
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
  normalizedKey: string,
  cache: CacheProvenance
): Promise<void> {
  try {
    const config = parseCacheRefresherConfig(env);
    await touchHotCacheEntry({
      env,
      resource,
      normalizedKey,
      cache,
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
  if (entry.resource === 'metar') {
    const result = await getOrRefreshCached({
      adapter: METAR_ADAPTER,
      input: { icao: entry.normalizedKey },
      request: toRefreshRequest('metar', entry.normalizedKey),
      env
    });
    return result.cache;
  }

  const result = await getOrRefreshCached({
    adapter: AIRPORT_ADAPTER,
    input: { icao: entry.normalizedKey },
    request: toRefreshRequest('airport', entry.normalizedKey),
    env
  });
  return result.cache;
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

function isRefreshDue(entry: HotCacheQueueEntry, nowMs: number, config: ReturnType<typeof parseCacheRefresherConfig>): boolean {
  const refreshIntervalMs = refreshIntervalSecondsForResource(entry.resource, config) * 1000;
  const lastRefreshedAtMs = readIsoTimestamp(entry.lastRefreshedAt);
  return lastRefreshedAtMs <= 0 || nowMs - lastRefreshedAtMs >= refreshIntervalMs;
}

function selectRoundRobinDueEntries(
  dueEntries: Record<'metar' | 'airport', HotCacheQueueEntry[]>,
  maxItems: number
): HotCacheQueueEntry[] {
  const remaining = {
    metar: [...dueEntries.metar].sort(
      (left, right) => readIsoTimestamp(left.lastRefreshedAt) - readIsoTimestamp(right.lastRefreshedAt)
    ),
    airport: [...dueEntries.airport].sort(
      (left, right) => readIsoTimestamp(left.lastRefreshedAt) - readIsoTimestamp(right.lastRefreshedAt)
    )
  };
  const queues = [remaining.metar, remaining.airport];
  const selected: HotCacheQueueEntry[] = [];
  let nextQueueIndex =
    readIsoTimestamp(remaining.metar[0]?.lastRefreshedAt ?? '') <=
    readIsoTimestamp(remaining.airport[0]?.lastRefreshedAt ?? '')
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
  scanBudget: number
): Promise<ResourceScan> {
  const savedCursor = await readHotCacheQueueCursor(env, resource);
  let page: HotCacheQueuePage;
  try {
    page = await listHotCacheQueuePage(env, resource, savedCursor, scanBudget);
  } catch (error) {
    if (!savedCursor || !isInvalidHotCacheQueueCursorError(error)) {
      throw error;
    }

    await recoverRejectedHotCacheQueueCursor(env, resource);
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
  scanCap: number
): Promise<Record<'metar' | 'airport', ResourceScan>> {
  const metarBudget = Math.ceil(scanCap / 2);
  const airportBudget = scanCap - metarBudget;
  const [metarPage, airportPage] = await Promise.all([
    startResourceScan(env, 'metar', metarBudget),
    startResourceScan(env, 'airport', airportBudget)
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
  isRefreshDue,
  keepOrEvictQueueEntry,
  selectRoundRobinDueEntries
};

async function recordScheduledRefreshFailure(
  env: CacheEngineEnv,
  entry: HotCacheQueueEntry,
  inactivityTtlSeconds: number,
  message: string,
  details: Record<string, unknown>
): Promise<void> {
  try {
    const failure = await recordHotCacheRefreshFailure(env, entry, inactivityTtlSeconds);
    console.error(message, {
      entry,
      ...details,
      consecutiveRefreshFailures: failure.consecutiveRefreshFailures,
      droppedFromHotQueue: failure.dropped
    });
  } catch (failureRecordError) {
    console.error('Scheduled cache refresh failure count could not be recorded.', {
      entry,
      ...details,
      failureRecordError
    });
  }
}

export async function runScheduledCacheRefresh(env: CacheEngineEnv, now = new Date()): Promise<void> {
  const config = parseCacheRefresherConfig(env);
  if (!config.enabled) {
    return;
  }
  if (!env.METAR_CACHE.list) {
    return;
  }

  const scans = await scanHotQueueEntries(env, config.maxItemsPerRun * 10);

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

    if (isRefreshDue(effectiveEntry, nowMs, config)) {
      dueEntries[effectiveEntry.resource].push(effectiveEntry);
    }
  }

  const toRefresh = selectRoundRobinDueEntries(dueEntries, config.maxItemsPerRun);
  for (const entry of toRefresh) {
    let refreshedCache: CacheProvenance;
    try {
      refreshedCache = await refreshQueueEntry(entry, env);
    } catch (error) {
      await recordScheduledRefreshFailure(
        env,
        entry,
        config.inactivityTtlSeconds,
        'Scheduled cache refresh failed for hot cache queue entry.',
        { error }
      );
      continue;
    }

    if (refreshedCache.status === 'stale_on_error') {
      await recordScheduledRefreshFailure(
        env,
        entry,
        config.inactivityTtlSeconds,
        'Scheduled cache refresh fell back to stale data after an upstream failure.',
        {}
      );
      continue;
    }

    if (refreshedCache.status !== 'upstream_refresh') {
      continue;
    }

    try {
      await updateHotCacheEntryAfterRefresh(env, entry, refreshedCache, config.inactivityTtlSeconds);
    } catch (error) {
      console.error('Scheduled cache refresh succeeded but hot cache metadata could not be updated.', {
        entry,
        error
      });
    }
  }

  await Promise.all([
    commitHotCacheQueueCursor(env, scans.metar.resource, scans.metar.finalPage),
    commitHotCacheQueueCursor(env, scans.airport.resource, scans.airport.finalPage)
  ]);
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
    const accessPromise = noteSuccessfulCacheAccess(env, 'metar', normalizeIcao(input.icao), result.cache);
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
    const accessPromise = noteSuccessfulCacheAccess(env, 'airport', normalizeAirportIcao(input.icao), result.cache);
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
