// url.test.js — share-URL parsing/building and server normalization. All
// parsing must fail closed BEFORE any network activity (a bad fragment or a
// non-HTTPS server is rejected at parse time).
import { describe, it, expect } from 'vitest';
import { b64urlFromBytes } from '../vendor/bytes.js';
import { UsageError } from '../src/errors.js';
import {
  buildShareUrl, isBurnId, normalizeServer, parseShareUrl, parseUrlOrId,
} from '../src/url.js';

const FRAG = b64urlFromBytes(new Uint8Array(32).fill(7)); // 32 bytes → valid F
const KID = 'k' + b64urlFromBytes(new Uint8Array(16).fill(1)); // 22-char b64url
const BID = 'b' + b64urlFromBytes(new Uint8Array(16).fill(2));

describe('parseShareUrl', () => {
  it('parses a valid https share URL', () => {
    const parsed = parseShareUrl(`https://binthere.example.com/p/${KID}#${FRAG}`);
    expect(parsed).toEqual({ server: 'https://binthere.example.com', id: KID, fragment: FRAG });
  });

  it('allows http for localhost (wrangler dev) only', () => {
    expect(parseShareUrl(`http://localhost:8787/p/${KID}#${FRAG}`).server).toBe('http://localhost:8787');
    expect(parseShareUrl(`http://127.0.0.1:8787/p/${BID}#${FRAG}`).id).toBe(BID);
    expect(() => parseShareUrl(`http://binthere.example.com/p/${KID}#${FRAG}`)).toThrow(UsageError);
  });

  it('rejects a missing or short fragment before any network use', () => {
    expect(() => parseShareUrl(`https://x.example/p/${KID}`)).toThrow(/fragment/);
    expect(() => parseShareUrl(`https://x.example/p/${KID}#`)).toThrow(/fragment/);
    const short = b64urlFromBytes(new Uint8Array(16)); // 16 bytes ≠ 32
    expect(() => parseShareUrl(`https://x.example/p/${KID}#${short}`)).toThrow(/invalid key/);
    expect(() => parseShareUrl(`https://x.example/p/${KID}#not!base64url`)).toThrow(/invalid key/);
  });

  it('rejects malformed ids and non-share paths', () => {
    expect(() => parseShareUrl(`https://x.example/p/xyz#${FRAG}`)).toThrow(/malformed paste id/);
    expect(() => parseShareUrl(`https://x.example/q/${KID}#${FRAG}`)).toThrow(/share URL/);
    expect(() => parseShareUrl('not a url')).toThrow(UsageError);
  });

  it('rejects URLs with embedded credentials', () => {
    expect(() => parseShareUrl(`https://user:pw@x.example/p/${KID}#${FRAG}`)).toThrow(/credentials/);
  });
});

describe('buildShareUrl / isBurnId', () => {
  it('round-trips through parseShareUrl', () => {
    const url = buildShareUrl('https://x.example', BID, FRAG);
    expect(url).toBe(`https://x.example/p/${BID}#${FRAG}`);
    expect(parseShareUrl(url)).toEqual({ server: 'https://x.example', id: BID, fragment: FRAG });
  });

  it('classifies burn ids by their class prefix', () => {
    expect(isBurnId(BID)).toBe(true);
    expect(isBurnId(KID)).toBe(false);
  });
});

describe('normalizeServer', () => {
  it('normalizes to a bare origin', () => {
    expect(normalizeServer('https://binthere.example.com')).toBe('https://binthere.example.com');
    expect(normalizeServer('https://binthere.example.com/')).toBe('https://binthere.example.com');
    expect(normalizeServer('http://localhost:8787')).toBe('http://localhost:8787');
  });

  it('rejects http (non-local), paths, queries, and junk', () => {
    expect(() => normalizeServer('http://binthere.example.com')).toThrow(/non-HTTPS/);
    expect(() => normalizeServer('https://x.example/api')).toThrow(/bare origin/);
    expect(() => normalizeServer('https://x.example/?a=1')).toThrow(/bare origin/);
    expect(() => normalizeServer('nonsense')).toThrow(UsageError);
  });
});

describe('parseUrlOrId', () => {
  it('accepts a bare id with a fallback server', () => {
    expect(parseUrlOrId(KID, 'https://fallback.example')).toEqual({
      server: 'https://fallback.example', id: KID,
    });
  });

  it('accepts a share URL with or without its fragment', () => {
    expect(parseUrlOrId(`https://x.example/p/${BID}#${FRAG}`, 'https://fallback.example')).toEqual({
      server: 'https://x.example', id: BID,
    });
    expect(parseUrlOrId(`https://x.example/p/${BID}`, 'https://fallback.example')).toEqual({
      server: 'https://x.example', id: BID,
    });
  });

  it('rejects malformed ids', () => {
    expect(() => parseUrlOrId('nope', 'https://fallback.example')).toThrow(/malformed paste id/);
  });
});
