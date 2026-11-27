// index.js — binthere Worker entry.
//
// Serves the zero-knowledge paste API under /api/* (run_worker_first); every
// other path is handled by Workers Static Assets (the SPA frontend), so the
// Worker never sees or stores a decryption key. The server is deliberately dumb:
// it stores opaque ciphertext + non-secret metadata and enforces size, rate, and
// burn-after-read semantics. See SPEC.md §10 for the API contract.

import { recordPasteCreation, readPasteCreationCount } from './lib/statistics.js';
import { validatePaste, FormatError, MAX_CT_B64, EXPIRE_SECONDS } from '../public/js/format.js';
import { timingSafeEqualHex } from '../public/js/bytes.js';
import { genId, parseId, genDeleteToken, hashToken, verifyToken } from './lib/ids.js';
import {
  MAX_BODY, MAX_BURN_RECORD, kvGet, kvDelete, burnStub,
  idxPut, idxDelete, idxList, idxUpdateNote, sanitizeNote,
} from './lib/store.js';
import { allowCreate } from './lib/ratelimit.js';
import { readStoredStars, updateStarCount, STARS_TTL, STARS_ERROR_TTL } from './lib/stars.js';

export { BurnPaste } from './burn-do.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  // _headers covers static assets; the Worker sets its own nosniff on API JSON.
  'x-content-type-options': 'nosniff',
};

