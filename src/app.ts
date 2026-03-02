import { evaluateRunways } from './domain/evaluateRunways';
import { parseWindInput } from './domain/metarParser';
import { parseRunwayEndsInput } from './domain/runwayParser';
import type { EvaluationResult, RunwayWindComponentValue } from './domain/types';

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

function renderParsedWindSummary(result: EvaluationResult): string {
  const wind = result.parsedWind;
  const directionLabel =
    wind.directionType === 'fixed' ? `${wind.directionDegTrue?.toString().padStart(3, '0')}°` : wind.directionType;

  const gustLabel = wind.gustKt !== null ? `${wind.gustKt} kt` : 'None';

  return `
    <section class="panel" aria-labelledby="parsed-wind-title">
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
  const bestLabel = result.bestRunwayId ? `Runway ${result.bestRunwayId}` : 'Not Determinable';

  return `
    <section class="panel panel-accent" aria-labelledby="best-runway-title">
      <h2 id="best-runway-title">Best Runway</h2>
      <p class="best-runway-value">${bestLabel}</p>
      <p>${result.bestReason}</p>
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

function renderGlobalNotes(notes: string[]): string {
  if (!notes.length) {
    return '';
  }

  return `
    <section class="panel" aria-labelledby="global-notes-title">
      <h2 id="global-notes-title">Notes</h2>
      <ul class="notes-list">
        ${notes.map((note) => `<li>${note}</li>`).join('')}
      </ul>
    </section>
  `;
}

export function mountApp(root: HTMLElement): void {
  root.innerHTML = `
    <div class="app-shell">
      <header class="panel hero-panel">
        <h1>Runway Picker</h1>
        <p>Enter runway ends and METAR wind data to compute headwind and crosswind components.</p>
      </header>

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
  const resultsNode = root.querySelector<HTMLElement>('#results');

  if (!form || !runwaysInput || !metarInput || !errorNode || !resultsNode) {
    throw new Error('App failed to initialize required form elements.');
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    errorNode.textContent = '';

    try {
      const runways = parseRunwayEndsInput(runwaysInput.value);
      const parsedWind = parseWindInput(metarInput.value);
      const evaluation = evaluateRunways(runways, parsedWind.wind, parsedWind.notes);

      resultsNode.innerHTML = [
        renderParsedWindSummary(evaluation),
        renderBestRunway(evaluation),
        renderRunwayTable(evaluation),
        renderGlobalNotes(evaluation.globalNotes)
      ].join('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error.';
      errorNode.textContent = message;
      resultsNode.innerHTML = '';
    }
  });
}
