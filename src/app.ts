import { evaluateRunways } from './domain/evaluateRunways';
import { fetchAirportByIcao } from './services/airportApi';
import type { AirportLookupResponse } from './services/airportApi';
import { fetchMetarByIcao } from './services/metarApi';
import type { MetarLookupResponse } from './services/metarApi';
import type { EvaluationResult, ParsedWind, RunwayWindComponentValue } from './domain/types';

const MIN_FEEDBACK_MS = 250;

type MissingDataPart = 'runway' | 'weather';

interface LookupResolution {
  airport: AirportLookupResponse;
  metar: MetarLookupResponse;
  runwaySourceIcao: string;
  weatherSourceIcao: string;
  alternateIcao: string | null;
}

interface SettledLookup<T> {
  value: T | null;
  error: Error | null;
}

function formatHeadingValue(headwindKt: number): string {
  if (headwindKt < 0) {
    return `Tailwind ${Math.abs(headwindKt)} kt`;
  }

  if (headwindKt === 0) {
    return 'Headwind 0 kt';
  }

  return `Headwind ${headwindKt} kt`;
}

function formatCrosswindValue(component: RunwayWindComponentValue): string {
  if (component.crosswindFrom === 'none') {
    return 'Crosswind 0 kt';
  }

  return `Crosswind ${component.crosswindKt} kt (${component.crosswindFrom})`;
}

function formatBestHeadwindSummary(
  sustained: RunwayWindComponentValue | null,
  gust: RunwayWindComponentValue | null
): string {
  if (!sustained) {
    return 'Direction variable';
  }

  const arrow = sustained.headwindKt < 0 ? '↑' : '↓';
  const sustainedValue = Math.abs(sustained.headwindKt);
  const gustValue = gust ? ` G${Math.abs(gust.headwindKt)} kt` : '';
  return `${arrow} ${sustainedValue} kt${gustValue}`;
}

function formatBestCrosswindSummary(
  sustained: RunwayWindComponentValue | null,
  gust: RunwayWindComponentValue | null
): string {
  if (!sustained) {
    return 'Direction variable';
  }

  const arrow =
    sustained.crosswindFrom === 'left' ? '←' : sustained.crosswindFrom === 'right' ? '→' : '↔';
  const gustValue = gust ? ` G${gust.crosswindKt} kt` : '';
  return `${arrow} ${sustained.crosswindKt} kt${gustValue}`;
}

function renderBestRunway(result: EvaluationResult): string {
  const bestRunway = result.bestRunwayId
    ? result.runwayResults.find((runway) => runway.runwayId === result.bestRunwayId) ?? null
    : null;

  const runwayDisplay = bestRunway?.runwayId ?? 'Not determinable';
  const headwindSummary = formatBestHeadwindSummary(bestRunway?.sustained ?? null, bestRunway?.gust ?? null);
  const crosswindSummary = formatBestCrosswindSummary(bestRunway?.sustained ?? null, bestRunway?.gust ?? null);

  return `
    <section class="panel panel-accent panel-spotlight" aria-label="Best runway summary">
      <div class="best-runway-row">
        <p class="best-runway-cell"><strong>Best runway:</strong> ${runwayDisplay}</p>
        <p class="best-runway-cell">${headwindSummary}</p>
        <p class="best-runway-cell">${crosswindSummary}</p>
      </div>
    </section>
  `;
}

function renderLookupSummary(resolution: LookupResolution): string {
  const runwaySourceLabel =
    resolution.runwaySourceIcao === resolution.airport.requestedIcao
      ? resolution.runwaySourceIcao
      : `${resolution.runwaySourceIcao} (requested ${resolution.airport.requestedIcao})`;

  const weatherSourceLabel = resolution.weatherSourceIcao;

  return `
    <section class="panel panel-subtle" aria-label="Lookup summary">
      <h2>Lookup Summary</h2>
      <p><strong>Runway airport:</strong> ${runwaySourceLabel} - ${resolution.airport.name}</p>
      <p><strong>Weather airport:</strong> ${weatherSourceLabel}</p>
      <p><strong>Runway ends loaded:</strong> ${resolution.airport.runwayEnds.length}</p>
    </section>
  `;
}

