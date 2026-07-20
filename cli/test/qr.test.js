// qr.test.js — the terminal QR renderer wraps the vendored qrcode.cjs and must
// fail soft (null), never throw: the QR is decoration, the URL is the product.
import { describe, it, expect } from 'vitest';
import { renderQr, renderQrCompact } from '../src/qr.js';

describe('renderQr', () => {
  it('renders a realistic share URL as compact half-block output', () => {
    const url = 'https://binthere.pages.dev/p/bAAAAAAAAAAAAAAAAAAAAAA#'
      + 'B'.repeat(43);
    const qr = renderQr(url);
    expect(qr).toBeTypeOf('string');
    expect(qr.length).toBeGreaterThan(0);
    expect(qr).toMatch(/[▀▄█]/);
    // Every line has the same width, and error correction L keeps a share URL
    // small enough for a default terminal (< 50 columns).
    const lines = qr.trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(10);
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
    expect(lines[0].length).toBeLessThan(50);
  });

  it('returns null instead of throwing on unencodable input', () => {
    // Type-0 auto-sizing caps at version 40; ~8 KB of data cannot fit.
    expect(renderQr('x'.repeat(8000))).toBeNull();
  });
});

describe('renderQrCompact', () => {
  const url = 'https://binthere.pages.dev/p/bAAAAAAAAAAAAAAAAAAAAAA#' + 'B'.repeat(43);

  it('renders braille cells at half the half-block size in both dimensions', () => {
    const compact = renderQrCompact(url);
    expect(compact).toBeTypeOf('string');
    const lines = compact.split('\n');
    // Every character is a braille cell (U+2800–U+28FF), uniform width.
    const brailleOnly = new RegExp(`^[${String.fromCharCode(0x2800)}-${String.fromCharCode(0x28ff)}]+$`);
    for (const line of lines) expect(line).toMatch(brailleOnly);
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
    const big = renderQr(url).trimEnd().split('\n');
    expect(lines[0].length).toBeLessThanOrEqual(Math.ceil(big[0].length / 2) + 1);
    expect(lines.length).toBeLessThanOrEqual(Math.ceil(big.length / 2) + 1);
  });

  it('returns null instead of throwing on unencodable input', () => {
    expect(renderQrCompact('x'.repeat(8000))).toBeNull();
  });
});
