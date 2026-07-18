// burn.test.js — backend API + strict burn-after-read semantics, exercised in
// the real workerd runtime (KV + Durable Object) via vitest-pool-workers.
import { env, SELF, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { encryptPaste, decryptPaste, deriveContentKey, PasswordRequired, DecryptError } from '../public/js/crypto.js';
import { genDeleteToken, hashToken } from '../src/lib/ids.js';

const ORIGIN = 'https://binthere.test';
const postPaste = (body) =>
  SELF.fetch(`${ORIGIN}/api/paste`, { method: 'POST', body: JSON.stringify(body) });
const getPaste = (id) => SELF.fetch(`${ORIGIN}/api/paste/${id}`);
const deletePaste = (id, token) =>
  SELF.fetch(`${ORIGIN}/api/paste/${id}`, { method: 'DELETE', headers: { 'x-delete-token': token } });

describe('paste lifecycle (KV)', () => {
  it('creates, reads, decrypts, and deletes a normal paste', async () => {
    const text = 'a normal paste';
    const { body, fragment } = await encryptPaste({ text });

    const created = await postPaste(body);
    expect(created.status).toBe(201);
    const { id, deletetoken } = await created.json();
    expect(id[0]).toBe('k'); // KV class

    const read = await getPaste(id);
    expect(read.status).toBe(200);
    const paste = await read.json();
    expect((await decryptPaste({ paste, fragment })).text).toBe(text);

    const del = await deletePaste(id, deletetoken);
    expect(del.status).toBe(200);
    expect((await getPaste(id)).status).toBe(404);
  });

  it('rejects deletion with the wrong token (403) and keeps the paste', async () => {
    const { body } = await encryptPaste({ text: 'keep me' });
    const { id } = await (await postPaste(body)).json();
    expect((await deletePaste(id, genDeleteToken())).status).toBe(403);
    expect((await getPaste(id)).status).toBe(200);
  });
});

describe('burn-after-read (Durable Object)', () => {
  it('is single-use: first read 200, second read 410', async () => {
    const { body, fragment } = await encryptPaste({ text: 'once', bar: true });
    const { id } = await (await postPaste(body)).json();
    expect(id[0]).toBe('b'); // burn class

    const first = await getPaste(id);
    expect(first.status).toBe(200);
    expect((await decryptPaste({ paste: await first.json(), fragment })).text).toBe('once');

    expect((await getPaste(id)).status).toBe(410);
  });

  it('CONCURRENCY: many simultaneous reads → exactly one 200, the rest 410', async () => {
    const { body } = await encryptPaste({ text: 'exactly once', bar: true });
    const { id } = await (await postPaste(body)).json();

    const N = 25;
    const statuses = (await Promise.all(Array.from({ length: N }, () => getPaste(id))))
      .map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 410)).toHaveLength(N - 1);
  });

  it('expires via the DO alarm', async () => {
    const token = genDeleteToken();
    const dth = await hashToken(token);
    const paste = { v: 1, ct: 'AA', wk: 'AA', adata: {}, meta: { expire: '5min', created: 0 } };
    const stub = env.BURN.get(env.BURN.idFromName('balarmtest'));
    await stub.create(paste, dth, 300); // schedules an alarm 5 min out
    expect(await runDurableObjectAlarm(stub)).toBe(true); // fire it now
    expect((await stub.consume()).status).toBe('gone');
  });

  it('delete via token works on a burn paste', async () => {
    const { body } = await encryptPaste({ text: 'burn+delete', bar: true });
    const { id, deletetoken } = await (await postPaste(body)).json();
    expect((await deletePaste(id, genDeleteToken())).status).toBe(403);
    expect((await deletePaste(id, deletetoken)).status).toBe(200);
    expect((await getPaste(id)).status).toBe(410);
  });
});

