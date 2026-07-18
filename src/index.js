// index.js — binthere Worker entry.
//
// Serves the zero-knowledge paste API under /api/* (run_worker_first); every
// other path is handled by Workers Static Assets (the SPA frontend), so the
// Worker never sees or stores a decryption key. The server is deliberately dumb:
// it stores opaque ciphertext + non-secret metadata and enforces size, rate, and
// burn-after-read semantics. See SPEC.md §10 for the API contract.

import { validatePaste, FormatError } from '../public/js/format.js';
import { genId, parseId, genDeleteToken, hashToken, verifyToken } from './lib/ids.js';
import { ttlSeconds, MAX_BODY, kvExists, kvPut, kvGet, kvDelete, burnStub } from './lib/store.js';
import { allowCreate } from './lib/ratelimit.js';

export { BurnPaste } from './burn-do.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  // _headers covers static assets; the Worker sets its own nosniff on API JSON.
  'x-content-type-options': 'nosniff',
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
const err = (message, status) => json({ error: message }, status);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // The Worker only owns the API surface; anything else is a static asset.
    if (!pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }

    if (pathname === '/api/paste' && request.method === 'POST') {
      return createPaste(request, env, ctx);
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
      return err('Method not allowed', 405);
    }

    return err('Not found', 404);
  },
};

async function createPaste(request, env, _ctx) {
  if (!(await allowCreate(env, request))) {
    return err('Rate limit exceeded. Try again shortly.', 429);
  }

  // Body-size guard before parsing (defends storage + JSON parser).
  const cl = Number(request.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > MAX_BODY) return err('Document is too large.', 413);

  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY) return err('Document is too large.', 413);

  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return err('Invalid JSON body.', 400);
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
    // Peek (?meta=1) returns the head without consuming; a plain GET consumes.
    // The client peeks first to verify a password before the single read.
    if (peekOnly) {
      const res = await burnStub(env, id).peek();
      if (res.status === 'ok') return json(res.head, 200);
      return err('This document was single-use and has already been read, or has expired.', 410);
    }
    const res = await burnStub(env, id).consume();
    if (res.status === 'ok') return json(res.paste, 200);
    return err('This document was single-use and has already been read, or has expired.', 410);
  }

  // KV reads never consume, so peekOnly is a no-op here.
  const rec = await kvGet(env, id);
  if (!rec) return err('Document does not exist, has expired or has been deleted.', 404);
  return json(rec.p, 200);
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
