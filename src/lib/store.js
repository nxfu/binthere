// store.js — storage layer for pastes. Normal pastes live in KV (native TTL);
// burn-after-read pastes live in the BurnPaste Durable Object (atomic consume).
// The stored delete-token hash (`dth`) is kept alongside the paste and never
// returned to a reader. See SPEC.md §7–§9.

import { EXPIRE_SECONDS } from '../../public/js/format.js';

export const MAX_BODY = 4 * 1024 * 1024; // 4 MiB request-body cap

export function ttlSeconds(expire) {
  return EXPIRE_SECONDS[expire] ?? 0;
}

// ── KV (normal pastes) ───────────────────────────────────────────────────────

export async function kvExists(env, id) {
  return (await env.PASTES.get(id)) !== null;
}

export async function kvPut(env, id, paste, dth, ttl) {
  const opts = ttl > 0 ? { expirationTtl: ttl } : {};
  await env.PASTES.put(id, JSON.stringify({ p: paste, dth }), opts);
}

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

// ── Durable Object (burn-after-read pastes) ──────────────────────────────────

/** Get the BurnPaste stub for a paste id (one DO instance per id). */
export function burnStub(env, id) {
  return env.BURN.get(env.BURN.idFromName(id));
}