const json = (obj, status = 200, extraHeaders) => new Response(JSON.stringify(obj), {
  status, headers: extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS,
});
const err = (message, status, extraHeaders) => json({ error: message }, status, extraHeaders);

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(updateStarCount(env));
  },

  async fetch(request, env, ctx) {
    // Last-resort guard: an unexpected throw anywhere in routing or a
    // handler becomes a JSON { error } 500 instead of the runtime's bare
    // 500 page, which API clients cannot parse.
    try {
      return await route(request, env, ctx);
    } catch {
      return err('Internal error.', 500);
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;

  // The Worker only owns the API surface; anything else is a static asset.
  if (!pathname.startsWith('/api/')) {
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  }

  if (pathname === '/api/paste') {
    if (request.method === 'POST') return createPaste(request, env, ctx);
    return err('Method not allowed', 405, { allow: 'POST' });
  }

  // Owner admin (custom fork): cross-device list/revoke of created links.
  // Same token gate as creation (X-Create-Token vs CREATE_TOKEN_SHA256).
  if (pathname === '/api/admin/list') {
    if (request.method === 'GET') return adminList(request, env);
    return err('Method not allowed', 405, { allow: 'GET' });
  }

  if (pathname === '/api/admin/revoke') {
    if (request.method === 'POST') return adminRevoke(request, env);
    return err('Method not allowed', 405, { allow: 'POST' });
  }

  if (pathname === '/api/admin/note') {
    if (request.method === 'POST') return adminNote(request, env);
    return err('Method not allowed', 405, { allow: 'POST' });
  }

  if (pathname === '/api/statistics') {
    if (request.method === 'GET') return readPasteStatistics(env);
    return err('Method not allowed', 405, { allow: 'GET' });
  }

  if (pathname === '/api/stars') {
    if (request.method === 'GET') return readStars(env);
    return err('Method not allowed', 405, { allow: 'GET' });
  }

  const mc = pathname.match(/^\/api\/paste\/([^/]+)\/consume$/);
  if (mc) {
    let id;
    try {
      id = decodeURIComponent(mc[1]);
    } catch {
      return err('Document does not exist, has expired or has been deleted.', 404);
    }
    if (request.method !== 'POST') return err('Method not allowed', 405, { allow: 'POST' });
    return consumePaste(id, request, env, url.searchParams.get('ext') === '1');
  }

  const m = pathname.match(/^\/api\/paste\/([^/]+)$/);
  if (m) {
    let id;
    try {
      // Malformed percent-encoding (e.g. "%zz") must be a clean 404, not an
      // uncaught URIError → HTTP 500.
      id = decodeURIComponent(m[1]);
    } catch {
      return err('Document does not exist, has expired or has been deleted.', 404);
    }
    if (request.method === 'GET') {
      return readPaste(id, env, url.searchParams.get('meta') === '1', url.searchParams.get('ext') === '1');
    }
    if (request.method === 'DELETE') return deletePaste(id, request, env);
    return err('Method not allowed', 405, { allow: 'GET, DELETE' });
  }

  return err('Not found', 404);
}

// Read a request body while enforcing a hard byte cap, without ever buffering
// an attacker-sized payload. Returns the bytes as a Uint8Array, or null if the
// stream exceeds `max` (caller answers 413). At most `max + one chunk` is held:
// as soon as the running total crosses `max` we cancel the reader, which tells
// the runtime to stop pulling from the socket, and bail. A null/absent body
// (GET-style request with no payload) yields an empty Uint8Array, matching the
// old request.arrayBuffer() behaviour (→ empty string → JSON.parse throws → 400).
async function readCappedBody(stream, max) {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > max) {
        await reader.cancel(); // terminate the stream; stop the client uploading more
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Single allocation of the exact final size; concatenate the chunks into it.
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Env-tunable create limits (custom fork). Non-numeric / non-positive values
// fall back to the defaults so a typo'd var can never widen the limits.
function envLimit(env, name, fallback) {
  const n = Number.parseInt(env?.[name], 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Owner-only creation gate (custom fork): when CREATE_TOKEN_SHA256 (hex of
// the owner's create token) is set, POST /api/paste must present the token in
// X-Create-Token. verifyToken handles generated 256-bit b64url tokens; for
// free-form passphrases we fall back to the same SHA-256 + constant-time
// compare primitives. Unset → gate disabled (local dev). Read/consume/delete
// stay public: holding the link is the capability there.
async function tokenMatches(request, expected) {
  const presented = request.headers.get('x-create-token') || '';
  if (!presented) return false;
  if (await verifyToken(presented, expected)) return true;
  return timingSafeEqualHex(await hashToken(presented), expected);
}

async function createAuthorized(request, env) {
  const expected = String(env?.CREATE_TOKEN_SHA256 || '').trim().toLowerCase();
  if (!expected) return true;
  return tokenMatches(request, expected);
}

// Admin endpoints reuse the create-token check but FAIL CLOSED when the var
// is unset: a deployment without a gate must not expose list/revoke to the
// world just because creation is open (local dev included).
async function adminAuthorized(request, env) {
  const expected = String(env?.CREATE_TOKEN_SHA256 || '').trim().toLowerCase();
  if (!expected) return false;
  return tokenMatches(request, expected);
}

async function createPaste(request, env, ctx) {
  // Requiring a real JSON media type forces a CORS preflight for cross-origin
  // browser requests: a hostile page can no longer spend a visitor's creation
  // quota (or create storage objects from their network) with a "simple"
  // text/plain POST. Zero cost to both official clients — they already send it.
  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return err('Content-Type must be application/json.', 415);
  }

  if (!(await createAuthorized(request, env))) {
    return err('A valid create token is required.', 401);
  }

  if (!(await allowCreate(env, request))) {
    return err('Rate limit exceeded. Try again shortly.', 429);
  }

  // Body-size guard before parsing (defends storage + JSON parser).
  //
  // The Content-Length header is only an honest-client fast path: a hostile
  // client can omit it (chunked transfer) or lie, so it can reject early but
  // cannot be relied on. The authoritative cap is the streaming read below,
  // which counts bytes as they arrive and aborts the moment the running total
  // exceeds MAX_BODY — so we never buffer more than MAX_BODY + one chunk,
  // rather than materializing an attacker-sized body via request.arrayBuffer().
  const cl = Number(request.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > MAX_BODY) return err('Document is too large.', 413);

  const bytes = await readCappedBody(request.body, MAX_BODY);
  if (bytes === null) return err('Document is too large.', 413);

  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return err('Invalid JSON body.', 400);
  }

  // An oversized `ct` is a size problem, not a format one: SPEC §6 promises
  // 413, while validatePaste would report it as a 400 FormatError.
  if (parsed && typeof parsed === 'object' && typeof parsed.ct === 'string'
      && parsed.ct.length > MAX_CT_B64) {
    return err('Document is too large.', 413);
  }

  // Optional owner note (custom fork): a plain-text label for the admin
  // list, carried BESIDE the paste in the request JSON. It is extracted
  // before format validation — the frozen v1 paste shape (exact keys,
  // AAD) never sees it — and stored only in the admin index.
  let pasteInput = parsed;
  let rawNote;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    ({ note: rawNote, ...pasteInput } = parsed);
  }
  const note = sanitizeNote(rawNote);

  let clean;
  try {
    clean = validatePaste(pasteInput);
  } catch (e) {
    if (e instanceof FormatError) return err(e.message, 400);
    throw e;
  }

  // Custom lifecycle: every new paste is burn-after-read (bar) with a
  // free-form view budget and TTL. Legacy { expire } creates (CLI) map to
  // views=1 and the enum's TTL. Ranges are enforced here, server-side.
  if (!clean.adata.bar) {
    return err('New pastes must be burn-after-read.', 400);
  }
  const maxViews = envLimit(env, 'MAX_VIEWS', 1000);
  const maxTtl = envLimit(env, 'MAX_TTL_SECONDS', 2592000);
  // Effective floor is max(60, env): KV's minimum expirationTtl is 60s, so
  // a sub-60 paste would make the admin index (clamped to 60s in idxPut)
  // outlive the paste it describes.
  const minTtl = Math.max(60, envLimit(env, 'MIN_TTL_SECONDS', 60));
  const ttl = clean.meta.ttlSeconds ?? EXPIRE_SECONDS[clean.meta.expire];
  const views = clean.meta.views ?? 1;
  if (!Number.isInteger(ttl) || ttl < minTtl || ttl > maxTtl) {
    return err(`ttlSeconds must be between ${minTtl} and ${maxTtl}.`, 400);
  }
  if (!Number.isInteger(views) || views < 1 || views > maxViews) {
    return err(`views must be between 1 and ${maxViews}.`, 400);
  }

  const deleteToken = genDeleteToken();
  const dth = await hashToken(deleteToken);
  const created = Math.floor(Date.now() / 1000);

  // The stored/returned paste carries meta.created but never the token hash.
  // Server-only read fields (viewsLeft/expiresAt) are never taken from the
  // client; the DO attaches them on peek/consume only when the caller opts
  // in with ?ext=1 (legacy callers keep the exact upstream meta shape).
  // A legacy-shaped create (client meta carried only `expire`) keeps the
  // upstream stored shape { created, expire }: pre-fork clients validate
  // meta against a strict { expire, created } allowlist and would reject
  // (and, on consume, lose) a paste whose stored meta gained ttlSeconds/
  // views. The DO's exp/viewsLeft and the admin index carry the numbers
  // separately, so nothing is lost; new clients read the countdown from
  // ?ext=1's expiresAt (or created + EXPIRE_SECONDS[expire]).
  const legacyShape = clean.meta.ttlSeconds === undefined && clean.meta.views === undefined;
  const meta = legacyShape
    ? { created, expire: clean.meta.expire }
    : { created, ttlSeconds: ttl, views, ...(clean.meta.expire ? { expire: clean.meta.expire } : {}) };
  const paste = {
    v: clean.v, ct: clean.ct, wk: clean.wk, adata: clean.adata,
    meta,
  };

  // Burn records live in SQLite-backed DO storage, whose ~2 MB per-value limit
  // is below what MAX_CT_B64 admits: a valid-per-format record between the two
  // caps would make storage.put throw an uncaught 500 inside the DO. Reject it
  // here with a clean 413 instead (SPEC §6).
  if (JSON.stringify({ paste, dth, exp: 0, viewsLeft: views }).length > MAX_BURN_RECORD) {
    return err('Document is too large for a burn-after-read paste.', 413);
  }

  // New pastes always use the burn Durable Object. Legacy KV records remain
  // readable and deletable through their k-prefixed IDs.
  let id;
  for (let attempt = 0; ; attempt++) {
    id = genId();
    if (await burnStub(env, id).create(paste, dth, ttl, views)) break;
    if (attempt >= 4) return err('Could not allocate a paste id, please retry.', 500);
  }

  // Admin index (custom fork): metadata only, TTL matched to the paste.
  // Best-effort — the paste already exists in the DO, so an index write
  // failure must not fail creation; the link simply won't show in /admin.
  // The optional note is the one plain-text field (owner's request); the
  // key is omitted entirely when empty so old/new records read uniformly.
  try {
    const idxMeta = {
      createdAt: created,
      expiresAt: created + ttl,
      viewsTotal: views,
      kind: 'burn',
    };
    if (note) idxMeta.note = note;
    await idxPut(env, id, idxMeta, ttl);
  } catch { /* index is advisory; creation already succeeded */ }

  // Count only after the paste Durable Object confirms its successful write.
  // The statistics path receives neither this paste's ID nor any paste data.
  recordPasteCreation(ctx, env);

  return json({ id, deletetoken: deleteToken }, 201);
}

async function readPaste(id, env, peekOnly, extended = false) {
  const info = parseId(id);
  if (!info) return err('Document does not exist, has expired or has been deleted.', 404);

  if (info.burn) {
    // GET on a burn id is always safe: with or without ?meta=1 it returns the
    // head (never `ct`) without consuming. Destructive consumption lives on
    // POST /api/paste/:id/consume (see consumePaste), so an ambient GET — an
    // <img> tag, a navigation prefetch, a link-scanning bot — can never destroy
    // a note whose id it happened to learn.
    // `?ext=1` opts into the fork's server-attached meta fields
    // (viewsLeft/expiresAt); without it the head keeps the exact upstream
    // shape so pre-fork clients don't reject the response.
    const res = await burnStub(env, id).peek(extended);
    if (res.status === 'ok') return json(res.head, 200);
    return err('This document has used up its views, or has expired.', 410);
  }

  const rec = await kvGet(env, id);
  if (!rec) return err('Document does not exist, has expired or has been deleted.', 404);
  if (peekOnly) {
    // SPEC §10: ?meta=1 returns a head for every storage class, not just burn
    // ids — the ciphertext must not ride along on a metadata request.
    const p = rec.p;
    return json({ v: p.v, wk: p.wk, adata: p.adata, meta: p.meta }, 200);
  }
  return json(rec.p, 200);
}

// The single destructive read for burn pastes. Requiring a custom header makes
// this a CORS *non-simple* request: a cross-origin browser must preflight, the
// API sends no CORS headers, so the preflight fails and the consume never
// happens. Fetch Metadata (when the browser provides it) rejects cross-site
// senders outright as defense in depth. Non-browser clients just set the header.
async function consumePaste(id, request, env, extended = false) {
  if ((request.headers.get('x-burn-intent') || '').trim().toLowerCase() !== 'consume') {
    return err('Burn consumption requires the "X-Burn-Intent: consume" header.', 400);
  }
  const site = (request.headers.get('sec-fetch-site') || '').toLowerCase();
  if (site === 'cross-site') {
    return err('Cross-site burn consumption is not allowed.', 403);
  }

  const info = parseId(id);
  if (!info) return err('Document does not exist, has expired or has been deleted.', 404);
  if (!info.burn) return err('Only burn-after-read pastes can be consumed.', 404);

  const res = await burnStub(env, id).consume(extended);
  if (res.status === 'ok') return json(res.paste, 200);
  return err('This document has used up its views, or has expired.', 410);
}

// The repository's daily star-count snapshot for the topbar badge. Visitors
// only read KV; the scheduled handler is the sole GitHub API caller.
async function readStars(env) {
  let stars;
  try {
    stars = await readStoredStars(env);
  } catch {
    return err('Star count unavailable.', 503, { 'cache-control': `public, max-age=${STARS_ERROR_TTL}` });
  }
  if (stars === null) {
    return err('Star count has not been initialized yet.', 503, {
      'cache-control': `public, max-age=${STARS_ERROR_TTL}`,
    });
  }
  return json({ stars }, 200, { 'cache-control': `public, max-age=${STARS_TTL}` });
}

// Public, read-only aggregate. A small cache allows the sharded counter to
// remain off the hot path for page views; the deployment baseline is zero.
async function readPasteStatistics(env) {
  try {
    const totalPastes = await readPasteCreationCount(env);
    return json({
      totalPastes,
      baseline: 0,
      scope: 'successfully created pastes since statistics deployment',
    }, 200, { 'cache-control': 'public, max-age=30, s-maxage=60' });
  } catch {
    return err('Paste statistics unavailable.', 503, {
      'cache-control': 'no-store',
    });
  }
}

async function deletePaste(id, request, env) {
  // The token travels in a header, never the URL: request URLs are captured by
  // Workers Logs / observability, and the raw token must not land in logs
  // (only its SHA-256 is ever stored). See SPEC.md §10.
  const token = request.headers.get('x-delete-token');
  if (!token) return err('Missing deletion token.', 400);

  const info = parseId(id);
  if (!info) return err('Document does not exist, has expired or has been deleted.', 404);

  if (info.burn) {
    const res = await burnStub(env, id).remove(token);
    if (res.status === 'ok') {
      // Keep the admin index consistent (best-effort; list also prunes).
      try { await idxDelete(env, id); } catch { /* advisory */ }
      return json({ status: 'deleted', id }, 200);
    }
    if (res.status === 'bad') return err('Wrong deletion token. Document was not deleted.', 403);
    return err('Document does not exist, has expired or has been deleted.', 404);
  }

  const rec = await kvGet(env, id);
  if (!rec) return err('Document does not exist, has expired or has been deleted.', 404);
  if (!(await verifyToken(token, rec.dth))) {
    return err('Wrong deletion token. Document was not deleted.', 403);
  }
  await kvDelete(env, id);
  try { await idxDelete(env, id); } catch { /* advisory */ }
  return json({ status: 'deleted', id }, 200);
}

// ── Owner admin (custom fork) ────────────────────────────────────────────────
//
// Cross-device link management for the owner. Auth = the create token
// (X-Create-Token vs CREATE_TOKEN_SHA256), fail-closed when unset, plus the
// same per-IP rate limit as creation. The list is built from KV `idx:`
// records (metadata only), one bounded page per request (cursor
// pagination); burn pastes are peeked (never consumed) for the live
// remaining-view count. Entries whose paste is already gone are reported
// once with gone:true and their index record is pruned.

async function adminList(request, env) {
  if (!(await adminAuthorized(request, env))) {
    return err('A valid create token is required.', 401);
  }
  if (!(await allowCreate(env, request))) {
    return err('Rate limit exceeded. Try again shortly.', 429);
  }

  // Bounded page + continuation cursor (KV list cursor, opaque to the
  // client): each request lists/reads/peeks at most `limit` entries, so
  // it stays inside the per-request KV operation budget however many
  // links exist. The admin page follows the cursor until it is null.
  const params = new URL(request.url).searchParams;
  const rawLimit = Number(params.get('limit'));
  const cursorParam = params.get('cursor') || undefined;
  let entries, cursor;
  try {
    ({ entries, cursor } = await idxList(env, {
      cursor: cursorParam,
      limit: Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : undefined,
    }));
  } catch (e) {
    // KV rejects a malformed/foreign cursor by throwing; that is the
    // client's error (400), not a server fault. A failure with no
    // cursor supplied is a real storage error → top-level 500.
    if (cursorParam !== undefined) return err('Invalid cursor.', 400);
    throw e;
  }
  const pastes = [];
  for (const { id, meta } of entries) {
    const base = {
      id,
      createdAt: Number.isInteger(meta?.createdAt) ? meta.createdAt : 0,
      expiresAt: Number.isInteger(meta?.expiresAt) ? meta.expiresAt : 0,
      viewsTotal: Number.isInteger(meta?.viewsTotal) ? meta.viewsTotal : 0,
      kind: meta?.kind === 'kv' ? 'kv' : 'burn',
      // Owner label, plain text by design. Records written before notes
      // existed have no key → ''.
      note: typeof meta?.note === 'string' ? meta.note : '',
    };
    try {
      const info = parseId(id);
      if (!info || !meta) {
        // Corrupt/foreign index record: report gone once and prune it.
        try { await idxDelete(env, id); } catch { /* advisory */ }
        pastes.push({ ...base, viewsLeft: 0, gone: true });
        continue;
      }
      if (info.burn) {
        const res = await burnStub(env, id).peek(true);
        if (res.status === 'ok') {
          pastes.push({ ...base, viewsLeft: res.head.meta.viewsLeft, gone: false });
        } else {
          try { await idxDelete(env, id); } catch { /* advisory */ }
          pastes.push({ ...base, viewsLeft: 0, gone: true });
        }
      } else {
        // Legacy KV pastes are reusable (reads don't spend views).
        const rec = await kvGet(env, id);
        if (rec) {
          pastes.push({ ...base, viewsLeft: base.viewsTotal, gone: false });
        } else {
          try { await idxDelete(env, id); } catch { /* advisory */ }
          pastes.push({ ...base, viewsLeft: 0, gone: true });
        }
      }
    } catch {
      // One bad entry (transient DO/KV error, corrupt record) must not
      // sink the whole page. Report it gone for this response but do
      // NOT prune its index: the failure may be transient, and a later
      // list will re-check it.
      pastes.push({ ...base, viewsLeft: 0, gone: true });
    }
  }
  // Newest first within the page; same-second creates fall back to later
  // expiry, then id, so the order is deterministic. (The admin page
  // re-sorts the accumulated pages with the same comparator.)
  pastes.sort((a, b) => (b.createdAt - a.createdAt)
    || (b.expiresAt - a.expiresAt)
    || (a.id < b.id ? -1 : 1));
  return json({ pastes, cursor }, 200);
}

async function adminRevoke(request, env) {
  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return err('Content-Type must be application/json.', 415);
  }
  if (!(await adminAuthorized(request, env))) {
    return err('A valid create token is required.', 401);
  }
  if (!(await allowCreate(env, request))) {
    return err('Rate limit exceeded. Try again shortly.', 429);
  }

  const bytes = await readCappedBody(request.body, MAX_BODY);
  if (bytes === null) return err('Document is too large.', 413);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return err('Invalid JSON body.', 400);
  }
  const id = parsed && typeof parsed === 'object' ? parsed.id : null;
  const info = typeof id === 'string' ? parseId(id) : null;
  if (!info) return err('Document does not exist, has expired or has been deleted.', 404);

  let existed = false;
  if (info.burn) {
    const res = await burnStub(env, id).destroy();
    existed = res.status === 'ok';
  } else {
    existed = (await kvGet(env, id)) !== null;
    if (existed) await kvDelete(env, id);
  }
  // Always drop the index record; a paste that was already gone is a 404
  // (the revoke goal is met, but there was nothing left to revoke).
  try { await idxDelete(env, id); } catch { /* advisory */ }
  if (!existed) return err('Document does not exist, has expired or has been deleted.', 404);
  return json({ status: 'revoked', id }, 200);
}

