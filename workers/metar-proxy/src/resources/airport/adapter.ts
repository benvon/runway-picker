import type { CacheEnvelope, CacheResourceAdapter } from '../../cache/types';

const AIRPORT_DB_BASE_URL = 'https://airportdb.io/api/v1/airport';
const USER_AGENT = 'benvon-runway-picker';

export const AIRPORT_SCHEMA_VERSION = 7;

export interface AirportResourceInput {
  icao: string;
}

export interface AirportRunwayEnd {
  id: string;
  headingDegMag: number;
  isClosed: boolean;
  lengthFt: number | null;
}

export interface AirportResourceFrequency {
  type: string;
  description: string;
  frequencyMhz: string;
}

interface AirportDbCountry {
  name?: unknown;
  [key: string]: unknown;
}

export interface AirportUpstreamSnapshot {
  ident?: unknown;
  icao_code?: unknown;
  name?: unknown;
  municipality?: unknown;
  iso_country?: unknown;
  country?: AirportDbCountry | unknown;
  elevation_ft?: unknown;
  runways?: unknown;
  frequencies?: unknown;
  freqs?: unknown;
  [key: string]: unknown;
}

export interface AirportResourceData {
  requestedIcao: string;
  icao: string;
  name: string;
  municipality: string;
  countryCode: string;
  countryName: string;
  elevationFt: number | null;
  runwayEnds: AirportRunwayEnd[];
  frequencies: AirportResourceFrequency[];
  upstreamPayload: AirportUpstreamSnapshot;
  source: 'airportdb';
  fetchedAt: string;
}

export type AirportWorkerErrorCode =
  | 'INVALID_ICAO'
  | 'SERVICE_NOT_CONFIGURED'
  | 'AUTH_ERROR'
  | 'ICAO_NOT_FOUND'
  | 'RUNWAY_DATA_UNAVAILABLE'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_PAYLOAD_INVALID'
  | 'UNEXPECTED';

type AirportDbPayload = AirportUpstreamSnapshot;

interface AirportDbRunway {
  closed?: unknown;
  length_ft?: unknown;
  le_ident?: unknown;
  he_ident?: unknown;
  [key: string]: unknown;
}

interface AirportDbFrequency {
  type?: unknown;
  description?: unknown;
  frequency_mhz?: unknown;
  [key: string]: unknown;
}

type AirportResourceShapeCandidate = Omit<AirportResourceData, 'frequencies' | 'upstreamPayload'> & {
  frequencies?: AirportResourceData['frequencies'];
  upstreamPayload?: unknown;
};

export class AirportWorkerError extends Error {
  status: number;
  code: AirportWorkerErrorCode;

  constructor(message: string, status: number, code: AirportWorkerErrorCode) {
    super(message);
    this.name = 'AirportWorkerError';
    this.status = status;
    this.code = code;
  }
}

export function normalizeAirportIcao(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(normalized)) {
    throw new AirportWorkerError('Invalid ICAO code. Expected 4 alphanumeric characters.', 400, 'INVALID_ICAO');
  }

  return normalized;
}

function toStringValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toIntegerValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }

  return Number.parseInt(trimmed, 10);
}

