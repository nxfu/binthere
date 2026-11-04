import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations.push({ directive: event.violatedDirective, blocked: event.blockedURI });
    });
  });
  await page.route('**/api/stars', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ stars: 0 }),
  }));
});

async function openComposer(page) {
  const response = await page.goto('/');
  expect(response.headers()['content-security-policy']).toContain("script-src 'self'");
  await expect(page.locator('#view-create')).toBeVisible();
}

async function readShareUrl(page) {
  await expect(page.locator('#view-success')).toBeVisible();
  const url = await page.locator('#paste-url').textContent();
  expect(url).toMatch(/\/p\/b[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/);
  return url;
}

async function expectNoCspViolations(page) {
  await expect.poll(() => page.evaluate(() => window.__cspViolations)).toEqual([]);
}

async function createNote(page, text = 'browser failure test note') {
  await openComposer(page);
  await page.locator('#editor').fill(text);
  await page.locator('#create').click();
  return readShareUrl(page);
}

function pasteIdFromUrl(url) {
  return new URL(url).pathname.split('/').at(-1);
}

async function timeoutFor(page, operation) {
  return page.evaluate(async (name) => {
    const api = await import('/js/api.js');
    return api.REQUEST_TIMEOUTS_MS[name];
  }, operation);
}

async function stallRequest(page, matcher) {
  let release;
  let sawRequest;
  const released = new Promise((resolve) => { release = resolve; });
  const requestSeen = new Promise((resolve) => { sawRequest = resolve; });
  let count = 0;

  await page.route(matcher, async (route) => {
    count++;
    sawRequest(route.request());
    await released;
    try { await route.abort(); } catch { /* the browser may already have aborted it */ }
  });

  return { requestSeen, release, count: () => count };
}

test('creates, reveals, burns, and downloads a note under the production CSP', async ({ page }) => {
  await openComposer(page);
  await page.locator('#editor').fill('browser e2e note');
  await page.locator('#create').click();
  const url = await readShareUrl(page);

  await page.goto(url);
  await expect(page.locator('#status-msg')).toContainText('viewed once');
  await page.locator('#reveal-burn').click();
  await expect(page.locator('#view-paste')).toBeVisible();
  await expect(page.locator('#paste-content')).toHaveText('browser e2e note');
  await expect(page).toHaveURL(/\/p\/b[^#]+$/);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-content').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('binthere-paste.txt');
  const file = await download.path();
  expect(await readFile(file, 'utf8')).toBe('browser e2e note');
  await expectNoCspViolations(page);

  await page.goto(url);
  // The first reveal scrubs the fragment with replaceState. Navigating to the
  // original URL changes only the fragment, which is a same-document change;
  // reload it so the application performs a fresh server read.
  await page.reload();
  await expect(page.locator('#status-msg')).toContainText('already consumed');
  await expectNoCspViolations(page);
});

test('wrong password preserves the note; correct password consumes it once', async ({ page }) => {
  await openComposer(page);
  await page.locator('#editor').fill('password protected e2e note');
  await page.locator('#lock').click();
  await page.locator('#create').click();
  await expect(page.locator('#pw-modal')).toBeVisible();
  await page.locator('#modal-password').fill('correct horse battery staple');
  await page.locator('#modal-password-confirm').fill('correct horse battery staple');
  await page.locator('#pw-create').click();
  const url = await readShareUrl(page);

  await page.goto(url);
  await expect(page.locator('#view-password')).toBeVisible();
  await page.locator('#decrypt-password').fill('wrong password');
  await page.locator('#decrypt-btn').click();
  await expect(page.locator('#password-msg')).toContainText('Wrong password');

  const parsed = new URL(url);
  const id = parsed.pathname.split('/').at(-1);
  const head = await page.request.get(`/api/paste/${id}?meta=1`);
  expect(head.status()).toBe(200);
  expect((await head.json()).ct).toBeUndefined();

  await page.locator('#decrypt-password').fill('correct horse battery staple');
  await page.locator('#decrypt-btn').click();
  await expect(page.locator('#view-paste')).toBeVisible();
  await expect(page.locator('#paste-content')).toHaveText('password protected e2e note');
  await expectNoCspViolations(page);
});

test('create failure preserves the editor and does not submit automatically again', async ({ page }) => {
  let requests = 0;
  await page.route((url) => url.pathname === '/api/paste', async (route) => {
    requests++;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'simulated failure' }),
    });
  });

  await openComposer(page);
  const content = 'keep this text after a failed create';
  await page.locator('#editor').fill(content);
  await page.locator('#create').click();

  await expect(page.locator('#create-msg')).toContainText('Could not confirm whether the paste was created');
  await expect(page.locator('#editor')).toHaveValue(content);
  await expect(page.locator('#create')).toBeEnabled();
  expect(requests).toBe(1);
});

