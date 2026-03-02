// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mountApp } from '../app';

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe('app integration', () => {
  it('calculates and renders best runway', async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const root = document.querySelector<HTMLElement>('#app');
    if (!root) {
      throw new Error('Expected #app root element in test.');
    }

    mountApp(root);

    const runwayInput = root.querySelector<HTMLInputElement>('#runways');
    const metarInput = root.querySelector<HTMLTextAreaElement>('#metar');
    const form = root.querySelector<HTMLFormElement>('#calculator-form');

    if (!runwayInput || !metarInput || !form) {
      throw new Error('Expected form elements not found.');
    }

    runwayInput.value = '22 04';
    metarInput.value = '22012G20KT';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => (root.textContent?.includes('Best runway:') ?? false));

    expect(root.textContent).toContain('Best runway:');
    expect(root.textContent).toContain('22');
    expect(root.textContent).toContain('All Runway Components');
  });
});
