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

const RESOURCE_REGISTRY = createResourceRegistry();
const METAR_ADAPTER = getAdapterOrThrow(RESOURCE_REGISTRY, 'metar') as typeof metarResourceAdapter;
const AIRPORT_ADAPTER = getAdapterOrThrow(RESOURCE_REGISTRY, 'airport') as typeof airportResourceAdapter;

interface MetarApiSuccessPayload extends MetarResourceData {
  cache: CacheProvenance;
}

interface AirportApiSuccessPayload extends AirportResourceData {
  cache: CacheProvenance;
}

function buildJsonResponse(
  payload: unknown,
  status: number,
  options?: {
    cache?: CacheProvenance;
    ttlSeconds?: number;
  }
): Response {
  const headers: Record<string, string> = {
    'Cache-Control': status === 200 ? `public, max-age=60, s-maxage=${options?.ttlSeconds ?? 60}` : 'no-store'
  };

  if (options?.cache && status === 200) {
    headers['X-Runway-Cache-Status'] = options.cache.status;
  }

  return Response.json(payload, {
    status,
    headers
  });
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

export async function handleMetarRequest(request: Request, env: CacheEngineEnv): Promise<Response> {
  if (request.method !== 'GET') {
    return buildJsonResponse({ error: 'Method not allowed.' }, 405);
  }

  const url = new URL(request.url);
  if (url.pathname !== '/api/metar' && url.pathname !== '/') {
    return buildJsonResponse({ error: 'Not found.' }, 404);
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
      cache: result.cache,
      ttlSeconds: metarResourceAdapter.policy.ttlSeconds
    });
  } catch (error) {
    if (error instanceof MetarWorkerError) {
      return buildJsonResponse(
        error.debug ? { error: error.message, debug: error.debug } : { error: error.message },
        error.status
      );
    }

    if (error instanceof CacheEngineError) {
      return buildJsonResponse({ error: error.message }, error.status);
    }

    return buildJsonResponse({ error: 'Unexpected error while loading METAR.' }, 500);
  }
}

export async function handleAirportRequest(request: Request, env: CacheEngineEnv): Promise<Response> {
  if (request.method !== 'GET') {
    return buildJsonResponse({ error: 'Method not allowed.' }, 405);
  }

  const url = new URL(request.url);
  if (url.pathname !== '/api/airport') {
    return buildJsonResponse({ error: 'Not found.' }, 404);
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
      cache: result.cache,
      ttlSeconds: airportResourceAdapter.policy.ttlSeconds
    });
  } catch (error) {
    if (error instanceof AirportWorkerError) {
      return buildJsonResponse({ error: error.message }, error.status);
    }

    if (error instanceof CacheEngineError) {
      return buildJsonResponse({ error: error.message }, error.status);
    }

    return buildJsonResponse({ error: 'Unexpected error while loading airport data.' }, 500);
  }
}

export { CacheSingleFlightCoordinator, MetarWorkerError, normalizeIcao, extractMetarRaw, normalizeAirportIcao };

export default {
  async fetch(request: Request, env: CacheEngineEnv): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (pathname === '/api/airport') {
      return handleAirportRequest(request, env);
    }

    return handleMetarRequest(request, env);
  }
};
