import type { CacheEnvelope, CacheResourceAdapter } from '../../cache/types';

const AVIATION_WEATHER_METAR_URL = 'https://aviationweather.gov/api/data/metar';
const AVIATION_WEATHER_STATION_INFO_URL = 'https://aviationweather.gov/api/data/stationinfo';
const USER_AGENT = 'benvon-runway-picker';

export const METAR_SCHEMA_VERSION = 3;

export interface MetarResourceInput {
  icao: string;
}

export interface MetarResourceData {
  icao: string;
  metarRaw: string;
  wind: MetarResourceWind;
  source: 'aviationweather';
  fetchedAt: string;
}

export interface MetarResourceWind {
  raw: string;
  directionType: 'fixed' | 'variable' | 'calm';
  directionDegTrue: number | null;
  speedKt: number;
  gustKt: number | null;
}

export class MetarWorkerError extends Error {
  status: number;
  debug?: Record<string, unknown>;

  constructor(message: string, status: number, debug?: Record<string, unknown>) {
    super(message);
    this.name = 'MetarWorkerError';
    this.status = status;
    this.debug = debug;
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
  url.searchParams.set('format', 'json');
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
    !asData.wind ||
    typeof asData.wind !== 'object' ||
    typeof (asData.wind as { raw?: unknown }).raw !== 'string' ||
    typeof (asData.wind as { directionType?: unknown }).directionType !== 'string' ||
    typeof (asData.wind as { speedKt?: unknown }).speedKt !== 'number' ||
    typeof asData.fetchedAt !== 'string' ||
    asData.source !== 'aviationweather'
  ) {
    return null;
  }

  return {
    icao: asData.icao,
    metarRaw: asData.metarRaw,
    wind: {
      raw: (asData.wind as { raw: string }).raw,
      directionType: (asData.wind as { directionType: 'fixed' | 'variable' | 'calm' }).directionType,
      directionDegTrue: (asData.wind as { directionDegTrue?: number | null }).directionDegTrue ?? null,
      speedKt: (asData.wind as { speedKt: number }).speedKt,
      gustKt: (asData.wind as { gustKt?: number | null }).gustKt ?? null
    },
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

  const candidate = value as Partial<CacheEnvelope<unknown>>;
  if (
    typeof candidate.schemaVersion !== 'number' ||
    typeof candidate.resource !== 'string' ||
    typeof candidate.key !== 'string'
  ) {
    return null;
  }

  return toMetarData(candidate.data);
}

function readField(report: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in report) {
      return report[key];
    }
  }

  return null;
}

function toStringValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${value}`;
  }

  if (value && typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    const nestedKeys = ['repr', 'value', 'raw', 'text', 'str', 'degrees', 'deg'];
    for (const key of nestedKeys) {
      const nested = toStringValue(objectValue[key]);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

function toIntegerValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }

  const stringValue = toStringValue(value);
  if (!stringValue) {
    return null;
  }

  if (!/^-?\d+$/.test(stringValue)) {
    return null;
  }

  return Number.parseInt(stringValue, 10);
}

function formatWindRaw(directionType: 'fixed' | 'variable' | 'calm', speedKt: number, gustKt: number | null, directionDeg: number | null): string {
  if (directionType === 'calm') {
    return '00000KT';
  }

  const speed = speedKt.toString().padStart(2, '0');
  const gust = gustKt === null ? '' : `G${gustKt.toString().padStart(2, '0')}`;

  if (directionType === 'variable') {
    return `VRB${speed}${gust}KT`;
  }

  const direction = (directionDeg ?? 0).toString().padStart(3, '0');
  return `${direction}${speed}${gust}KT`;
}

function parseWind(report: Record<string, unknown>): MetarResourceWind | null {
  const directionField = readField(report, ['wdir', 'wind_dir_degrees', 'windDirDegrees', 'windDir']);
  const speedField = readField(report, ['wspd', 'wind_speed_kt', 'windSpeedKt', 'windSpd']);
  const gustField = readField(report, ['wgst', 'wind_gust_kt', 'windGustKt', 'windGust']);

  const speedKt = toIntegerValue(speedField);
  const rawMetar = extractMetarRawFromReport(report);

  if (speedKt === null) {
    if (rawMetar && /\b0000{1,2}KT\b/.test(rawMetar)) {
      return {
        raw: '00000KT',
        directionType: 'calm',
        directionDegTrue: null,
        speedKt: 0,
        gustKt: null
      };
    }

    return null;
  }

  if (speedKt < 0) {
    return null;
  }

  const gustKtCandidate = toIntegerValue(gustField);
  const gustKt = gustKtCandidate !== null && gustKtCandidate >= speedKt ? gustKtCandidate : null;

  if (speedKt === 0) {
    return {
      raw: formatWindRaw('calm', speedKt, null, null),
      directionType: 'calm',
      directionDegTrue: null,
      speedKt,
      gustKt: null
    };
  }

  const directionText = toStringValue(directionField)?.toUpperCase() ?? null;
  if (directionText === 'VRB') {
    return {
      raw: formatWindRaw('variable', speedKt, gustKt, null),
      directionType: 'variable',
      directionDegTrue: null,
      speedKt,
      gustKt
    };
  }

  const directionDeg = toIntegerValue(directionField);
  if (directionDeg === null || directionDeg < 0 || directionDeg > 360) {
    return {
      raw: formatWindRaw('variable', speedKt, gustKt, null),
      directionType: 'variable',
      directionDegTrue: null,
      speedKt,
      gustKt
    };
  }

  return {
    raw: formatWindRaw('fixed', speedKt, gustKt, directionDeg),
    directionType: 'fixed',
    directionDegTrue: directionDeg,
    speedKt,
    gustKt
  };
}

function extractWindToken(rawMetar: string): string | null {
  const match = rawMetar.match(/\b((?:\d{3}|VRB)\d{2,3}(?:G\d{2,3})?KT|0000{1,2}KT)\b/);
  if (!match) {
    return null;
  }

  return match[1] ?? null;
}

function buildWindDebugInfo(report: Record<string, unknown>): Record<string, unknown> {
  const directionField = readField(report, ['wdir', 'wind_dir_degrees', 'windDirDegrees', 'windDir']);
  const speedField = readField(report, ['wspd', 'wind_speed_kt', 'windSpeedKt', 'windSpd']);
  const gustField = readField(report, ['wgst', 'wind_gust_kt', 'windGustKt', 'windGust']);
  const rawMetar = extractMetarRawFromReport(report);

  return {
    availableFields: Object.keys(report).sort(),
    candidates: {
      directionField: toStringValue(directionField),
      speedField: toStringValue(speedField),
      gustField: toStringValue(gustField)
    },
    rawWindToken: rawMetar ? extractWindToken(rawMetar) : null,
    rawObPresent: Boolean(rawMetar)
  };
}

function toMetarReport(upstream: unknown): Record<string, unknown> | null {
  if (!Array.isArray(upstream) || upstream.length === 0) {
    return null;
  }

  const first = upstream[0];
  if (!first || typeof first !== 'object') {
    return null;
  }

  return first as Record<string, unknown>;
}

function extractMetarRawFromReport(report: Record<string, unknown>): string | null {
  const direct = toStringValue(
    readField(report, ['rawOb', 'raw_text', 'rawText', 'raw', 'metar'])
  );

  if (direct) {
    return direct;
  }

  return null;
}

export const metarResourceAdapter: CacheResourceAdapter<MetarResourceInput, unknown, MetarResourceData> = {
  resource: 'metar',
  schemaVersion: METAR_SCHEMA_VERSION,
  normalizeKey: (input) => normalizeIcao(input.icao),
  fetchUpstream: async (input) => {
    const icao = normalizeIcao(input.icao);
    const response = await fetch(buildMetarUrl(icao), {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new MetarWorkerError(`METAR provider returned status ${response.status}.`, 502);
    }

    return response.json();
  },
  validate: async (upstream, input) => {
    const icao = normalizeIcao(input.icao);
    const report = toMetarReport(upstream);
    if (!report) {
      const stationExists = await stationExistsForIcao(icao);
      if (!stationExists) {
        throw new MetarWorkerError(`ICAO code ${icao} was not found. Check the code and try again.`, 404);
      }

      throw new MetarWorkerError(`No METAR is currently available for ICAO ${icao}. Try again later.`, 404);
    }

    const metarRaw = extractMetarRawFromReport(report);
    if (!metarRaw) {
      throw new MetarWorkerError(`No METAR is currently available for ICAO ${icao}. Try again later.`, 404);
    }

    const wind = parseWind(report);
    if (!wind) {
      throw new MetarWorkerError(
        `Unable to parse wind data from METAR provider for ICAO ${icao}.`,
        502,
        buildWindDebugInfo(report)
      );
    }

    return {
      icao,
      metarRaw,
      wind,
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
