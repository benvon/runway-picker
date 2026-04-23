import type { Page } from '@playwright/test';

export interface MockResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface MockApiConfig {
  airport: Record<string, MockResponse>;
  metar: Record<string, MockResponse>;
}

interface WindPayload {
  directionType: 'fixed' | 'variable';
  directionDegTrue: number | null;
  speedKt: number;
  gustKt: number | null;
  raw: string;
}

export function airportPayload(icao: string): Record<string, unknown> {
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
      { type: 'TWR', description: 'CITY TOWER', frequencyMhz: '118.5' },
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

export function metarPayload(icao: string, wind: WindPayload): Record<string, unknown> {
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

export async function mockApi(page: Page, config: MockApiConfig): Promise<void> {
  await page.route('**/api/airport?icao=*', async (route) => {
    const url = new URL(route.request().url());
    const icao = (url.searchParams.get('icao') ?? '').toUpperCase();
    const match = config.airport[icao];

    if (!match) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: `Missing airport mock for ${icao}` })
      });
      return;
    }

    await route.fulfill({
      status: match.status,
      contentType: 'application/json',
      body: JSON.stringify(match.body)
    });
  });

  await page.route('**/api/metar?icao=*', async (route) => {
    const url = new URL(route.request().url());
    const icao = (url.searchParams.get('icao') ?? '').toUpperCase();
    const match = config.metar[icao];

    if (!match) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: `Missing METAR mock for ${icao}` })
      });
      return;
    }

    await route.fulfill({
      status: match.status,
      contentType: 'application/json',
      body: JSON.stringify(match.body)
    });
  });
}
