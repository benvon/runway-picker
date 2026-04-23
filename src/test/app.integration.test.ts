// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    frequencies: [
      { type: 'APP', description: 'CITY APPROACH', frequencyMhz: '120.4' },
      { type: 'DEP', description: 'CITY DEPARTURE', frequencyMhz: '121.7' },
      { type: 'TWR', description: 'CITY TOWER', frequencyMhz: '118.5' },
      { type: 'GND', description: 'CITY GROUND', frequencyMhz: '121.9' },
      { type: 'ATIS', description: 'ATIS', frequencyMhz: '124.7' },
      { type: 'CTAF', description: 'CTAF', frequencyMhz: '122.8' }
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
  beforeEach(() => {
    vi.stubEnv('VITE_APP_VERSION', 'v9.9.9');
    vi.stubEnv('VITE_APP_COMMIT_SHA', 'abcdef1234567890');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
    expect(root.textContent).toContain('Airport Info');
    expect(root.textContent).toContain('Approach: 120.4 MHz');
    expect(root.textContent).toContain('Departure: 121.7 MHz');
    expect(root.textContent).toContain('Tower: 118.5 MHz');
    expect(root.textContent).toContain('Ground: 121.9 MHz');
    expect(root.textContent).toContain('ATIS: 124.7 MHz');
    expect(root.textContent).toContain('CTAF: 122.8 MHz');
    expect(root.textContent).toContain('Lookup Summary');
    expect(root.textContent).toContain('Runway ends loaded: 2');
    expect(root.textContent).toContain('All Runway Components');
    expect(root.textContent).toContain('Raw METAR: METAR KMCI 021953Z 11010KT 10SM FEW020 08/03 A3012 RMK AO2');
    expect(root.textContent).toContain('Airport cache freshness: upstream_refresh via upstream');
    expect(root.textContent).toContain('METAR cache freshness: upstream_refresh via upstream');
    expect(root.textContent).toContain('Calculation Notes & Disclaimer');
    expect(root.textContent).toContain('Technical Details');
    expect(root.textContent).toContain('Version v9.9.9 (abcdef1)');
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

  it('selects the directional approach frequency that matches the recommended runway approach path', async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === '/api/airport?icao=KAPP') {
        return Promise.resolve(
          Response.json({
            ...airportPayload('KAPP'),
            runwayEnds: [
              { id: '18', headingDegMag: 180, isClosed: false, lengthFt: 8000 },
              { id: '36', headingDegMag: 360, isClosed: false, lengthFt: 8000 }
            ],
            frequencies: [
              { type: 'A/D', description: 'NORTH APPROACH', frequencyMhz: '120.1' },
              { type: 'APP', description: 'SOUTH APPROACH', frequencyMhz: '124.2' },
              { type: 'DEP', description: 'CITY DEPARTURE', frequencyMhz: '121.7' },
              { type: 'TWR', description: 'TOWER', frequencyMhz: '118.5' },
              { type: 'GND', description: 'GROUND', frequencyMhz: '121.9' },
              { type: 'AWOS', description: 'AWOS', frequencyMhz: '121.0' },
              { type: 'CTAF', description: 'CTAF', frequencyMhz: '122.8' }
            ]
          })
        );
      }

      if (url === '/api/metar?icao=KAPP') {
        return Promise.resolve(
          Response.json(
            metarPayload('KAPP', {
              raw: '18012KT',
              directionType: 'fixed',
              directionDegTrue: 180,
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

    icaoInput.value = 'KAPP';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => (root.textContent?.includes('Best runway: 18') ?? false));

    expect(root.textContent).toContain('Approach: 120.1 MHz');
    expect(root.textContent).not.toContain('Approach: 124.2 MHz');
    expect(root.textContent).toContain('Departure: 120.1 MHz, 121.7 MHz');
    expect(root.textContent).toContain('Ground: 121.9 MHz');
    expect(root.textContent).toContain('AWOS: 121.0 MHz');
  });

  it('renders N/A for missing airport frequencies', async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === '/api/airport?icao=KNUL') {
        return Promise.resolve(
          Response.json({
            ...airportPayload('KNUL'),
            frequencies: []
          })
        );
      }

      if (url === '/api/metar?icao=KNUL') {
        return Promise.resolve(
          Response.json(
            metarPayload('KNUL', {
              raw: '22008KT',
              directionType: 'fixed',
              directionDegTrue: 220,
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

    icaoInput.value = 'KNUL';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => (root.textContent?.includes('Airport Info') ?? false));

    expect(root.textContent).toContain('Approach: N/A');
    expect(root.textContent).toContain('Departure: N/A');
    expect(root.textContent).toContain('Tower: N/A');
    expect(root.textContent).toContain('Ground: N/A');
    expect(root.textContent).toContain('AWOS / ATIS / ASOS: N/A');
    expect(root.textContent).toContain('CTAF: N/A');
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
              error: 'No METAR is currently available for ICAO KJFK. Try again later.',
              code: 'METAR_UNAVAILABLE'
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

  it('reveals alternate METAR flow only when METAR API returns fallback code', async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === '/api/airport?icao=KDKB') {
        return Promise.resolve(Response.json(airportPayload('KDKB')));
      }

      if (url === '/api/metar?icao=KDKB') {
        return Promise.resolve(
          Response.json(
            {
              error: 'No METAR is currently available for ICAO KDKB. Try again later.',
              code: 'METAR_UNAVAILABLE'
            },
            { status: 404 }
          )
        );
      }

      if (url === '/api/metar?icao=KORD') {
        return Promise.resolve(
          Response.json(
            metarPayload('KORD', {
              raw: '18011KT',
              directionType: 'fixed',
              directionDegTrue: 180,
              speedKt: 11,
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

    icaoInput.value = 'KDKB';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => (alternateGroup.hidden === false));

    expect(alternateGroup.hidden).toBe(false);
    expect(icaoInput.readOnly).toBe(true);
    expect(root.textContent).toContain(
      'No METAR is currently available for ICAO KDKB. Enter an alternate ICAO code for METAR data.'
    );

    alternateInput.value = 'KORD';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => (root.textContent?.includes('Weather airport: KORD') ?? false));
    expect(root.textContent).toContain('Using split data sources: runways from KDKB and METAR from KORD.');
  });

  it('reveals alternate METAR flow when fallback code is returned with non-404 status', async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === '/api/airport?icao=KDKB') {
        return Promise.resolve(Response.json(airportPayload('KDKB')));
      }

      if (url === '/api/metar?icao=KDKB') {
        return Promise.resolve(
          Response.json(
            {
              error: 'No METAR is currently available for ICAO KDKB. Try again later.',
              code: 'METAR_UNAVAILABLE'
            },
            { status: 500 }
          )
        );
      }

      if (url === '/api/metar?icao=KORD') {
        return Promise.resolve(
          Response.json(
            metarPayload('KORD', {
              raw: '21009KT',
              directionType: 'fixed',
              directionDegTrue: 210,
              speedKt: 9,
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

    icaoInput.value = 'KDKB';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => (alternateGroup.hidden === false));

    expect(alternateGroup.hidden).toBe(false);
    expect(icaoInput.readOnly).toBe(true);

    alternateInput.value = 'KORD';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => (root.textContent?.includes('Weather airport: KORD') ?? false));
  });

  it('does not reveal alternate METAR flow for generic METAR errors without fallback code', async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === '/api/airport?icao=KDKB') {
        return Promise.resolve(Response.json(airportPayload('KDKB')));
      }

      if (url === '/api/metar?icao=KDKB') {
        return Promise.resolve(
          Response.json(
            {
              error: 'Unexpected error while loading METAR.',
              code: 'UNEXPECTED'
            },
            { status: 500 }
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

    icaoInput.value = 'KDKB';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => (root.textContent?.includes('Unexpected error while loading METAR.') ?? false));

    expect(root.textContent).toContain('Unexpected error while loading METAR.');
    expect(alternateGroup.hidden).toBe(true);
  });

  it('shows friendly airport-not-found message and does not reveal alternate flow', async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === '/api/airport?icao=KXYZ') {
        return Promise.resolve(
          Response.json(
            {
              error: 'ICAO code KXYZ was not found in airport database.',
              code: 'ICAO_NOT_FOUND'
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

  it('renders provider-derived fields as text instead of executable HTML', async () => {
    document.body.innerHTML = '<main id="app"></main>';

    const maliciousAirportName = 'Airport <img src=x onerror=alert(1) />';
    const maliciousMetar = 'METAR <script>alert(1)</script> 22012KT';

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === '/api/airport?icao=KXSS') {
        return Promise.resolve(
          Response.json({
            ...airportPayload('KXSS'),
            name: maliciousAirportName
          })
        );
      }

      if (url === '/api/metar?icao=KXSS') {
        return Promise.resolve(
          Response.json({
            ...metarPayload('KXSS', {
              raw: '22012KT',
              directionType: 'fixed',
              directionDegTrue: 220,
              speedKt: 12,
              gustKt: null
            }),
            metarRaw: maliciousMetar
          })
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

    icaoInput.value = 'KXSS';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => (root.textContent?.includes('Best runway:') ?? false));

    expect(root.textContent).toContain(`Runway airport: KXSS - ${maliciousAirportName}`);
    expect(root.textContent).toContain(`Raw METAR: ${maliciousMetar}`);
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('img[onerror]')).toBeNull();
  });
});
