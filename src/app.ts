import { evaluateRunways } from './domain/evaluateRunways';
import type { EvaluationResult, ParsedWind, RunwayWindComponentValue } from './domain/types';
import { AirportLookupError, fetchAirportByIcao } from './services/airportApi';
import type { AirportLookupResponse } from './services/airportApi';
import { fetchMetarByIcao } from './services/metarApi';
import { MetarLookupError } from './services/metarApi';
import type { MetarLookupResponse } from './services/metarApi';
import { appendChildren, createElement, createTextParagraph, strongLabel } from './ui/dom';

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

interface AppElements {
  form: HTMLFormElement;
  icaoInput: HTMLInputElement;
  alternateGroup: HTMLElement;
  alternateIcaoInput: HTMLInputElement;
  alternateHelp: HTMLElement;
  errorNode: HTMLElement;
  submitButton: HTMLButtonElement;
  bestSpotlightNode: HTMLElement;
  resultsNode: HTMLElement;
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

function renderBestRunway(result: EvaluationResult): HTMLElement {
  const bestRunway = result.bestRunwayId
    ? result.runwayResults.find((runway) => runway.runwayId === result.bestRunwayId) ?? null
    : null;

  const runwayDisplay = bestRunway?.runwayId ?? 'Not determinable';
  const headwindSummary = formatBestHeadwindSummary(bestRunway?.sustained ?? null, bestRunway?.gust ?? null);
  const crosswindSummary = formatBestCrosswindSummary(bestRunway?.sustained ?? null, bestRunway?.gust ?? null);

  const section = createElement('section', {
    className: 'panel panel-accent panel-spotlight',
    attributes: { 'aria-label': 'Best runway summary' }
  });
  const row = createElement('div', { className: 'best-runway-row' });

  const bestRunwayCell = createElement('p', { className: 'best-runway-cell' });
  bestRunwayCell.append(strongLabel('Best runway:'), document.createTextNode(` ${runwayDisplay}`));

  const headwindCell = createElement('p', {
    className: 'best-runway-cell',
    textContent: headwindSummary
  });

  const crosswindCell = createElement('p', {
    className: 'best-runway-cell',
    textContent: crosswindSummary
  });

  appendChildren(row, [bestRunwayCell, headwindCell, crosswindCell]);
  section.appendChild(row);
  return section;
}

function renderLookupSummary(resolution: LookupResolution): HTMLElement {
  const runwaySourceLabel =
    resolution.runwaySourceIcao === resolution.airport.requestedIcao
      ? resolution.runwaySourceIcao
      : `${resolution.runwaySourceIcao} (requested ${resolution.airport.requestedIcao})`;

  const section = createElement('section', {
    className: 'panel panel-subtle',
    attributes: { 'aria-label': 'Lookup summary' }
  });

  const heading = createElement('h2', { textContent: 'Lookup Summary' });
  const runwayAirport = createTextParagraph('Runway airport:', `${runwaySourceLabel} - ${resolution.airport.name}`);
  const weatherAirport = createTextParagraph('Weather airport:', resolution.weatherSourceIcao);
  const runwayCount = createTextParagraph(
    'Runway ends loaded:',
    `${resolution.airport.runwayEnds.length}`
  );

  appendChildren(section, [heading, runwayAirport, weatherAirport, runwayCount]);
  return section;
}

function renderRunwayTable(result: EvaluationResult): HTMLElement {
  const variableSustainedLabel =
    result.parsedWind.directionType === 'variable'
      ? `Variable direction ${result.parsedWind.speedKt} kt`
      : 'Not available (variable winds)';
  const variableGustLabel =
    result.parsedWind.directionType === 'variable' && result.parsedWind.gustKt !== null
      ? `Variable direction G${result.parsedWind.gustKt} kt`
      : 'None';

  const section = createElement('section', {
    className: 'panel panel-subtle',
    attributes: { 'aria-labelledby': 'components-title' }
  });
  const heading = createElement('h2', {
    textContent: 'All Runway Components',
    attributes: { id: 'components-title' }
  });

  const tableWrap = createElement('div', { className: 'table-wrap' });
  const table = createElement('table');
  const thead = createElement('thead');
  const headerRow = createElement('tr');
  const body = createElement('tbody');

  const headerLabels = ['Runway', 'Sustained', 'Gust', 'Notes'];
  for (const label of headerLabels) {
    const header = createElement('th', {
      textContent: label,
      attributes: { scope: 'col' }
    });
    headerRow.appendChild(header);
  }
  thead.appendChild(headerRow);

  for (const runway of result.runwayResults) {
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

    const row = createElement('tr');
    const runwayCell = createElement('th', {
      textContent: runway.runwayId,
      attributes: { scope: 'row' }
    });
    const sustainedCell = createElement('td', { textContent: sustained });
    const gustCell = createElement('td', { textContent: gust });
    const notesCell = createElement('td', { textContent: notes });

    appendChildren(row, [runwayCell, sustainedCell, gustCell, notesCell]);
    body.appendChild(row);
  }

  appendChildren(table, [thead, body]);
  tableWrap.appendChild(table);

  appendChildren(section, [heading, tableWrap]);
  return section;
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

function createNotesList(notes: string[]): HTMLUListElement {
  const list = createElement('ul', { className: 'notes-list' });
  for (const note of notes) {
    list.appendChild(createElement('li', { textContent: note }));
  }

  return list;
}

function renderCalculationInfo(result: EvaluationResult): HTMLElement {
  const notes = [
    result.bestReason,
    ...result.globalNotes,
    'Advisory only: wind component output does not account for runway condition, runway length, traffic flow, NOTAMs, or ATC instructions.'
  ];

  const dedupedNotes = [...new Set(notes)];

  const section = createElement('section', {
    className: 'panel panel-subtle',
    attributes: { 'aria-label': 'Calculation notes and disclaimer' }
  });

  appendChildren(section, [
    createElement('h2', { textContent: 'Calculation Notes & Disclaimer' }),
    createNotesList(dedupedNotes)
  ]);

  return section;
}

function renderTechnicalDetails(resolution: LookupResolution): HTMLElement {
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

  const section = createElement('section', {
    className: 'panel panel-subtle',
    attributes: { 'aria-label': 'Technical details' }
  });

  appendChildren(section, [
    createElement('h2', { textContent: 'Technical Details' }),
    createNotesList(dedupedNotes)
  ]);

  return section;
}

function renderErrorTechnicalDetails(error: unknown): HTMLElement | null {
  if (!(error instanceof MetarLookupError)) {
    return null;
  }

  if (!error.debug || typeof error.debug !== 'object') {
    return null;
  }

  const debugJson = JSON.stringify(error.debug, null, 2);
  if (!debugJson) {
    return null;
  }

  const details = createElement('details', { className: 'panel panel-subtle info-box' });
  details.open = true;
  const summary = createElement('summary', { textContent: 'Technical Details' });
  const pre = createElement('pre', { className: 'debug-json' });
  pre.textContent = debugJson;

  appendChildren(details, [summary, pre]);
  return details;
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

function renderDetailsPanel(resolution: LookupResolution, evaluation: EvaluationResult): HTMLElement {
  const details = createElement('details', { className: 'panel panel-subtle details-toggle' });
  const summary = createElement('summary', { textContent: 'View details' });
  const detailsStack = createElement('div', { className: 'details-stack' });

  appendChildren(detailsStack, [
    renderLookupSummary(resolution),
    renderRunwayTable(evaluation),
    renderCalculationInfo(evaluation),
    renderTechnicalDetails(resolution)
  ]);

  appendChildren(details, [summary, detailsStack]);
  return details;
}

function buildAppUi(root: HTMLElement): AppElements {
  root.textContent = '';

  const appShell = createElement('div', { className: 'app-shell' });

  const header = createElement('header', { className: 'panel hero-panel' });
  header.appendChild(createElement('h1', { textContent: 'Runway Picker' }));

  const bestSpotlightNode = createElement('section', {
    className: 'results-stack',
    attributes: {
      id: 'best-runway-spotlight',
      'aria-live': 'polite'
    }
  });

  const inputSection = createElement('section', {
    className: 'panel',
    attributes: { 'aria-labelledby': 'input-title' }
  });
  const inputTitle = createElement('h2', {
    textContent: 'Inputs',
    attributes: { id: 'input-title' }
  });

  const form = createElement('form', {
    attributes: {
      id: 'calculator-form',
      novalidate: ''
    }
  });

  const primaryIcaoLabel = createElement('label', { textContent: 'Primary ICAO code' });
  primaryIcaoLabel.htmlFor = 'icao';

  const icaoInput = createElement('input', {
    className: 'icao-input',
    attributes: {
      id: 'icao',
      name: 'icao',
      type: 'text',
      placeholder: 'Example: KJFK',
      autocomplete: 'off'
    }
  });
  icaoInput.maxLength = 4;
  icaoInput.required = true;

  const alternateGroup = createElement('div', {
    className: 'alternate-group',
    attributes: { id: 'alternate-group' }
  });
  alternateGroup.hidden = true;

  const alternateLabel = createElement('label', { textContent: 'Alternate METAR ICAO code' });
  alternateLabel.htmlFor = 'alternate-icao';

  const alternateIcaoInput = createElement('input', {
    className: 'icao-input',
    attributes: {
      id: 'alternate-icao',
      name: 'alternateIcao',
      type: 'text',
      placeholder: 'Example: KLGA',
      autocomplete: 'off'
    }
  });
  alternateIcaoInput.maxLength = 4;

  const alternateHelp = createElement('p', {
    className: 'field-help',
    attributes: { id: 'alternate-help' }
  });

  appendChildren(alternateGroup, [alternateLabel, alternateIcaoInput, alternateHelp]);

  const submitButton = createElement('button', { textContent: 'Lookup Airport and METAR' });
  submitButton.type = 'submit';

  const errorNode = createElement('p', {
    className: 'error-message',
    attributes: {
      id: 'form-error',
      role: 'alert',
      'aria-live': 'polite'
    }
  });

  appendChildren(form, [primaryIcaoLabel, icaoInput, alternateGroup, submitButton, errorNode]);
  appendChildren(inputSection, [inputTitle, form]);

  const resultsNode = createElement('section', {
    className: 'results-stack',
    attributes: {
      id: 'results',
      'aria-live': 'polite'
    }
  });

  appendChildren(appShell, [header, bestSpotlightNode, inputSection, resultsNode]);
  root.appendChild(appShell);

  return {
    form,
    icaoInput,
    alternateGroup,
    alternateIcaoInput,
    alternateHelp,
    errorNode,
    submitButton,
    bestSpotlightNode,
    resultsNode
  };
}

export function mountApp(root: HTMLElement): void {
  const {
    form,
    icaoInput,
    alternateGroup,
    alternateIcaoInput,
    alternateHelp,
    errorNode,
    submitButton,
    bestSpotlightNode,
    resultsNode
  } = buildAppUi(root);

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

    bestSpotlightNode.replaceChildren(renderBestRunway(evaluation));
    resultsNode.replaceChildren(renderDetailsPanel(resolution, evaluation));
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
        bestSpotlightNode.replaceChildren();
        resultsNode.replaceChildren();
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
        bestSpotlightNode.replaceChildren();
        resultsNode.replaceChildren();
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
      bestSpotlightNode.replaceChildren();
      const technicalDetails = renderErrorTechnicalDetails(error);
      if (technicalDetails) {
        resultsNode.replaceChildren(technicalDetails);
      } else {
        resultsNode.replaceChildren();
      }
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
