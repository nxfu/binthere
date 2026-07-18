// bytes.js — small, dependency-free byte/encoding helpers shared by the browser
// client, the Worker (bundled), and the tests. Pure: no DOM, no compression.
// Lives under public/js so the browser can import it as a static asset AND the
// Worker bundle can import it relatively. See SPEC.md for the encodings used.

const _enc = new TextEncoder();
const _dec = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 encode a string to bytes. */
export function utf8(str) {
  return _enc.encode(str);
}

/** UTF-8 decode bytes to a string (throws on invalid UTF-8). */
export function fromUtf8(bytes) {
  return _dec.decode(bytes);
}

/** CSPRNG bytes. The ONLY source of randomness for security-sensitive values. */
export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** Lowercase hex of a byte array. */
export function hex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

// ── base64url (RFC 4648 §5, unpadded) ────────────────────────────────────────

const _B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** Encode bytes to unpadded URL-safe base64. */
export function b64urlFromBytes(bytes) {
  let bin = '';
  // Chunk to avoid blowing the argument-length limit on large inputs.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode unpadded URL-safe base64 to bytes. Strict: rejects any character
 * outside the base64url alphabet and structurally-impossible lengths. Throws on
 * malformed input so callers fail closed.
 */
export function bytesFromB64url(str) {
  if (typeof str !== 'string' || !_B64URL_RE.test(str) || str.length % 4 === 1) {
    throw new Error('invalid base64url');
  }
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  let bin;
  try {
    bin = atob(b64);
  } catch {
    throw new Error('invalid base64url');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── SHA-256 ──────────────────────────────────────────────────────────────────

/** SHA-256 digest of bytes → bytes. */
async function sha256(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(d);
}

/** SHA-256 digest of bytes → lowercase hex. */
export async function sha256Hex(bytes) {
  return hex(await sha256(bytes));
}

// ── constant-time comparison ─────────────────────────────────────────────────

/**
 * Timing-safe equality for two equal-length lowercase hex strings. Returns false
 * for unequal lengths (length is not secret here — both are fixed 64-char SHA-256
 * hexes) and otherwise compares in constant time over the string length.
 */
export function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
