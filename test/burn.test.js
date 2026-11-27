// burn.test.js — backend API + strict burn-after-read semantics, exercised in
// the real workerd runtime (KV + Durable Object) via vitest-pool-workers.
import { env, SELF, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { encryptPaste, decryptPaste, deriveContentKey, PasswordRequired, DecryptError } from '../public/js/crypto.js';
import { genDeleteToken, hashToken } from '../src/lib/ids.js';

const ORIGIN = 'https://binthere.test';
const JSON_CT = { 'content-type': 'application/json' };
// Rotate the client IP per create: the suite creates more pastes than the
// production per-IP rate limit (30/min) allows from a single address.
let ipSeq = 0;
const postPaste = (body) =>
  SELF.fetch(`${ORIGIN}/api/paste`, {
    method: 'POST',
    headers: { ...JSON_CT, 'cf-connecting-ip': `203.0.113.${(ipSeq++ % 250) + 1}` },
    body: JSON.stringify(body),
  });
const getPaste = (id) => SELF.fetch(`${ORIGIN}/api/paste/${id}`);
// Extended-meta variants (?ext=1): the fork's own clients opt into the
// server-attached viewsLeft/expiresAt fields; plain requests keep the
// exact upstream meta shape for pre-fork clients.
const getPasteExt = (id) => SELF.fetch(`${ORIGIN}/api/paste/${id}?ext=1`);
const consume = (id, headers = { 'x-burn-intent': 'consume' }) =>
  SELF.fetch(`${ORIGIN}/api/paste/${id}/consume`, { method: 'POST', headers });
const consumeExt = (id) =>
  SELF.fetch(`${ORIGIN}/api/paste/${id}/consume?ext=1`, {
    method: 'POST', headers: { 'x-burn-intent': 'consume' },
  });
const deletePaste = (id, token) =>
  SELF.fetch(`${ORIGIN}/api/paste/${id}`, { method: 'DELETE', headers: { 'x-delete-token': token } });

describe('supported paste lifecycle', () => {
  it('rejects non-burn pastes; legacy { expire } creates still work (1 view)', async () => {
    const { body } = await encryptPaste({ text: 'legacy settings' });
    body.adata.bar = false;
    expect((await postPaste(body)).status).toBe(400);

    // Old CLI shape: meta { expire: '1week' } → views=1, TTL from the enum.
    const { body: expiring, fragment } = await encryptPaste({ text: 'legacy expiry' });
    expiring.meta.expire = '1week';
    const created = await postPaste(expiring);
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const head = await (await getPasteExt(id)).json();
    expect(head.meta.viewsLeft).toBe(1);
    expect(head.meta.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 600000);
    const read = await consume(id);
    expect(read.status).toBe(200);
    expect((await decryptPaste({ paste: await read.json(), fragment })).text).toBe('legacy expiry');
    expect((await consume(id)).status).toBe(410);
  });

  it('enforces view/TTL ranges server-side', async () => {
    const tooMany = await encryptPaste({ text: 'x', views: 1001, ttlSeconds: 3600 });
    expect((await postPaste(tooMany.body)).status).toBe(400);
    const tooShort = await encryptPaste({ text: 'x', views: 1, ttlSeconds: 59 });
    expect((await postPaste(tooShort.body)).status).toBe(400);
    const tooLong = await encryptPaste({ text: 'x', views: 1, ttlSeconds: 2592001 });
    expect((await postPaste(tooLong.body)).status).toBe(400);
    const ok = await encryptPaste({ text: 'x', views: 1000, ttlSeconds: 2592000 });
    expect((await postPaste(ok.body)).status).toBe(201);
  });

  it('owner create gate: 401 without/with wrong token, 201 with the right one', async () => {
    const token = 'owner-test-token';
    env.CREATE_TOKEN_SHA256 = await hashToken(token);
    try {
      const { body } = await encryptPaste({ text: 'gated' });
      expect((await postPaste(body)).status).toBe(401);
      const wrong = await SELF.fetch(`${ORIGIN}/api/paste`, {
        method: 'POST',
        headers: { ...JSON_CT, 'x-create-token': 'wrong-token' },
        body: JSON.stringify(body),
      });
      expect(wrong.status).toBe(401);
      const right = await SELF.fetch(`${ORIGIN}/api/paste`, {
        method: 'POST',
        headers: { ...JSON_CT, 'x-create-token': token },
        body: JSON.stringify(body),
      });
      expect(right.status).toBe(201);
      // Reads stay public for link holders.
      const { id } = await right.json();
      expect((await getPaste(id)).status).toBe(200);
      expect((await consume(id)).status).toBe(200);
    } finally {
      delete env.CREATE_TOKEN_SHA256;
    }
    // Gate disabled again once the var is gone.
    const { body: open } = await encryptPaste({ text: 'open again' });
    expect((await postPaste(open)).status).toBe(201);
  });

  it('rejects deletion with the wrong token (403) and keeps the note', async () => {
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

  it('consume on a legacy KV id is 404; GET on /consume is 405 + Allow: POST', async () => {
    const id = 'k' + 'A'.repeat(22);
    expect((await consume(id)).status).toBe(404);
    expect((await getPaste(id)).status).toBe(404);

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

  it('multi-view: views=3 reads exactly 3 times, 4th is 410; peeks never spend', async () => {
    const { body, fragment } = await encryptPaste({ text: 'thrice', views: 3, ttlSeconds: 3600 });
    const { id } = await (await postPaste(body)).json();

    // Plain GETs (previews/crawlers) return the head and spend nothing.
    for (let i = 0; i < 3; i++) {
      const head = await (await getPasteExt(id)).json();
      expect(head.ct).toBeUndefined();
      expect(head.meta.viewsLeft).toBe(3);
    }

    for (const leftAfter of [2, 1, 0]) {
      const r = await consumeExt(id);
      expect(r.status).toBe(200);
      const paste = await r.json();
      expect(paste.meta.viewsLeft).toBe(leftAfter);
      expect((await decryptPaste({ paste, fragment })).text).toBe('thrice');
      if (leftAfter > 0) {
        const head = await (await getPasteExt(id)).json();
        expect(head.meta.viewsLeft).toBe(leftAfter);
      }
    }
    expect((await consume(id)).status).toBe(410);
    expect((await getPaste(id)).status).toBe(410);
  });

  it('multi-view concurrency: 10 simultaneous consumes of views=3 → exactly 3×200', async () => {
    const { body } = await encryptPaste({ text: 'race3', views: 3, ttlSeconds: 3600 });
    const { id } = await (await postPaste(body)).json();
    const statuses = (await Promise.all(Array.from({ length: 10 }, () => consume(id))))
      .map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 410)).toHaveLength(7);
  });

  it('custom TTL: DO alarm purges a multi-view paste at expiry', async () => {
    const token = genDeleteToken();
    const dth = await hashToken(token);
    const paste = { v: 1, ct: 'AA', wk: 'AA', adata: {}, meta: { ttlSeconds: 120, views: 5, created: 0 } };
    const stub = env.BURN.get(env.BURN.idFromName('bcustomttltest'));
    await stub.create(paste, dth, 120, 5);
    expect((await stub.peek(true)).head.meta.viewsLeft).toBe(5);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.peek()).status).toBe('gone');
    expect((await stub.consume()).status).toBe('gone');
  });

  it('legacy shape: without ?ext=1, peek/consume meta carries no server-attached fields', async () => {
    const { body, fragment } = await encryptPaste({ text: 'legacy reader', views: 2, ttlSeconds: 3600 });
    const { id } = await (await postPaste(body)).json();

    // Pre-fork clients validate meta against a strict key allowlist; the
    // default response must not gain viewsLeft/expiresAt.
    const head = await (await getPaste(id)).json();
    expect('viewsLeft' in head.meta).toBe(false);
    expect('expiresAt' in head.meta).toBe(false);

    const paste = await (await consume(id)).json();
    expect('viewsLeft' in paste.meta).toBe(false);
    expect('expiresAt' in paste.meta).toBe(false);
    expect((await decryptPaste({ paste, fragment })).text).toBe('legacy reader');

    // The same paste with ?ext=1 carries both fields (one view spent).
    const headExt = await (await getPasteExt(id)).json();
    expect(headExt.meta.viewsLeft).toBe(1);
    expect(headExt.meta.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    const pasteExt = await (await consumeExt(id)).json();
    expect(pasteExt.meta.viewsLeft).toBe(0);
    expect(Number.isInteger(pasteExt.meta.expiresAt)).toBe(true);
  });

  it('legacy-shaped create stores upstream meta {created, expire} only', async () => {
    // Client meta { expire } (no ttlSeconds/views) → the stored meta must
    // stay the exact upstream shape so pre-fork clients (strict
    // { expire, created } allowlist) can read the link. The DO still
    // enforces TTL/views from its own exp/viewsLeft.
    const { body, fragment } = await encryptPaste({ text: 'old shape' });
    expect(body.meta).toEqual({ expire: '1day' });
    const { id } = await (await postPaste(body)).json();

    const head = await (await getPaste(id)).json();
    expect(Object.keys(head.meta).sort()).toEqual(['created', 'expire']);
    expect(head.meta.expire).toBe('1day');

    // The fork's own UI still gets its countdown/budget via ?ext=1.
    const headExt = await (await getPasteExt(id)).json();
    expect(headExt.meta.viewsLeft).toBe(1);
    expect(headExt.meta.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 80000);

    const paste = await (await consume(id)).json();
    expect(Object.keys(paste.meta).sort()).toEqual(['created', 'expire']);
    expect((await decryptPaste({ paste, fragment })).text).toBe('old shape');
    expect((await consume(id)).status).toBe(410); // legacy = 1 view

    // Contrast: a custom-shaped create keeps ttlSeconds/views in meta.
    const custom = await encryptPaste({ text: 'new shape', views: 2, ttlSeconds: 3600 });
    const { id: id2 } = await (await postPaste(custom.body)).json();
    const head2 = await (await getPaste(id2)).json();
    expect(head2.meta.ttlSeconds).toBe(3600);
    expect(head2.meta.views).toBe(2);
  });

  it('MIN_TTL_SECONDS below 60 is floored to 60 (index never outlives paste)', async () => {
    env.MIN_TTL_SECONDS = '30';
    try {
      const tooShort = await encryptPaste({ text: 'x', views: 1, ttlSeconds: 45 });
      expect((await postPaste(tooShort.body)).status).toBe(400);
      const atFloor = await encryptPaste({ text: 'x', views: 1, ttlSeconds: 60 });
      expect((await postPaste(atFloor.body)).status).toBe(201);
    } finally {
      delete env.MIN_TTL_SECONDS;
    }
  });

  it('revoke (delete token) works mid-budget on a multi-view paste', async () => {
    const { body } = await encryptPaste({ text: 'revoke me', views: 5, ttlSeconds: 3600 });
    const { id, deletetoken } = await (await postPaste(body)).json();
    expect((await consume(id)).status).toBe(200); // 4 left
    expect((await deletePaste(id, genDeleteToken())).status).toBe(403);
    expect((await deletePaste(id, deletetoken)).status).toBe(200);
    expect((await consume(id)).status).toBe(410);
    expect((await getPaste(id)).status).toBe(410);
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
  const getMeta = (id) => SELF.fetch(`${ORIGIN}/api/paste/${id}?meta=1&ext=1`);

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

  it('REGRESSION: a wrong/absent password on a burn paste does NOT consume it', async () => {
    const password = 'correct-horse-battery';
    const { body, fragment } = await encryptPaste({ text: 'secret burn', bar: true, password, views: 2, ttlSeconds: 3600 });
    const { id } = await (await postPaste(body)).json();

    const head = await (await getMeta(id)).json();
    expect(head.adata.kdf).toBe('pbkdf2-hkdf');
    expect(head.meta.viewsLeft).toBe(2);

    // Wrong password → verify throws, paste and view budget stay intact.
    await expect(deriveContentKey({ adata: head.adata, wk: head.wk, fragment, password: 'nope' }))
      .rejects.toBeInstanceOf(DecryptError);
    expect((await getMeta(id)).status).toBe(200);
    expect((await (await getMeta(id)).json()).meta.viewsLeft).toBe(2);

    // No password → PasswordRequired, still intact.
    await expect(deriveContentKey({ adata: head.adata, wk: head.wk, fragment }))
      .rejects.toBeInstanceOf(PasswordRequired);
    expect((await getMeta(id)).status).toBe(200);

    // Correct password verifies → THEN a view is spent. Budget was 2, so one
    // more read succeeds and the third is gone.
    await expect(deriveContentKey({ adata: head.adata, wk: head.wk, fragment, password }))
      .resolves.toBeTruthy();
    const read = await consume(id);
    expect(read.status).toBe(200);
    expect((await decryptPaste({ paste: await read.json(), fragment, password })).text).toBe('secret burn');
    expect((await consume(id)).status).toBe(200); // second (last) view
    expect((await consume(id)).status).toBe(410); // budget exhausted
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

  it('rejects an oversized streamed body with 413 (no Content-Length to trust)', async () => {
    // Streaming the body omits Content-Length (chunked), so the header fast path
    // cannot fire — this exercises the incremental read cap itself. The stream
    // yields more than MAX_BODY across several chunks; the read must abort and
    // 413 without buffering the whole thing.
    const chunk = new Uint8Array(1024 * 1024); // 1 MiB per pull
    let sent = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (sent >= 6 * 1024 * 1024) { controller.close(); return; } // 6 MiB total > 4 MiB cap
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    });
    const r = await SELF.fetch(`${ORIGIN}/api/paste`, {
      method: 'POST', headers: JSON_CT, body: stream, duplex: 'half' });
    expect(r.status).toBe(413);
  });

  it('treats an empty body as invalid JSON (400), never 413/500', async () => {
    // Bodyless POST → request.body is null → readCappedBody yields 0 bytes →
    // JSON.parse('') throws → 400, matching the old arrayBuffer() behaviour.
    const r = await SELF.fetch(`${ORIGIN}/api/paste`, { method: 'POST', headers: JSON_CT });
    expect(r.status).toBe(400);
  });

  it('accepts a body of exactly MAX_BODY bytes (cap is inclusive → 400, not 413)', async () => {
    // Exactly at the cap must pass the size gate (received > max is strict), so
    // the request reaches JSON parsing. 4 MiB of 'a' is valid-size but not JSON,
    // so a 400 here proves it was NOT rejected as oversized (which would be 413).
    const chunk = new Uint8Array(1024 * 1024).fill(0x61); // 'a'
    let sent = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (sent >= 4 * 1024 * 1024) { controller.close(); return; }
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    });
    const r = await SELF.fetch(`${ORIGIN}/api/paste`, {
      method: 'POST', headers: JSON_CT, body: stream, duplex: 'half' });
    expect(r.status).toBe(400);
  });

  it('rejects MAX_BODY + 1 streamed byte with 413', async () => {
    // One byte over the cap on the streaming path (no Content-Length) must 413.
    const kib = new Uint8Array(1024).fill(0x61);
    let sent = 0;
    const total = 4 * 1024 * 1024 + 1;
    const stream = new ReadableStream({
      pull(controller) {
        if (sent >= total) { controller.close(); return; }
        const n = Math.min(kib.byteLength, total - sent);
        controller.enqueue(kib.subarray(0, n));
        sent += n;
      },
    });
    const r = await SELF.fetch(`${ORIGIN}/api/paste`, {
      method: 'POST', headers: JSON_CT, body: stream, duplex: 'half' });
    expect(r.status).toBe(413);
  });

  it('rejects an oversized ct with 413 (not a 400 format error)', async () => {
    const { body } = await encryptPaste({ text: 'x' });
    body.ct = 'A'.repeat(3000004); // > MAX_CT_B64, body still under 4 MiB
    expect((await postPaste(body)).status).toBe(413);
  });

  it('rejects a paste whose record exceeds the DO storage cap with 413', async () => {
    const { body } = await encryptPaste({ text: 'x', bar: true });
    body.ct = 'A'.repeat(2500000); // valid per-format, but over MAX_BURN_RECORD
    expect((await postPaste(body)).status).toBe(413);
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