function renderRunwayTable(result: EvaluationResult): string {
  const variableSustainedLabel =
    result.parsedWind.directionType === 'variable'
      ? `Variable direction ${result.parsedWind.speedKt} kt`
      : 'Not available (variable winds)';
  const variableGustLabel =
    result.parsedWind.directionType === 'variable' && result.parsedWind.gustKt !== null
      ? `Variable direction G${result.parsedWind.gustKt} kt`
      : 'None';

  const rows = result.runwayResults
    .map((runway) => {
      const sustained = runway.sustained
        ? `${formatHeadingValue(runway.sustained.headwindKt)} | ${formatCrosswindValue(runway.sustained)}`
        : variableSustainedLabel;

      const gust = runway.gust
        ? `${formatHeadingValue(runway.gust.headwindKt)} | ${formatCrosswindValue(runway.gust)}`
        : variableGustLabel;

      const notes = runway.notes.length ? runway.notes.join(' ') : 'None';

      return `
        <tr>
          <th scope="row">${runway.runwayId}</th>
          <td>${sustained}</td>
          <td>${gust}</td>
          <td>${notes}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <section class="panel" aria-labelledby="components-title">
      <h2 id="components-title">All Runway Components</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Runway</th>
              <th scope="col">Sustained</th>
              <th scope="col">Gust</th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function toParsedWindFromLookup(metarLookup: MetarLookupResponse): ParsedWind {
  return {
    raw: metarLookup.wind.raw,
    directionType: metarLookup.wind.directionType,
    directionDegTrue: metarLookup.wind.directionDegTrue,
    speedKt: metarLookup.wind.speedKt,
    gustKt: metarLookup.wind.gustKt,
    source: 'metar_api'
  };
}

function renderCalculationInfo(result: EvaluationResult): string {
  const notes = [
    result.bestReason,
    ...result.globalNotes,
    'Advisory only: wind component output does not account for runway condition, runway length, traffic flow, NOTAMs, or ATC instructions.'
  ];

  const dedupedNotes = [...new Set(notes)];

  return `
    <details class="panel panel-subtle info-box">
      <summary>Calculation Notes & Disclaimer</summary>
      <ul class="notes-list">
        ${dedupedNotes.map((note) => `<li>${note}</li>`).join('')}
      </ul>
    </details>
  `;
}

function renderTechnicalDetails(resolution: LookupResolution): string {
  const airport = resolution.airport;
  const metar = resolution.metar;

  const notes = [
    `Airport cache freshness: ${airport.cache.status} via ${airport.cache.source}`,
    `Airport cache age: ${airport.cache.ageSeconds}s (TTL ${airport.cache.ttlSeconds}s)`,
    `Airport cache fetched at: ${airport.cache.fetchedAt}`,
    `Airport cache served at: ${airport.cache.servedAt}`,
    airport.cache.key ? `Airport cache key: ${airport.cache.key}` : 'Airport cache key: not provided',
    `METAR cache freshness: ${metar.cache.status} via ${metar.cache.source}`,
    `METAR cache age: ${metar.cache.ageSeconds}s (TTL ${metar.cache.ttlSeconds}s)`,
    `METAR cache fetched at: ${metar.cache.fetchedAt}`,
    `METAR cache served at: ${metar.cache.servedAt}`,
    metar.cache.key ? `METAR cache key: ${metar.cache.key}` : 'METAR cache key: not provided',
    `Raw METAR: ${metar.metarRaw}`
  ];

  const dedupedNotes = [...new Set(notes)];

  return `
    <details class="panel panel-subtle info-box">
      <summary>Technical Details</summary>
      <ul class="notes-list">
        ${dedupedNotes.map((note) => `<li>${note}</li>`).join('')}
      </ul>
    </details>
  `;
}

function toSettledLookup<T>(result: PromiseSettledResult<T>): SettledLookup<T> {
  if (result.status === 'fulfilled') {
    return { value: result.value, error: null };
  }

  return {
    value: null,
    error: result.reason instanceof Error ? result.reason : new Error('Unexpected lookup failure.')
  };
}

function isNotFoundLookupError(error: Error | null): boolean {
  if (!error) {
    return false;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status === 404;
}

function buildMissingDataMessage(primaryIcao: string, missing: MissingDataPart[], alternateProvided: boolean): string {
  const runwayMissing = missing.includes('runway');
  const weatherMissing = missing.includes('weather');

  if (runwayMissing && weatherMissing) {
    return alternateProvided
      ? `Runway and weather data are unavailable for ICAO ${primaryIcao}.`
      : `Runway and weather data are unavailable for ICAO ${primaryIcao}. Enter an alternate ICAO code to source missing data.`;
  }

  if (runwayMissing) {
    return alternateProvided
      ? `Runway data is unavailable for ICAO ${primaryIcao}.`
      : `Runway data is unavailable for ICAO ${primaryIcao}. Enter an alternate ICAO code to source runway data.`;
  }

  return alternateProvided
    ? `Weather data is unavailable for ICAO ${primaryIcao}.`
    : `Weather data is unavailable for ICAO ${primaryIcao}. Enter an alternate ICAO code to source weather data.`;
}

function buildAlternateFailureMessage(
  primaryIcao: string,
  alternateIcao: string,
  missing: MissingDataPart[],
  runwayError: Error | null,
  weatherError: Error | null
): string {
  const runwayMissing = missing.includes('runway');
  const weatherMissing = missing.includes('weather');

  if (runwayMissing && weatherMissing) {
    return `Runway and weather data are unavailable for ICAO ${primaryIcao} and alternate ICAO ${alternateIcao}.`;
  }

  if (runwayMissing) {
    const detail = runwayError ? ` ${runwayError.message}` : '';
    return `Runway data is unavailable for ICAO ${primaryIcao} and alternate ICAO ${alternateIcao}.${detail}`;
  }

  const detail = weatherError ? ` ${weatherError.message}` : '';
  return `Weather data is unavailable for ICAO ${primaryIcao} and alternate ICAO ${alternateIcao}.${detail}`;
}

function buildFallbackNotes(resolution: LookupResolution): string[] {
  const notes: string[] = [];

  if (resolution.runwaySourceIcao !== resolution.metar.icao && resolution.weatherSourceIcao !== resolution.airport.icao) {
    notes.push(
      `Using split data sources: runways from ${resolution.runwaySourceIcao} and METAR from ${resolution.weatherSourceIcao}.`
    );
    return notes;
  }

  if (resolution.alternateIcao && resolution.runwaySourceIcao === resolution.alternateIcao) {
    notes.push(`Runway data sourced from alternate ICAO ${resolution.alternateIcao}.`);
  }

  if (resolution.alternateIcao && resolution.weatherSourceIcao === resolution.alternateIcao) {
    notes.push(`METAR data sourced from alternate ICAO ${resolution.alternateIcao}.`);
  }

  return notes;
}

async function resolveLookupData(primaryInput: string, alternateInput: string): Promise<LookupResolution> {
  const primaryIcao = primaryInput.trim().toUpperCase();
  const alternateIcao = alternateInput.trim().toUpperCase() || null;

  const [airportPrimaryResult, metarPrimaryResult] = await Promise.allSettled([
    fetchAirportByIcao(primaryIcao),
    fetchMetarByIcao(primaryIcao)
  ]);

  const airportPrimary = toSettledLookup(airportPrimaryResult);
  const metarPrimary = toSettledLookup(metarPrimaryResult);

  if (airportPrimary.error && !isNotFoundLookupError(airportPrimary.error)) {
    throw airportPrimary.error;
  }

  if (metarPrimary.error && !isNotFoundLookupError(metarPrimary.error)) {
    throw metarPrimary.error;
  }

  const missingFromPrimary: MissingDataPart[] = [];
  if (!airportPrimary.value && isNotFoundLookupError(airportPrimary.error)) {
    missingFromPrimary.push('runway');
  }

  if (!metarPrimary.value && isNotFoundLookupError(metarPrimary.error)) {
    missingFromPrimary.push('weather');
  }

  if (missingFromPrimary.length > 0 && !alternateIcao) {
    throw new Error(buildMissingDataMessage(primaryIcao, missingFromPrimary, false));
  }

  let airport = airportPrimary.value;
  let metar = metarPrimary.value;
  let runwaySourceIcao = primaryIcao;
  let weatherSourceIcao = primaryIcao;
  let airportAlternateError: Error | null = null;
  let metarAlternateError: Error | null = null;

  if (alternateIcao && missingFromPrimary.length > 0) {
    const fallbackPromises: Array<Promise<AirportLookupResponse | MetarLookupResponse>> = [];

    if (missingFromPrimary.includes('runway')) {
      fallbackPromises.push(fetchAirportByIcao(alternateIcao));
    }

    if (missingFromPrimary.includes('weather')) {
      fallbackPromises.push(fetchMetarByIcao(alternateIcao));
    }

    const fallbackResults = await Promise.allSettled(fallbackPromises);
    let fallbackIndex = 0;

    if (missingFromPrimary.includes('runway')) {
      const result = fallbackResults[fallbackIndex];
      fallbackIndex += 1;
      if (result?.status === 'fulfilled') {
        airport = result.value as AirportLookupResponse;
        runwaySourceIcao = alternateIcao;
      } else {
        airportAlternateError =
          result && result.status === 'rejected' && result.reason instanceof Error
            ? result.reason
            : new Error('Alternate runway lookup failed.');
      }
    }

    if (missingFromPrimary.includes('weather')) {
      const result = fallbackResults[fallbackIndex];
      if (result?.status === 'fulfilled') {
        metar = result.value as MetarLookupResponse;
        weatherSourceIcao = alternateIcao;
      } else {
        metarAlternateError =
          result && result.status === 'rejected' && result.reason instanceof Error
            ? result.reason
            : new Error('Alternate weather lookup failed.');
      }
    }
  }

  if (!airport || !metar) {
    if (!alternateIcao) {
      throw new Error(buildMissingDataMessage(primaryIcao, missingFromPrimary, false));
    }

    throw new Error(
      buildAlternateFailureMessage(primaryIcao, alternateIcao, missingFromPrimary, airportAlternateError, metarAlternateError)
    );
  }

  return {
    airport,
    metar,
    runwaySourceIcao,
    weatherSourceIcao,
    alternateIcao
  };
}

export function mountApp(root: HTMLElement): void {
  root.innerHTML = `
    <div class="app-shell">
      <header class="panel hero-panel">
        <h1>Runway Picker</h1>
      </header>

      <section id="best-runway-spotlight" class="results-stack" aria-live="polite"></section>

      <section class="panel" aria-labelledby="input-title">
        <h2 id="input-title">Inputs</h2>
        <form id="calculator-form" novalidate>
          <label for="icao">Primary ICAO code</label>
          <input
            id="icao"
            name="icao"
            type="text"
            placeholder="Example: KJFK"
            autocomplete="off"
            maxlength="4"
            class="icao-input"
            required
          />

          <label for="alternate-icao">Alternate ICAO code (optional)</label>
          <input
            id="alternate-icao"
            name="alternateIcao"
            type="text"
            placeholder="Used only when runway or METAR data is missing"
            autocomplete="off"
            maxlength="4"
            class="icao-input"
          />
          <p class="field-help">If data is missing for the primary airport, we will use this alternate code.</p>

          <button type="submit">Lookup Airport and METAR</button>
          <p id="form-error" class="error-message" role="alert" aria-live="polite"></p>
        </form>
      </section>

      <section id="results" class="results-stack" aria-live="polite"></section>
    </div>
  `;

  const form = root.querySelector<HTMLFormElement>('#calculator-form');
  const icaoInput = root.querySelector<HTMLInputElement>('#icao');
  const alternateIcaoInput = root.querySelector<HTMLInputElement>('#alternate-icao');
  const errorNode = root.querySelector<HTMLElement>('#form-error');
  const submitButton = root.querySelector<HTMLButtonElement>('button[type="submit"]');
  const bestSpotlightNode = root.querySelector<HTMLElement>('#best-runway-spotlight');
  const resultsNode = root.querySelector<HTMLElement>('#results');

  if (!form || !icaoInput || !alternateIcaoInput || !errorNode || !submitButton || !bestSpotlightNode || !resultsNode) {
    throw new Error('App failed to initialize required form elements.');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorNode.textContent = '';
    submitButton.disabled = true;
    submitButton.textContent = 'Fetching airport + METAR...';
    const startedAt = Date.now();

    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const resolution = await resolveLookupData(icaoInput.value, alternateIcaoInput.value);
      const parsedWind = toParsedWindFromLookup(resolution.metar);
      const parserNotes =
        parsedWind.directionType === 'variable'
          ? [
              `Variable winds reported at ${parsedWind.speedKt} kt${
                parsedWind.gustKt !== null ? ` (gust ${parsedWind.gustKt} kt)` : ''
              }.`
            ]
          : [];

      const evaluation = evaluateRunways(
        resolution.airport.runwayEnds,
        parsedWind,
        parserNotes.concat(buildFallbackNotes(resolution))
      );

      bestSpotlightNode.innerHTML = renderBestRunway(evaluation);
      resultsNode.innerHTML = [
        renderLookupSummary(resolution),
        renderRunwayTable(evaluation),
        renderCalculationInfo(evaluation),
        renderTechnicalDetails(resolution)
      ].join('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error.';
      errorNode.textContent = message;
      bestSpotlightNode.innerHTML = '';
      resultsNode.innerHTML = '';
    } finally {
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(0, MIN_FEEDBACK_MS - elapsedMs);
      if (remainingMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
      }

      submitButton.disabled = false;
      submitButton.textContent = 'Lookup Airport and METAR';
    }
  });
}
