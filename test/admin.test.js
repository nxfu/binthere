// admin.test.js — owner admin API (custom fork): KV index + list/revoke,
// exercised in the real workerd runtime via vitest-pool-workers.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encryptPaste } from '../public/js/crypto.js';
import { hashToken } from '../src/lib/ids.js';
import { idxKey } from '../src/lib/store.js';

const ORIGIN = 'https://binthere.test';
const JSON_CT = { 'content-type': 'application/json' };
const TOKEN = 'owner-admin-test-token';

let ipSeq = 0;
const ip = () => `198.51.100.${(ipSeq++ % 250) + 1}`;

const postPaste = async (opts) => {
  const { body } = await encryptPaste(opts);
  return SELF.fetch(`${ORIGIN}/api/paste`, {
    method: 'POST',
    headers: { ...JSON_CT, 'x-create-token': TOKEN, 'cf-connecting-ip': ip() },
    body: JSON.stringify(body),
  });
};
// Same, but with an owner note riding beside the paste object in the JSON.
const postPasteWithNote = async (opts, note) => {
  const { body } = await encryptPaste(opts);
  return SELF.fetch(`${ORIGIN}/api/paste`, {
    method: 'POST',
    headers: { ...JSON_CT, 'x-create-token': TOKEN, 'cf-connecting-ip': ip() },
    body: JSON.stringify({ ...body, note }),
  });
};
const adminList = (headers = { 'x-create-token': TOKEN }, qs = '') =>
  SELF.fetch(`${ORIGIN}/api/admin/list${qs}`, { headers: { ...headers, 'cf-connecting-ip': ip() } });
// Walk every page of the paginated list endpoint and return all entries.
const listAll = async () => {
  const out = [];
  let cursor = null;
  do {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const data = await (await adminList({ 'x-create-token': TOKEN }, qs)).json();
    out.push(...data.pastes);
    cursor = data.cursor;
  } while (cursor);
  return out;
};
const adminRevoke = (id, headers = { 'x-create-token': TOKEN }) =>
  SELF.fetch(`${ORIGIN}/api/admin/revoke`, {
    method: 'POST',
    headers: { ...JSON_CT, ...headers, 'cf-connecting-ip': ip() },
    body: JSON.stringify({ id }),
  });
const adminNote = (id, note, headers = { 'x-create-token': TOKEN }) =>
  SELF.fetch(`${ORIGIN}/api/admin/note`, {
    method: 'POST',
    headers: { ...JSON_CT, ...headers, 'cf-connecting-ip': ip() },
    body: JSON.stringify({ id, note }),
  });
const consume = (id) =>
  SELF.fetch(`${ORIGIN}/api/paste/${id}/consume`, { method: 'POST', headers: { 'x-burn-intent': 'consume' } });
const getPaste = (id) => SELF.fetch(`${ORIGIN}/api/paste/${id}`);
const findIn = (list, id) => list.find((p) => p.id === id);

