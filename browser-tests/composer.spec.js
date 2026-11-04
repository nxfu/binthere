import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/stars', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ stars: 0 }),
  }));
});

async function openComposer(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await expect(page.locator('#view-create')).toBeVisible();
  await expect(page.locator('.editor-size-hint')).toContainText('Maximum size: 1 MiB');
}

test('shows UTF-8 byte size, warning, and over-limit state on desktop', async ({ page }) => {
  await openComposer(page, 1280, 900);
  const editor = page.locator('#editor');
  const meter = page.locator('#content-size');
  const create = page.locator('#create');

  const formats = await page.locator('#content-format option').evaluateAll((options) => options.map((option) => option.value));
  expect(formats).toEqual(['plaintext', 'code', 'markdown']);
  expect(await page.locator('#content-format').inputValue()).toBe('plaintext');
  expect(await page.locator('.editor-meta').evaluate((element) => getComputedStyle(element).flexDirection)).toBe('row');

  await editor.fill('Aé😀');
  await expect(meter).toContainText('7 / 1,048,576 bytes');
  await expect(create).toBeEnabled();

  await editor.fill('x'.repeat(Math.ceil(1_048_576 * 0.9)));
  await expect(meter).toContainText('Near limit');
  await expect(meter).toHaveClass(/near-limit/);
  await expect(create).toBeEnabled();

  await editor.fill('x'.repeat(1_048_577));
  await expect(meter).toContainText('1 over limit');
  await expect(meter).toHaveClass(/over-limit/);
  await expect(editor).toHaveAttribute('aria-invalid', 'true');
  await expect(create).toBeDisabled();
});

test('keeps the composer usable on mobile and preserves Markdown plus raw view', async ({ page }) => {
  await openComposer(page, 390, 844);
  await expect(page.locator('.editor-meta')).toHaveCSS('flex-direction', 'column');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.locator('#content-format').selectOption('markdown');
  await page.locator('#editor').fill('**safe markdown**');
  await page.locator('#create').click();
  await expect(page.locator('#view-success')).toBeVisible();
  const url = await page.locator('#paste-url').textContent();

  await page.goto(url);
  await expect(page.locator('#reveal-burn')).toBeVisible();
  await page.locator('#reveal-burn').click();
  await expect(page.locator('#paste-content strong')).toHaveText('safe markdown');
  await expect(page.locator('#toggle-raw')).toBeVisible();
  await page.locator('#toggle-raw').click();
  await expect(page.locator('#paste-content')).toHaveText('**safe markdown**');
});
