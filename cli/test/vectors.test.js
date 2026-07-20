// vectors.test.js — the Phase-1 gate: the frozen SPEC.md §11 vectors, run in
// PLAIN NODE against the vendored modules. The pinned hex values are identical
// to test/crypto.test.js (which runs in workerd); passing here proves Node's
// WebCrypto reproduces the protocol byte-for-byte, so the CLI is a conforming
// second client. Round-trips additionally exercise Node's CompressionStream.
import { describe, it, expect } from 'vitest';
import {
  encryptPaste, decryptPaste, deriveContentKey, decryptContent,
  deriveKEK, aesGcmEncrypt, aesGcmDecrypt,
  PasswordRequired, DecryptError,
} from '../vendor/crypto.js';
import { buildAAD, validatePaste } from '../vendor/format.js';
import { hex, b64urlFromBytes, utf8, fromUtf8 } from '../vendor/bytes.js';

const seq = (start, n) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);
const fill = (v, n) => new Uint8Array(n).fill(v);
const unhex = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));

// ── Fixed inputs shared by the frozen vectors (SPEC.md §11) ──────────────────
const F = seq(0, 32);
const CEK = seq(0x20, 32);
const ivc = fill(0x11, 12);
const ivw = fill(0x22, 12);
const salt = fill(0x33, 16);
const VEC_PLAINTEXT = 'binthere vector — zero knowledge ✓';

// FROZEN vectors — same pinned values as test/crypto.test.js. Never hand-edit;
// regenerate with test/genvectors.mjs only alongside a SPEC.md change.
const VECTORS = {
  nopw: {
    adata: { alg: 'A256GCM', kdf: 'hkdf', iter: 0, comp: 'none', fmt: 'plaintext', bar: false,
             ivc: b64urlFromBytes(ivc), ivw: b64urlFromBytes(ivw), skdf: '' },
    usePassword: false, password: '', iter: 0,
    aadHex: '62696e74686572652f76310a616c673d4132353647434d0a6b64663d686b64660a697465723d300a636f6d703d6e6f6e650a666d743d706c61696e746578740a6261723d300a6976633d455245524552455245524552455245520a6976773d496949694969496949694969496949690a736b64663d0a',
    wkHex: '07adc270949ba48117e0553655023ae11d326766c13f9dc06b05a69085f5306bd0de61efac880cc08a63ac800daf2a39',
    ctHex: '51541cd10292619073e3adbab99d55c8839d57470ec512ba5d5edc785ab314316870323b42928ccf3cf019e7d978e06397fe19127efa',
  },
  pw: {
    adata: { alg: 'A256GCM', kdf: 'pbkdf2-hkdf', iter: 310000, comp: 'none', fmt: 'plaintext', bar: false,
             ivc: b64urlFromBytes(ivc), ivw: b64urlFromBytes(ivw), skdf: b64urlFromBytes(salt) },
    usePassword: true, password: 'correct horse', iter: 310000,
    aadHex: '62696e74686572652f76310a616c673d4132353647434d0a6b64663d70626b6466322d686b64660a697465723d3331303030300a636f6d703d6e6f6e650a666d743d706c61696e746578740a6261723d300a6976633d455245524552455245524552455245520a6976773d496949694969496949694969496949690a736b64663d4d7a4d7a4d7a4d7a4d7a4d7a4d7a4d7a4d7a4d7a4d770a',
    wkHex: '7e725b2ac4e6e87e6611414186d6ae345f1350d6ab29a669d358009ea80c7b7e8b91f5bafd77d958339c236cd3aaa8a1',
    ctHex: '51541cd10292619073e3adbab99d55c8839d57470ec512ba5d5edc785ab314316870323b42926928351131f61f1f667f678bf05521e4',
  },
};

describe('frozen test vectors (plain Node, vendored modules)', () => {
  for (const [name, v] of Object.entries(VECTORS)) {
    it(`${name}: canonical AAD matches`, () => {
      expect(hex(buildAAD(v.adata))).toBe(v.aadHex);
    });
    it(`${name}: CEK wrap matches and unwraps`, async () => {
      const aad = buildAAD(v.adata);
      const kek = await deriveKEK(F, { usePassword: v.usePassword, password: v.password, salt, iter: v.iter });
      const wk = await aesGcmEncrypt(kek, ivw, CEK, aad);
      expect(hex(wk)).toBe(v.wkHex);
      expect(hex(await aesGcmDecrypt(kek, ivw, wk, aad))).toBe(hex(CEK));
    });
    it(`${name}: content ciphertext matches and decrypts`, async () => {
      const aad = buildAAD(v.adata);
      const key = await crypto.subtle.importKey('raw', CEK, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      const ct = await aesGcmEncrypt(key, ivc, utf8(VEC_PLAINTEXT), aad);
      expect(hex(ct)).toBe(v.ctHex);
      expect(fromUtf8(await aesGcmDecrypt(key, ivc, unhex(v.ctHex), aad))).toBe(VEC_PLAINTEXT);
    });
  }

  it('pw: wrong password / F alone / password alone all fail', async () => {
    const v = VECTORS.pw;
    const aad = buildAAD(v.adata);
    const wk = unhex(v.wkHex);
    for (const [pw, frag] of [['wrong horse', F], ['', F], [v.password, fill(0x99, 32)]]) {
      const usePassword = pw.length > 0;
      const kek = await deriveKEK(frag, { usePassword, password: pw, salt, iter: usePassword ? v.iter : 0 });
      await expect(aesGcmDecrypt(kek, ivw, wk, aad)).rejects.toBeInstanceOf(DecryptError);
    }
  });
});

describe('round-trips in Node (gzip via native CompressionStream)', () => {
  it('no-password paste round-trips and emits a valid format-v1 body', async () => {
    const text = 'hello from the CLI runtime';
    const { body, fragment } = await encryptPaste({ text });
    expect(() => validatePaste(body)).not.toThrow();
    expect((await decryptPaste({ paste: body, fragment })).text).toBe(text);
  });

  it('compressible content takes the gzip path and round-trips', async () => {
    const text = 'z'.repeat(50000);
    const { body, fragment } = await encryptPaste({ text });
    expect(body.adata.comp).toBe('gzip');
    expect((await decryptPaste({ paste: body, fragment })).text).toBe(text);
  });

  it('password paste verifies via deriveContentKey before content decryption', async () => {
    const { body, fragment } = await encryptPaste({ text: 'burn me safely', password: 'pw', bar: true });
    await expect(deriveContentKey({ adata: body.adata, wk: body.wk, fragment }))
      .rejects.toBeInstanceOf(PasswordRequired);
    await expect(deriveContentKey({ adata: body.adata, wk: body.wk, fragment, password: 'nope' }))
      .rejects.toBeInstanceOf(DecryptError);
    const cek = await deriveContentKey({ adata: body.adata, wk: body.wk, fragment, password: 'pw' });
    expect((await decryptContent({ adata: body.adata, ct: body.ct, cek })).text).toBe('burn me safely');
  });
});
