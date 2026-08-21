import type { CacheEnvelope, CacheResourceAdapter } from '../../cache/types';

const AIRPORT_DB_BASE_URL = 'https://airportdb.io/api/v1/airport';
const USER_AGENT = 'benvon-runway-picker';

export const AIRPORT_SCHEMA_VERSION = 9;

export interface AirportResourceInput {
  icao: string;
}

export interface AirportRunwayEnd {
  id: string;
  /** Physical runway heading from AirportDB, referenced to true north. */
  headingDegTrue: number;
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
  coordinates: AirportCoordinates | null;
  runwayEnds: AirportRunwayEnd[];
  frequencies: AirportResourceFrequency[];
  source: 'airportdb';
  fetchedAt: string;
}

export interface AirportCoordinates {
  latitudeDeg: number;
  longitudeDeg: number;
}

/**
 * Slow-changing airport reference data used to validate an alternate METAR
 * station. This is deliberately a separate cache resource from the runway
 * profile so it never enters the hot-refresh queue for operational data.
 */
export interface AirportLocationResourceData {
  requestedIcao: string;
  icao: string;
  coordinates: AirportCoordinates | null;
  source: 'airportdb';
  fetchedAt: string;
}

export type AirportWorkerErrorCode =
  | 'INVALID_ICAO'
  | 'INVALID_REQUEST'
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
  le_heading_degT?: unknown;
  he_heading_degT?: unknown;
  [key: string]: unknown;
}

interface AirportDbFrequency {
  type?: unknown;
  description?: unknown;
  frequency_mhz?: unknown;
  [key: string]: unknown;
}

type AirportResourceShapeCandidate = Omit<AirportResourceData, 'frequencies'> & {
  frequencies?: AirportResourceData['frequencies'];
};

/**
 * Cached airport data is only valid for the request it was created to serve.
 * This is deliberately non-throwing because cache deserialization must fail
 * closed and let the cache engine refresh malformed or mismatched records.
 */
export function hasCanonicalAirportIdentity(requestedIcao: unknown, icao: unknown): boolean {
  return (
    typeof requestedIcao === 'string' &&
    typeof icao === 'string' &&
    /^[A-Z0-9]{4}$/.test(requestedIcao) &&
    requestedIcao === icao
  );
}

export interface AirportCacheEnvelope extends CacheEnvelope<AirportResourceData> {
  upstreamSnapshot?: AirportUpstreamSnapshot;
}

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

function toCoordinateValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const text = toStringValue(value);
  if (!text) {
    return null;
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveAirportCoordinates(payload: AirportDbPayload): AirportCoordinates | null {
  const latitudeDeg = toCoordinateValue(payload.latitude_deg);
  const longitudeDeg = toCoordinateValue(payload.longitude_deg);
  if (latitudeDeg === null || longitudeDeg === null || Math.abs(latitudeDeg) > 90 || Math.abs(longitudeDeg) > 180) {
    return null;
  }

  return { latitudeDeg, longitudeDeg };
}

function toFiniteNumberValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
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

function toRunwayEnd(
  identCandidate: unknown,
  headingDegTrueCandidate: unknown,
  isClosed: boolean,
  lengthFt: number | null
): AirportRunwayEnd | null {
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
  const headingDegTrue = toFiniteNumberValue(headingDegTrueCandidate);
  if (headingDegTrue === null || headingDegTrue < 0 || headingDegTrue > 360) {
    return null;
  }

  return {
    id: `${String(runwayNumber).padStart(2, '0')}${suffix}`,
    headingDegTrue,
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
    typeof asData.fetchedAt === 'string' &&
    asData.source === 'airportdb'
  );
}

function isAirportRunwayEndCandidate(runway: unknown): runway is AirportRunwayEnd {
  return (
    Boolean(runway) &&
    typeof runway === 'object' &&
    typeof (runway as { id?: unknown }).id === 'string' &&
    typeof (runway as { headingDegTrue?: unknown }).headingDegTrue === 'number' &&
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
      headingDegTrue: runway.headingDegTrue,
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

function toAirportData(candidate: unknown): AirportResourceData | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const asData = candidate as Partial<AirportResourceShapeCandidate>;
  if (!isAirportResourceShape(asData)) {
    return null;
  }

  if (!hasCanonicalAirportIdentity(asData.requestedIcao, asData.icao)) {
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
    coordinates: asData.coordinates ?? null,
    runwayEnds,
    frequencies: normalizeCachedFrequencies(Array.isArray(asData.frequencies) ? asData.frequencies : []),
    fetchedAt: asData.fetchedAt,
    source: asData.source
  };
}

function toUpstreamSnapshot(candidate: unknown): AirportUpstreamSnapshot | undefined {
  if (!isOptionalPlainObject(candidate) || typeof candidate === 'undefined') {
    return undefined;
  }

  return candidate as AirportUpstreamSnapshot;
}

function serializeAirport(
  data: AirportResourceData,
  key: string,
  resource: string,
  upstream?: unknown
): AirportCacheEnvelope {
  const fetchedAt = new Date(data.fetchedAt);
  const fallbackFetchedAt = Number.isNaN(fetchedAt.getTime()) ? new Date() : fetchedAt;
  const upstreamSnapshot = toUpstreamSnapshot(upstream);

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
    },
    ...(upstreamSnapshot ? { upstreamSnapshot } : {})
  };
}

