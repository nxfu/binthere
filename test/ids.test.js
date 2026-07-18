// ids.test.js — paste ids, delete tokens, hashing, constant-time verification.
import { describe, it, expect } from 'vitest';
import { genId, parseId, genDeleteToken, hashToken, verifyToken } from '../src/lib/ids.js';

describe('paste ids', () => {
  it('generates class-prefixed ids of the right shape and entropy', () => {
    const k = genId(false);
    const b = genId(true);
    expect(k[0]).toBe('k');
    expect(b[0]).toBe('b');
    expect(k.length).toBe(23); // 1 prefix + 22 b64url chars (16 bytes)
    expect(parseId(k)).toEqual({ cls: 'k', burn: false });
    expect(parseId(b)).toEqual({ cls: 'b', burn: true });
  });

  it('ids are unique across many draws', () => {
    const s = new Set();
    for (let i = 0; i < 1000; i++) s.add(genId(false));
    expect(s.size).toBe(1000);
  });

  it('rejects malformed ids', () => {
    for (const bad of ['', 'x' + 'A'.repeat(22), 'k', 'kshort', 'k' + 'A'.repeat(21),
      'k' + 'A'.repeat(23), 'k' + '*'.repeat(22), 'zAAAAAAAAAAAAAAAAAAAAAA', 42, null, {}]) {
      expect(parseId(bad)).toBeNull();
    }
  });
});

describe('delete tokens', () => {
  it('generates 256-bit tokens and verifies only the correct one', async () => {
    const token = genDeleteToken();
    const stored = await hashToken(token);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyToken(token, stored)).toBe(true);
    expect(await verifyToken(genDeleteToken(), stored)).toBe(false);
  });

  it('never accepts a malformed or wrong-length token', async () => {
    const stored = await hashToken(genDeleteToken());
    for (const bad of ['', 'not-base64!!', 'AAAA', genDeleteToken().slice(0, 10), null, 12]) {
      expect(await verifyToken(bad, stored)).toBe(false);
    }
  });

  it('does not accept a raw hash echoed back as the token', async () => {
    const token = genDeleteToken();
    const stored = await hashToken(token);
    expect(await verifyToken(stored, stored)).toBe(false);
  });
});
