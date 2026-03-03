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

function airportPayload(icao: string) {
  return {
    requestedIcao: icao,
    icao,
    name: `${icao} Airport`,
    municipality: 'City',
    countryCode: 'US',
    countryName: 'United States',
    elevationFt: 100,
    runwayEnds: [
      { id: '04', headingDegMag: 40, isClosed: false, lengthFt: 8000 },
      { id: '22', headingDegMag: 220, isClosed: false, lengthFt: 8000 }
    ],
    source: 'airportdb',
    fetchedAt: '2026-03-02T00:00:00.000Z',
    cache: {
      status: 'upstream_refresh',
      source: 'upstream',
      ageSeconds: 0,
      fetchedAt: '2026-03-02T00:00:00.000Z',
      servedAt: '2026-03-02T00:00:00.000Z',
      ttlSeconds: 86400,
      key: `v1:airport:${icao}`,
      resource: 'airport'
    }
  };
}

function metarPayload(
  icao: string,
  wind: {
    directionType: 'fixed' | 'variable';
    directionDegTrue: number | null;
    speedKt: number;
    gustKt: number | null;
    raw: string;
  }
) {
  return {
    icao,
    metarRaw: `METAR ${icao} 021953Z ${wind.raw} 10SM FEW020 08/03 A3012 RMK AO2`,
    wind,
    source: 'aviationweather',
    fetchedAt: '2026-03-02T00:00:00.000Z',
    cache: {
      status: 'upstream_refresh',
      source: 'upstream',
      ageSeconds: 0,
      fetchedAt: '2026-03-02T00:00:00.000Z',
      servedAt: '2026-03-02T00:00:00.000Z',
      ttlSeconds: 1800,
      key: `v1:metar:${icao}`,
      resource: 'metar'
    }
  };
}

