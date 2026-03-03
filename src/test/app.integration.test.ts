// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calculates and renders best runway from API METAR lookup', async () => {
    document.body.innerHTML = '<main id="app"></main>';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            icao: 'KMCI',
            metarRaw: 'METAR KMCI 021953Z 11010KT 7SM OVC008 04/02 A3014 RMK AO2',
            source: 'aviationweather',
            fetchedAt: '2026-03-02T00:00:00.000Z'
          },
          {
            headers: {
              'X-Cache': 'MISS'
            }
          }
        )
      )
    );

    const root = document.querySelector<HTMLElement>('#app');
    if (!root) {
      throw new Error('Expected #app root element in test.');
    }

    mountApp(root);

    const icaoInput = root.querySelector<HTMLInputElement>('#icao');
    const runwayInput = root.querySelector<HTMLInputElement>('#runways');
    const form = root.querySelector<HTMLFormElement>('#calculator-form');

    if (!icaoInput || !runwayInput || !form) {
      throw new Error('Expected form elements not found.');
    }

    icaoInput.value = 'KMCI';
    runwayInput.value = '22 04';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => (root.textContent?.includes('Best runway:') ?? false));

    expect(fetch).toHaveBeenCalledWith('/api/metar?icao=KMCI', {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    expect(root.textContent).toContain('Best runway:');
    expect(root.textContent).toContain('22');
    expect(root.textContent).toContain('All Runway Components');
    expect(root.textContent).toContain('Raw METAR: METAR KMCI 021953Z 11010KT 7SM OVC008 04/02 A3014 RMK AO2');
    expect(root.textContent).toContain('Data freshness: Fresh METAR data');
    expect(root.textContent).not.toContain('Parsed Wind Summary');
  });
});
