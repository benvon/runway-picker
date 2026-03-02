export interface MetarLookupResponse {
  icao: string;
  metarRaw: string;
  source: 'aviationweather';
  fetchedAt: string;
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

  return (await response.json()) as MetarLookupResponse;
}
