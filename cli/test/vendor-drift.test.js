// vendor-drift.test.js — the vendored copies in cli/vendor/ MUST stay
// byte-identical to public/js/ (the single source of truth for the frozen
// protocol). Any drift fails CI in the same run that changed the shared files.
// Re-align with: node cli/scripts/sync-shared.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// [source in public/js/, vendored name] — qrcode.js is renamed .cjs so Node's
// CommonJS loader takes its UMD module.exports branch.
const FILES = [
  ['bytes.js', 'bytes.js'],
  ['format.js', 'format.js'],
  ['crypto.js', 'crypto.js'],
  ['qrcode.js', 'qrcode.cjs'],
];

describe('vendored shared modules match public/js/', () => {
  for (const [source, vendored] of FILES) {
    it(`vendor/${vendored} is byte-identical`, async () => {
      const a = await readFile(fileURLToPath(new URL(`../../public/js/${source}`, import.meta.url)));
      const b = await readFile(fileURLToPath(new URL(`../vendor/${vendored}`, import.meta.url)));
      expect(
        b.equals(a),
        `cli/vendor/${vendored} has drifted from public/js/${source} — run: node cli/scripts/sync-shared.mjs`,
      ).toBe(true);
    });
  }

  it('cli/LICENSE is byte-identical to the repo LICENSE', async () => {
    const a = await readFile(fileURLToPath(new URL('../../LICENSE', import.meta.url)));
    const b = await readFile(fileURLToPath(new URL('../LICENSE', import.meta.url)));
    expect(
      b.equals(a),
      'cli/LICENSE has drifted from the repo LICENSE — run: node cli/scripts/sync-shared.mjs',
    ).toBe(true);
  });
});
