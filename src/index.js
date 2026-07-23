// index.js — binthere Worker entry.
//
// Serves the zero-knowledge paste API under /api/* (run_worker_first); every
// other path is handled by Workers Static Assets (the SPA frontend), so the
// Worker never sees or stores a decryption key. The server is deliberately dumb:
// it stores opaque ciphertext + non-secret metadata and enforces size, rate, and
// burn-after-read semantics. See SPEC.md §10 for the API contract.

import { validatePaste, FormatError, MAX_CT_B64 } from '../public/js/format.js';
import { genId, parseId, genDeleteToken, hashToken, verifyToken } from './lib/ids.js';
import { ttlSeconds, MAX_BODY, MAX_BURN_RECORD, kvExists, kvPut, kvGet, kvDelete, burnStub } from './lib/store.js';
import { allowCreate } from './lib/ratelimit.js';

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
  async fetch(request, env, ctx) {
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

    const mc = pathname.match(/^\/api\/paste\/([^/]+)\/consume$/);
    if (mc) {
      let id;
      try {
        id = decodeURIComponent(mc[1]);
      } catch {
        return err('Document does not exist, has expired or has been deleted.', 404);
      }
      if (request.method !== 'POST') return err('Method not allowed', 405, { allow: 'POST' });
      return consumePaste(id, request, env);
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
      if (request.method === 'GET') return readPaste(id, env, url.searchParams.get('meta') === '1');
      if (request.method === 'DELETE') return deletePaste(id, request, env);
      return err('Method not allowed', 405, { allow: 'GET, DELETE' });
    }

    return err('Not found', 404);
  },
};

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

async function createPaste(request, env, _ctx) {
  // Requiring a real JSON media type forces a CORS preflight for cross-origin
  // browser requests: a hostile page can no longer spend a visitor's creation
  // quota (or create storage objects from their network) with a "simple"
  // text/plain POST. Zero cost to both official clients — they already send it.
  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return err('Content-Type must be application/json.', 415);
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

  let clean;
  try {
    clean = validatePaste(parsed);
  } catch (e) {
    if (e instanceof FormatError) return err(e.message, 400);
    throw e;
  }

  const burn = clean.adata.bar;
  const ttl = ttlSeconds(clean.meta.expire);
  const deleteToken = genDeleteToken();
  const dth = await hashToken(deleteToken);
  const created = Math.floor(Date.now() / 1000);

  // The stored/returned paste carries meta.created but never the token hash.
  const paste = {
    v: clean.v, ct: clean.ct, wk: clean.wk, adata: clean.adata,
    meta: { expire: clean.meta.expire, created },
  };

  // Burn records live in SQLite-backed DO storage, whose ~2 MB per-value limit
  // is below what MAX_CT_B64 admits: a valid-per-format record between the two
  // caps would make storage.put throw an uncaught 500 inside the DO. Reject it
  // here with a clean 413 instead (SPEC §6). KV (25 MiB values) is unaffected.
  if (burn && JSON.stringify({ paste, dth, exp: 0 }).length > MAX_BURN_RECORD) {
    return err('Document is too large for a one-time-view paste.', 413);
  }

  // Generate an unused id (128-bit; collisions are astronomically unlikely, but
  // we still check and regenerate to be safe).
  let id;
  for (let attempt = 0; ; attempt++) {
    id = genId(burn);
    if (burn) {
      if (await burnStub(env, id).create(paste, dth, ttl)) break;
    } else {
      if (!(await kvExists(env, id))) { await kvPut(env, id, paste, dth, ttl); break; }
    }
    if (attempt >= 4) return err('Could not allocate a paste id, please retry.', 500);
  }

  return json({ id, deletetoken: deleteToken }, 201);
}

async function readPaste(id, env, peekOnly) {
  const info = parseId(id);
  if (!info) return err('Document does not exist, has expired or has been deleted.', 404);

  if (info.burn) {
    // GET on a burn id is always safe: with or without ?meta=1 it returns the
    // head (never `ct`) without consuming. Destructive consumption lives on
    // POST /api/paste/:id/consume (see consumePaste), so an ambient GET — an
    // <img> tag, a navigation prefetch, a link-scanning bot — can never destroy
    // a note whose id it happened to learn.
    const res = await burnStub(env, id).peek();
    if (res.status === 'ok') return json(res.head, 200);
    return err('This document was single-use and has already been read, or has expired.', 410);
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
async function consumePaste(id, request, env) {
  if ((request.headers.get('x-burn-intent') || '').trim().toLowerCase() !== 'consume') {
    return err('Burn consumption requires the "X-Burn-Intent: consume" header.', 400);
  }
  const site = (request.headers.get('sec-fetch-site') || '').toLowerCase();
  if (site === 'cross-site') {
    return err('Cross-site burn consumption is not allowed.', 403);
  }

  const info = parseId(id);
  if (!info) return err('Document does not exist, has expired or has been deleted.', 404);
  if (!info.burn) return err('Only one-time-view pastes can be consumed.', 404);

  const res = await burnStub(env, id).consume();
  if (res.status === 'ok') return json(res.paste, 200);
  return err('This document was single-use and has already been read, or has expired.', 410);
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
    if (res.status === 'ok') return json({ status: 'deleted', id }, 200);
    if (res.status === 'bad') return err('Wrong deletion token. Document was not deleted.', 403);
    return err('Document does not exist, has expired or has been deleted.', 404);
  }

  const rec = await kvGet(env, id);
  if (!rec) return err('Document does not exist, has expired or has been deleted.', 404);
  if (!(await verifyToken(token, rec.dth))) {
    return err('Wrong deletion token. Document was not deleted.', 403);
  }
  await kvDelete(env, id);
  return json({ status: 'deleted', id }, 200);
}
