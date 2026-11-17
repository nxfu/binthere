import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/stars', (route) => route.fulfill({ json: { stars: 0 } }));
});

async function openComposer(page, width = 1280, height = 900) {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await expect(page.locator('#view-create')).toBeVisible();
  await expect(page.locator('#content-format, #content-size, #content-size-live, .editor-size-hint')).toHaveCount(0);
}

test('keeps size validation out of the composer until an oversized submission', async ({ page }) => {
  await openComposer(page);
  const editor = page.locator('#editor');
  const create = page.locator('#create');
  let requests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/paste') requests++;
  });
  await editor.fill('Aé😀');
  await expect(create).toBeEnabled();
  await expect(page.locator('#create-msg')).toBeHidden();
  await editor.fill('😀'.repeat(262_144) + 'é');
  await expect(page.locator('#create-msg')).toBeHidden();
  await create.click();
  await expect(page.locator('#create-msg')).toContainText('1 MiB max');
  await expect(editor).toHaveValue('😀'.repeat(262_144) + 'é');
  await expect(create).toBeEnabled();
  expect(requests).toBe(0);
  await editor.fill('fits again');
  await create.click();
  await expect(page.locator('#view-success')).toBeVisible();
  expect(requests).toBe(1);
});

test('accepts the exact UTF-8 limit without a size meter', async ({ page }) => {
  await openComposer(page);
  await page.locator('#editor').fill('😀'.repeat(262_144));
  await page.locator('#create').click();
  await expect(page.locator('#view-success')).toBeVisible();
});

for (const { kind, text, width } of [
  { kind: 'plain text', text: 'just an ordinary sentence', width: 1280 },
  { kind: 'code', text: 'const answer = 42;', width: 1280 },
  { kind: 'Markdown', text: '# Note\n\n**safe markdown**', width: 390 },
]) {
  test(`detects ${kind} only when the recipient opens the note`, async ({ page }) => {
    await openComposer(page, width, 844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('#editor').fill(text);
    const uploaded = page.waitForRequest((request) => (
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/paste'
    ));
    await page.locator('#create').click();
    expect((await uploaded).postDataJSON().adata.fmt).toBe('plaintext');
    await expect(page.locator('#view-success')).toBeVisible();
    const url = await page.locator('#paste-url').textContent();
    await page.goto(url);
    await page.locator('#reveal-burn').click();
    if (kind === 'Markdown') {
      await expect(page.locator('#paste-content strong')).toHaveText('safe markdown');
      await expect(page.locator('#paste-pills')).toContainText('markdown');
    } else {
      await expect(page.locator('#paste-content')).toHaveText(text);
      if (kind === 'code') {
        await expect(page.locator('#paste-content code')).toBeVisible();
        await expect(page.locator('#paste-pills')).toContainText('code');
      }
    }
    if (kind === 'plain text') {
      await expect(page.locator('#toggle-raw')).toBeHidden();
    } else {
      await page.locator('#toggle-raw').click();
      await expect(page.locator('#paste-content')).toHaveText(text);
    }
  });
}

test('failed creation preserves the editor and restores the control', async ({ page }) => {
  await openComposer(page);
  let requests = 0;
  await page.route('**/api/paste', async (route) => {
    requests++;
    await route.fulfill({ status: 503, json: { error: 'unavailable' } });
  });
  await page.locator('#editor').fill('const retained = true;');
  await page.locator('#create').click();
  await expect(page.locator('#create-msg')).toBeVisible();
  await expect(page.locator('#editor')).toHaveValue('const retained = true;');
  await expect(page.locator('#create')).toBeEnabled();
  expect(requests).toBe(1);
});

test('typing during a pending request cannot submit again; timeout preserves text for retry', async ({ page }) => {
  await openComposer(page);
  await page.clock.install();
  await page.locator('#editor').fill('# Before timeout');
  let requests = 0;
  let release;
  let requestSeen;
  const released = new Promise((resolve) => { release = resolve; });
  const seen = new Promise((resolve) => { requestSeen = resolve; });
  await page.route('**/api/paste', async (route) => {
    requests++;
    if (requests > 1) return route.continue();
    requestSeen();
    await released;
    try { await route.abort(); } catch { /* the deadline may already have aborted it */ }
  });
  try {
    await page.locator('#create').click();
    await seen;
    await page.locator('#editor').fill('# Retained\n\n**after timeout**');
    await expect(page.locator('#create')).toBeDisabled();
    await page.locator('#editor').press('Control+Enter');
    expect(requests).toBe(1);
    const deadline = await page.evaluate(async () => (await import('/js/api.js')).REQUEST_TIMEOUTS_MS.create);
    await page.clock.fastForward(deadline + 1);
    await expect(page.locator('#create-msg')).toContainText('server may have created it');
    await expect(page.locator('#editor')).toHaveValue('# Retained\n\n**after timeout**');
    await expect(page.locator('#create')).toBeEnabled();
    expect(requests).toBe(1);
  } finally { release(); }
  await page.clock.resume();
  await page.locator('#create').click();
  await expect(page.locator('#view-success')).toBeVisible();
  expect(requests).toBe(2);
  const url = await page.locator('#paste-url').textContent();
  await page.goto(url);
  await page.locator('#reveal-burn').click();
  await expect(page.locator('#paste-content strong')).toHaveText('after timeout');
});
