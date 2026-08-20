import { AirportLookupError, type AirportLookupResponse } from '../../services/airportApi';
import { MetarLookupError, type MetarLookupResponse } from '../../services/metarApi';

export type LookupStage = 'primary' | 'alternate-metar';

export interface LookupResolution {
  airport: AirportLookupResponse;
  metar: MetarLookupResponse;
  runwaySourceIcao: string;
  weatherSourceIcao: string;
  recommendation: RecommendationEligibility;
}

export const MAX_METAR_OBSERVATION_AGE_MINUTES = 60;
export const MAX_ALTERNATE_METAR_DISTANCE_NM = 50;

export type RecommendationBlockReason =
  | 'STALE_METAR_CACHE'
  | 'METAR_OBSERVATION_TIME_UNAVAILABLE'
  | 'METAR_OBSERVATION_TOO_OLD'
  | 'ALTERNATE_STATION_LOCATION_UNAVAILABLE'
  | 'ALTERNATE_STATION_TOO_FAR';

export interface RecommendationEligibility {
  allowed: boolean;
  reasons: RecommendationBlockReason[];
  observationAgeMinutes: number | null;
  alternateDistanceNm: number | null;
}

export interface LookupState {
  stage: LookupStage;
  primaryAirport: AirportLookupResponse | null;
  primaryIcao: string;
}

export interface LookupGateway {
  fetchAirportByIcao(icao: string): Promise<AirportLookupResponse>;
  fetchMetarByIcao(icao: string): Promise<MetarLookupResponse>;
}

export interface PrimaryLookupSuccess {
  type: 'success';
  state: LookupState;
  resolution: LookupResolution;
}

export interface PrimaryLookupPromptAlternate {
  type: 'prompt-alternate';
  state: LookupState;
  message: string;
}

export type PrimaryLookupResult = PrimaryLookupSuccess | PrimaryLookupPromptAlternate;

export function normalizeIcaoInput(value: string): string {
  return value.trim().toUpperCase();
}

export function createPrimaryState(): LookupState {
  return {
    stage: 'primary',
    primaryAirport: null,
    primaryIcao: ''
  };
}

function createAlternateState(primaryIcao: string, primaryAirport: AirportLookupResponse): LookupState {
  return {
    stage: 'alternate-metar',
    primaryAirport,
    primaryIcao
  };
}

function shouldPromptAlternateMetar(error: unknown): boolean {
  return error instanceof MetarLookupError && (error.code === 'METAR_UNAVAILABLE' || error.code === 'ICAO_NOT_FOUND');
}

function shouldShowAirportNotFoundMessage(error: unknown): boolean {
  return error instanceof AirportLookupError && error.code === 'ICAO_NOT_FOUND';
}

function isStaleMetarCache(status: MetarLookupResponse['cache']['status']): boolean {
  return status === 'stale_on_error' || status === 'stale_while_refresh';
}

function observationAgeMinutes(observedAt: string | null, now: Date): number | null {
  if (!observedAt) {
    return null;
  }

  const observedAtMs = Date.parse(observedAt);
  if (Number.isNaN(observedAtMs) || observedAtMs > now.getTime()) {
    return null;
  }

  return Math.floor((now.getTime() - observedAtMs) / 60_000);
}