function isRunwayClosed(value: unknown): boolean {
  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function toRunwayEnd(identCandidate: unknown, isClosed: boolean, lengthFt: number | null): AirportRunwayEnd | null {
  const ident = toStringValue(identCandidate)?.toUpperCase() ?? null;
  if (!ident) {
    return null;
  }

  const match = ident.match(/^(0?[1-9]|[12][0-9]|3[0-6])([LCR])?$/i);
  if (!match) {
    return null;
  }

  const runwayNumber = Number.parseInt(match[1], 10);
  const suffix = match[2] ?? '';

  return {
    id: `${String(runwayNumber).padStart(2, '0')}${suffix}`,
    headingDegMag: runwayNumber === 36 ? 360 : runwayNumber * 10,
    isClosed,
    lengthFt
  };
}

function isOptionalArray(value: unknown): boolean {
  return typeof value === 'undefined' || Array.isArray(value);
}

function isOptionalPlainObject(value: unknown): boolean {
  return (
    typeof value === 'undefined' ||
    (Boolean(value) && typeof value === 'object' && !Array.isArray(value))
  );
}

function isAirportResourceShape(
  asData: Partial<AirportResourceShapeCandidate>
): asData is AirportResourceShapeCandidate {
  return (
    typeof asData.requestedIcao === 'string' &&
    typeof asData.icao === 'string' &&
    typeof asData.name === 'string' &&
    typeof asData.municipality === 'string' &&
    typeof asData.countryCode === 'string' &&
    typeof asData.countryName === 'string' &&
    Array.isArray(asData.runwayEnds) &&
    isOptionalArray(asData.frequencies) &&
    isOptionalPlainObject(asData.upstreamPayload) &&
    typeof asData.fetchedAt === 'string' &&
    asData.source === 'airportdb'
  );
}

function isAirportRunwayEndCandidate(runway: unknown): runway is AirportRunwayEnd {
  return (
    Boolean(runway) &&
    typeof runway === 'object' &&
    typeof (runway as { id?: unknown }).id === 'string' &&
    typeof (runway as { headingDegMag?: unknown }).headingDegMag === 'number' &&
    typeof (runway as { isClosed?: unknown }).isClosed === 'boolean' &&
    ((runway as { lengthFt?: unknown }).lengthFt === null ||
      typeof (runway as { lengthFt?: unknown }).lengthFt === 'number')
  );
}

function isAirportFrequencyCandidate(frequency: unknown): frequency is AirportResourceFrequency {
  return (
    Boolean(frequency) &&
    typeof frequency === 'object' &&
    typeof (frequency as { type?: unknown }).type === 'string' &&
    typeof (frequency as { description?: unknown }).description === 'string' &&
    typeof (frequency as { frequencyMhz?: unknown }).frequencyMhz === 'string'
  );
}

function normalizeCachedRunways(runways: AirportResourceData['runwayEnds']): AirportRunwayEnd[] {
  return runways
    .filter(isAirportRunwayEndCandidate)
    .map((runway) => ({
      id: runway.id,
      headingDegMag: runway.headingDegMag,
      isClosed: runway.isClosed,
      lengthFt: runway.lengthFt
    }));
}

function normalizeCachedFrequencies(
  frequencies: AirportResourceData['frequencies']
): AirportResourceFrequency[] {
  return frequencies
    .filter(isAirportFrequencyCandidate)
    .map((frequency) => ({
      type: frequency.type,
      description: frequency.description,
      frequencyMhz: frequency.frequencyMhz
    }));
}

function normalizeUpstreamPayload(candidate: unknown): AirportUpstreamSnapshot {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return {};
  }

  return candidate as AirportUpstreamSnapshot;
}

function toAirportData(candidate: unknown): AirportResourceData | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const asData = candidate as Partial<AirportResourceShapeCandidate>;
  if (!isAirportResourceShape(asData)) {
    return null;
  }

  const runwayEnds = normalizeCachedRunways(asData.runwayEnds);

  if (runwayEnds.length === 0) {
    return null;
  }

  return {
    requestedIcao: asData.requestedIcao,
    icao: asData.icao,
    name: asData.name,
    municipality: asData.municipality,
    countryCode: asData.countryCode,
    countryName: asData.countryName,
    elevationFt: typeof asData.elevationFt === 'number' ? asData.elevationFt : null,
    runwayEnds,
    frequencies: normalizeCachedFrequencies(Array.isArray(asData.frequencies) ? asData.frequencies : []),
    upstreamPayload: normalizeUpstreamPayload(asData.upstreamPayload),
    fetchedAt: asData.fetchedAt,
    source: asData.source
  };
}

