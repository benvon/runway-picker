import type { CacheEnvelope, CacheResourceAdapter } from '../../cache/types';

const AVIATION_WEATHER_METAR_URL = 'https://aviationweather.gov/api/data/metar';
const AVIATION_WEATHER_STATION_INFO_URL = 'https://aviationweather.gov/api/data/stationinfo';
const USER_AGENT = 'benvon-runway-picker';

export const METAR_SCHEMA_VERSION = 2;

export interface MetarResourceInput {
  icao: string;
}

export interface MetarResourceData {
  icao: string;
  metarRaw: string;
  source: 'aviationweather';
  fetchedAt: string;
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

function buildMetarUrl(icao: string): string {
  const url = new URL(AVIATION_WEATHER_METAR_URL);
  url.searchParams.set('ids', icao);
  url.searchParams.set('format', 'raw');
  return url.toString();
}

function buildStationInfoUrl(icao: string): string {
  const url = new URL(AVIATION_WEATHER_STATION_INFO_URL);
  url.searchParams.set('ids', icao);
  url.searchParams.set('format', 'json');
  return url.toString();
}

async function stationExistsForIcao(icao: string): Promise<boolean> {
  const response = await fetch(buildStationInfoUrl(icao), {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new MetarWorkerError('Unable to validate ICAO code with weather provider.', 502);
  }

  const payload = (await response.json()) as unknown;
  return Array.isArray(payload) && payload.length > 0;
}

function toMetarData(candidate: unknown): MetarResourceData | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const asData = candidate as Partial<MetarResourceData>;
  if (
    typeof asData.icao !== 'string' ||
    typeof asData.metarRaw !== 'string' ||
    typeof asData.fetchedAt !== 'string' ||
    asData.source !== 'aviationweather'
  ) {
    return null;
  }

  return {
    icao: asData.icao,
    metarRaw: asData.metarRaw,
    fetchedAt: asData.fetchedAt,
    source: asData.source
  };
}

function toDateOrNow(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }

  return parsed;
}

function serializeMetar(data: MetarResourceData, key: string, resource: string): CacheEnvelope<MetarResourceData> {
  const fetchedAtDate = toDateOrNow(data.fetchedAt);
  const fetchedAt = fetchedAtDate.toISOString();
  const expiresAt = new Date(fetchedAtDate.getTime() + metarResourceAdapter.policy.ttlSeconds * 1000).toISOString();

  return {
    schemaVersion: METAR_SCHEMA_VERSION,
    resource,
    key,
    data: {
      ...data,
      fetchedAt
    },
    cacheMeta: {
      fetchedAt,
      expiresAt,
      policyVersion: metarResourceAdapter.policy.policyVersion,
      source: 'upstream'
    }
  };
}

function deserializeMetar(value: unknown): MetarResourceData | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const withEnvelopeData = (value as { data?: unknown }).data;
  if (withEnvelopeData) {
    return toMetarData(withEnvelopeData);
  }

  return toMetarData(value);
}

export const metarResourceAdapter: CacheResourceAdapter<MetarResourceInput, string, MetarResourceData> = {
  resource: 'metar',
  schemaVersion: METAR_SCHEMA_VERSION,
  normalizeKey: (input) => normalizeIcao(input.icao),
  fetchUpstream: async (input) => {
    const icao = normalizeIcao(input.icao);
    const response = await fetch(buildMetarUrl(icao), {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/plain'
      }
    });

    if (!response.ok) {
      throw new MetarWorkerError(`METAR provider returned status ${response.status}.`, 502);
    }

    return response.text();
  },
  validate: async (upstream, input) => {
    const icao = normalizeIcao(input.icao);
    const metarRaw = extractMetarRaw(upstream);
    if (!metarRaw) {
      const stationExists = await stationExistsForIcao(icao);
      if (!stationExists) {
        throw new MetarWorkerError(`ICAO code ${icao} was not found. Check the code and try again.`, 404);
      }

      throw new MetarWorkerError(`No METAR is currently available for ICAO ${icao}. Try again later.`, 404);
    }

    return {
      icao,
      metarRaw,
      source: 'aviationweather',
      fetchedAt: new Date().toISOString()
    };
  },
  serialize: serializeMetar,
  deserialize: deserializeMetar,
  policy: {
    ttlSeconds: 1800,
    staleWhileRevalidateSeconds: 180,
    staleOnErrorSeconds: 7200,
    negativeCacheTtlSeconds: 180,
    policyVersion: 'metar-v1'
  },
  observability: (input, key) => ({
    labels: {
      resource: 'metar',
      key,
      icao: normalizeIcao(input.icao)
    }
  })
};
