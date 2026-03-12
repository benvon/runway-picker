import { expect, test, type Page } from '@playwright/test';

interface MockResponse {
  status: number;
  body: Record<string, unknown>;
}

interface MockApiConfig {
  airport: Record<string, MockResponse>;
  metar: Record<string, MockResponse>;
}

interface PanelMetrics {
  left: number;
  width: number;
}

const WIDTH_TOLERANCE_PX = 2;
const CENTER_TOLERANCE_PX = 2;
const DESKTOP_MIN_WIDTH_PX = 900;
const DESKTOP_MAX_WIDTH_PX = 922;

function airportPayload(icao: string): Record<string, unknown> {
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
): Record<string, unknown> {
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

async function mockApi(page: Page, config: MockApiConfig): Promise<void> {
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

async function getPanelMetrics(page: Page, selector: string): Promise<PanelMetrics> {
  return page.locator(selector).evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      width: rect.width
    };
  });
}

async function assertMatchedAndCentered(page: Page, selectors: string[]): Promise<void> {
  const viewportSize = page.viewportSize();
  if (!viewportSize) {
    throw new Error('Expected desktop viewport size to be available.');
  }

  const metrics = await Promise.all(selectors.map((selector) => getPanelMetrics(page, selector)));
  const baseline = metrics[0];
  const expectedLeft = (viewportSize.width - baseline.width) / 2;

  expect(baseline.width).toBeGreaterThanOrEqual(DESKTOP_MIN_WIDTH_PX);
  expect(baseline.width).toBeLessThanOrEqual(DESKTOP_MAX_WIDTH_PX);

  for (const metric of metrics) {
    expect(Math.abs(metric.width - baseline.width)).toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);
    expect(Math.abs(metric.left - baseline.left)).toBeLessThanOrEqual(CENTER_TOLERANCE_PX);
    expect(Math.abs(metric.left - expectedLeft)).toBeLessThanOrEqual(CENTER_TOLERANCE_PX);
  }
}

test.describe('Runway Picker desktop layout', () => {
  test.skip(!process.env.PREVIEW_URL, 'Set PREVIEW_URL to run preview UI tests.');

  test('keeps header and input panels the same width and centered on initial load', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('header.hero-panel')).toBeVisible();
    await expect(page.locator('section[aria-labelledby="input-title"]')).toBeVisible();

    await assertMatchedAndCentered(page, ['header.hero-panel', 'section[aria-labelledby="input-title"]']);
  });

  test('keeps major panels matched and centered after lookup results render', async ({ page }) => {
    await mockApi(page, {
      airport: {
        KRFD: { status: 200, body: airportPayload('KRFD') }
      },
      metar: {
        KRFD: {
          status: 200,
          body: metarPayload('KRFD', {
            raw: '25005KT',
            directionType: 'fixed',
            directionDegTrue: 250,
            speedKt: 5,
            gustKt: null
          })
        }
      }
    });

    await page.goto('/');
    await page.locator('#icao').fill('KRFD');
    await page.getByRole('button', { name: 'Lookup Airport and METAR' }).click();

    await expect(page.getByText('Best runway:')).toBeVisible();
    await expect(page.locator('#best-runway-spotlight > .panel')).toBeVisible();
    await expect(page.locator('#results > .details-toggle')).toBeVisible();

    await assertMatchedAndCentered(page, [
      'header.hero-panel',
      '#best-runway-spotlight > .panel',
      'section[aria-labelledby="input-title"]',
      '#results > .details-toggle'
    ]);
  });
});
