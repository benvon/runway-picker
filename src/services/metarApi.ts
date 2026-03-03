export type MetarCacheState = 'fresh' | 'cached' | 'unknown';

export interface MetarLookupResponse {
  icao: string;
  metarRaw: string;
  source: 'aviationweather';
  fetchedAt: string;
  cacheState: MetarCacheState;
}

export class MetarLookupError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'MetarLookupError';
    this.status = status;
  }
}

function normalizeIcaoInput(value: string): string {
  return value.trim().toUpperCase();
}

function parseCacheState(headers: Headers): MetarCacheState {
  const cacheHeader = headers.get('X-Cache')?.trim().toUpperCase();
  if (cacheHeader === 'HIT') {
    return 'cached';
  }

  if (cacheHeader === 'MISS') {
    return 'fresh';
  }

  return 'unknown';
}

export async function fetchMetarByIcao(icaoInput: string): Promise<MetarLookupResponse> {
  const icao = normalizeIcaoInput(icaoInput);
  if (!/^[A-Z0-9]{4}$/.test(icao)) {
    throw new MetarLookupError('Enter a valid 4-character ICAO code, for example KJFK.', 400);
  }

  const response = await fetch(`/api/metar?icao=${encodeURIComponent(icao)}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    let message = `Unable to load METAR for ${icao}.`;

    try {
      const errorPayload = (await response.json()) as { error?: string; message?: string };
      message = errorPayload.error ?? errorPayload.message ?? message;
    } catch {
      // Keep default message when body isn't JSON.
    }

    throw new MetarLookupError(message, response.status);
  }

  const payload = (await response.json()) as Omit<MetarLookupResponse, 'cacheState'>;
  return {
    ...payload,
    cacheState: parseCacheState(response.headers)
  };
}