// Set/replace the plain-text owner note on one index record. Writes ONLY
// the `idx:` record — the paste itself is peeked (never consumed) purely
// as a liveness check, so a note edit can never spend a view. Same gate
// and rate limit as the other admin endpoints; unknown id (no index
// record, or paste already gone) is a 404.
async function adminNote(request, env) {
  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return err('Content-Type must be application/json.', 415);
  }
  if (!(await adminAuthorized(request, env))) {
    return err('A valid create token is required.', 401);
  }
  if (!(await allowCreate(env, request))) {
    return err('Rate limit exceeded. Try again shortly.', 429);
  }

  const bytes = await readCappedBody(request.body, MAX_BODY);
  if (bytes === null) return err('Document is too large.', 413);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return err('Invalid JSON body.', 400);
  }
  const id = parsed && typeof parsed === 'object' ? parsed.id : null;
  const info = typeof id === 'string' ? parseId(id) : null;
  if (!info) {
    return err('Document does not exist, has expired or has been deleted.', 404);
  }
  // Liveness check before touching the index: if the paste is already
  // gone (consumed/revoked/expired) but its index record survived, a
  // note edit must not keep or resurrect it — prune the index and 404.
  // peek never consumes, so this cannot spend a view. (A revoke landing
  // in the peek→put gap can still resurrect the record; the next list
  // prunes it — DO and KV offer no cross-store atomicity.)
  const alive = info.burn
    ? (await burnStub(env, id).peek(false)).status === 'ok'
    : (await kvGet(env, id)) !== null;
  if (!alive) {
    try { await idxDelete(env, id); } catch { /* advisory */ }
    return err('Document does not exist, has expired or has been deleted.', 404);
  }
  const note = sanitizeNote(parsed.note);
  const updated = await idxUpdateNote(env, id, note);
  if (updated === 'notfound') {
    return err('Document does not exist, has expired or has been deleted.', 404);
  }
  if (updated === 'expiring') {
    return err('This link expires in under a minute; its note can no longer be edited.', 409);
  }
  return json({ status: 'updated', id, note }, 200);
}