describe('app integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calculates and renders best runway from primary airport + METAR lookup with details collapsed by default', async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === '/api/airport?icao=KMCI') {
        return Promise.resolve(Response.json(airportPayload('KMCI')));
      }

      if (url === '/api/metar?icao=KMCI') {
        return Promise.resolve(
          Response.json(
            metarPayload('KMCI', {
              raw: '11010KT',
              directionType: 'fixed',
              directionDegTrue: 110,
              speedKt: 10,
              gustKt: null
            })
          )
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const root = document.querySelector<HTMLElement>('#app');
    if (!root) {
      throw new Error('Expected #app root element in test.');
    }

    mountApp(root);

    const icaoInput = root.querySelector<HTMLInputElement>('#icao');
    const alternateGroup = root.querySelector<HTMLElement>('#alternate-group');
    const form = root.querySelector<HTMLFormElement>('#calculator-form');

    if (!icaoInput || !alternateGroup || !form) {
      throw new Error('Expected form elements not found.');
    }

    expect(alternateGroup.hidden).toBe(true);

    icaoInput.value = 'KMCI';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => (root.textContent?.includes('Best runway:') ?? false));

    const details = root.querySelector<HTMLDetailsElement>('.details-toggle');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);

    expect(fetchMock).toHaveBeenCalledWith('/api/airport?icao=KMCI', {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/metar?icao=KMCI', {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
    expect(root.textContent).toContain('Best runway:');
    expect(root.textContent).toContain('Lookup Summary');
    expect(root.textContent).toContain('Runway ends loaded: 2');
    expect(root.textContent).toContain('All Runway Components');
    expect(root.textContent).toContain('Raw METAR: METAR KMCI 021953Z 11010KT 10SM FEW020 08/03 A3012 RMK AO2');
    expect(root.textContent).toContain('Airport cache freshness: upstream_refresh via upstream');
    expect(root.textContent).toContain('METAR cache freshness: upstream_refresh via upstream');
    expect(root.textContent).toContain('Calculation Notes & Disclaimer');
    expect(root.textContent).toContain('Technical Details');
  });

  it('shows variable wind speed in results when direction is VRB', async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === '/api/airport?icao=KARR') {
        return Promise.resolve(Response.json(airportPayload('KARR')));
      }

      if (url === '/api/metar?icao=KARR') {
        return Promise.resolve(
          Response.json(
            metarPayload('KARR', {
              raw: 'VRB03KT',
              directionType: 'variable',
              directionDegTrue: null,
              speedKt: 3,
              gustKt: null
            })
          )
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const root = document.querySelector<HTMLElement>('#app');
    if (!root) {
      throw new Error('Expected #app root element in test.');
    }

    mountApp(root);

    const icaoInput = root.querySelector<HTMLInputElement>('#icao');
    const form = root.querySelector<HTMLFormElement>('#calculator-form');
    if (!icaoInput || !form) {
      throw new Error('Expected form elements not found.');
    }

    icaoInput.value = 'KARR';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => (root.textContent?.includes('All Runway Components') ?? false));

    expect(root.textContent).toContain('Variable direction 3 kt');
    expect(root.textContent).toContain('Variable winds reported at 3 kt; no deterministic best runway.');
  });

  it('uses runway length as tie-break when wind components are equal', async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === '/api/airport?icao=KLEN') {
        return Promise.resolve(
          Response.json({
            ...airportPayload('KLEN'),
            runwayEnds: [
              { id: '18L', headingDegMag: 180, isClosed: false, lengthFt: 7000 },
              { id: '18R', headingDegMag: 180, isClosed: false, lengthFt: 9000 }
            ]
          })
        );
      }

      if (url === '/api/metar?icao=KLEN') {
        return Promise.resolve(
          Response.json(
            metarPayload('KLEN', {
              raw: '18010KT',
              directionType: 'fixed',
              directionDegTrue: 180,
              speedKt: 10,
              gustKt: null
            })
          )
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const root = document.querySelector<HTMLElement>('#app');
    if (!root) {
      throw new Error('Expected #app root element in test.');
    }

    mountApp(root);

    const icaoInput = root.querySelector<HTMLInputElement>('#icao');
    const form = root.querySelector<HTMLFormElement>('#calculator-form');
    if (!icaoInput || !form) {
      throw new Error('Expected form elements not found.');
    }

    icaoInput.value = 'KLEN';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => (root.textContent?.includes('Best runway:') ?? false));

    expect(root.textContent).toContain('Best runway: 18R');
  });

  it('reveals alternate METAR flow only after primary METAR 404 and locks primary input', async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === '/api/airport?icao=KJFK') {
        return Promise.resolve(Response.json(airportPayload('KJFK')));
      }

      if (url === '/api/metar?icao=KJFK') {
        return Promise.resolve(
          Response.json(
            {
              error: 'No METAR is currently available for ICAO KJFK. Try again later.'
            },
            { status: 404 }
          )
        );
      }

      if (url === '/api/metar?icao=KLGA') {
        return Promise.resolve(
          Response.json(
            metarPayload('KLGA', {
              raw: '24012KT',
              directionType: 'fixed',
              directionDegTrue: 240,
              speedKt: 12,
              gustKt: null
            })
          )
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const root = document.querySelector<HTMLElement>('#app');
    if (!root) {
      throw new Error('Expected #app root element in test.');
    }

    mountApp(root);

    const icaoInput = root.querySelector<HTMLInputElement>('#icao');
    const alternateGroup = root.querySelector<HTMLElement>('#alternate-group');
    const alternateInput = root.querySelector<HTMLInputElement>('#alternate-icao');
    const form = root.querySelector<HTMLFormElement>('#calculator-form');
    if (!icaoInput || !alternateGroup || !alternateInput || !form) {
      throw new Error('Expected form elements not found.');
    }

    expect(alternateGroup.hidden).toBe(true);

    icaoInput.value = 'KJFK';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(
      () =>
        root.textContent?.includes('No METAR is currently available for ICAO KJFK. Enter an alternate ICAO code for METAR data.') ??
        false
    );

    expect(alternateGroup.hidden).toBe(false);
    expect(icaoInput.readOnly).toBe(true);

    alternateInput.value = 'KLGA';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => (root.textContent?.includes('Weather airport: KLGA') ?? false));

    expect(root.textContent).toContain('Using split data sources: runways from KJFK and METAR from KLGA.');
    expect(alternateGroup.hidden).toBe(true);
    expect(icaoInput.readOnly).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith('/api/metar?icao=KLGA', {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
  });

  it('shows friendly airport-not-found message and does not reveal alternate flow', async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === '/api/airport?icao=KXYZ') {
        return Promise.resolve(
          Response.json(
            {
              error: 'ICAO code KXYZ was not found in airport database.'
            },
            { status: 404 }
          )
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const root = document.querySelector<HTMLElement>('#app');
    if (!root) {
      throw new Error('Expected #app root element in test.');
    }

    mountApp(root);

    const icaoInput = root.querySelector<HTMLInputElement>('#icao');
    const alternateGroup = root.querySelector<HTMLElement>('#alternate-group');
    const form = root.querySelector<HTMLFormElement>('#calculator-form');
    if (!icaoInput || !alternateGroup || !form) {
      throw new Error('Expected form elements not found.');
    }

    icaoInput.value = 'KXYZ';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => (root.textContent?.includes("We couldn't find airport KXYZ. Check the code and try again.") ?? false));

    expect(root.textContent).toContain("We couldn't find airport KXYZ. Check the code and try again.");
    expect(alternateGroup.hidden).toBe(true);
    expect(root.textContent).not.toContain('All Runway Components');
  });

  it('excludes closed runways from best-runway selection', async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === '/api/airport?icao=KCLS') {
        return Promise.resolve(
          Response.json({
            ...airportPayload('KCLS'),
            runwayEnds: [
              { id: '09', headingDegMag: 90, isClosed: true, lengthFt: 9000 },
              { id: '27', headingDegMag: 270, isClosed: false, lengthFt: 9000 }
            ]
          })
        );
      }

      if (url === '/api/metar?icao=KCLS') {
        return Promise.resolve(
          Response.json(
            metarPayload('KCLS', {
              raw: '09012KT',
              directionType: 'fixed',
              directionDegTrue: 90,
              speedKt: 12,
              gustKt: null
            })
          )
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const root = document.querySelector<HTMLElement>('#app');
    if (!root) {
      throw new Error('Expected #app root element in test.');
    }

    mountApp(root);

    const icaoInput = root.querySelector<HTMLInputElement>('#icao');
    const form = root.querySelector<HTMLFormElement>('#calculator-form');
    if (!icaoInput || !form) {
      throw new Error('Expected form elements not found.');
    }

    icaoInput.value = 'KCLS';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => (root.textContent?.includes('Best runway:') ?? false));

    expect(root.textContent).toContain('Best runway: 27');
    expect(root.textContent).toContain('Runway is closed; excluded from recommendation.');
    expect(root.textContent).toContain('Closed runway');
  });

  it('shows debug output in Technical Details when METAR lookup fails with debug payload', async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === '/api/airport?icao=KJVL') {
        return Promise.resolve(Response.json(airportPayload('KJVL')));
      }

      if (url === '/api/metar?icao=KJVL') {
        return Promise.resolve(
          Response.json(
            {
              error: 'Unable to parse wind data from METAR provider for ICAO KJVL.',
              debug: {
                rawObPresent: true,
                rawWindToken: null,
                candidates: {
                  directionField: null,
                  speedField: null,
                  gustField: null
                }
              }
            },
            { status: 502 }
          )
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const root = document.querySelector<HTMLElement>('#app');
    if (!root) {
      throw new Error('Expected #app root element in test.');
    }

    mountApp(root);

    const icaoInput = root.querySelector<HTMLInputElement>('#icao');
    const form = root.querySelector<HTMLFormElement>('#calculator-form');
    if (!icaoInput || !form) {
      throw new Error('Expected form elements not found.');
    }

    icaoInput.value = 'KJVL';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() =>
      (root.textContent?.includes('Unable to parse wind data from METAR provider for ICAO KJVL.') ?? false)
    );

    expect(root.textContent).toContain('Technical Details');
    expect(root.textContent).toContain('"rawObPresent": true');
    expect(root.textContent).toContain('"rawWindToken": null');
    expect(root.textContent).not.toContain('All Runway Components');
  });

  it('dismisses focused input when lookup starts', async () => {
    document.body.innerHTML = '<main id="app"></main>';

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === '/api/airport?icao=KMCI') {
        return Promise.resolve(Response.json(airportPayload('KMCI')));
      }

      if (url === '/api/metar?icao=KMCI') {
        return Promise.resolve(
          Response.json(
            metarPayload('KMCI', {
              raw: '12008KT',
              directionType: 'fixed',
              directionDegTrue: 120,
              speedKt: 8,
              gustKt: null
            })
          )
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const root = document.querySelector<HTMLElement>('#app');
    if (!root) {
      throw new Error('Expected #app root element in test.');
    }

    mountApp(root);

    const icaoInput = root.querySelector<HTMLInputElement>('#icao');
    const form = root.querySelector<HTMLFormElement>('#calculator-form');
    if (!icaoInput || !form) {
      throw new Error('Expected form elements not found.');
    }

    icaoInput.value = 'KMCI';
    icaoInput.focus();
    expect(document.activeElement).toBe(icaoInput);

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(document.activeElement).not.toBe(icaoInput);
    await waitFor(() => (root.textContent?.includes('Best runway:') ?? false));
  });
});
