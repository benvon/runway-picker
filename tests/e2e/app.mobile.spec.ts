import { expect, test, type Page } from '@playwright/test';

interface MockResponse {
  status: number;
  body: Record<string, unknown>;
}

interface MockApiConfig {
  airport: Record<string, MockResponse>;
  metar: Record<string, MockResponse>;
}

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

test.describe('Runway Picker mobile preview UI', () => {
  test.skip(!process.env.PREVIEW_URL, 'Set PREVIEW_URL to run preview UI tests.');

  test('shows best runway quickly with details collapsed', async ({ page }) => {
    await mockApi(page, {
      airport: {
        KMCI: { status: 200, body: airportPayload('KMCI') }
      },
      metar: {
        KMCI: {
          status: 200,
          body: metarPayload('KMCI', {
            raw: '12010KT',
            directionType: 'fixed',
            directionDegTrue: 120,
            speedKt: 10,
            gustKt: null
          })
        }
      }
    });

    await page.goto('/');

    await expect(page.locator('#alternate-group')).toBeHidden();

    await page.locator('#icao').fill('KMCI');
    await page.getByRole('button', { name: 'Lookup Airport and METAR' }).click();

    await expect(page.getByText('Best runway:')).toBeVisible();
    await expect(page.locator('details.details-toggle')).toHaveJSProperty('open', false);
  });

  test('reveals alternate METAR flow only after primary METAR 404', async ({ page }) => {
    await mockApi(page, {
      airport: {
        KJFK: { status: 200, body: airportPayload('KJFK') }
      },
      metar: {
        KJFK: {
          status: 404,
          body: {
            error: 'No METAR is currently available for ICAO KJFK. Try again later.'
          }
        },
        KLGA: {
          status: 200,
          body: metarPayload('KLGA', {
            raw: '23012KT',
            directionType: 'fixed',
            directionDegTrue: 230,
            speedKt: 12,
            gustKt: null
          })
        }
      }
    });

    await page.goto('/');

    await page.locator('#icao').fill('KJFK');
    await page.getByRole('button', { name: 'Lookup Airport and METAR' }).click();

    await expect(
      page.getByText('No METAR is currently available for ICAO KJFK. Enter an alternate ICAO code for METAR data.')
    ).toBeVisible();
    await expect(page.locator('#alternate-group')).toBeVisible();
    await expect(page.locator('#icao')).toHaveAttribute('readonly', '');

    await page.locator('#alternate-icao').fill('KLGA');
    await page.getByRole('button', { name: 'Lookup Alternate METAR' }).click();

    await expect(page.getByText('Weather airport: KLGA')).toBeVisible();
    await expect(page.getByText('Using split data sources: runways from KJFK and METAR from KLGA.')).toBeVisible();
    await expect(page.locator('#alternate-group')).toBeHidden();
  });

  test('returns a friendly message when airport lookup fails', async ({ page }) => {
    await mockApi(page, {
      airport: {
        KXYZ: {
          status: 404,
          body: {
            error: 'ICAO code KXYZ was not found in airport database.'
          }
        }
      },
      metar: {}
    });

    await page.goto('/');

    await page.locator('#icao').fill('KXYZ');
    await page.getByRole('button', { name: 'Lookup Airport and METAR' }).click();

    await expect(page.getByText("We couldn't find airport KXYZ. Check the code and try again.")).toBeVisible();
    await expect(page.locator('#alternate-group')).toBeHidden();
    await expect(page.getByText('All Runway Components')).not.toBeVisible();
  });

  test('does not overflow horizontally on mobile after rendering results', async ({ page }) => {
    await mockApi(page, {
      airport: {
        KORD: { status: 200, body: airportPayload('KORD') }
      },
      metar: {
        KORD: {
          status: 200,
          body: metarPayload('KORD', {
            raw: '17014KT',
            directionType: 'fixed',
            directionDegTrue: 170,
            speedKt: 14,
            gustKt: null
          })
        }
      }
    });

    await page.goto('/');

    await page.locator('#icao').fill('KORD');
    await page.getByRole('button', { name: 'Lookup Airport and METAR' }).click();

    await expect(page.getByText('Best runway:')).toBeVisible();

    const hasHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth + 1;
    });

    expect(hasHorizontalOverflow).toBe(false);
  });
});
