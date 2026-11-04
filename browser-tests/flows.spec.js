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
  await expect(page.locator('#status-msg')).toContainText('already opened');
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
