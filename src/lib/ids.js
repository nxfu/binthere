// ids.js — server-side identifier and delete-token handling (SPEC.md §7).
// Paste IDs carry 128 bits of CSPRNG entropy plus a 1-char storage-class prefix
// (k=KV, b=burn). Delete tokens carry 256 bits; the server stores only their
// SHA-256 and verifies in constant time. Imports the shared byte helpers.

import {
  randomBytes, b64urlFromBytes, bytesFromB64url, utf8, sha256Hex, timingSafeEqualHex,
} from '../../public/js/bytes.js';

const CLASS_KV = 'k';
const CLASS_BURN = 'b';
const ID_RANDOM_BYTES = 16;   // 128-bit entropy
const ID_B64_LEN = 22;        // b64url length of 16 bytes (unpadded)
const TOKEN_BYTES = 32;       // 256-bit delete token

/** Generate a paste id: class prefix + base64url(16 CSPRNG bytes). */
export function genId(isBurn) {
  return (isBurn ? CLASS_BURN : CLASS_KV) + b64urlFromBytes(randomBytes(ID_RANDOM_BYTES));
}

/**
 * Parse/validate a paste id. Returns { cls: 'k'|'b', burn: boolean } or null if
 * the id is malformed (wrong prefix, wrong length, non-16-byte body). Callers
 * treat null as 404 — the read path also uses `cls` to pick the storage backend.
 */
export function parseId(id) {
  if (typeof id !== 'string' || id.length !== ID_B64_LEN + 1) return null;
  const cls = id[0];
  if (cls !== CLASS_KV && cls !== CLASS_BURN) return null;
  const body = id.slice(1);
  try {
    if (bytesFromB64url(body).length !== ID_RANDOM_BYTES) return null;
  } catch {
    return null;
  }
  return { cls, burn: cls === CLASS_BURN };
}

/** Generate a 256-bit delete token as base64url. */
export function genDeleteToken() {
  return b64urlFromBytes(randomBytes(TOKEN_BYTES));
}

/** SHA-256 (hex) of a delete-token string — the only form stored server-side. */
export function hashToken(token) {
  return sha256Hex(utf8(token));
}

/**
 * Constant-time verification of a presented delete token against a stored hash.
 * Validates the token's encoding/length first, then compares fixed-length hex
 * hashes in constant time. Returns false on any malformed input (fail closed).
 */
export async function verifyToken(presented, storedHashHex) {
  if (typeof presented !== 'string' || typeof storedHashHex !== 'string') return false;
  try {
    if (bytesFromB64url(presented).length !== TOKEN_BYTES) return false;
  } catch {
    return false;
  }
  const h = await hashToken(presented);
  return timingSafeEqualHex(h, storedHashHex);
}
