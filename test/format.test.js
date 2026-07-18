// format.test.js — adversarial, fail-closed validation of paste format v1
// (SPEC.md §5.3). Every malformed shape must be rejected with FormatError.
import { describe, it, expect } from 'vitest';
import { validatePaste, validateHead, buildAAD, FormatError, MAX_CT_B64 } from '../public/js/format.js';
import { b64urlFromBytes } from '../public/js/bytes.js';

const fill = (v, n) => new Uint8Array(n).fill(v);
const addOwn = (obj, key, val) =>
  (Object.defineProperty(obj, key, { value: val, enumerable: true, writable: true, configurable: true }), obj);

// A canonical, valid no-password paste. Deep-cloned per test before mutation.
const base = () => structuredClone({
  v: 1,
  ct: b64urlFromBytes(fill(1, 40)),
  wk: b64urlFromBytes(fill(2, 48)),
  adata: {
    alg: 'A256GCM', kdf: 'hkdf', iter: 0, comp: 'none', fmt: 'plaintext', bar: false,
    ivc: b64urlFromBytes(fill(3, 12)), ivw: b64urlFromBytes(fill(4, 12)), skdf: '',
  },
  meta: { expire: '1week' },
});
const pwBase = () => {
  const p = base();
  p.adata.kdf = 'pbkdf2-hkdf';
  p.adata.iter = 310000;
  p.adata.skdf = b64urlFromBytes(fill(5, 16));
  return p;
};
const reject = (p) => expect(() => validatePaste(p)).toThrow(FormatError);

describe('valid pastes pass and round-trip cleanly', () => {
  it('accepts a canonical no-password paste', () => {
    expect(() => validatePaste(base())).not.toThrow();
  });
  it('accepts a canonical password paste', () => {
    expect(() => validatePaste(pwBase())).not.toThrow();
  });
  it('accepts an optional integer meta.created (read shape)', () => {
    const p = base(); p.meta.created = 1700000000;
    expect(validatePaste(p).meta.created).toBe(1700000000);
  });
  it('returns only allowlisted fields', () => {
    const clean = validatePaste(base());
    expect(Object.keys(clean).sort()).toEqual(['adata', 'ct', 'meta', 'v', 'wk']);
    expect(Object.keys(clean.adata).sort()).toEqual(
      ['alg', 'bar', 'comp', 'fmt', 'ivc', 'ivw', 'iter', 'kdf', 'skdf'].sort());
  });
});

describe('structural rejection', () => {
  it('rejects non-objects', () => {
    for (const v of [null, undefined, 42, 'str', [], true]) reject(v);
  });
  it('rejects missing top-level fields', () => {
    for (const k of ['v', 'ct', 'wk', 'adata', 'meta']) {
      const p = base(); delete p[k]; reject(p);
    }
  });
  it('rejects unknown top-level fields', () => {
    const p = base(); p.extra = 1; reject(p);
  });
  it('rejects unknown adata fields', () => {
    const p = base(); p.adata.extra = 1; reject(p);
  });
  it('rejects missing adata fields', () => {
    for (const k of ['alg', 'kdf', 'iter', 'comp', 'fmt', 'bar', 'ivc', 'ivw', 'skdf']) {
      const p = base(); delete p.adata[k]; reject(p);
    }
  });
});

describe('version / algorithm / kdf', () => {
  it('rejects unsupported versions', () => { for (const v of [0, 2, '1', 1.5]) { const p = base(); p.v = v; reject(p); } });
  it('rejects unsupported alg', () => { const p = base(); p.adata.alg = 'AES-CBC'; reject(p); });
  it('rejects unsupported kdf', () => { const p = base(); p.adata.kdf = 'scrypt'; reject(p); });
  it('rejects unsupported comp', () => { const p = base(); p.adata.comp = 'brotli'; reject(p); });
  it('rejects unsupported fmt', () => { const p = base(); p.adata.fmt = 'html'; reject(p); });
});

describe('type checks', () => {
  it('rejects wrong types for ct/wk/bar/iter', () => {
    let p = base(); p.ct = 123; reject(p);
    p = base(); p.wk = null; reject(p);
    p = base(); p.adata.bar = 'true'; reject(p);
    p = base(); p.adata.iter = '0'; reject(p);
    p = base(); p.adata.iter = 1.5; reject(p);
  });
});