function distanceNm(
  primary: AirportLookupResponse,
  alternate: AirportLookupResponse | null
): number | null {
  if (!primary.coordinates || !alternate?.coordinates) {
    return null;
  }

  const toRadians = (value: number) => (value * Math.PI) / 180;
  const latitudeDelta = toRadians(alternate.coordinates.latitudeDeg - primary.coordinates.latitudeDeg);
  const longitudeDelta = toRadians(alternate.coordinates.longitudeDeg - primary.coordinates.longitudeDeg);
  const sinLatitude = Math.sin(latitudeDelta / 2);
  const sinLongitude = Math.sin(longitudeDelta / 2);
  const haversine =
    sinLatitude * sinLatitude +
    Math.cos(toRadians(primary.coordinates.latitudeDeg)) *
      Math.cos(toRadians(alternate.coordinates.latitudeDeg)) *
      sinLongitude * sinLongitude;
  return 3440.065 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function assessRecommendationEligibility(
  airport: AirportLookupResponse,
  metar: MetarLookupResponse,
  weatherStation: AirportLookupResponse | null,
  now = new Date()
): RecommendationEligibility {
  const reasons: RecommendationBlockReason[] = [];
  const ageMinutes = observationAgeMinutes(metar.observedAt, now);
  const usesAlternateStation = airport.icao !== metar.icao;
  const alternateDistanceNm = usesAlternateStation ? distanceNm(airport, weatherStation) : null;

  if (isStaleMetarCache(metar.cache.status)) {
    reasons.push('STALE_METAR_CACHE');
  }
  if (ageMinutes === null) {
    reasons.push('METAR_OBSERVATION_TIME_UNAVAILABLE');
  } else if (ageMinutes > MAX_METAR_OBSERVATION_AGE_MINUTES) {
    reasons.push('METAR_OBSERVATION_TOO_OLD');
  }
  if (usesAlternateStation && alternateDistanceNm === null) {
    reasons.push('ALTERNATE_STATION_LOCATION_UNAVAILABLE');
  } else if (alternateDistanceNm !== null && alternateDistanceNm > MAX_ALTERNATE_METAR_DISTANCE_NM) {
    reasons.push('ALTERNATE_STATION_TOO_FAR');
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    observationAgeMinutes: ageMinutes,
    alternateDistanceNm
  };
}

function buildResolution(
  airport: AirportLookupResponse,
  metar: MetarLookupResponse,
  weatherStation: AirportLookupResponse | null = airport
): LookupResolution {
  return {
    airport,
    metar,
    runwaySourceIcao: airport.requestedIcao,
    weatherSourceIcao: metar.icao,
    recommendation: assessRecommendationEligibility(airport, metar, weatherStation)
  };
}

export async function runPrimaryLookup(
  primaryIcao: string,
  gateway: LookupGateway
): Promise<PrimaryLookupResult> {
  let airport: AirportLookupResponse;
  try {
    airport = await gateway.fetchAirportByIcao(primaryIcao);
  } catch (error) {
    if (shouldShowAirportNotFoundMessage(error)) {
      throw new Error(`We couldn't find airport ${primaryIcao}. Check the code and try again.`, {
        cause: error
      });
    }

    throw error;
  }

  try {
    const metar = await gateway.fetchMetarByIcao(primaryIcao);
    return {
      type: 'success',
      state: createPrimaryState(),
      resolution: buildResolution(airport, metar)
    };
  } catch (error) {
    if (!shouldPromptAlternateMetar(error)) {
      throw error;
    }

    return {
      type: 'prompt-alternate',
      state: createAlternateState(primaryIcao, airport),
      message: `No METAR is currently available for ICAO ${primaryIcao}. Enter an alternate ICAO code for METAR data.`
    };
  }
}

export async function runAlternateLookup(
  state: LookupState,
  alternateIcao: string,
  gateway: LookupGateway
): Promise<PrimaryLookupSuccess> {
  if (!state.primaryAirport || !state.primaryIcao) {
    throw new Error('Primary airport context is missing. Submit a primary ICAO code first.');
  }

  const metar = await gateway.fetchMetarByIcao(alternateIcao);
  let weatherStation: AirportLookupResponse | null = null;
  try {
    weatherStation = await gateway.fetchAirportByIcao(metar.icao);
  } catch {
    // A missing station location must suppress the recommendation, not hide the METAR calculation.
  }

  return {
    type: 'success',
    state: createPrimaryState(),
    resolution: buildResolution(state.primaryAirport, metar, weatherStation)
  };
}
