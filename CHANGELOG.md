# Changelog

All notable changes to binthere are documented here. The format follows
[Keep a Changelog], and the project adheres to [Semantic Versioning]. The paste format is
versioned separately from the application (see [`SPEC.md`](./SPEC.md), currently **v1**).

## [Unreleased]

_Nothing yet — this section collects changes landing after the v1.0.0 open-source release._

## [1.0.0] — 2026-07-18

First public, open-source release: a clean-room, security-first, zero-knowledge encrypted
pastebin on a single Cloudflare Worker (Static Assets + KV + a `BurnPaste` Durable Object +
native rate limiting). Content is encrypted and decrypted only in the browser; the server
stores nothing but ciphertext and non-secret metadata.

### Cryptography (zero-knowledge, Web Crypto only)

- Per-paste random 256-bit content key (CEK); AES-256-GCM with fresh 96-bit IVs (never
  reused per key). The key rides in the URL `#fragment` and never reaches the server.
- Documented, domain-separated key hierarchy: `KEK = HKDF-SHA256(F, salt=PBKDF2(password))`
  wraps the CEK. Neither the URL fragment secret alone nor the password alone can decrypt a
  password-protected paste. All KDF parameters are versioned in the format.
- Canonical, fixed-order AAD binds every decryption/rendering/compression/burn field to both
  GCM operations. Frozen crypto test vectors in [`SPEC.md`](./SPEC.md) §11 /
  `test/crypto.test.js`, with a regenerator (`test/genvectors.mjs`) and an independent Python
  cross-check (`tools/verify-vectors.py`).
- Native `CompressionStream` gzip with a hard decompression cap (gzip-bomb defense).

### Backend

- Single Worker + Static Assets serves the frontend and the `/api/*` API.
- **Strict, atomic burn-after-read** via a `BurnPaste` Durable Object (single-consumer;
  concurrent reads → exactly one `200`, the rest `410`). Normal pastes live in KV with
  native TTL.
- Password-protected burn pastes are **verified before the destructive read**: a
  non-consuming metadata peek (`GET /api/paste/:id?meta=1`, returns `adata` + wrapped key,
  never the ciphertext) lets the client check the password first, so a wrong password never
  destroys the note (see [`SPEC.md`](./SPEC.md) §8). The client validates the peeked head
  with the same fail-closed rules before deriving any key.
- 128-bit CSPRNG paste ids (with a storage-class prefix); 256-bit CSPRNG delete tokens stored
  only as `SHA-256`, verified in constant time, and sent in the `X-Delete-Token` header
  (never in the URL, so they cannot land in logged request URLs).
- Native Workers Rate Limiting on create (fail-open). Real HTTP status codes.
  `X-Content-Type-Options: nosniff` on API JSON responses.
- Fail-closed, prototype-pollution-safe format validation; server body-size cap.

### Frontend

- Beginner-first create / success / view / password / status screens.
- **One-time view by default:** every note is single-use and auto-deletes within 24 hours.
  Optional password protection via a plain-language modal.
- Obvious source code is auto-detected and syntax-highlighted at view time by a first-party,
  `textContent`-only highlighter (`public/js/highlight.js`) — no CDN, no `innerHTML`;
  `tokenize()` is proven lossless in `test/highlight.test.js`. A **safe** Markdown subset
  (no raw HTML, `href` scheme allowlist) renders via DOM construction only.
- Copy link, QR code (self-hosted MIT `qrcode-generator`, rendered as a `data:` image),
  delete link, status pills (kind + one-time view).

### Design — the "Iron Gall" system

- The interface is treated as a piece of security printing:
  archival inks, engraved 1px hairlines, tight print-like radii (3px controls / 6px cards), a
  self-drawing guilloché seal on the success screen, a guilloché rosette watermark, stamp-like
  status pills, and banknote microtext in the footer.
- Hierarchy is carried by **one owned hue** — iron-gall blue — with **wax-seal red reserved
  strictly for destruction semantics** (the one-time / "now deleted" stamp and delete actions).
- Two themes, one token contract: light "Archive" on `:root`, dark "Plate" on `html.dark`
  (the shipped default).
- Three self-hosted (woff2, CSP-strict, first-party) typefaces: **Newsreader** for the wordmark
  and display titles, **Geist** for body and controls, **JetBrains Mono** for technical text.
- The footer names the actual primitives (AES-256-GCM · HKDF-SHA256 · key rides in the URL
  `#fragment`, never sent) and links to the source, the threat model
  ([`SECURITY.md`](./SECURITY.md)), and `/.well-known/security.txt`.

### Security posture

- Strict CSP (`default-src 'none'`; first-party `script`/`style`/`font`/`img`/`connect`; no
  inline, no eval, no CDN). Self-hosted Newsreader + Geist + JetBrains Mono (SIL OFL 1.1
  notices in `public/fonts/THIRD-PARTY-NOTICES.md`). Security headers via `_headers`.
- [`SECURITY.md`](./SECURITY.md) documents the threat model, the metadata/anonymity non-goals,
  and the deployment-compromise limitation of in-browser E2E encryption, plus a security
  contact — also published at `/.well-known/security.txt`.

### Tests & tooling

- 103 tests in the `workerd` runtime: frozen crypto vectors + round-trip + password hierarchy
  + tamper; adversarial format validation (incl. prototype pollution); id/token handling;
  Markdown XSS suite; syntax-highlighter losslessness; backend API + **burn concurrency** +
  password-peek regression tests.
- GitHub Actions CI (lint + byte-for-byte vector diff against `test/vectors.expected.txt` +
  full test suite); ESLint 9 flat config; `engines.node >= 20` + `.nvmrc`; MIT `LICENSE`,
  `CODE_OF_CONDUCT.md`, issue/PR templates.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[Semantic Versioning]: https://semver.org/spec/v2.0.0.html
[Unreleased]: https://github.com/nxfu/binthere/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/nxfu/binthere/releases/tag/v1.0.0
