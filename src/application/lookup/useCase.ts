import { AirportLookupError, type AirportLookupResponse } from '../../services/airportApi';
import { MetarLookupError, type MetarLookupResponse } from '../../services/metarApi';

export type LookupStage = 'primary' | 'alternate-metar';

export interface LookupResolution {
  airport: AirportLookupResponse;
  metar: MetarLookupResponse;
  runwaySourceIcao: string;
  weatherSourceIcao: string;
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
      resolution: {
        airport,
        metar,
        runwaySourceIcao: primaryIcao,
        weatherSourceIcao: primaryIcao
      }
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
  return {
    type: 'success',
    state: createPrimaryState(),
    resolution: {
      airport: state.primaryAirport,
      metar,
      runwaySourceIcao: state.primaryIcao,
      weatherSourceIcao: metar.icao
    }
  };
}
