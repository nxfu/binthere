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

// ── Durable Object (burn-after-read pastes) ──────────────────────────────────

/** Get the BurnPaste stub for a paste id (one DO instance per id). */
export function burnStub(env, id) {
  return env.BURN.get(env.BURN.idFromName(id));
}
