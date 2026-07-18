# binthere

[![CI](https://github.com/nxfu/binthere/actions/workflows/ci.yml/badge.svg)](https://github.com/nxfu/binthere/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](./.nvmrc)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)

**Live:** https://binthere.nxfu.workers.dev

**binthere** is a zero-knowledge, end-to-end encrypted pastebin. Write a note, get a link — your
browser encrypts everything with AES-256-GCM *before* it leaves your device, and only ciphertext
is ever stored. The decryption key lives in the URL fragment (`#…`) and **never reaches the
server**. Share the link, and the recipient's browser decrypts it locally.

It's a clean-room rebuild inspired by [PrivateBin](https://privatebin.info)'s zero-knowledge
model — modern Web Crypto, a strict CSP, atomic burn-after-read, and a real test suite, with the
~700 KB of jQuery/Bootstrap/zlib-WASM stripped out. It runs as a single Cloudflare Worker
(Static Assets + KV + a Durable Object), so it's cheap to host and there's no server to maintain.

```
you type ──▶ browser encrypts (AES-256-GCM) ──▶ Worker stores ciphertext only
                     │                                      │
              key stays in the URL #fragment          KV or Durable Object
                     │                                      │
recipient opens link ─▶ browser fetches ciphertext ─▶ browser decrypts ─▶ plaintext
```

## Features

- **Zero-knowledge**: content is encrypted/decrypted only in the browser; the server stores
  opaque ciphertext and non-secret metadata. See [`SECURITY.md`](./SECURITY.md).
- **Optional password** on top of the URL key (neither alone can decrypt).
- **One-time view, auto-deletes in 24 hours.** The current UI creates every note as a
  *strict, atomic* single-consumer burn-after-read (a Durable Object) — the first reader gets
  it, everyone else gets `410 Gone` — with a fixed 24h expiry. The wire format still supports
  the full expiry range (5 min–1 year or never) and non-burn pastes; those controls are just
  hidden in the current UI, so older links keep working.
- **Safe rendering.** Source code is auto-detected and syntax-highlighted at view time; the
  format also supports a **safe** Markdown subset (no raw HTML, sanitized links). All rendering
  is DOM-construction-only — never `innerHTML`.
- **Copy link, QR code, delete link.**
- **Strict CSP**, self-hosted fonts, no third-party scripts, no analytics, no accounts.

## Architecture

| Piece | What it does |
|---|---|
| Static Assets (`public/`) | The SPA frontend, served directly by the Worker. |
| Worker (`src/index.js`) | The `/api/*` paste API — stores ciphertext, enforces size/rate/burn. |
| KV (`PASTES`) | Normal pastes, with native TTL expiry. |
| Durable Object (`BurnPaste`) | Burn-after-read pastes, atomic single-consumer. |
| Rate Limiting binding | Abuse mitigation on paste creation (fail-open). |

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the request path and [`SPEC.md`](./SPEC.md) for
the exact cryptographic protocol and paste format v1 (with frozen test vectors).

## Develop

Requires Node.js ≥ 20 (`.nvmrc` pins 22).

```bash
npm install
npm run dev      # wrangler dev → http://127.0.0.1:8787 (KV + DO + rate limit emulated locally)
npm test         # vitest in the workerd runtime: crypto vectors, format, ids, markdown XSS, highlighter, burn concurrency
npm run lint     # ESLint 9 (flat config) — CI runs lint + a byte-for-byte vector diff + the full suite
```

## Deploy (Cloudflare)

```bash
# 1. Copy the config template (the real wrangler.toml is gitignored — it holds
#    your account-specific KV ids and stays local).
cp wrangler.toml.example wrangler.toml

# 2. Create the KV namespace and paste the ids into wrangler.toml
npm run kv:create        # wrangler kv namespace create PASTES (+ --preview)

# 3. Deploy (creates the Worker, the BurnPaste Durable Object, and the rate limiter)
npm run deploy           # wrangler deploy
```

`wrangler.toml.example` already declares the assets, KV binding, the `BurnPaste` DO + migration,
and the `CREATE_RL` rate limiter. Copy it to `wrangler.toml` and fill in the KV `id`/`preview_id`
before deploying. `npm run dev` works with the placeholder ids (KV is emulated locally).

## Project layout

```
public/            static frontend (CSP-clean; served by Workers Static Assets)
  index.html  css/styles.css  js/*.js  fonts/*.woff2  img/favicon.svg
  _headers  robots.txt  .well-known/security.txt
src/
  index.js         Worker: /api/paste routing + asset fallback
  burn-do.js       BurnPaste Durable Object (atomic burn-after-read)
  lib/             ids, storage routing, rate-limit wrapper
test/              vitest suites (run in workerd) + genvectors.mjs (vector regenerator)
tools/             verify-vectors.py — independent Python cross-check of the frozen vectors
SPEC.md SECURITY.md ARCHITECTURE.md
CHANGELOG.md CONTRIBUTING.md CODE_OF_CONDUCT.md LICENSE
```

Note: `public/js/{bytes,crypto,format,markdown}.js` are shared — the browser imports them as
static assets and the Worker bundles the same files, so the paste format is a single source of
truth.

## Limitations & rough edges

Be aware of these before relying on it — most are deliberate scope choices, not bugs:

- **Not anonymous or metadata-free.** The server sees IP, timing, ciphertext size, and the
  non-secret `adata` (IVs, KDF params, format flags). It only cannot read your *plaintext*.
  See [`SECURITY.md`](./SECURITY.md) §3.
- **No protection from a compromised deployment.** Because decryption runs in JavaScript the
  server delivers, a malicious or hacked host could serve code that leaks your key. In-browser
  E2E encryption trusts the origin. See [`SECURITY.md`](./SECURITY.md) §4.
- **Lose the link, lose the note.** There are no accounts and no server-side index. The id +
  key live only in the URL you share; nobody (including you) can recover or list pastes.
- **Burn password can be guessed offline.** The non-consuming peek returns the wrapped key so a
  password can be checked before the single read — which means someone who already has the URL
  secret can brute-force a weak password without burning the note. Use a strong password
  ([`SPEC.md`](./SPEC.md) §8 documents the trade-off).
- **Password KDF is PBKDF2-SHA256** (310k iterations), not a memory-hard KDF. Argon2id is on
  the roadmap.
- **The UI fixes expiry at 24h and one-time view.** The wire format still supports the full
  expiry range and non-burn pastes (older links keep working); the controls are just hidden.
- **English only**, and the rate limiter **fails open** (abuse mitigation, not access control).
- **Config is `wrangler.toml.example`** (placeholder KV ids); copy it to `wrangler.toml` (which
  is gitignored) and fill in your own `id`/`preview_id` before deploying (see below).
- **Canonical URLs are hardcoded to the origin deploy.** `index.html`'s `og:url`/`og:image` and
  `.well-known/security.txt`'s `Canonical` point at `binthere.nxfu.workers.dev`; the footer and
  `security.txt` `Policy`/CI point at `github.com/nxfu/binthere`. Update these to your own host
  and repo when self-hosting or forking.

## Roadmap

Deliberately out of scope for v1, roughly in priority order:

- **Argon2id** as a versioned password-KDF option alongside PBKDF2 (spec-first: vectors before code).
- **File attachments** — encrypted binary blobs with size limits (likely R2 for large files).
- **Headless-browser CSP + render test** (Playwright) in CI, asserting zero CSP violations across
  the create/view/burn flows.
- **Ticking expiry countdown** on the view screen (currently a static pill).
- Possible **comments/discussion** with per-thread encryption, and **i18n**.

## Security

binthere is a security-sensitive cryptographic app. The threat model, explicit non-goals, and
vulnerability-reporting process are in [`SECURITY.md`](./SECURITY.md); the frozen protocol and
paste format (with test vectors) are in [`SPEC.md`](./SPEC.md). **Please report suspected
vulnerabilities privately to [nxfu@proton.me](mailto:nxfu@proton.me) (see `SECURITY.md` §8) — do
not open a public issue with exploit details.**

## Contributing

Issues and PRs are welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md). Two hard rules:

1. **Crypto is spec-first.** Any change to the protocol, paste format, or canonical AAD must
   update [`SPEC.md`](./SPEC.md) **first** — never silently — then regenerate the frozen vectors
   with `node test/genvectors.mjs` (never hand-edit the pinned hexes in `test/crypto.test.js`).
2. **Keep the CSP strict and rendering XSS-safe.** No inline styles/scripts, no CDNs, no
   `innerHTML` on user content. New rendering paths need a case in `test/markdown.test.js`.

Run `npm run lint` and `npm test` before opening a PR; all suites run in the real `workerd` runtime.

## Acknowledgements

binthere stands on the work of these projects:

- **[PrivateBin](https://privatebin.info)** — the zero-knowledge pastebin whose model this is a
  clean-room rebuild of.
- **[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)** by Kazuhiko Arase
  (MIT) — vendored in `public/js/qrcode.js` for offline, CSP-safe QR rendering.
- **[Newsreader](https://fonts.google.com/specimen/Newsreader)** by Production Type,
  **[Geist](https://vercel.com/font)** by Vercel, and
  **[JetBrains Mono](https://www.jetbrains.com/lp/mono/)** by JetBrains (all SIL OFL 1.1) —
  self-hosted in `public/fonts/`; license texts in
  [`public/fonts/THIRD-PARTY-NOTICES.md`](./public/fonts/THIRD-PARTY-NOTICES.md).

## License

[MIT](./LICENSE) © 2026 nxfu.