function serializeAirport(data: AirportResourceData, key: string, resource: string): CacheEnvelope<AirportResourceData> {
  const fetchedAt = new Date(data.fetchedAt);
  const fallbackFetchedAt = Number.isNaN(fetchedAt.getTime()) ? new Date() : fetchedAt;

  return {
    schemaVersion: airportResourceAdapter.schemaVersion,
    resource,
    key,
    data,
    cacheMeta: {
      fetchedAt: fallbackFetchedAt.toISOString(),
      expiresAt: new Date(
        fallbackFetchedAt.getTime() + airportResourceAdapter.policy.ttlSeconds * 1000
      ).toISOString(),
      policyVersion: airportResourceAdapter.policy.policyVersion,
      source: 'upstream'
    }
  };
}

function buildAirportDbUrl(icao: string, token: string): string {
  const url = new URL(`${AIRPORT_DB_BASE_URL}/${encodeURIComponent(icao)}`);
  url.searchParams.set('apiToken', token);
  return url.toString();
}

function toAirportDbPayload(candidate: unknown): AirportDbPayload {
  if (!candidate || typeof candidate !== 'object') {
    throw new AirportWorkerError('Airport provider returned an invalid payload.', 502, 'PROVIDER_PAYLOAD_INVALID');
  }

  return candidate as AirportDbPayload;
}

function toCountryName(payload: AirportDbPayload): string {
  const direct = toStringValue((payload.country as AirportDbCountry | undefined)?.name);
  if (direct) {
    return direct;
  }

  return '';
}

function toFrequencyValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${value}`;
  }

  return toStringValue(value);
}

function toAirportFrequency(candidate: AirportDbFrequency): AirportResourceFrequency | null {
  const type = toStringValue(candidate.type)?.toUpperCase() ?? null;
  const frequencyMhz = toFrequencyValue(candidate.frequency_mhz);
  if (!type || !frequencyMhz) {
    return null;
  }

  return {
    type,
    description: toStringValue(candidate.description) ?? '',
    frequencyMhz
  };
}

function shouldReplaceRunway(existing: AirportRunwayEnd | undefined, candidate: AirportRunwayEnd): boolean {
  if (!existing) {
    return true;
  }

  if (existing.isClosed && !candidate.isClosed) {
    return true;
  }

  return existing.isClosed === candidate.isClosed && (existing.lengthFt ?? 0) < (candidate.lengthFt ?? 0);
}

function addRunwayCandidate(runwayMap: Map<string, AirportRunwayEnd>, candidate: AirportRunwayEnd | null): void {
  if (!candidate) {
    return;
  }

  const existing = runwayMap.get(candidate.id);
  if (shouldReplaceRunway(existing, candidate)) {
    runwayMap.set(candidate.id, candidate);
  }
}

function collectRunwayEnds(payload: AirportDbPayload): AirportRunwayEnd[] {
  const runways = Array.isArray(payload.runways) ? (payload.runways as AirportDbRunway[]) : [];
  const runwayMap = new Map<string, AirportRunwayEnd>();

  for (const runway of runways) {
    if (!runway || typeof runway !== 'object') {
      continue;
    }

    const runwayClosed = isRunwayClosed(runway.closed);
    const lengthFtCandidate = toIntegerValue(runway.length_ft);
    const lengthFt = lengthFtCandidate !== null && lengthFtCandidate > 0 ? lengthFtCandidate : null;
    addRunwayCandidate(runwayMap, toRunwayEnd(runway.le_ident, runwayClosed, lengthFt));
    addRunwayCandidate(runwayMap, toRunwayEnd(runway.he_ident, runwayClosed, lengthFt));
  }

  return [...runwayMap.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function getAirportDbFrequencyCandidates(payload: AirportDbPayload): AirportDbFrequency[] {
  if (Array.isArray(payload.frequencies)) {
    return payload.frequencies as AirportDbFrequency[];
  }

  if (Array.isArray(payload.freqs)) {
    return payload.freqs as AirportDbFrequency[];
  }

  return [];
}

function collectFrequencies(payload: AirportDbPayload): AirportResourceFrequency[] {
  const frequencies = getAirportDbFrequencyCandidates(payload);
  const uniqueFrequencies = new Map<string, AirportResourceFrequency>();

  for (const frequency of frequencies) {
    if (!frequency || typeof frequency !== 'object') {
      continue;
    }

    const normalized = toAirportFrequency(frequency);
    if (!normalized) {
      continue;
    }

    const key = `${normalized.type}|${normalized.description}|${normalized.frequencyMhz}`;
    uniqueFrequencies.set(key, normalized);
  }

  return [...uniqueFrequencies.values()].sort((left, right) => {
    const typeCompare = left.type.localeCompare(right.type);
    if (typeCompare !== 0) {
      return typeCompare;
    }

    const descriptionCompare = left.description.localeCompare(right.description);
    if (descriptionCompare !== 0) {
      return descriptionCompare;
    }

    return left.frequencyMhz.localeCompare(right.frequencyMhz);
  });
}

function resolvePayloadIcao(payload: AirportDbPayload, requestedIcao: string): string {
  return (
    toStringValue(payload.icao_code)?.toUpperCase() ??
    toStringValue(payload.ident)?.toUpperCase() ??
    requestedIcao
  );
}

export const airportResourceAdapter: CacheResourceAdapter<AirportResourceInput, unknown, AirportResourceData> = {
  resource: 'airport',
  schemaVersion: AIRPORT_SCHEMA_VERSION,
  normalizeKey: (input) => normalizeAirportIcao(input.icao),
  fetchUpstream: async (input, ctx) => {
    const icao = normalizeAirportIcao(input.icao);
    const token = ctx.env.AIRPORTDB_API_TOKEN?.trim();

    if (!token) {
      throw new AirportWorkerError('Airport lookup service is not configured.', 500, 'SERVICE_NOT_CONFIGURED');
    }

    const response = await fetch(buildAirportDbUrl(icao, token), {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json'
      }
    });

    if (response.status === 401 || response.status === 403) {
      throw new AirportWorkerError('Airport lookup service token is invalid or missing privileges.', 502, 'AUTH_ERROR');
    }

    if (response.status === 404) {
      throw new AirportWorkerError(`ICAO code ${icao} was not found in airport database.`, 404, 'ICAO_NOT_FOUND');
    }

    if (!response.ok) {
      throw new AirportWorkerError(`Airport provider returned status ${response.status}.`, 502, 'PROVIDER_ERROR');
    }

    return response.json();
  },
  validate: (upstream, input) => {
    const requestedIcao = normalizeAirportIcao(input.icao);
    const payload = toAirportDbPayload(upstream);
    const runwayEnds = collectRunwayEnds(payload);
    if (runwayEnds.length === 0) {
      throw new AirportWorkerError(
        `No runway data is available for ICAO ${requestedIcao}.`,
        404,
        'RUNWAY_DATA_UNAVAILABLE'
      );
    }

    return {
      requestedIcao,
      icao: resolvePayloadIcao(payload, requestedIcao),
      name: toStringValue(payload.name) ?? requestedIcao,
      municipality: toStringValue(payload.municipality) ?? '',
      countryCode: toStringValue(payload.iso_country) ?? '',
      countryName: toCountryName(payload),
      elevationFt: toIntegerValue(payload.elevation_ft),
      runwayEnds,
      frequencies: collectFrequencies(payload),
      upstreamPayload: payload,
      source: 'airportdb',
      fetchedAt: new Date().toISOString()
    };
  },
  serialize: serializeAirport,
  deserialize: (cached) => {
    if (!cached || typeof cached !== 'object') {
      return null;
    }

    const envelopeData = (cached as { data?: unknown }).data;
    return toAirportData(envelopeData ?? cached);
  },
  policy: {
    ttlSeconds: 86400,
    staleWhileRevalidateSeconds: 43200,
    staleOnErrorSeconds: 259200,
    negativeCacheTtlSeconds: 3600,
    policyVersion: 'airport-v5'
  },
  observability: (input, key) => ({
    labels: {
      resource: 'airport',
      key,
      icao: normalizeAirportIcao(input.icao)
    }
  })
};
