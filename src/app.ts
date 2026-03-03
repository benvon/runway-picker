import { evaluateRunways } from './domain/evaluateRunways';
import { AirportLookupError, fetchAirportByIcao } from './services/airportApi';
import type { AirportLookupResponse } from './services/airportApi';
import { fetchMetarByIcao } from './services/metarApi';
import { MetarLookupError } from './services/metarApi';
import type { MetarLookupResponse } from './services/metarApi';
import type { EvaluationResult, ParsedWind, RunwayWindComponentValue } from './domain/types';

const MIN_FEEDBACK_MS = 250;

type LookupStage = 'primary' | 'alternate-metar';

interface LookupResolution {
  airport: AirportLookupResponse;
  metar: MetarLookupResponse;
  runwaySourceIcao: string;
  weatherSourceIcao: string;
}

interface LookupState {
  stage: LookupStage;
  primaryAirport: AirportLookupResponse | null;
  primaryIcao: string;
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
      const sustained = runway.isClosed
        ? 'Closed runway'
        : runway.sustained
          ? `${formatHeadingValue(runway.sustained.headwindKt)} | ${formatCrosswindValue(runway.sustained)}`
          : variableSustainedLabel;

      const gust = runway.isClosed
        ? 'Closed runway'
        : runway.gust
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
    <section class="panel panel-subtle" aria-labelledby="components-title">
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
    <section class="panel panel-subtle" aria-label="Calculation notes and disclaimer">
      <h2>Calculation Notes & Disclaimer</h2>
      <ul class="notes-list">
        ${dedupedNotes.map((note) => `<li>${note}</li>`).join('')}
      </ul>
    </section>
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
    <section class="panel panel-subtle" aria-label="Technical details">
      <h2>Technical Details</h2>
      <ul class="notes-list">
        ${dedupedNotes.map((note) => `<li>${note}</li>`).join('')}
      </ul>
    </section>
  `;
}

function renderErrorTechnicalDetails(error: unknown): string {
  if (!(error instanceof MetarLookupError)) {
    return '';
  }

  if (!error.debug || typeof error.debug !== 'object') {
    return '';
  }

  const debugJson = JSON.stringify(error.debug, null, 2);
  if (!debugJson) {
    return '';
  }

  return `
    <details class="panel panel-subtle info-box" open>
      <summary>Technical Details</summary>
      <pre class="debug-json">${debugJson}</pre>
    </details>
  `;
}

function shouldPromptAlternateMetar(error: unknown): boolean {
  if (!(error instanceof MetarLookupError)) {
    return false;
  }

  return error.code === 'METAR_UNAVAILABLE' || error.code === 'ICAO_NOT_FOUND';
}

function shouldShowAirportNotFoundMessage(error: unknown): boolean {
  if (!(error instanceof AirportLookupError)) {
    return false;
  }

  return error.code === 'ICAO_NOT_FOUND';
}

function normalizeIcaoInput(value: string): string {
  return value.trim().toUpperCase();
}

function blurActiveElement(): void {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement) {
    activeElement.blur();
  }
}

function buildFallbackNotes(resolution: LookupResolution): string[] {
  if (resolution.runwaySourceIcao === resolution.weatherSourceIcao) {
    return [];
  }

  return [
    `Using split data sources: runways from ${resolution.runwaySourceIcao} and METAR from ${resolution.weatherSourceIcao}.`
  ];
}

function renderDetailsPanel(resolution: LookupResolution, evaluation: EvaluationResult): string {
  return `
    <details class="panel panel-subtle details-toggle">
      <summary>View details</summary>
      <div class="details-stack">
        ${renderLookupSummary(resolution)}
        ${renderRunwayTable(evaluation)}
        ${renderCalculationInfo(evaluation)}
        ${renderTechnicalDetails(resolution)}
      </div>
    </details>
  `;
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

          <div id="alternate-group" class="alternate-group" hidden>
            <label for="alternate-icao">Alternate METAR ICAO code</label>
            <input
              id="alternate-icao"
              name="alternateIcao"
              type="text"
              placeholder="Example: KLGA"
              autocomplete="off"
              maxlength="4"
              class="icao-input"
            />
            <p id="alternate-help" class="field-help"></p>
          </div>

          <button type="submit">Lookup Airport and METAR</button>
          <p id="form-error" class="error-message" role="alert" aria-live="polite"></p>
        </form>
      </section>

      <section id="results" class="results-stack" aria-live="polite"></section>
    </div>
  `;

  const form = root.querySelector<HTMLFormElement>('#calculator-form');
  const icaoInput = root.querySelector<HTMLInputElement>('#icao');
  const alternateGroup = root.querySelector<HTMLElement>('#alternate-group');
  const alternateIcaoInput = root.querySelector<HTMLInputElement>('#alternate-icao');
  const alternateHelp = root.querySelector<HTMLElement>('#alternate-help');
  const errorNode = root.querySelector<HTMLElement>('#form-error');
  const submitButton = root.querySelector<HTMLButtonElement>('button[type="submit"]');
  const bestSpotlightNode = root.querySelector<HTMLElement>('#best-runway-spotlight');
  const resultsNode = root.querySelector<HTMLElement>('#results');

