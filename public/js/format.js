// format.js — binthere paste format v1: canonical AAD construction and strict,
// fail-closed, prototype-pollution-safe validation. Single source of truth for
// the frozen wire/storage format (SPEC.md §4, §5). Shared by the browser client
// (validates on read) and the Worker (validates on create).

import { bytesFromB64url } from './bytes.js';

export const FORMAT_VERSION = 1;

/** Expiry option → TTL seconds (0 = never). Single source of truth (SPEC.md §9). */
export const EXPIRE_SECONDS = {
  '5min': 300, '10min': 600, '1hour': 3600, '1day': 86400,
  '1week': 604800, '1month': 2592000, '1year': 31536000, 'never': 0,
};
export const EXPIRE_OPTIONS = Object.keys(EXPIRE_SECONDS);
export const FORMATS = ['plaintext', 'code', 'markdown'];
export const COMP = ['gzip', 'none'];
export const KDFS = ['hkdf', 'pbkdf2-hkdf'];

export const ITER_V1 = 310000;
export const ITER_MIN = 100000;
export const ITER_MAX = 1000000;

export const MAX_CT_B64 = 3000000; // ~2.25 MiB of ciphertext
export const MAX_WK_B64 = 128;     // wrapped CEK is 48 bytes → ~64 b64url chars

const ADATA_KEYS = ['alg', 'kdf', 'iter', 'comp', 'fmt', 'bar', 'ivc', 'ivw', 'skdf'];
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

/** Thrown for any format violation. Callers map this to HTTP 400 / a UI error. */
export class FormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FormatError';
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Reject objects carrying prototype-pollution-shaped own keys. */
function assertNoDangerousKeys(obj, where) {
  for (const k of DANGEROUS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      throw new FormatError(`illegal key "${k}" in ${where}`);
    }
  }
}

/** Exact key-set check: obj must have exactly `allowed` own keys, no more, no less. */
function assertExactKeys(obj, allowed, where) {
  assertNoDangerousKeys(obj, where);
  const keys = Object.keys(obj);
  for (const k of keys) {
    if (!allowed.includes(k)) throw new FormatError(`unknown field "${k}" in ${where}`);
  }
  for (const k of allowed) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) {
      throw new FormatError(`missing field "${k}" in ${where}`);
    }
  }
}

function b64urlByteLength(str, where) {
  try {
    return bytesFromB64url(str).length;
  } catch {
    throw new FormatError(`invalid base64url in ${where}`);
  }
}

/**
 * Build the canonical Additional Authenticated Data for a paste's adata.
 * Fixed field order, newline-terminated — never depends on JSON key order.
 * (SPEC.md §4.) Returns UTF-8 bytes.
 */
export function buildAAD(adata) {
  const lines = [
    'binthere/v1',
    'alg=' + adata.alg,
    'kdf=' + adata.kdf,
    'iter=' + adata.iter,
    'comp=' + adata.comp,
    'fmt=' + adata.fmt,
    'bar=' + (adata.bar ? '1' : '0'),
    'ivc=' + adata.ivc,
    'ivw=' + adata.ivw,
    'skdf=' + adata.skdf,
  ];
  return new TextEncoder().encode(lines.join('\n') + '\n');
}

function validateWk(wk) {
  if (typeof wk !== 'string' || wk.length === 0 || wk.length > MAX_WK_B64) {
    throw new FormatError('invalid wk');
  }
  if (b64urlByteLength(wk, 'wk') !== 48) throw new FormatError('invalid wk length');
}

