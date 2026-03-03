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
            wind: {
              raw: '11010KT',
              directionType: 'fixed',
              directionDegTrue: 110,
              speedKt: 10,
              gustKt: null
            },
            source: 'aviationweather',
            fetchedAt: '2026-03-02T00:00:00.000Z',
            cache: {
              status: 'upstream_refresh',
              source: 'upstream',
              ageSeconds: 0,
              fetchedAt: '2026-03-02T00:00:00.000Z',
              servedAt: '2026-03-02T00:00:00.000Z',
              ttlSeconds: 1800,
              key: 'v1:metar:KMCI',
              resource: 'metar'
            }
          },
          {
            headers: {
              'X-Runway-Cache-Status': 'upstream_refresh'
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
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
    expect(root.textContent).toContain('Best runway:');
    expect(root.textContent).toContain('22');
    expect(root.textContent).toContain('All Runway Components');
    expect(root.textContent).toContain('Raw METAR: METAR KMCI 021953Z 11010KT 7SM OVC008 04/02 A3014 RMK AO2');
    expect(root.textContent).toContain('Data freshness: upstream_refresh via upstream');
    expect(root.textContent).toContain('Cache age: 0s (TTL 1800s)');
    expect(root.textContent).toContain('Cache key: v1:metar:KMCI');
    expect(root.textContent).toContain('Calculation Notes & Disclaimer');
    expect(root.textContent).toContain('Technical Details');

    const detailsPanels = root.querySelectorAll('details.info-box');
    expect(detailsPanels).toHaveLength(2);
    detailsPanels.forEach((panel) => {
      expect(panel.hasAttribute('open')).toBe(false);
    });
    expect(root.textContent).not.toContain('Parsed Wind Summary');
  });

  it('shows variable wind speed in results when direction is VRB', async () => {
    document.body.innerHTML = '<main id="app"></main>';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            icao: 'KARR',
            metarRaw: 'METAR KARR 031652Z VRB03KT 4SM HZ OVC013 05/00 A3011 RMK AO2 SLP202 T00500000',
            wind: {
              raw: 'VRB03KT',
              directionType: 'variable',
              directionDegTrue: null,
              speedKt: 3,
              gustKt: null
            },
            source: 'aviationweather',
            fetchedAt: '2026-03-03T16:52:00.000Z',
            cache: {
              status: 'upstream_refresh',
              source: 'upstream',
              ageSeconds: 0,
              fetchedAt: '2026-03-03T16:52:00.000Z',
              servedAt: '2026-03-03T16:52:00.000Z',
              ttlSeconds: 1800,
              key: 'v1:metar:KARR',
              resource: 'metar'
            }
          },
          {
            headers: {
              'X-Runway-Cache-Status': 'upstream_refresh'
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

    icaoInput.value = 'KARR';
    runwayInput.value = '09 27';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => (root.textContent?.includes('All Runway Components') ?? false));

    expect(root.textContent).toContain('Variable direction 3 kt');
    expect(root.textContent).toContain('Variable winds reported at 3 kt; no deterministic best runway.');
  });
});
