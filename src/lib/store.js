// store.js — storage layer for pastes. Normal pastes live in KV (native TTL);
// burn-after-read pastes live in the BurnPaste Durable Object (atomic consume).
// The stored delete-token hash (`dth`) is kept alongside the paste and never
// returned to a reader. See SPEC.md §7–§9.

export const MAX_BODY = 4 * 1024 * 1024; // 4 MiB request-body cap
export const PASTE_TTL_SECONDS = 86400;

// SQLite-backed Durable Object storage caps a serialized value at ~2 MB — below
// what MAX_CT_B64 (3,000,000 b64url chars) admits. Burn records are capped with
// headroom for the { paste, dth, exp } envelope so the create path can answer a
// clean 413 instead of storage.put throwing mid-create (SPEC §6). Both official
// clients stay far under this (1 MiB plaintext → ~1.4 M b64url chars).
export const MAX_BURN_RECORD = 1900000;

// ── KV (read/delete compatibility for existing v1 reusable pastes) ───────────

/** Returns { p, dth } or null. Corrupt records are treated as missing. */
export async function kvGet(env, id) {
  const raw = await env.PASTES.get(id);
  if (raw === null) return null;
  try {
    const rec = JSON.parse(raw);
    if (rec && typeof rec === 'object' && rec.p) return rec;
  } catch { /* fall through */ }
  return null;
}

export async function kvDelete(env, id) {
  await env.PASTES.delete(id);
}

// ── Admin index (custom fork) ────────────────────────────────────────────────
//
// One KV record per created paste, key `idx:<id>`, holding ONLY non-secret
// metadata { createdAt, expiresAt, viewsTotal, kind } so the owner can list
// and revoke links across devices. Never plaintext, ciphertext, keys, or
// delete tokens (not even hashes). TTL matches the paste's own TTL, so the
// index self-cleans at expiry; the admin list also prunes entries whose
// paste is already gone (consumed/revoked before expiry).
//
// The one deliberate exception is `note`: an optional owner-written label
// stored in PLAIN TEXT (owner's explicit request) so links are
// distinguishable in /admin. It is never part of the paste, the encryption,
// or the AAD — just an index field, capped at MAX_NOTE_LEN characters.

export const IDX_PREFIX = 'idx:';

export const MAX_NOTE_LEN = 100;

/**
 * Normalize an owner-supplied note: non-strings become '', whitespace is
 * trimmed, and the result is truncated (never rejected) to MAX_NOTE_LEN
 * Unicode code points so a surrogate pair is never split.
 */
export function sanitizeNote(value) {
  if (typeof value !== 'string') return '';
  return [...value.trim()].slice(0, MAX_NOTE_LEN).join('');
}

export function idxKey(id) {
  return IDX_PREFIX + id;
}

export async function idxPut(env, id, meta, ttlSec) {
  // KV expirationTtl has a 60s floor; create validation already enforces
  // MIN_TTL_SECONDS >= 60 by default, but clamp so a lower env floor can
  // never make the put throw.
  const expirationTtl = Math.max(60, Math.floor(ttlSec) || 60);
  await env.PASTES.put(idxKey(id), JSON.stringify(meta), { expirationTtl });
}

/** Returns the parsed index meta or null (missing/corrupt → null). */
export async function idxGet(env, id) {
  const raw = await env.PASTES.get(idxKey(id));
  if (raw === null) return null;
  try {
    const meta = JSON.parse(raw);
    if (meta && typeof meta === 'object') return meta;
  } catch { /* fall through */ }
  return null;
}

export async function idxDelete(env, id) {
  await env.PASTES.delete(idxKey(id));
}

/**
 * Replace the note on an existing index record (paste itself untouched).
 * Returns false when there is no index record for the id. The record is
 * re-put with its REMAINING lifetime (from the stored expiresAt), so
 * editing a note never extends the index past the paste's own expiry.
 */
export async function idxUpdateNote(env, id, note) {
  const meta = await idxGet(env, id);
  if (!meta) return false;
  if (note) meta.note = note;
  else delete meta.note;
  const now = Math.floor(Date.now() / 1000);
  const remaining = Number.isInteger(meta.expiresAt) ? meta.expiresAt - now : 60;
  await idxPut(env, id, meta, remaining);
  return true;
}

/** All index entries as [{ id, meta }]; corrupt values yield meta=null. */
export async function idxList(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.PASTES.list({ prefix: IDX_PREFIX, cursor });
    for (const key of page.keys) {
      const id = key.name.slice(IDX_PREFIX.length);
      out.push({ id, meta: await idxGet(env, id) });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

// ── Durable Object (burn-after-read pastes) ──────────────────────────────────

/** Get the BurnPaste stub for a paste id (one DO instance per id). */
export function burnStub(env, id) {
  return env.BURN.get(env.BURN.idFromName(id));
}
