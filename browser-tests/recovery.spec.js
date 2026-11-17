import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/stars', (route) => route.fulfill({ json: { stars: 0 } }));
});

async function createNote(page) {
  await page.goto('/');
  await page.locator('#editor').fill('local recovery test');
  await page.locator('#create').click();
  await expect(page.locator('#view-success')).toBeVisible();
  return page.locator('#paste-url').textContent();
}

test('a lost response after real consumption stays uncertain and is never retried', async ({ page }) => {
  const url = await createNote(page);
  const id = new URL(url).pathname.split('/').at(-1);
  let consumes = 0;
  await page.route(`**/api/paste/${id}/consume`, async (route) => {
    consumes++;
    const response = await route.fetch(); // actually consumes the local Worker record
    expect(response.status()).toBe(200);
    await route.abort('connectionreset');
  });
  await page.goto(url);
  await page.locator('#reveal-burn').click();
  await expect(page.locator('#status-msg')).toContainText('Could not confirm whether the paste was consumed');
  await expect(page.locator('#status-msg')).toContainText('Check with the sender');
  expect(consumes).toBe(1);
  const head = await page.request.get(`/api/paste/${id}?meta=1`);
  expect(head.status()).toBe(410);
  await page.reload();
  await expect(page.locator('#status-msg')).toContainText('already consumed');
  expect(consumes).toBe(1);
});

test('HTTP 200 consume headers followed by a stalled body remain uncertain', async ({ page }) => {
  const url = await createNote(page);
  await page.goto(url);
  await expect(page.locator('#reveal-burn')).toBeVisible();
  await page.clock.install();
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.__consumeCalls = 0;
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      if (!String(input).endsWith('/consume')) return response;
      window.__consumeCalls++;
      // Keep real Worker consumption, but model a body that stalls after headers.
      await response.body.cancel();
      return {
        ok: response.ok, status: response.status,
        json: () => new Promise((_resolve, reject) => {
          window.__bodyStarted = true;
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        }),
      };
    };
  });
  const deadline = await page.evaluate(async () => (await import('/js/api.js')).REQUEST_TIMEOUTS_MS.consume);
  await page.locator('#reveal-burn').click();
  await expect.poll(() => page.evaluate(() => window.__bodyStarted)).toBe(true);
  await page.clock.fastForward(deadline + 1);
  await expect(page.locator('#status-msg')).toContainText('Could not confirm whether the paste was consumed');
  await expect(page.locator('#status-msg')).not.toContainText('rejected (HTTP 200)');
  expect(await page.evaluate(() => window.__consumeCalls)).toBe(1);
});

test('legacy read deadline recovers without issuing a consume', async ({ page }) => {
  await page.goto('/');
  await page.clock.install();
  const id = `k${'A'.repeat(22)}`;
  let release;
  let seen;
  let consumes = 0;
  const held = new Promise((resolve) => { release = resolve; });
  const requestSeen = new Promise((resolve) => { seen = resolve; });
  await page.route(`**/api/paste/${id}`, async (route) => {
    seen();
    await held;
    try { await route.abort(); } catch { /* deadline may already have aborted */ }
  });
  await page.route('**/consume', async (route) => { consumes++; await route.abort(); });
  try {
    const deadline = await page.evaluate(async () => (await import('/js/api.js')).REQUEST_TIMEOUTS_MS.read);
    await page.goto(`/p/${id}#${'A'.repeat(43)}`);
    await requestSeen;
    await page.clock.fastForward(deadline + 1);
    await expect(page.locator('#status-msg')).toContainText('request timed out');
    expect(consumes).toBe(0);
  } finally { release(); }
});

test('late metadata cannot update a page after pagehide; cached restoration reloads safely', async ({ page }) => {
  const url = await createNote(page);
  const id = new URL(url).pathname.split('/').at(-1);
  let release;
  let seen;
  const held = new Promise((resolve) => { release = resolve; });
  const requestSeen = new Promise((resolve) => { seen = resolve; });
  const matcher = `**/api/paste/${id}?meta=1`;
  await page.route(matcher, async (route) => {
    const response = await route.fetch();
    seen();
    await held;
    await route.fulfill({ response });
  });
  await page.goto(url);
  await requestSeen;
  await expect(page.locator('#status-msg')).toHaveText('checking…');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  const received = page.waitForResponse((response) => response.url().endsWith(`${id}?meta=1`));
  release();
  await received;
  // Drain the same app request's parsing/microtask work before checking the old view.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('#status-msg')).toHaveText('checking…');
  await expect(page.locator('#reveal-burn')).toBeHidden();
  await page.unroute(matcher);
  await Promise.all([
    page.waitForEvent('load'),
    page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))),
  ]);
  await expect(page.locator('#reveal-burn')).toBeVisible();
});

test('keyboard modal focus stays trapped and confirmation blur cancels deletion', async ({ page }) => {
  await page.goto('/');
  await page.locator('#editor').fill('keyboard test');
  await page.locator('#lock').click();
  await page.locator('#create').click();
  const first = page.locator('#modal-password');
  const last = page.locator('#pw-create');
  await first.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Escape');
  await page.locator('#lock').click();
  await page.locator('#create').click();
  await expect(page.locator('#view-success')).toBeVisible();
  const url = await page.locator('#paste-url').textContent();
  let deletes = 0;
  page.on('request', (request) => { if (request.method() === 'DELETE') deletes++; });
  const button = page.locator('#delete-btn');
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(button).toContainText('Permanently delete');
  await page.keyboard.press('Tab');
  await expect(button).not.toHaveClass(/armed/);
  expect(deletes).toBe(0);
  await button.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(button).toHaveText('Deleted');
  expect(deletes).toBe(1);
  const id = new URL(url).pathname.split('/').at(-1);
  expect((await page.request.get(`/api/paste/${id}?meta=1`)).status()).toBe(410);
});
