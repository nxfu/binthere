// qr.js — terminal QR rendering via the vendored MIT qrcode-generator
// (vendor/qrcode.cjs, byte-identical to public/js/qrcode.js; the .cjs name makes
// Node's CommonJS loader take the UMD module.exports branch). Unlike the web
// client (error correction M), the terminal uses L: a screen QR cannot be
// damaged, and fewer modules keep the code small enough to fit a terminal.
import { createRequire } from 'node:module';

/**
 * Render a share URL as a compact half-block QR string (1 module per column,
 * 2 per row — square modules, since terminal cells are ~1:2), or null on any
 * failure (fail-soft, like the browser: a missing QR never blocks the link).
 * The quiet zone is 1 module: the spec asks for 4, but phone scanners cope
 * fine on an emissive screen and every saved row keeps the result screen on
 * one terminal page. Note: cellSize 1 draws light modules as blocks — correct
 * contrast on the common light-text-on-dark terminal; scanners tolerate the
 * inverse.
 */
export function renderQr(url) {
  try {
    const qrcode = createRequire(import.meta.url)('../vendor/qrcode.cjs');
    const qr = qrcode(0, 'L');
    qr.addData(url);
    qr.make();
    return qr.createASCII(1, 1);
  } catch {
    return null;
  }
}

// Braille dot bit values by [row][col] within one 2×4-dot cell (U+2800 base).
const BRAILLE_DOTS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];

/**
 * Render a share URL as a quarter-size braille QR: each character cell packs
 * 2×4 modules, halving both dimensions of the half-block QR while keeping a
 * square dot pitch (terminal cells are ~1:2). Same polarity trick as above —
 * light modules get the dots, so the code reads normally on a dark terminal.
 * Returns null on any failure, like renderQr.
 */
export function renderQrCompact(url) {
  try {
    const qrcode = createRequire(import.meta.url)('../vendor/qrcode.cjs');
    const qr = qrcode(0, 'L');
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount();
    const margin = 1;
    const size = n + margin * 2;
    const light = (r, c) => {
      const rr = r - margin;
      const cc = c - margin;
      if (rr < 0 || cc < 0 || rr >= n || cc >= n) return true;
      return !qr.isDark(rr, cc);
    };
    const lines = [];
    for (let r = 0; r < size; r += 4) {
      let line = '';
      for (let c = 0; c < size; c += 2) {
        let bits = 0;
        for (let dr = 0; dr < 4; dr++) {
          for (let dc = 0; dc < 2; dc++) {
            if (light(r + dr, c + dc)) bits |= BRAILLE_DOTS[dr][dc];
          }
        }
        line += String.fromCharCode(0x2800 + bits);
      }
      lines.push(line);
    }
    return lines.join('\n');
  } catch {
    return null;
  }
}