for (const { statusCode, message } of [
  { statusCode: 404, message: 'This paste was not found.' },
  { statusCode: 410, message: 'This paste has expired or was already consumed.' },
  { statusCode: 429, message: 'Too many requests.' },
  { statusCode: 503, message: 'The server could not complete the request (HTTP 503).' },
]) {
  test(`distinguishes metadata read HTTP ${statusCode}`, async ({ page }) => {
    const id = `b${'A'.repeat(22)}`;
    await page.route((url) => url.pathname === `/api/paste/${id}` && url.searchParams.get('meta') === '1', (route) => route.fulfill({
      status: statusCode,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'simulated failure' }),
    }));

    await page.goto(`/p/${id}#${'A'.repeat(43)}`);
    await expect(page.locator('#status-msg')).toContainText(message);
  });
}

for (const { statusCode, message } of [
  { statusCode: 404, message: 'This paste was not found.' },
  { statusCode: 410, message: 'This paste has expired or was already consumed.' },
  { statusCode: 429, message: 'The consume request was rate limited.' },
  { statusCode: 503, message: 'The server returned HTTP 503. Could not confirm whether the paste was consumed.' },
]) {
  test(`distinguishes burn consume HTTP ${statusCode}`, async ({ page }) => {
    const url = await createNote(page, `consume status ${statusCode}`);
    const id = pasteIdFromUrl(url);
    let consumeRequests = 0;
    await page.route((requestUrl) => (
      requestUrl.pathname === `/api/paste/${id}/consume`
    ), async (route) => {
      consumeRequests++;
      await route.fulfill({
        status: statusCode,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'simulated failure' }),
      });
    });

    await page.goto(url);
    await expect(page.locator('#reveal-burn')).toBeVisible();
    await page.locator('#reveal-burn').click();
    await expect(page.locator('#status-msg')).toContainText(message);
    expect(consumeRequests).toBe(1);
    if (statusCode >= 500) {
      await expect(page.locator('#status-msg')).toContainText('Retrying may return an already-consumed response');
    }
  });
}

test('cancelling the open-link confirmation leaves the burn paste available', async ({ page }) => {
  const url = await createNote(page, 'cancel leaves this note alone');
  const id = pasteIdFromUrl(url);
  let consumeRequests = 0;
  await page.route((requestUrl) => (
    requestUrl.pathname === `/api/paste/${id}/consume`
  ), async (route) => {
    consumeRequests++;
    await route.continue();
  });

  const openLink = page.locator('#open-link');
  await openLink.focus();
  await page.keyboard.press('Enter');
  await expect(openLink).toContainText('Uses the one view');
  await page.keyboard.press('Tab'); // blur disarms the confirmation
  await expect(openLink).toHaveText('Open link');
  expect(consumeRequests).toBe(0);

  await page.goto(url);
  await expect(page.locator('#reveal-burn')).toBeVisible();
  await page.locator('#reveal-burn').click();
  await expect(page.locator('#paste-content')).toHaveText('cancel leaves this note alone');
});

test('create timeout preserves text, recovers the button, and warns about a possible duplicate', async ({ page }) => {
  await openComposer(page);
  await page.clock.install();
  const stalled = await stallRequest(page, (url) => (
    url.pathname === '/api/paste'
  ));
  const content = 'text survives a timed out create';
  await page.locator('#editor').fill(content);
  const timeoutMs = await timeoutFor(page, 'create');
  await page.locator('#create').click();
  await stalled.requestSeen;
  await page.clock.fastForward(timeoutMs + 1);

  await expect(page.locator('#create-msg')).toContainText('Creating the paste timed out');
  await expect(page.locator('#create-msg')).toContainText('server may have created it');
  await expect(page.locator('#editor')).toHaveValue(content);
  await expect(page.locator('#create')).toBeEnabled();
  expect(stalled.count()).toBe(1);
  stalled.release();
});

