// burn.test.js — backend API + strict burn-after-read semantics, exercised in
// the real workerd runtime (KV + Durable Object) via vitest-pool-workers.
import { env, SELF, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { encryptPaste, decryptPaste, deriveContentKey, PasswordRequired, DecryptError } from '../public/js/crypto.js';
import { genDeleteToken, hashToken } from '../src/lib/ids.js';

const ORIGIN = 'https://binthere.test';
const JSON_CT = { 'content-type': 'application/json' };
const postPaste = (body) =>
  SELF.fetch(`${ORIGIN}/api/paste`, { method: 'POST', headers: JSON_CT, body: JSON.stringify(body) });
const getPaste = (id) => SELF.fetch(`${ORIGIN}/api/paste/${id}`);
const consume = (id, headers = { 'x-burn-intent': 'consume' }) =>
  SELF.fetch(`${ORIGIN}/api/paste/${id}/consume`, { method: 'POST', headers });
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
  it('is single-use: first consume 200, second consume 410', async () => {
    const { body, fragment } = await encryptPaste({ text: 'once', bar: true });
    const { id } = await (await postPaste(body)).json();
    expect(id[0]).toBe('b'); // burn class

    const first = await consume(id);
    expect(first.status).toBe(200);
    expect((await decryptPaste({ paste: await first.json(), fragment })).text).toBe('once');

    expect((await consume(id)).status).toBe(410);
  });

  it('CONCURRENCY: many simultaneous consumes → exactly one 200, the rest 410', async () => {
    const { body } = await encryptPaste({ text: 'exactly once', bar: true });
    const { id } = await (await postPaste(body)).json();

    const N = 25;
    const statuses = (await Promise.all(Array.from({ length: N }, () => consume(id))))
      .map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 410)).toHaveLength(N - 1);
  });

  it('GET on a burn id NEVER consumes: returns the head (no ct), repeatably', async () => {
    const { body } = await encryptPaste({ text: 'ambient-safe', bar: true });
    const { id } = await (await postPaste(body)).json();

    for (let i = 0; i < 3; i++) {
      const r = await getPaste(id); // an <img>/prefetch/bot-style plain GET
      expect(r.status).toBe(200);
      const head = await r.json();
      expect(head.ct).toBeUndefined();
      expect(head.wk).toBeTruthy();
    }
    expect((await consume(id)).status).toBe(200); // still there for the real reader
  });

  it('consume without the X-Burn-Intent header is 400 and does not consume', async () => {
    const { body } = await encryptPaste({ text: 'guarded', bar: true });
    const { id } = await (await postPaste(body)).json();

    expect((await consume(id, {})).status).toBe(400);
    expect((await consume(id, { 'x-burn-intent': 'nope' })).status).toBe(400);
    expect((await consume(id)).status).toBe(200); // survived the header-less attempts
  });

  it('cross-site consume (Sec-Fetch-Site) is 403 and does not consume', async () => {
    const { body } = await encryptPaste({ text: 'same-site only', bar: true });
    const { id } = await (await postPaste(body)).json();

    const r = await consume(id, { 'x-burn-intent': 'consume', 'sec-fetch-site': 'cross-site' });
    expect(r.status).toBe(403);
    expect((await consume(id, { 'x-burn-intent': 'consume', 'sec-fetch-site': 'same-origin' })).status).toBe(200);
  });

  it('consume on a non-burn (KV) id is 404; GET on /consume is 405 + Allow: POST', async () => {
    const { body } = await encryptPaste({ text: 'kv paste' });
    const { id } = await (await postPaste(body)).json();
    expect((await consume(id)).status).toBe(404);
    expect((await getPaste(id)).status).toBe(200); // untouched

    const get = await SELF.fetch(`${ORIGIN}/api/paste/${id}/consume`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
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
    expect((await consume(id)).status).toBe(200); // the explicit consume destroys
    expect((await getMeta(id)).status).toBe(410);  // now gone
  });

  it('KV ?meta=1 returns the head without ciphertext (every storage class)', async () => {
    const { body } = await encryptPaste({ text: 'kv head' });
    const { id } = await (await postPaste(body)).json();

    const head = await (await getMeta(id)).json();
    expect(head.ct).toBeUndefined();
    expect(head.wk).toBeTruthy();
    expect(head.adata.kdf).toBe('hkdf');
    expect(head.meta.expire).toBeTruthy();

    const full = await (await getPaste(id)).json(); // plain GET still has ct
    expect(full.ct).toBeTruthy();
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
    const read = await consume(id);
    expect(read.status).toBe(200);
    expect((await decryptPaste({ paste: await read.json(), fragment, password })).text).toBe('secret burn');
    expect((await consume(id)).status).toBe(410); // burned only after being read
  });
});

describe('request validation & limits', () => {
  it('rejects invalid JSON with 400', async () => {
    const r = await SELF.fetch(`${ORIGIN}/api/paste`, { method: 'POST', headers: JSON_CT, body: '{not json' });
    expect(r.status).toBe(400);
  });

  it('rejects a missing or non-JSON content-type with 415', async () => {
    const { body } = await encryptPaste({ text: 'x' });
    const noCt = await SELF.fetch(`${ORIGIN}/api/paste`, { method: 'POST', body: JSON.stringify(body) });
    expect(noCt.status).toBe(415);
    const textPlain = await SELF.fetch(`${ORIGIN}/api/paste`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
    expect(textPlain.status).toBe(415);
    // Parameters after the media type are fine.
    const withCharset = await SELF.fetch(`${ORIGIN}/api/paste`, {
      method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
    expect(withCharset.status).toBe(201);
  });

  it('rejects a malformed paste with 400', async () => {
    const { body } = await encryptPaste({ text: 'x' });
    body.v = 2; // unsupported version
    expect((await postPaste(body)).status).toBe(400);
  });

  it('rejects an oversized body with 413', async () => {
    const big = 'a'.repeat(4 * 1024 * 1024 + 16);
    const r = await SELF.fetch(`${ORIGIN}/api/paste`, { method: 'POST', headers: JSON_CT, body: big });
    expect(r.status).toBe(413);
  });

  it('rejects an oversized ct with 413 (not a 400 format error)', async () => {
    const { body } = await encryptPaste({ text: 'x' });
    body.ct = 'A'.repeat(3000004); // > MAX_CT_B64, body still under 4 MiB
    expect((await postPaste(body)).status).toBe(413);
  });

  it('rejects a burn paste whose record exceeds the DO storage cap with 413', async () => {
    const { body } = await encryptPaste({ text: 'x', bar: true });
    body.ct = 'A'.repeat(2500000); // valid per-format, but over MAX_BURN_RECORD
    expect((await postPaste(body)).status).toBe(413);
    // The same ct in a normal (KV) paste is fine — the cap is burn-only.
    const { body: kvBody } = await encryptPaste({ text: 'x' });
    kvBody.ct = 'A'.repeat(2500000);
    expect((await postPaste(kvBody)).status).toBe(201);
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

  it('rejects unknown routes with 404 and known routes with 405 + Allow', async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/nope`)).status).toBe(404);
    const put = await SELF.fetch(`${ORIGIN}/api/paste`, { method: 'PUT' });
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('POST');
    const { body } = await encryptPaste({ text: 'x' });
    const { id } = await (await postPaste(body)).json();
    const post = await SELF.fetch(`${ORIGIN}/api/paste/${id}`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, DELETE');
  });
});