describe('base64url / length constraints', () => {
  it('rejects malformed base64url in ct/wk/ivc', () => {
    let p = base(); p.ct = 'not base64!!'; reject(p);
    p = base(); p.wk = '****'; reject(p);
    p = base(); p.adata.ivc = '@@@@'; reject(p);
  });
  it('rejects empty ct/wk', () => {
    let p = base(); p.ct = ''; reject(p);
    p = base(); p.wk = ''; reject(p);
  });
  it('rejects oversized ct', () => {
    const p = base(); p.ct = 'A'.repeat(MAX_CT_B64 + 4); reject(p);
  });
  it('rejects wrong wk length (must be 48 bytes)', () => {
    const p = base(); p.wk = b64urlFromBytes(fill(2, 47)); reject(p);
  });
  it('rejects wrong IV lengths (must be 12 bytes)', () => {
    let p = base(); p.adata.ivc = b64urlFromBytes(fill(3, 11)); reject(p);
    p = base(); p.adata.ivw = b64urlFromBytes(fill(4, 13)); reject(p);
  });
});

describe('iteration-count and salt coherence', () => {
  it('rejects nonzero iter on hkdf', () => { const p = base(); p.adata.iter = 310000; reject(p); });
  it('rejects zero/low/high iter on pbkdf2-hkdf', () => {
    for (const iter of [0, 99999, 1000001]) { const p = pwBase(); p.adata.iter = iter; reject(p); }
  });
  it('rejects nonempty skdf on hkdf', () => { const p = base(); p.adata.skdf = b64urlFromBytes(fill(5, 16)); reject(p); });
  it('rejects empty skdf on pbkdf2-hkdf', () => { const p = pwBase(); p.adata.skdf = ''; reject(p); });
  it('rejects wrong salt length on pbkdf2-hkdf', () => { const p = pwBase(); p.adata.skdf = b64urlFromBytes(fill(5, 15)); reject(p); });
});

describe('meta', () => {
  it('rejects invalid expire', () => { const p = base(); p.meta.expire = '2week'; reject(p); });
  it('rejects unknown meta fields', () => { const p = base(); p.meta.evil = 1; reject(p); });
  it('rejects non-integer/negative created', () => {
    let p = base(); p.meta.created = 1.5; reject(p);
    p = base(); p.meta.created = -1; reject(p);
  });
});

describe('prototype pollution safety', () => {
  it('rejects dangerous own keys at every level', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      reject(addOwn(base(), key, { polluted: true }));
      { const p = base(); addOwn(p.adata, key, 1); reject(p); }
      { const p = base(); addOwn(p.meta, key, 1); reject(p); }
    }
  });
  it('rejects a JSON.parse-shaped pollution payload without polluting Object', () => {
    const payload = JSON.parse(
      '{"v":1,"ct":"AAAA","wk":"AAAA","adata":{},"meta":{},"__proto__":{"admin":true}}');
    reject(payload);
    expect({}.admin).toBeUndefined();
  });
});

describe('burn-peek head validation (SPEC.md §8)', () => {
  const head = (p = pwBase()) => { delete p.ct; p.meta.created = 1700000000; return p; };
  const rejectHead = (h) => expect(() => validateHead(h)).toThrow(FormatError);

  it('accepts a canonical head (paste minus ct)', () => {
    const clean = validateHead(head());
    expect(Object.keys(clean).sort()).toEqual(['adata', 'meta', 'v', 'wk']);
  });
  it('rejects a head that still carries ciphertext', () => {
    const h = head(); h.ct = 'AAAA'; rejectHead(h);
  });
  it('rejects an absurd PBKDF2 workload before any key derivation', () => {
    const h = head(); h.adata.iter = 1e9; rejectHead(h);
  });
  it('rejects non-objects, bad wk, and pollution-shaped keys', () => {
    for (const v of [null, 42, 'str', []]) rejectHead(v);
    let h = head(); h.wk = b64urlFromBytes(fill(2, 47)); rejectHead(h);
    h = head(); addOwn(h.adata, '__proto__', 1); rejectHead(h);
  });
});

describe('canonical AAD', () => {
  it('is byte-stable regardless of adata key insertion order', () => {
    const a1 = { alg: 'A256GCM', kdf: 'hkdf', iter: 0, comp: 'none', fmt: 'plaintext', bar: false, ivc: 'AAAA', ivw: 'BBBB', skdf: '' };
    const a2 = { skdf: '', ivw: 'BBBB', ivc: 'AAAA', bar: false, fmt: 'plaintext', comp: 'none', iter: 0, kdf: 'hkdf', alg: 'A256GCM' };
    expect(Array.from(buildAAD(a1))).toEqual(Array.from(buildAAD(a2)));
  });
});
