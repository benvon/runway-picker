import { CacheEngineError, getOrRefreshCached } from './cache/engine';
import { getAdapterOrThrow } from './cache/registry';
import { CacheSingleFlightCoordinator } from './cache/singleFlight';
import type { CacheEngineEnv, CacheProvenance } from './cache/types';
import { createResourceRegistry } from './resources';
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

interface MetarApiSuccessPayload extends MetarResourceData {
  cache: CacheProvenance;
}

function buildJsonResponse(payload: unknown, status: number, cache?: CacheProvenance): Response {
  const headers: Record<string, string> = {
    'Cache-Control': status === 200 ? `public, max-age=60, s-maxage=${metarResourceAdapter.policy.ttlSeconds}` : 'no-store'
  };

  if (cache && status === 200) {
    headers['X-Runway-Cache-Status'] = cache.status;
  }

  return Response.json(payload, {
    status,
    headers
  });
}

function toInput(request: Request): MetarResourceInput {
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
    const input = toInput(request);
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

    return buildJsonResponse(payload, 200, result.cache);
  } catch (error) {
    if (error instanceof MetarWorkerError) {
      return buildJsonResponse({ error: error.message }, error.status);
    }

    if (error instanceof CacheEngineError) {
      return buildJsonResponse({ error: error.message }, error.status);
    }

    return buildJsonResponse({ error: 'Unexpected error while loading METAR.' }, 500);
  }
}

export { CacheSingleFlightCoordinator, MetarWorkerError, normalizeIcao, extractMetarRaw };

export default {
  async fetch(request: Request, env: CacheEngineEnv): Promise<Response> {
    return handleMetarRequest(request, env);
  }
};