/** Validate adata and return a clean, allowlisted copy. Throws FormatError. */
function validateAdata(a) {
  if (!isPlainObject(a)) throw new FormatError('adata must be an object');
  assertExactKeys(a, ADATA_KEYS, 'adata');

  if (a.alg !== 'A256GCM') throw new FormatError('unsupported alg');
  if (!KDFS.includes(a.kdf)) throw new FormatError('unsupported kdf');
  if (!COMP.includes(a.comp)) throw new FormatError('unsupported comp');
  if (!FORMATS.includes(a.fmt)) throw new FormatError('unsupported fmt');
  if (typeof a.bar !== 'boolean') throw new FormatError('bar must be boolean');

  if (!Number.isInteger(a.iter)) throw new FormatError('iter must be an integer');
  if (a.kdf === 'hkdf') {
    if (a.iter !== 0) throw new FormatError('iter must be 0 for hkdf');
  } else {
    if (a.iter < ITER_MIN || a.iter > ITER_MAX) throw new FormatError('iter out of range');
  }

  if (typeof a.ivc !== 'string' || b64urlByteLength(a.ivc, 'ivc') !== 12) {
    throw new FormatError('invalid ivc');
  }
  if (typeof a.ivw !== 'string' || b64urlByteLength(a.ivw, 'ivw') !== 12) {
    throw new FormatError('invalid ivw');
  }
  if (typeof a.skdf !== 'string') throw new FormatError('invalid skdf');
  if (a.kdf === 'pbkdf2-hkdf') {
    if (b64urlByteLength(a.skdf, 'skdf') !== 16) throw new FormatError('invalid skdf length');
  } else if (a.skdf !== '') {
    throw new FormatError('skdf must be empty for hkdf');
  }

  return {
    alg: a.alg, kdf: a.kdf, iter: a.iter, comp: a.comp, fmt: a.fmt,
    bar: a.bar, ivc: a.ivc, ivw: a.ivw, skdf: a.skdf,
  };
}

/** Validate meta and return a clean copy. Throws FormatError. */
function validateMeta(m) {
  if (!isPlainObject(m)) throw new FormatError('meta must be an object');
  assertNoDangerousKeys(m, 'meta');
  for (const k of Object.keys(m)) {
    if (k !== 'expire' && k !== 'created') throw new FormatError(`unknown field "${k}" in meta`);
  }
  if (!EXPIRE_OPTIONS.includes(m.expire)) throw new FormatError('invalid expire');
  if (Object.prototype.hasOwnProperty.call(m, 'created')) {
    if (!Number.isInteger(m.created) || m.created < 0) throw new FormatError('invalid created');
    return { expire: m.expire, created: m.created };
  }
  return { expire: m.expire };
}

/**
 * Validate a paste object against format v1 and return a freshly-built, clean
 * copy containing ONLY allowlisted fields (untrusted input is never spread into
 * the result). Throws FormatError on any violation. `meta.created` is accepted
 * when present (reads) and ignored otherwise (the server sets it on create).
 */
export function validatePaste(input) {
  if (!isPlainObject(input)) throw new FormatError('paste must be an object');
  assertExactKeys(input, ['v', 'ct', 'wk', 'adata', 'meta'], 'paste');

  if (input.v !== FORMAT_VERSION) throw new FormatError('unsupported version');

  if (typeof input.ct !== 'string' || input.ct.length === 0 || input.ct.length > MAX_CT_B64) {
    throw new FormatError('invalid ct');
  }
  b64urlByteLength(input.ct, 'ct');
  validateWk(input.wk);

  return {
    v: FORMAT_VERSION, ct: input.ct, wk: input.wk,
    adata: validateAdata(input.adata), meta: validateMeta(input.meta),
  };
}

/**
 * Validate a burn paste *head* — the non-consuming peek response (SPEC.md §8):
 * a full paste minus the ciphertext `ct`. Fail-closed like validatePaste; in
 * particular `iter` stays within [ITER_MIN, ITER_MAX], so a hostile or buggy
 * server cannot demand an absurd PBKDF2 workload before key derivation.
 */
export function validateHead(input) {
  if (!isPlainObject(input)) throw new FormatError('head must be an object');
  assertExactKeys(input, ['v', 'wk', 'adata', 'meta'], 'head');

  if (input.v !== FORMAT_VERSION) throw new FormatError('unsupported version');
  validateWk(input.wk);

  return {
    v: FORMAT_VERSION, wk: input.wk,
    adata: validateAdata(input.adata), meta: validateMeta(input.meta),
  };
}
