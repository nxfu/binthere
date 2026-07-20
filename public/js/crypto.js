// crypto.js — binthere zero-knowledge crypto protocol (Web Crypto only).
//
// Implements SPEC.md exactly: per-paste random 256-bit CEK encrypts the paste
// with AES-256-GCM; the CEK is wrapped by a KEK derived from the URL fragment
// secret F (HKDF) combined with an optional PBKDF2-stretched password; a
// canonical AAD binds all security-relevant metadata to both GCM operations.
//
// Runs unchanged in the browser and in the workerd test runtime. All randomness
// comes from crypto.getRandomValues (via bytes.js). Never uses Math.random.

import { randomBytes, utf8, fromUtf8, b64urlFromBytes, bytesFromB64url } from './bytes.js';
import { buildAAD, validatePaste, ITER_V1 } from './format.js';

const KDF_INFO = utf8('binthere/v1 kek');
export const MAX_PLAINTEXT = 1 << 20; // 1 MiB — cap before compression and on decompression

/** Raised when a paste needs a password the caller didn't supply. */
export class PasswordRequired extends Error {
  constructor() { super('password required'); this.name = 'PasswordRequired'; }
}
/** Raised when decryption/authentication fails (wrong key/password or tampering). */
export class DecryptError extends Error {
  constructor(message = 'decryption failed') { super(message); this.name = 'DecryptError'; }
}

// ── low-level primitives (exported for test vectors) ─────────────────────────

/** Import raw 32 bytes as an AES-256-GCM CryptoKey. */
async function importAesKey(rawBytes) {
  return crypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function aesGcmEncrypt(key, iv, plaintext, aad) {
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext);
  return new Uint8Array(ct);
}

export async function aesGcmDecrypt(key, iv, ciphertext, aad) {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ciphertext);
    return new Uint8Array(pt);
  } catch {
    throw new DecryptError();
  }
}

/**
 * Derive the key-encryption key (KEK) per SPEC.md §2.
 *   pw_ikm = password ? PBKDF2-SHA256(pw, salt, iter, 32B) : ""(0 bytes)
 *   KEK    = HKDF-SHA256(ikm=F, salt=pw_ikm, info="binthere/v1 kek", 32B)
 * `usePassword` selects the branch explicitly (mirrors adata.kdf) so behavior
 * never depends on truthiness of an empty string.
 */
export async function deriveKEK(F, { usePassword, password, salt, iter }) {
  let pwIkm = new Uint8Array(0);
  if (usePassword) {
    // NFC-normalize before UTF-8 encoding (SPEC §2): "café" typed on macOS
    // (NFD) and Windows (NFC) must stretch to the same key, or the right
    // password fails across devices. ASCII passwords are unaffected.
    const pwKey = await crypto.subtle.importKey('raw', utf8(password.normalize('NFC')), { name: 'PBKDF2' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, pwKey, 256);
    pwIkm = new Uint8Array(bits);
  }
  const hkdfKey = await crypto.subtle.importKey('raw', F, { name: 'HKDF' }, false, ['deriveBits']);
  const kekBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: pwIkm, info: KDF_INFO }, hkdfKey, 256);
  return importAesKey(new Uint8Array(kekBits));
}

// ── gzip via native streams, with a hard decompression cap ───────────────────