describe('burn peek — verify password before the single read', () => {
  const getMeta = (id) => SELF.fetch(`${ORIGIN}/api/paste/${id}?meta=1`);

  it('peek returns the head without ciphertext and does NOT consume', async () => {
    const { body } = await encryptPaste({ text: 'peekable', bar: true });
    const { id } = await (await postPaste(body)).json();

    const head = await (await getMeta(id)).json();
    expect(head.ct).toBeUndefined();      // ciphertext is never released on peek
    expect(head.wk).toBeTruthy();
    expect(head.adata.kdf).toBe('hkdf');

    expect((await getMeta(id)).status).toBe(200); // peeking again still works
    expect((await getPaste(id)).status).toBe(200); // the real read consumes
    expect((await getMeta(id)).status).toBe(410);  // now gone
  });

  it('REGRESSION: a wrong/absent password on a burn paste does NOT consume it', async () => {
    const password = 'correct-horse-battery';
    const { body, fragment } = await encryptPaste({ text: 'secret burn', bar: true, password });
    const { id } = await (await postPaste(body)).json();

    const head = await (await getMeta(id)).json();
    expect(head.adata.kdf).toBe('pbkdf2-hkdf');

    // Wrong password → verify throws, paste stays intact.
    await expect(deriveContentKey({ adata: head.adata, wk: head.wk, fragment, password: 'nope' }))
      .rejects.toBeInstanceOf(DecryptError);
    expect((await getMeta(id)).status).toBe(200);

    // No password → PasswordRequired, still intact.
    await expect(deriveContentKey({ adata: head.adata, wk: head.wk, fragment }))
      .rejects.toBeInstanceOf(PasswordRequired);
    expect((await getMeta(id)).status).toBe(200);

    // Correct password verifies → THEN the single destructive read succeeds once.
    await expect(deriveContentKey({ adata: head.adata, wk: head.wk, fragment, password }))
      .resolves.toBeTruthy();
    const read = await getPaste(id);
    expect(read.status).toBe(200);
    expect((await decryptPaste({ paste: await read.json(), fragment, password })).text).toBe('secret burn');
    expect((await getPaste(id)).status).toBe(410); // burned only after being read
  });
});

describe('request validation & limits', () => {
  it('rejects invalid JSON with 400', async () => {
    const r = await SELF.fetch(`${ORIGIN}/api/paste`, { method: 'POST', body: '{not json' });
    expect(r.status).toBe(400);
  });

  it('rejects a malformed paste with 400', async () => {
    const { body } = await encryptPaste({ text: 'x' });
    body.v = 2; // unsupported version
    expect((await postPaste(body)).status).toBe(400);
  });

  it('rejects an oversized body with 413', async () => {
    const big = 'a'.repeat(4 * 1024 * 1024 + 16);
    const r = await SELF.fetch(`${ORIGIN}/api/paste`, { method: 'POST', body: big });
    expect(r.status).toBe(413);
  });

  it('returns 404 for unknown or malformed ids', async () => {
    expect((await getPaste('zzz')).status).toBe(404);
    expect((await getPaste('k' + 'A'.repeat(22))).status).toBe(404);
  });

  it('returns 404 (not 500) for malformed percent-encoding in the id', async () => {
    expect((await getPaste('%zz')).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/api/paste/%zz`, { method: 'DELETE' })).status).toBe(404);
  });

  it('DELETE without a token is 400; a token in the query string is ignored', async () => {
    const { body } = await encryptPaste({ text: 'header only' });
    const { id, deletetoken } = await (await postPaste(body)).json();
    expect((await SELF.fetch(`${ORIGIN}/api/paste/${id}`, { method: 'DELETE' })).status).toBe(400);
    const viaQuery = await SELF.fetch(
      `${ORIGIN}/api/paste/${id}?token=${encodeURIComponent(deletetoken)}`, { method: 'DELETE' });
    expect(viaQuery.status).toBe(400); // query tokens are not accepted (they would end up in logs)
    expect((await getPaste(id)).status).toBe(200); // paste untouched
  });

  it('rejects unknown routes and methods', async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/nope`)).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/api/paste`, { method: 'PUT' })).status).toBe(404);
  });
});
