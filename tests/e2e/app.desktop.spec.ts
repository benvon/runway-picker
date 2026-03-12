import { expect, test, type Page } from '@playwright/test';
import { airportPayload, metarPayload, mockApi } from './mockApi';

interface PanelMetrics {
  left: number;
  width: number;
}

const WIDTH_TOLERANCE_PX = 2;
const CENTER_TOLERANCE_PX = 2;

async function getPanelMetrics(page: Page, selector: string): Promise<PanelMetrics> {
  return page.locator(selector).evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      width: rect.width
    };
  });
}

async function getRootCssPxVariable(page: Page, variableName: string): Promise<number> {
  const rawValue = await page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name), variableName);
  const parsedValue = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsedValue)) {
    throw new Error(`Expected numeric CSS variable ${variableName}, received "${rawValue}".`);
  }

  return parsedValue;
}

async function assertMatchedAndCentered(page: Page, selectors: string[]): Promise<void> {
  const viewportSize = page.viewportSize();
  if (!viewportSize) {
    throw new Error('Expected desktop viewport size to be available.');
  }

  const metrics = await Promise.all(selectors.map((selector) => getPanelMetrics(page, selector)));
  const baseline = metrics[0];
  const expectedLeft = (viewportSize.width - baseline.width) / 2;
  const contentMaxWidthPx = await getRootCssPxVariable(page, '--content-max-width');

  expect(Math.abs(baseline.width - contentMaxWidthPx)).toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);

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