function buildAirportDbUrl(icao: string, token: string): string {
  const url = new URL(`${AIRPORT_DB_BASE_URL}/${encodeURIComponent(icao)}`);
  url.searchParams.set('apiToken', token);
  return url.toString();
}

export function toAirportDbPayload(candidate: unknown): AirportDbPayload {
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
    const lowEnd = toRunwayEnd(runway.le_ident, runway.le_heading_degT, runwayClosed, lengthFt);
    const highEnd = toRunwayEnd(runway.he_ident, runway.he_heading_degT, runwayClosed, lengthFt);
    if (!lowEnd || !highEnd) {
      continue;
    }

    addRunwayCandidate(runwayMap, lowEnd);
    addRunwayCandidate(runwayMap, highEnd);
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

export function resolveAirportPayloadIcao(payload: AirportDbPayload, requestedIcao: string): string {
  const returnedIcao =
    toStringValue(payload.icao_code)?.toUpperCase() ??
    toStringValue(payload.ident)?.toUpperCase();
  if (!returnedIcao || !/^[A-Z0-9]{4}$/.test(returnedIcao) || returnedIcao !== requestedIcao) {
    throw new AirportWorkerError(
      'Airport provider returned a record that does not match the requested ICAO code.',
      502,
      'PROVIDER_PAYLOAD_INVALID'
    );
  }

  return returnedIcao;
}

export function toAirportLocationData(upstream: unknown, input: AirportResourceInput): AirportLocationResourceData {
  const requestedIcao = normalizeAirportIcao(input.icao);
  const payload = toAirportDbPayload(upstream);

  return {
    requestedIcao,
    icao: resolveAirportPayloadIcao(payload, requestedIcao),
    coordinates: resolveAirportCoordinates(payload),
    source: 'airportdb',
    fetchedAt: new Date().toISOString()
  };
}

export async function fetchAirportUpstream(input: AirportResourceInput, ctx: Parameters<CacheResourceAdapter<AirportResourceInput, unknown, AirportResourceData>['fetchUpstream']>[1]): Promise<unknown> {
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
}

export const airportResourceAdapter: CacheResourceAdapter<AirportResourceInput, unknown, AirportResourceData> = {
  resource: 'airport',
  schemaVersion: AIRPORT_SCHEMA_VERSION,
  normalizeKey: (input) => normalizeAirportIcao(input.icao),
  fetchUpstream: fetchAirportUpstream,
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
      icao: resolveAirportPayloadIcao(payload, requestedIcao),
      name: toStringValue(payload.name) ?? requestedIcao,
      municipality: toStringValue(payload.municipality) ?? '',
      countryCode: toStringValue(payload.iso_country) ?? '',
      countryName: toCountryName(payload),
      elevationFt: toIntegerValue(payload.elevation_ft),
      coordinates: resolveAirportCoordinates(payload),
      runwayEnds,
      frequencies: collectFrequencies(payload),
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
    policyVersion: 'airport-v6'
  },
  negativeCache: {
    toEntry: (error) =>
      error instanceof AirportWorkerError && error.status === 404 && error.code === 'ICAO_NOT_FOUND'
        ? { status: 404, code: 'ICAO_NOT_FOUND' }
        : null,
    toError: (entry, input) => {
      if (entry.status !== 404 || entry.code !== 'ICAO_NOT_FOUND') {
        return null;
      }

      const icao = normalizeAirportIcao(input.icao);
      return new AirportWorkerError(`ICAO code ${icao} was not found in airport database.`, 404, 'ICAO_NOT_FOUND');
    }
  },
  observability: (input, key) => ({
    labels: {
      resource: 'airport',
      key,
      icao: normalizeAirportIcao(input.icao)
    }
  })
};
