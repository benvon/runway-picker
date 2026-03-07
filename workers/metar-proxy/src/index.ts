import { CacheEngineError, getOrRefreshCached } from './cache/engine';
import {
  deleteHotCacheEntryAndPayload,
  listHotCacheQueueEntries,
  parseCacheRefresherConfig,
  readHotCacheQueueEntry,
  readIsoTimestamp,
  refreshIntervalSecondsForResource,
  touchHotCacheEntry,
  updateHotCacheEntryAfterRefresh,
  type HotCacheQueueEntry
} from './cache/hotQueue';
import { getAdapterOrThrow } from './cache/registry';
import { CacheSingleFlightCoordinator } from './cache/singleFlight';
import type { CacheEngineEnv, CacheProvenance } from './cache/types';
import { createResourceRegistry } from './resources';
import {
  airportResourceAdapter,
  AirportWorkerError,
  normalizeAirportIcao,
  type AirportResourceData,
  type AirportResourceInput
} from './resources/airport/adapter';
import {
  extractMetarRaw,
  MetarWorkerError,
  metarResourceAdapter,
  normalizeIcao,
  type MetarResourceData,
  type MetarResourceInput
} from './resources/metar/adapter';
import { ApiRateLimiter, enforceRateLimit, noteInvalidIcao, type RateLimitHeaders } from './security/rateLimiter';

const RESOURCE_REGISTRY = createResourceRegistry();
const METAR_ADAPTER = getAdapterOrThrow(RESOURCE_REGISTRY, 'metar') as typeof metarResourceAdapter;
const AIRPORT_ADAPTER = getAdapterOrThrow(RESOURCE_REGISTRY, 'airport') as typeof airportResourceAdapter;

const API_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
};

interface MetarApiSuccessPayload extends MetarResourceData {
  cache: CacheProvenance;
}

interface AirportApiSuccessPayload extends AirportResourceData {
  cache: CacheProvenance;
}

type Endpoint = 'metar' | 'airport';

interface ResponseOptions {
  requestId: string;
  cache?: CacheProvenance;
  ttlSeconds?: number;
  rateLimit?: RateLimitHeaders;
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

function withApiHeaders(status: number, options: ResponseOptions): Headers {
  const headers = new Headers({
    'Cache-Control': status === 200 ? `public, max-age=60, s-maxage=${options.ttlSeconds ?? 60}` : 'no-store',
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

  return headers;
}

function buildJsonResponse(payload: unknown, status: number, options: ResponseOptions): Response {
  return Response.json(payload, {
    status,
    headers: withApiHeaders(status, options)
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
  if (!decision.allowed) {
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

async function noteInvalidIcaoAttempt(request: Request, env: CacheEngineEnv, endpoint: Endpoint): Promise<void> {
  await noteInvalidIcao(env.API_RATE_LIMITER, getClientIdentifier(request), endpoint);
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

export async function runScheduledCacheRefresh(env: CacheEngineEnv, now = new Date()): Promise<void> {
  const config = parseCacheRefresherConfig(env);
  if (!config.enabled) {
    return;
  }

  const scanCap = config.maxItemsPerRun * 10;
  const queueEntries = await listHotCacheQueueEntries(env, scanCap);
  if (queueEntries.length === 0) {
    return;
  }

  const nowMs = now.getTime();
  const inactivityTtlMs = config.inactivityTtlSeconds * 1000;
  const dueEntries: HotCacheQueueEntry[] = [];

  for (const entry of queueEntries) {
    let effectiveEntry: HotCacheQueueEntry = entry;
    let lastAccessedAtMs = readIsoTimestamp(effectiveEntry.lastAccessedAt);

    if (lastAccessedAtMs <= 0 || nowMs - lastAccessedAtMs > inactivityTtlMs) {
      // Re-read latest metadata before evicting to avoid racing with concurrent user requests.
      const latest = await readHotCacheQueueEntry(env, entry.metadataKey);
      if (!latest) {
        // Entry was already deleted elsewhere.
        continue;
      }

      effectiveEntry = latest;
      lastAccessedAtMs = readIsoTimestamp(effectiveEntry.lastAccessedAt);

      if (lastAccessedAtMs <= 0 || nowMs - lastAccessedAtMs > inactivityTtlMs) {
        await deleteHotCacheEntryAndPayload(env, effectiveEntry);
        await purgeEdgeCacheForKey(effectiveEntry.cacheKey);
        continue;
      }

      // Entry was recently accessed by a concurrent request; fall through to refresh check.
    }

    const refreshIntervalMs = refreshIntervalSecondsForResource(effectiveEntry.resource, config) * 1000;
    const lastRefreshedAtMs = readIsoTimestamp(effectiveEntry.lastRefreshedAt);
    if (lastRefreshedAtMs <= 0 || nowMs - lastRefreshedAtMs >= refreshIntervalMs) {
      dueEntries.push(effectiveEntry);
    }
  }

  dueEntries.sort((left, right) => readIsoTimestamp(left.lastRefreshedAt) - readIsoTimestamp(right.lastRefreshedAt));

  const toRefresh = dueEntries.slice(0, config.maxItemsPerRun);
  for (const entry of toRefresh) {
    try {
      const refreshedCache = await refreshQueueEntry(entry, env);
      await updateHotCacheEntryAfterRefresh(env, entry, refreshedCache, config.inactivityTtlSeconds);
    } catch (error) {
      console.error('Scheduled cache refresh failed for hot cache queue entry.', {
        entry,
        error
      });
    }
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
      ttlSeconds: metarResourceAdapter.policy.ttlSeconds,
      rateLimit: rateResult.headers
    });
  } catch (error) {
    if (error instanceof MetarWorkerError) {
      if (error.code === 'INVALID_ICAO') {
        await noteInvalidIcaoAttempt(request, env, 'metar');
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
      ttlSeconds: airportResourceAdapter.policy.ttlSeconds,
      rateLimit: rateResult.headers
    });
  } catch (error) {
    if (error instanceof AirportWorkerError) {
      if (error.code === 'INVALID_ICAO') {
        await noteInvalidIcaoAttempt(request, env, 'airport');
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

    return handleMetarRequest(request, env, ctx);
  },

  async scheduled(_controller: unknown, env: CacheEngineEnv): Promise<void> {
    await runScheduledCacheRefresh(env);
  }
};
