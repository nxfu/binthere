// Vitest configuration for the DOM-mount suites.
//
// A third, separate vitest project: the root suites run inside workerd (no DOM)
// and the CLI suite runs in plain Node, so the browser modules' mount() paths —
// the createElement/textContent sink discipline that IS the XSS defense
// (SECURITY.md §4) — were previously enforced by review alone. These suites run
// the real renderers against a happy-dom document and assert the produced tree
// can never contain live HTML. Run from the repo root with `npm test`, or:
//   vitest run --config vitest.dom.config.js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['test-dom/**/*.test.js'],
  },
});
