import { evaluateRunways } from '../domain/evaluateRunways';
import type {
  EvaluationResult,
  ParsedWind,
  RunwayWindComponent,
  RunwayWindComponentValue
} from '../domain/types';
import { MetarLookupError } from '../services/metarApi';
import type { LookupResolution } from '../application/lookup/useCase';
import { appendChildren, createElement, createTextParagraph, strongLabel } from './dom';

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

function findBestRunway(result: EvaluationResult): RunwayWindComponent | null {
  if (!result.bestRunwayId) {
    return null;
  }

  return result.runwayResults.find((runway) => runway.runwayId === result.bestRunwayId) ?? null;
}

function renderBestRunway(result: EvaluationResult): HTMLElement {
  const bestRunway = findBestRunway(result);
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

  const headwindCell = createElement('p', { className: 'best-runway-cell', textContent: headwindSummary });
  const crosswindCell = createElement('p', { className: 'best-runway-cell', textContent: crosswindSummary });

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

  appendChildren(section, [
    createElement('h2', { textContent: 'Lookup Summary' }),
    createTextParagraph('Runway airport:', `${runwaySourceLabel} - ${resolution.airport.name}`),
    createTextParagraph('Weather airport:', resolution.weatherSourceIcao),
    createTextParagraph('Runway ends loaded:', `${resolution.airport.runwayEnds.length}`)
  ]);

  return section;
}

function variableWindLabels(result: EvaluationResult): { sustained: string; gust: string } {
  const sustained =
    result.parsedWind.directionType === 'variable'
      ? `Variable direction ${result.parsedWind.speedKt} kt`
      : 'Not available (variable winds)';
  const gust =
    result.parsedWind.directionType === 'variable' && result.parsedWind.gustKt !== null
      ? `Variable direction G${result.parsedWind.gustKt} kt`
      : 'None';
  return { sustained, gust };
}

function formatRunwayCell(
  runway: RunwayWindComponent,
  labels: { sustained: string; gust: string }
): { sustained: string; gust: string; notes: string } {
  const sustained = runway.isClosed
    ? 'Closed runway'
    : runway.sustained
      ? `${formatHeadingValue(runway.sustained.headwindKt)} | ${formatCrosswindValue(runway.sustained)}`
      : labels.sustained;
  const gust = runway.isClosed
    ? 'Closed runway'
    : runway.gust
      ? `${formatHeadingValue(runway.gust.headwindKt)} | ${formatCrosswindValue(runway.gust)}`
      : labels.gust;
  const notes = runway.notes.length ? runway.notes.join(' ') : 'None';
  return { sustained, gust, notes };
}

function renderRunwayTable(result: EvaluationResult): HTMLElement {
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
  for (const label of ['Runway', 'Sustained', 'Gust', 'Notes']) {
    headerRow.appendChild(createElement('th', { textContent: label, attributes: { scope: 'col' } }));
  }
  thead.appendChild(headerRow);

  const labels = variableWindLabels(result);
  for (const runway of result.runwayResults) {
    const formatted = formatRunwayCell(runway, labels);
    const row = createElement('tr');
    appendChildren(row, [
      createElement('th', { textContent: runway.runwayId, attributes: { scope: 'row' } }),
      createElement('td', { textContent: formatted.sustained }),
      createElement('td', { textContent: formatted.gust }),
      createElement('td', { textContent: formatted.notes })
    ]);
    body.appendChild(row);
  }

  appendChildren(table, [thead, body]);
  tableWrap.appendChild(table);
  appendChildren(section, [heading, tableWrap]);
  return section;
}

function toParsedWindFromLookup(resolution: LookupResolution): ParsedWind {
  return {
    raw: resolution.metar.wind.raw,
    directionType: resolution.metar.wind.directionType,
    directionDegTrue: resolution.metar.wind.directionDegTrue,
    speedKt: resolution.metar.wind.speedKt,
    gustKt: resolution.metar.wind.gustKt,
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
  const section = createElement('section', {
    className: 'panel panel-subtle',
    attributes: { 'aria-label': 'Calculation notes and disclaimer' }
  });

  appendChildren(section, [
    createElement('h2', { textContent: 'Calculation Notes & Disclaimer' }),
    createNotesList([...new Set(notes)])
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
  const section = createElement('section', {
    className: 'panel panel-subtle',
    attributes: { 'aria-label': 'Technical details' }
  });

  appendChildren(section, [
    createElement('h2', { textContent: 'Technical Details' }),
    createNotesList([...new Set(notes)])
  ]);
  return section;
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

function buildFallbackNotes(resolution: LookupResolution): string[] {
  if (resolution.runwaySourceIcao === resolution.weatherSourceIcao) {
    return [];
  }

  return [
    `Using split data sources: runways from ${resolution.runwaySourceIcao} and METAR from ${resolution.weatherSourceIcao}.`
  ];
}

function parserNotes(parsedWind: ParsedWind): string[] {
  if (parsedWind.directionType !== 'variable') {
    return [];
  }

  return [
    `Variable winds reported at ${parsedWind.speedKt} kt${
      parsedWind.gustKt !== null ? ` (gust ${parsedWind.gustKt} kt)` : ''
    }.`
  ];
}

export function renderLookupPanels(resolution: LookupResolution): {
  bestRunway: HTMLElement;
  details: HTMLElement;
} {
  const parsedWind = toParsedWindFromLookup(resolution);
  const evaluation = evaluateRunways(
    resolution.airport.runwayEnds,
    parsedWind,
    parserNotes(parsedWind).concat(buildFallbackNotes(resolution))
  );

  return {
    bestRunway: renderBestRunway(evaluation),
    details: renderDetailsPanel(resolution, evaluation)
  };
}

export function renderErrorTechnicalDetails(error: unknown): HTMLElement | null {
  if (!(error instanceof MetarLookupError) || !error.debug || typeof error.debug !== 'object') {
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
