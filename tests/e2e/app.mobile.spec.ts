import { expect, test } from '@playwright/test';
import { airportPayload, metarPayload, mockApi } from './mockApi';

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
            error: 'No METAR is currently available for ICAO KJFK. Try again later.',
            code: 'METAR_UNAVAILABLE'
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

    await expect(page.locator('#form-error')).toHaveText(
      'No METAR is currently available for ICAO KJFK. Enter an alternate ICAO code for METAR data.'
    );
    await expect(page.locator('#alternate-group')).toBeVisible();
    await expect(page.locator('#icao')).toHaveAttribute('readonly', '');

    await page.locator('#alternate-icao').fill('KLGA');
    await page.getByRole('button', { name: 'Lookup Alternate METAR' }).click();

    await expect(page.getByText('Best runway:')).toBeVisible();
    await page.locator('details.details-toggle summary').click();
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
            error: 'ICAO code KXYZ was not found in airport database.',
            code: 'ICAO_NOT_FOUND'
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
