// ESLint flat config for binthere. Style is enforced lightly — the point is to
// catch real bugs (undeclared globals, unused vars, accidental debugger) across
// the three runtime surfaces: the browser client (public/js), the Worker (src),
// and the vitest suites (test). The vendored qrcode.js is exempt.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'public/js/qrcode.js', '.wrangler/**', 'coverage/**'] },

  js.configs.recommended,

  {
    linterOptions: { reportUnusedDisableDirectives: true },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      'no-console': 'off',
    },
  },

  // Browser client: DOM + Web Crypto + streams.
  {
    files: ['public/js/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },

  // Worker: service-worker/Web-API globals (fetch, Response, URL, crypto, DO).
  {
    files: ['src/**/*.js'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.node } },
  },

  // Tests + the vector generator: vitest globals + Node.
  {
    files: ['test/**/*.js', 'test/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