function hasCompression() {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

async function streamThrough(stream, bytes) {
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const reader = stream.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export async function gzip(bytes) {
  return streamThrough(new CompressionStream('gzip'), bytes);
}

/**
 * Gunzip with a hard output cap (gzip-bomb defense): aborts as soon as the
 * cumulative decompressed size exceeds `maxOut`. Throws on malformed input.
 */
export async function gunzip(bytes, maxOut = MAX_PLAINTEXT) {
  const stream = new DecompressionStream('gzip');
  const writer = stream.writable.getWriter();
  // Errors surface fail-closed through the reader loop below; catch the write/
  // close promises too so a malformed input doesn't also raise an unhandled
  // rejection (the writable side rejects in parallel with the readable side).
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  writer.closed.catch(() => {});
  const reader = stream.readable.getReader();
  // reader.closed / writer.closed also reject on malformed input — parallel
  // signals of the same error the read() loop already handles; silence them.
  reader.closed.catch(() => {});
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxOut) {
        await reader.cancel().catch(() => {});
        throw new DecryptError('decompressed data too large');
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof DecryptError) throw e;
    throw new DecryptError('malformed compressed data');
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ── high-level: encrypt / decrypt a paste ────────────────────────────────────

/**
 * Encrypt a paste. Returns { body, fragment } where `body` is the format-v1
 * object to POST (server adds meta.created + delete-token hash) and `fragment`
 * is the base64url URL-fragment secret F — which MUST stay client-side.
 */
export async function encryptPaste({ text, password = '', fmt = 'plaintext', bar = false, expire = '1week' }) {
  const data = utf8(text);
  if (data.length > MAX_PLAINTEXT) throw new Error('paste too large');

  // Compress only if it helps and the API is available.
  let comp = 'none';
  let payload = data;
  if (hasCompression()) {
    const gz = await gzip(data);
    if (gz.length < data.length) { comp = 'gzip'; payload = gz; }
  }

  const CEK = randomBytes(32);
  const F = randomBytes(32);
  const ivc = randomBytes(12);
  const ivw = randomBytes(12);

  const usePassword = password.length > 0;
  const salt = usePassword ? randomBytes(16) : new Uint8Array(0);
  const iter = usePassword ? ITER_V1 : 0;

  const adata = {
    alg: 'A256GCM',
    kdf: usePassword ? 'pbkdf2-hkdf' : 'hkdf',
    iter,
    comp,
    fmt,
    bar,
    ivc: b64urlFromBytes(ivc),
    ivw: b64urlFromBytes(ivw),
    skdf: usePassword ? b64urlFromBytes(salt) : '',
  };
  const aad = buildAAD(adata);

  const kek = await deriveKEK(F, { usePassword, password, salt, iter });
  const wk = await aesGcmEncrypt(kek, ivw, CEK, aad);

  const contentKey = await importAesKey(CEK);
  const ct = await aesGcmEncrypt(contentKey, ivc, payload, aad);

  const body = {
    v: 1,
    ct: b64urlFromBytes(ct),
    wk: b64urlFromBytes(wk),
    adata,
    meta: { expire },
  };
  return { body, fragment: b64urlFromBytes(F) };
}

/**
 * Derive the content key by unwrapping the CEK from `wk` — i.e. *verify the
 * password* — WITHOUT touching the ciphertext. This is what lets a burn paste's
 * password be checked before the single, destructive read (the content `ct` is
 * only fetched, and the paste only consumed, once this succeeds). Needs just the
 * non-secret `adata` and the wrapped key `wk`.
 *
 * Throws PasswordRequired when a password is needed but absent, and DecryptError
 * on a wrong key/password, tampering, or malformed inputs.
 */
export async function deriveContentKey({ adata, wk, fragment, password = '' }) {
  let F;
  try {
    F = bytesFromB64url(fragment);
  } catch {
    throw new DecryptError('invalid key');
  }
  if (F.length !== 32) throw new DecryptError('invalid key');

  const usePassword = adata.kdf === 'pbkdf2-hkdf';
  if (usePassword && password.length === 0) throw new PasswordRequired();

  let salt, ivw, wkBytes;
  try {
    salt = usePassword ? bytesFromB64url(adata.skdf) : new Uint8Array(0);
    ivw = bytesFromB64url(adata.ivw);
    wkBytes = bytesFromB64url(wk);
  } catch {
    throw new DecryptError('invalid paste');
  }

  const aad = buildAAD(adata);
  const kek = await deriveKEK(F, { usePassword, password, salt, iter: adata.iter });
  const cek = await aesGcmDecrypt(kek, ivw, wkBytes, aad); // throws on wrong pw/tamper
  return importAesKey(cek);
}

/** Decrypt the content with an already-unwrapped CEK. Returns { text, fmt, bar }. */
export async function decryptContent({ adata, ct, cek }) {
  const aad = buildAAD(adata);
  let ctBytes, ivc;
  try {
    ctBytes = bytesFromB64url(ct);
    ivc = bytesFromB64url(adata.ivc);
  } catch {
    throw new DecryptError('invalid ciphertext');
  }
  const payload = await aesGcmDecrypt(cek, ivc, ctBytes, aad);
  const plainBytes = adata.comp === 'gzip' ? await gunzip(payload, MAX_PLAINTEXT) : payload;
  let text;
  try {
    text = fromUtf8(plainBytes);
  } catch {
    throw new DecryptError('invalid text encoding');
  }
  return { text, fmt: adata.fmt, bar: adata.bar };
}

/**
 * Decrypt a full paste in one step. `paste` is the object returned by the API,
 * `fragment` the base64url secret from the URL, `password` optional. Throws
 * PasswordRequired, DecryptError, or FormatError. For burn pastes that need a
 * password, prefer deriveContentKey (verify) → consume → decryptContent so the
 * paste is not consumed until the password is proven correct.
 */
export async function decryptPaste({ paste, fragment, password = '' }) {
  const clean = validatePaste(paste); // defense-in-depth on the client too
  const cek = await deriveContentKey({ adata: clean.adata, wk: clean.wk, fragment, password });
  return decryptContent({ adata: clean.adata, ct: clean.ct, cek });
}
