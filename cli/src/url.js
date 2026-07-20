// url.js — build/parse binthere share URLs: "/p/" + id + "#" + b64url(F)
// (SPEC.md §10). Parsing is strict and fail-closed: the fragment must decode to
// exactly 32 bytes (the fragment secret F) BEFORE any network request is made,
// ids must match the server's shape (SPEC.md §7), and plain http is refused
// except toward localhost (wrangler dev).
import { bytesFromB64url } from '../vendor/bytes.js';
import { UsageError } from './errors.js';

export const DEFAULT_SERVER = 'https://binthere.gaury.dev';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// classPrefix ("k" KV | "b" burn DO) + b64url(random(16)) = 22 chars — SPEC.md §7.
const ID_RE = /^[kb][A-Za-z0-9_-]{22}$/;

function parseUrl(raw, what) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`invalid ${what}: "${raw}"`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))) {
    throw new UsageError('refusing a non-HTTPS server (only localhost may use plain http)');
  }
  if (u.username || u.password) throw new UsageError(`${what} must not contain credentials`);
  return u;
}

/** Validate/normalize a server base URL (--server / BINTHERE_SERVER) → origin. */
export function normalizeServer(raw) {
  const u = parseUrl(raw, 'server URL');
  if (u.pathname !== '/' || u.search || u.hash) {
    throw new UsageError('server URL must be a bare origin (e.g. https://binthere.example.com)');
  }
  return u.origin;
}

/** Validate a paste id against the server's id shape. */
export function parseId(id) {
  if (!ID_RE.test(id)) throw new UsageError(`malformed paste id: "${id}"`);
  return id;
}

/** Burn-after-read pastes live under the "b" class prefix (SPEC.md §7). */
export function isBurnId(id) {
  return id.startsWith('b');
}

/**
 * Parse a full share URL into { server, id, fragment }. The fragment is
 * checked to b64url-decode to exactly 32 bytes before anything touches the
 * network, reusing bytesFromB64url's fail-closed behavior.
 */
export function parseShareUrl(raw) {
  const u = parseUrl(raw, 'share URL');
  const m = /^\/p\/([^/]+)$/.exec(u.pathname);
  if (!m) throw new UsageError('not a binthere share URL (expected …/p/<id>#<key>)');
  const id = parseId(m[1]);
  const fragment = u.hash.replace(/^#/, '');
  if (!fragment) {
    throw new UsageError('share URL is missing its #key fragment — the paste cannot be decrypted without it');
  }
  let key = null;
  try {
    key = bytesFromB64url(fragment);
  } catch {
    /* handled below, fail closed */
  }
  if (!key || key.length !== 32) throw new UsageError('invalid key fragment in share URL');
  return { server: u.origin, id, fragment };
}

/**
 * Accept either a share URL (fragment optional — deleting needs no key) or a
 * bare paste id resolved against `fallbackServer`. Returns { server, id }.
 */
export function parseUrlOrId(raw, fallbackServer) {
  if (/^[A-Za-z0-9_-]+$/.test(raw)) {
    return { server: normalizeServer(fallbackServer), id: parseId(raw) };
  }
  const u = parseUrl(raw, 'share URL');
  const m = /^\/p\/([^/]+)$/.exec(u.pathname);
  if (!m) throw new UsageError('not a binthere share URL or paste id');
  return { server: u.origin, id: parseId(m[1]) };
}

/** Compose the shareable URL. `F` never appears anywhere but the fragment. */
export function buildShareUrl(server, id, fragment) {
  return `${server}/p/${id}#${fragment}`;
}
