// Vitest configuration for binthere.
//
// Tests run inside the real workerd runtime via @cloudflare/vitest-pool-workers so
// that Web Crypto, CompressionStream, KV, and the BurnPaste Durable Object behave
// exactly as they do in production (crucial for the burn-after-read concurrency test).
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // Rate limiting binding isn't emulated locally; the code fails open, so
        // tests exercise creation without it. Everything else comes from wrangler.toml.
        compatibilityDate: '2025-10-11',
        // workerd can fire unhandledrejection before a same-checkpoint .catch()
        // attaches (workerd#4042); DecompressionStream errors both stream sides
        // and trips this, which vitest 4 then reports as an unhandled error.
        // This flag defers the event until the microtask checkpoint completes.
        compatibilityFlags: ['unhandled_rejection_after_microtask_checkpoint'],
      },
    }),
  ],
  test: {
    coverage: {
      // istanbul (source instrumentation), NOT v8: the v8 provider needs
      // node:inspector, which doesn't exist inside workerd.
      provider: 'istanbul',
      include: ['src/**/*.js', 'public/js/**/*.js'],
      // Vendored library and browser-only glue with no DOM test harness
      // (see README roadmap: Playwright e2e would cover these).
      exclude: ['public/js/qrcode.js', 'public/js/{api,ui,app,theme,theme-init}.js'],
    },
  },
});