test('metadata peek timeout does not issue a consume request', async ({ page }) => {
  const url = await createNote(page, 'peek timeout does not consume');
  const id = pasteIdFromUrl(url);
  await page.clock.install();
  const stalledPeek = await stallRequest(page, (requestUrl) => (
    requestUrl.pathname === `/api/paste/${id}` && requestUrl.searchParams.get('meta') === '1'
  ));
  let consumeRequests = 0;
  await page.route((requestUrl) => (
    requestUrl.pathname === `/api/paste/${id}/consume`
  ), async (route) => {
    consumeRequests++;
    await route.continue();
  });

  const timeoutMs = await timeoutFor(page, 'peek');
  await page.goto(url);
  await stalledPeek.requestSeen;
  await page.clock.fastForward(timeoutMs + 1);
  await expect(page.locator('#status-msg')).toContainText('The request timed out while checking this note');
  expect(consumeRequests).toBe(0);
  stalledPeek.release();
});

test('consume timeout is ambiguous and never retries automatically', async ({ page }) => {
  const url = await createNote(page, 'consume timeout is ambiguous');
  const id = pasteIdFromUrl(url);
  await page.goto(url);
  await expect(page.locator('#reveal-burn')).toBeVisible();
  await page.clock.install();
  const stalledConsume = await stallRequest(page, (requestUrl) => (
    requestUrl.pathname === `/api/paste/${id}/consume`
  ));

  const timeoutMs = await timeoutFor(page, 'consume');
  await page.locator('#reveal-burn').click();
  await stalledConsume.requestSeen;
  await page.clock.fastForward(timeoutMs + 1);
  await expect(page.locator('#status-msg')).toContainText('Could not confirm whether the paste was consumed');
  await expect(page.locator('#status-msg')).toContainText('Retrying may return an already-consumed response');
  expect(stalledConsume.count()).toBe(1);
  stalledConsume.release();
});

test('consume preparation failure is marked as not sent', async ({ page }) => {
  await openComposer(page);
  const result = await page.evaluate(async () => {
    const api = await import('/js/api.js');
    const originalFetch = window.fetch;
    let calls = 0;
    window.fetch = (...args) => {
      calls++;
      return originalFetch(...args);
    };
    try {
      await api.consumePaste(String.fromCharCode(0xd800));
      return { state: 'unexpected-success', calls };
    } catch (error) {
      return { state: error.consumeState, calls };
    } finally {
      window.fetch = originalFetch;
    }
  });
  expect(result).toEqual({ state: 'not-sent', calls: 0 });
});

test('delete server failure is reported without claiming deletion succeeded', async ({ page }) => {
  const url = await createNote(page, 'delete failure remains visible');
  const id = pasteIdFromUrl(url);
  await page.route((requestUrl) => (
    requestUrl.pathname === `/api/paste/${id}`
  ), (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'simulated failure' }),
  }));

  await page.locator('#delete-btn').click();
  await page.locator('#delete-btn').click();
  await expect(page.locator('#success-msg')).toContainText('Could not confirm whether deletion completed');
  const head = await page.request.get(`/api/paste/${id}?meta=1`);
  expect(head.status()).toBe(200);
});

test('delete timeout restores the control and reports an unconfirmed result', async ({ page }) => {
  const url = await createNote(page, 'delete timeout is uncertain');
  const id = pasteIdFromUrl(url);
  await page.clock.install();
  const stalledDelete = await stallRequest(page, (requestUrl) => (
    requestUrl.pathname === `/api/paste/${id}`
  ));
  const delBtn = page.locator('#delete-btn');
  await delBtn.click();
  await delBtn.click();
  await stalledDelete.requestSeen;
  await page.clock.fastForward(await timeoutFor(page, 'delete') + 1);

  await expect(page.locator('#success-msg')).toContainText('Could not confirm whether deletion completed');
  await expect(delBtn).toBeEnabled();
  expect(stalledDelete.count()).toBe(1);
  stalledDelete.release();
});

test('password dialog supports Escape and focus restoration from the keyboard', async ({ page }) => {
  await openComposer(page);
  await page.locator('#editor').fill('keyboard modal test');
  const create = page.locator('#create');
  await page.locator('#lock').click();
  await create.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#pw-modal')).toBeVisible();
  await expect(page.locator('#pw-modal-dialog')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#modal-password')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#pw-modal')).toBeHidden();
  await expect(create).toBeFocused();
});

test('reduced-motion preference does not block paste creation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openComposer(page);
  await page.locator('#editor').fill('reduced motion creation');
  await page.locator('#create').click();
  await expect(page.locator('#view-success')).toBeVisible();
  await expect(page.locator('#paste-url')).toContainText('/p/b');
});

test('composer remains usable at a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openComposer(page);
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#create')).toBeVisible();
  await page.locator('#editor').fill('mobile viewport test');
  await page.locator('#create').click();
  await expect(page.locator('#view-success')).toBeVisible();
});