  if (
    !form ||
    !icaoInput ||
    !alternateGroup ||
    !alternateIcaoInput ||
    !alternateHelp ||
    !errorNode ||
    !submitButton ||
    !bestSpotlightNode ||
    !resultsNode
  ) {
    throw new Error('App failed to initialize required form elements.');
  }

  let lookupState: LookupState = {
    stage: 'primary',
    primaryAirport: null,
    primaryIcao: ''
  };

  const setIdleSubmitLabel = () => {
    submitButton.textContent =
      lookupState.stage === 'alternate-metar' ? 'Lookup Alternate METAR' : 'Lookup Airport and METAR';
  };

  const setBusySubmitLabel = () => {
    submitButton.textContent =
      lookupState.stage === 'alternate-metar' ? 'Fetching alternate METAR...' : 'Fetching airport + METAR...';
  };

  const enterPrimaryStage = () => {
    lookupState = {
      stage: 'primary',
      primaryAirport: null,
      primaryIcao: ''
    };

    icaoInput.readOnly = false;
    icaoInput.classList.remove('locked-input');

    alternateGroup.hidden = true;
    alternateIcaoInput.required = false;
    alternateIcaoInput.value = '';
    alternateHelp.textContent = '';

    setIdleSubmitLabel();
  };

  const enterAlternateMetarStage = (primaryIcao: string, primaryAirport: AirportLookupResponse) => {
    lookupState = {
      stage: 'alternate-metar',
      primaryAirport,
      primaryIcao
    };

    icaoInput.readOnly = true;
    icaoInput.classList.add('locked-input');

    alternateGroup.hidden = false;
    alternateIcaoInput.required = true;
    alternateHelp.textContent = `No METAR is currently available for ICAO ${primaryIcao}. Enter an alternate ICAO code for METAR data.`;

    setIdleSubmitLabel();
  };

  const renderLookupResult = (resolution: LookupResolution) => {
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
    resultsNode.innerHTML = renderDetailsPanel(resolution, evaluation);
  };

  const handlePrimaryLookupSubmit = async () => {
    const primaryIcao = normalizeIcaoInput(icaoInput.value);
    icaoInput.value = primaryIcao;

    let airport: AirportLookupResponse;
    try {
      airport = await fetchAirportByIcao(primaryIcao);
    } catch (error) {
      if (shouldShowAirportNotFoundMessage(error)) {
        enterPrimaryStage();
        bestSpotlightNode.innerHTML = '';
        resultsNode.innerHTML = '';
        throw new Error(`We couldn't find airport ${primaryIcao}. Check the code and try again.`, {
          cause: error
        });
      }

      throw error;
    }

    let metar: MetarLookupResponse;
    try {
      metar = await fetchMetarByIcao(primaryIcao);
    } catch (error) {
      if (shouldPromptAlternateMetar(error)) {
        bestSpotlightNode.innerHTML = '';
        resultsNode.innerHTML = '';
        enterAlternateMetarStage(primaryIcao, airport);
        errorNode.textContent = `No METAR is currently available for ICAO ${primaryIcao}. Enter an alternate ICAO code for METAR data.`;
        return;
      }

      throw error;
    }

    enterPrimaryStage();
    renderLookupResult({
      airport,
      metar,
      runwaySourceIcao: primaryIcao,
      weatherSourceIcao: primaryIcao
    });
  };

  const handleAlternateMetarSubmit = async () => {
    const alternateIcao = normalizeIcaoInput(alternateIcaoInput.value);
    alternateIcaoInput.value = alternateIcao;

    if (!lookupState.primaryAirport || !lookupState.primaryIcao) {
      enterPrimaryStage();
      throw new Error('Primary airport context is missing. Submit a primary ICAO code first.');
    }

    const metar = await fetchMetarByIcao(alternateIcao);

    const resolution: LookupResolution = {
      airport: lookupState.primaryAirport,
      metar,
      runwaySourceIcao: lookupState.primaryIcao,
      weatherSourceIcao: metar.icao
    };

    enterPrimaryStage();
    renderLookupResult(resolution);
  };

  setIdleSubmitLabel();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    blurActiveElement();

    errorNode.textContent = '';
    submitButton.disabled = true;
    setBusySubmitLabel();
    const startedAt = Date.now();

    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      if (lookupState.stage === 'alternate-metar') {
        await handleAlternateMetarSubmit();
      } else {
        await handlePrimaryLookupSubmit();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error.';
      errorNode.textContent = message;
      bestSpotlightNode.innerHTML = '';
      resultsNode.innerHTML = renderErrorTechnicalDetails(error);
    } finally {
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(0, MIN_FEEDBACK_MS - elapsedMs);
      if (remainingMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
      }

      submitButton.disabled = false;
      setIdleSubmitLabel();
    }
  });
}
