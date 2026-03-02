const AVIATION_WEATHER_METAR_URL = 'https://aviationweather.gov/api/data/metar';
const CACHE_TTL_SECONDS = 1800;
const USER_AGENT = 'benvon-runway-picker';

interface MetarCachePayload {
  icao: string;
  metarRaw: string;
  source: 'aviationweather';
  fetchedAt: string;
}

interface MetarWorkerEnv {
  METAR_CACHE: {
    get(key: string, type: 'json'): Promise<unknown>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  };
}

export class MetarWorkerError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'MetarWorkerError';
    this.status = status;
  }
}

export function normalizeIcao(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(normalized)) {
    throw new MetarWorkerError('Invalid ICAO code. Expected 4 alphanumeric characters.', 400);
  }

  return normalized;
}

export function extractMetarRaw(rawText: string): string | null {
  const lines = rawText
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  for (const line of lines) {
    if (/^(METAR|SPECI)\s/.test(line) || /^[A-Z0-9]{4}\s\d{6}Z\s/.test(line)) {
      return line;
    }
  }

  return null;
}

function buildUpstreamUrl(icao: string): string {
  const url = new URL(AVIATION_WEATHER_METAR_URL);
  url.searchParams.set('ids', icao);
  url.searchParams.set('format', 'raw');
  return url.toString();
}

function buildJsonResponse(payload: unknown, status: number, cacheState?: 'HIT' | 'MISS'): Response {
  const headers: Record<string, string> = {};

  if (status === 200) {
    headers['Cache-Control'] = `public, max-age=60, s-maxage=${CACHE_TTL_SECONDS}`;
    if (cacheState) {
      headers['X-Cache'] = cacheState;
    }
  } else {
    headers['Cache-Control'] = 'no-store';
  }

  return Response.json(payload, {
    status,
    headers
  });
}

function cacheKeyForIcao(icao: string): string {
  return `metar:${icao}`;
}

function toMetarPayload(value: unknown): MetarCachePayload | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<MetarCachePayload>;
  if (
    typeof candidate.icao !== 'string' ||
    typeof candidate.metarRaw !== 'string' ||
    typeof candidate.fetchedAt !== 'string' ||
    candidate.source !== 'aviationweather'
  ) {
    return null;
  }

  return {
    icao: candidate.icao,
    metarRaw: candidate.metarRaw,
    source: candidate.source,
    fetchedAt: candidate.fetchedAt
  };
}

export async function handleMetarRequest(request: Request, env: MetarWorkerEnv): Promise<Response> {
  if (request.method !== 'GET') {
    return buildJsonResponse({ error: 'Method not allowed.' }, 405);
  }

  try {
    const url = new URL(request.url);
    if (url.pathname !== '/api/metar' && url.pathname !== '/') {
      return buildJsonResponse({ error: 'Not found.' }, 404);
    }

    const icao = normalizeIcao(url.searchParams.get('icao') ?? '');
    const key = cacheKeyForIcao(icao);

    const cached = toMetarPayload(await env.METAR_CACHE.get(key, 'json'));
    if (cached) {
      return buildJsonResponse(cached, 200, 'HIT');
    }

    const upstreamResponse = await fetch(buildUpstreamUrl(icao), {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/plain'
      }
    });

    if (!upstreamResponse.ok) {
      throw new MetarWorkerError(`METAR provider returned status ${upstreamResponse.status}.`, 502);
    }

    const upstreamBody = await upstreamResponse.text();
    const metarRaw = extractMetarRaw(upstreamBody);
    if (!metarRaw) {
      throw new MetarWorkerError(`No METAR found for ICAO ${icao}.`, 404);
    }

    const payload: MetarCachePayload = {
      icao,
      metarRaw,
      source: 'aviationweather',
      fetchedAt: new Date().toISOString()
    };

    await env.METAR_CACHE.put(key, JSON.stringify(payload), {
      expirationTtl: CACHE_TTL_SECONDS
    });

    return buildJsonResponse(payload, 200, 'MISS');
  } catch (error) {
    if (error instanceof MetarWorkerError) {
      return buildJsonResponse({ error: error.message }, error.status);
    }

    return buildJsonResponse({ error: 'Unexpected error while loading METAR.' }, 500);
  }
}

export default {
  async fetch(request: Request, env: MetarWorkerEnv): Promise<Response> {
    return handleMetarRequest(request, env);
  }
};