describe('owner admin API', () => {
  beforeEach(async () => {
    env.CREATE_TOKEN_SHA256 = await hashToken(TOKEN);
  });
  afterEach(() => {
    delete env.CREATE_TOKEN_SHA256;
  });

  it('fails closed when CREATE_TOKEN_SHA256 is unset (even with a header)', async () => {
    delete env.CREATE_TOKEN_SHA256;
    expect((await adminList()).status).toBe(401);
    expect((await adminRevoke('b' + 'A'.repeat(22))).status).toBe(401);
  });

  it('401 without token and with wrong token, on both endpoints', async () => {
    expect((await adminList({})).status).toBe(401);
    expect((await adminList({ 'x-create-token': 'wrong' })).status).toBe(401);
    expect((await adminRevoke('b' + 'A'.repeat(22), {})).status).toBe(401);
    expect((await adminRevoke('b' + 'A'.repeat(22), { 'x-create-token': 'wrong' })).status).toBe(401);
  });

  it('lists created pastes with metadata + live viewsLeft, newest first', async () => {
    const a = await (await postPaste({ text: 'three views', views: 3, ttlSeconds: 3600 })).json();
    const b = await (await postPaste({ text: 'one view', views: 1, ttlSeconds: 7200 })).json();

    const res = await adminList();
    expect(res.status).toBe(200);
    const page = await res.json();
    expect(Array.isArray(page.pastes)).toBe(true);
    expect(page.cursor).toBeNull(); // both fit on the first page
    const list = page.pastes;

    const ea = findIn(list, a.id);
    const eb = findIn(list, b.id);
    expect(ea).toMatchObject({ viewsTotal: 3, viewsLeft: 3, kind: 'burn', gone: false });
    expect(eb).toMatchObject({ viewsTotal: 1, viewsLeft: 1, kind: 'burn', gone: false });
    expect(ea.expiresAt - ea.createdAt).toBe(3600);
    expect(eb.expiresAt - eb.createdAt).toBe(7200);
    // Newest first: b was created after a.
    expect(list.indexOf(eb)).toBeLessThan(list.indexOf(ea));

    // Index record holds metadata only — no ct, no token hash, no key material.
    const idx = JSON.parse(await env.PASTES.get(idxKey(a.id)));
    expect(Object.keys(idx).sort()).toEqual(['createdAt', 'expiresAt', 'kind', 'viewsTotal']);

    // Peek (plain GET) must not spend a view; consume must.
    expect((await getPaste(a.id)).status).toBe(200);
    expect(findIn(await listAll(), a.id).viewsLeft).toBe(3);
    expect((await consume(a.id)).status).toBe(200);
    expect(findIn(await listAll(), a.id).viewsLeft).toBe(2);
  });

  it('list paginates: bounded pages + cursor walk covers every entry once', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const { id } = await (await postPaste({ text: `page ${i}`, views: 1, ttlSeconds: 3600 })).json();
      ids.push(id);
    }

    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const qs = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await adminList({ 'x-create-token': TOKEN }, qs);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.pastes.length).toBeLessThanOrEqual(2);
      seen.push(...data.pastes.map((p) => p.id));
      cursor = data.cursor;
      pages++;
      expect(pages).toBeLessThan(20); // cursor must terminate
    } while (cursor);

    // Every created id appears exactly once across the walk (other tests'
    // leftovers may also appear, so check our five as a set, no dupes).
    for (const id of ids) expect(seen.filter((x) => x === id)).toHaveLength(1);
    expect(new Set(seen).size).toBe(seen.length);
    expect(pages).toBeGreaterThanOrEqual(3);
  });

  it('revoke deletes the paste (410 after) and drops it from the list', async () => {
    const { id } = await (await postPaste({ text: 'revoke via admin', views: 5, ttlSeconds: 3600 })).json();
    expect(findIn(await listAll(), id)).toBeTruthy();

    const res = await adminRevoke(id);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('revoked');
    expect((await consume(id)).status).toBe(410);
    expect((await getPaste(id)).status).toBe(410);
    expect(findIn(await listAll(), id)).toBeUndefined();
    expect(await env.PASTES.get(idxKey(id))).toBeNull();

    // Second revoke: nothing left → 404. Unknown/malformed ids → 404.
    expect((await adminRevoke(id)).status).toBe(404);
    expect((await adminRevoke('b' + 'A'.repeat(22))).status).toBe(404);
    expect((await adminRevoke('zzz')).status).toBe(404);
  });

  it('gone cleanup: a burned-out paste shows gone once, then is pruned', async () => {
    const { id } = await (await postPaste({ text: 'burn out', views: 1, ttlSeconds: 3600 })).json();
    expect((await consume(id)).status).toBe(200); // last view → DO purged

    const first = findIn(await listAll(), id);
    expect(first).toMatchObject({ gone: true, viewsLeft: 0 });
    expect(await env.PASTES.get(idxKey(id))).toBeNull(); // pruned
    expect(findIn(await listAll(), id)).toBeUndefined();
  });

  it('delete via delete-token also removes the index entry', async () => {
    const { id, deletetoken } = await (await postPaste({ text: 'token delete', views: 2, ttlSeconds: 3600 })).json();
    const del = await SELF.fetch(`${ORIGIN}/api/paste/${id}`, {
      method: 'DELETE',
      headers: { 'x-delete-token': deletetoken },
    });
    expect(del.status).toBe(200);
    expect(findIn(await listAll(), id)).toBeUndefined();
  });

  it('pastes created before the index existed do not appear (expected)', async () => {
    // Simulate a pre-index paste: write straight into a DO, no idx record.
    const stub = env.BURN.get(env.BURN.idFromName('bpreindexlegacy01'));
    await stub.create(
      { v: 1, ct: 'AA', wk: 'AA', adata: {}, meta: { created: 0, ttlSeconds: 3600, views: 1 } },
      'deadbeef',
      3600,
      1,
    );
    expect(findIn(await listAll(), 'bpreindexlegacy01')).toBeUndefined();
  });

  it('method checks: POST list and GET revoke are 405', async () => {
    const post = await SELF.fetch(`${ORIGIN}/api/admin/list`, {
      method: 'POST',
      headers: { 'x-create-token': TOKEN },
    });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
    const get = await SELF.fetch(`${ORIGIN}/api/admin/revoke`, {
      headers: { 'x-create-token': TOKEN },
    });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
  });
});

