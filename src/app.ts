import { evaluateRunways } from './domain/evaluateRunways';
import { parseWindInput } from './domain/metarParser';
import { parseRunwayEndsInput } from './domain/runwayParser';
import type { EvaluationResult, RunwayWindComponentValue } from './domain/types';

const MIN_FEEDBACK_MS = 250;

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

function renderParsedWindSummary(result: EvaluationResult): string {
  const wind = result.parsedWind;
  const directionLabel =
    wind.directionType === 'fixed' ? `${wind.directionDegTrue?.toString().padStart(3, '0')}°` : wind.directionType;

  const gustLabel = wind.gustKt !== null ? `${wind.gustKt} kt` : 'None';

  return `
    <section class="panel panel-subtle" aria-labelledby="parsed-wind-title">
      <h2 id="parsed-wind-title">Parsed Wind Summary</h2>
      <div class="grid-two">
        <p><strong>Raw Group:</strong> ${wind.raw}</p>
        <p><strong>Source:</strong> ${wind.source === 'metar' ? 'Full METAR' : 'Wind Group'}</p>
        <p><strong>Direction:</strong> ${directionLabel}</p>
        <p><strong>Speed:</strong> ${wind.speedKt} kt</p>
        <p><strong>Gust:</strong> ${gustLabel}</p>
      </div>
    </section>
  `;
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

function renderRunwayTable(result: EvaluationResult): string {
  const rows = result.runwayResults
    .map((runway) => {
      const sustained = runway.sustained
        ? `${formatHeadingValue(runway.sustained.headwindKt)} | ${formatCrosswindValue(runway.sustained)}`
        : 'Not available (variable winds)';

      const gust = runway.gust
        ? `${formatHeadingValue(runway.gust.headwindKt)} | ${formatCrosswindValue(runway.gust)}`
        : 'None';

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
          <label for="runways">Runway ends</label>
          <input
            id="runways"
            name="runways"
            type="text"
            placeholder="Example: 09 27 18L 36R"
            autocomplete="off"
            required
          />
          <p class="field-help">Use spaces or commas between runway ends.</p>

          <label for="metar">METAR or wind group</label>
          <textarea
            id="metar"
            name="metar"
            rows="3"
            placeholder="Example: KJFK 021651Z 22012G20KT 10SM CLR 07/M01 A3012"
            required
          ></textarea>
          <p class="field-help">Accepted examples: 22012KT, 22012G20KT, VRB05KT, 00000KT.</p>

          <button type="submit">Calculate Runway Components</button>
          <p id="form-error" class="error-message" role="alert" aria-live="polite"></p>
        </form>
      </section>

      <section id="results" class="results-stack" aria-live="polite"></section>
    </div>
  `;

  const form = root.querySelector<HTMLFormElement>('#calculator-form');
  const runwaysInput = root.querySelector<HTMLInputElement>('#runways');
  const metarInput = root.querySelector<HTMLTextAreaElement>('#metar');
  const errorNode = root.querySelector<HTMLElement>('#form-error');
  const submitButton = root.querySelector<HTMLButtonElement>('button[type="submit"]');
  const bestSpotlightNode = root.querySelector<HTMLElement>('#best-runway-spotlight');
  const resultsNode = root.querySelector<HTMLElement>('#results');

  if (!form || !runwaysInput || !metarInput || !errorNode || !submitButton || !bestSpotlightNode || !resultsNode) {
    throw new Error('App failed to initialize required form elements.');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorNode.textContent = '';
    submitButton.disabled = true;
    submitButton.textContent = 'Calculating...';
    const startedAt = Date.now();

    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const runways = parseRunwayEndsInput(runwaysInput.value);
      const parsedWind = parseWindInput(metarInput.value);
      const evaluation = evaluateRunways(runways, parsedWind.wind, parsedWind.notes);

      bestSpotlightNode.innerHTML = renderBestRunway(evaluation);
      resultsNode.innerHTML = [
        renderRunwayTable(evaluation),
        renderParsedWindSummary(evaluation),
        renderCalculationInfo(evaluation)
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
      submitButton.textContent = 'Calculate Runway Components';
    }
  });
}
