import { CacheEngineError, getOrRefreshCached } from './cache/engine';
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

function createRequestId(existing: string | null): string {
  if (typeof existing === 'string' && existing.trim().length > 0) {
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

export async function handleMetarRequest(request: Request, env: CacheEngineEnv): Promise<Response> {
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

export async function handleAirportRequest(request: Request, env: CacheEngineEnv): Promise<Response> {
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
  async fetch(request: Request, env: CacheEngineEnv): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (pathname === '/api/airport') {
      return handleAirportRequest(request, env);
    }

    return handleMetarRequest(request, env);
  }
};