describe('owner notes (plain-text labels in the admin index)', () => {
  beforeEach(async () => {
    env.CREATE_TOKEN_SHA256 = await hashToken(TOKEN);
  });
  afterEach(() => {
    delete env.CREATE_TOKEN_SHA256;
  });

  it('note sent at create is stored in the index and shown in the list', async () => {
    const res = await postPasteWithNote({ text: 'labelled', views: 2, ttlSeconds: 3600 }, '  给张三的密钥  ');
    expect(res.status).toBe(201);
    const { id } = await res.json();

    const entry = findIn(await listAll(), id);
    expect(entry.note).toBe('给张三的密钥'); // trimmed

    const idx = JSON.parse(await env.PASTES.get(idxKey(id)));
    expect(idx.note).toBe('给张三的密钥');
    // Still metadata-only apart from the deliberate plain-text note.
    expect(Object.keys(idx).sort()).toEqual(['createdAt', 'expiresAt', 'kind', 'note', 'viewsTotal']);
  });

  it('create without a note lists note as empty string', async () => {
    const { id } = await (await postPaste({ text: 'unlabelled', views: 1, ttlSeconds: 3600 })).json();
    expect(findIn(await listAll(), id).note).toBe('');
    const idx = JSON.parse(await env.PASTES.get(idxKey(id)));
    expect('note' in idx).toBe(false); // key omitted when empty
  });

  it('overlong note at create is truncated to 100 chars, not rejected', async () => {
    const long = '备'.repeat(150);
    const res = await postPasteWithNote({ text: 'long note', views: 1, ttlSeconds: 3600 }, long);
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const entry = findIn(await listAll(), id);
    expect([...entry.note]).toHaveLength(100);
    expect(entry.note).toBe('备'.repeat(100));
  });

  it('note truncation counts Unicode code points, not UTF-16 units (emoji)', async () => {
    // 😀 is one code point but two UTF-16 code units; the server cap is
    // 100 code points, so 150 emoji truncate to exactly 100 whole emoji.
    const res = await postPasteWithNote({ text: 'emoji note', views: 1, ttlSeconds: 3600 }, '😀'.repeat(150));
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const entry = findIn(await listAll(), id);
    expect([...entry.note]).toHaveLength(100);
    expect(entry.note).toBe('😀'.repeat(100));
  });

  it('non-string note at create is ignored (still 201, empty note)', async () => {
    const res = await postPasteWithNote({ text: 'odd note', views: 1, ttlSeconds: 3600 }, 42);
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect(findIn(await listAll(), id).note).toBe('');
  });

  it('admin/note requires the token (401 missing/wrong/unset) and POST', async () => {
    const { id } = await (await postPaste({ text: 'gate check', views: 1, ttlSeconds: 3600 })).json();
    expect((await adminNote(id, 'x', {})).status).toBe(401);
    expect((await adminNote(id, 'x', { 'x-create-token': 'wrong' })).status).toBe(401);
    delete env.CREATE_TOKEN_SHA256;
    expect((await adminNote(id, 'x')).status).toBe(401); // fail-closed
    env.CREATE_TOKEN_SHA256 = await hashToken(TOKEN);
    const get = await SELF.fetch(`${ORIGIN}/api/admin/note`, {
      headers: { 'x-create-token': TOKEN, 'cf-connecting-ip': ip() },
    });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
  });

  it('admin/note updates the label without touching the paste', async () => {
    const { id } = await (await postPasteWithNote({ text: 'editable', views: 2, ttlSeconds: 3600 }, '旧备注')).json();

    const res = await adminNote(id, '新备注 v2');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'updated', id, note: '新备注 v2' });
    expect(findIn(await listAll(), id).note).toBe('新备注 v2');

    // The paste itself is untouched: still readable, views intact.
    expect((await getPaste(id)).status).toBe(200);
    expect((await consume(id)).status).toBe(200);
    expect(findIn(await listAll(), id).viewsLeft).toBe(1);

    // Clearing works too, and overlong edits truncate the same way.
    expect((await adminNote(id, '   ')).status).toBe(200);
    expect(findIn(await listAll(), id).note).toBe('');
    const over = await adminNote(id, 'x'.repeat(130));
    expect(over.status).toBe(200);
    expect((await over.json()).note).toHaveLength(100);
  });

  it('admin/note near expiry (<60s left) is 409 and writes nothing', async () => {
    const { id } = await (await postPaste({ text: 'about to expire', views: 1, ttlSeconds: 3600 })).json();
    // Age the index record so the paste has <60s of lifetime left: a re-put
    // would need KV's 60s minimum TTL and outlive the paste.
    const idx = JSON.parse(await env.PASTES.get(idxKey(id)));
    idx.expiresAt = Math.floor(Date.now() / 1000) + 30;
    await env.PASTES.put(idxKey(id), JSON.stringify(idx), { expirationTtl: 3600 });

    const res = await adminNote(id, '太晚了');
    expect(res.status).toBe(409);
    const after = JSON.parse(await env.PASTES.get(idxKey(id)));
    expect(after.note).toBeUndefined(); // unchanged

    // Already-past expiry is rejected the same way.
    idx.expiresAt = Math.floor(Date.now() / 1000) - 10;
    await env.PASTES.put(idxKey(id), JSON.stringify(idx), { expirationTtl: 3600 });
    expect((await adminNote(id, '太晚了')).status).toBe(409);
  });

  it('admin/note on unknown or malformed id is 404', async () => {
    expect((await adminNote('b' + 'A'.repeat(22), 'x')).status).toBe(404);
    expect((await adminNote('zzz', 'x')).status).toBe(404);
    expect((await adminNote(123, 'x')).status).toBe(404);
  });

  it('legacy index records without a note key list as empty string', async () => {
    const { id } = await (await postPaste({ text: 'legacy idx', views: 1, ttlSeconds: 3600 })).json();
    // Rewrite the index exactly as pre-note code wrote it (no note key).
    const idx = JSON.parse(await env.PASTES.get(idxKey(id)));
    delete idx.note;
    await env.PASTES.put(idxKey(id), JSON.stringify(idx), { expirationTtl: 3600 });
    expect(findIn(await listAll(), id).note).toBe('');
    // …and such a record can still receive a note afterwards.
    expect((await adminNote(id, '补上的备注')).status).toBe(200);
    expect(findIn(await listAll(), id).note).toBe('补上的备注');
  });
});
