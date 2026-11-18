// Disposable live checks. Fragment secrets and deletion tokens stay in memory.
// Pass only Preview origins, never production. No keys are printed or saved.
import assert from 'node:assert/strict';
import { encryptPaste, decryptPaste } from '../public/js/crypto.js';

const origins = process.argv.slice(2).map(value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash
      || !/^[a-z0-9-]+-binthere\.nxfu\.workers\.dev$/.test(url.hostname)) {
    throw new Error('Supply an HTTPS binthere workers.dev Preview origin only.');
  }
  return url.origin;
});
assert.ok(origins.length >= 1 && origins.length <= 2, 'Supply one or two Preview origins.');
const request = (origin, path, init) => fetch(`${origin}${path}`, {
  ...init, signal: AbortSignal.timeout(20000),
});

for (const origin of origins) {
  const page = await request(origin, '/');
  assert.equal(page.status, 200);
  assert.ok(page.headers.get('content-security-policy')?.includes("default-src 'none'"));
  assert.equal(page.headers.get('x-robots-tag'), 'noindex');
  const html = await page.text();
  assert.ok(html.includes('binthere'));
  assert.equal((await request(origin, '/js/app.js')).status, 200);

  const text = 'Disposable preview verification.';
  const { body, fragment } = await encryptPaste({ text, password: 'disposable-preview-check' });
  const created = await request(origin, '/api/paste', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const head = await (await request(origin, `/api/paste/${id}`)).json();
  assert.ok(!Object.hasOwn(head, 'ct'));
  assert.equal(head.meta.expire, '1day');
  assert.equal(head.adata.bar, true);
  // Other Previews must not see this paste. Never probe its ID on production:
  // doing so would instantiate an empty object in the production DO namespace.
  for (const other of origins.filter(other => other !== origin)) {
    assert.equal((await request(other, `/api/paste/${id}`)).status, 410);
  }
  const consume = () => request(origin, `/api/paste/${id}/consume`, {
    method: 'POST', headers: { 'x-burn-intent': 'consume' },
  });
  const responses = await Promise.all(Array.from({ length: 8 }, consume));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 410, 410, 410, 410, 410, 410, 410]);
  const paste = await responses.find(r => r.status === 200).json();
  assert.equal((await decryptPaste({ paste, fragment, password: 'disposable-preview-check' })).text, text);
  assert.equal((await consume()).status, 410);
  console.log(`${origin}: frontend, encrypted round trip, metadata, atomic burn${origins.length === 2 ? ', cross-Preview isolation' : ''} passed.`);
}
