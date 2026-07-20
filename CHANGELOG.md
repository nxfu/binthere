# Changelog

All notable changes to binthere are documented here. The format follows
[Keep a Changelog], and the project adheres to [Semantic Versioning]. The paste format is
versioned separately from the application (see [`SPEC.md`](./SPEC.md), currently **v1**).

## [Unreleased]

### Changed

- **New favicon.** The tab icon is now a simplified guilloché rosette in iron-gall blue
  on Plate paper — drawn from the same mark as the watermark and seal — replacing the
  pre-Iron-Gall brackets-and-keyhole placeholder. It follows the browser's
  `prefers-color-scheme`, flipping to the light Archive palette on light UIs
  (`tools/favicon-check.html` previews it at tab-strip sizes). PNG fallbacks ship
  alongside it — a 32px tile for Safari (which ignores SVG favicons) and a 180px
  full-bleed `apple-touch-icon` for iOS home screens.

## [1.1.0] — 2026-07-20

### Changed

- **One-time notes can no longer be destroyed by a stray GET.** Destructive burn
  consumption moved from `GET /api/paste/:id` to an explicit
  `POST /api/paste/:id/consume` carrying an `X-Burn-Intent: consume` header. The POST is
  CORS non-simple, so a hostile page can never trigger it cross-origin (the preflight
  fails; `Sec-Fetch-Site: cross-site` senders get a 403), and a plain GET on a one-time
  id — an `<img>` tag, a prefetching proxy, a link-scanning bot — now always returns the
  safe, non-consuming head. Both official clients (web + CLI) use the new endpoint;
  `GET /api/paste/:id?meta=1` now returns a ciphertext-free head for every storage class,
  as SPEC §10 always promised.
- **Two protocol errata, applied to both official clients** (see SPEC §1/§2 errata notes):
  base64url decoding now accepts only the canonical encoding (non-zero padding bits are
  rejected, so no two strings alias to the same id/token/key bytes), and passwords are
  Unicode-normalized to NFC before key stretching, so the same password typed on macOS
  (NFD input) and Windows (NFC) unlocks the same note.
- **Irreversible success-screen actions now confirm.** "Open link" (which consumes a
  one-time note) and "Delete now" are two-step: the first press re-labels the button with
  the destructive effect ("Uses the one view — open?" / "Permanently delete?"), a second
  press within 5 s confirms, and the button disarms on timeout or focus loss.
- **New-note passwords are typed twice.** The password modal gained a confirmation field
  (mismatch is caught before sealing — a typo'd password would permanently lock a
  one-time note) and a practical 128-character cap, enforced with a visible error rather
  than a `maxlength` attribute — silent truncation of a pasted longer password would
  seal the note with a password the reader doesn't have. Show/hide toggles reset to
  masked every time a password field is presented.
- **Hostile pastes can no longer freeze the viewer's tab:** syntax highlighting and
  Markdown rendering enforce a render budget (300 KB / 30k DOM nodes — every token
  counts, including plain-text ones); beyond it content is shown verbatim as plain text
  instead of minting hundreds of thousands of DOM nodes.
- **CLI: user aborts (Ctrl+C, Esc at the menu) now exit 130** (the conventional
  128+SIGINT code) instead of 2, so scripts can tell "user cancelled" from "bad
  invocation". Network failures name the host and cause (`ECONNREFUSED`, DNS, TLS)
  instead of a bare "fetch failed"; `binthere <command> --help` prints help instead of
  exiting 2; a bare `-f` dispatches to create like `-t` always did; `--out` files are
  written owner-only (0600); `TERM=dumb` terminals get plain text instead of ANSI.

### Fixed

- **Web accessibility/UX:** view transitions move keyboard and screen-reader focus to the
  shown view (previously focus could remain on a hidden control); informational text
  colors were raised to WCAG AA contrast (≥ 4.5:1) in both themes and are locked by an
  automated contrast test; the burn countdown now disables Reveal and switches to the
  expired state the moment it hits zero, instead of leaving a doomed button enabled.
- **CLI terminal robustness:** the hidden secret prompt reassembles multi-byte UTF-8
  split across raw-mode chunks and backspaces whole code points (half a surrogate pair
  silently derived a different key); keystrokes typed during the wizard intro no longer
  echo over the animation or leak into the first menu read; Ctrl+C on the burn
  confirmation prompt is a defined "no".
- **The wizard is now actually usable on Windows (conpty).** Three interlocking input
  bugs fixed: escape sequences split across reads no longer decode as a spurious Esc
  (which aborted the menu mid-navigation), several keys coalesced into one chunk are
  split and queued instead of silently dropped (fast or held arrows now register every
  press), and the per-keypress pause/raw-mode churn that could wedge the conpty read
  loop — freezing the menu after one keypress with even Ctrl+C dead — is gone. Key
  reading is now a persistent raw-mode reader for the whole wizard session
  (`tui/keys.js`); raw mode is set once and never toggled between screens, because
  conpty applies console-mode changes asynchronously and an off/on race at the
  menu-to-prompt hand-off left the terminal line-buffered with echo off (typing was
  invisible until Enter). The entry point restores the terminal and pauses stdin on the
  way out, so the process still exits cleanly.
- **Web polish:** programmatic focus targets (the view sections) no longer paint a
  focus ring around the entire view on load.
- **A bad link no longer burns a passwordless one-time note:** the web client now verifies
  the key from the link against the note's wrapped key *before* the destructive read, so a
  truncated or corrupted link fails with "the note was not opened and still exists" instead
  of destroying an unreadable note. The verified key is reused for the final decrypt, which
  also removes a duplicated (deliberately slow) key derivation from the password-protected
  reveal, and the key fragment is scrubbed from the address bar once a one-time note is
  revealed.
- **Password screen re-entry race:** rapid Enter presses could start a second password
  verification while one was already in flight; on a password-protected one-time note the two
  destructive reads raced and the reader could land on the "already opened" screen instead of
  the decrypted note (the server's single-consumer guarantee was never at risk). The submit
  handler is now guarded against re-entry — exactly one consuming read per unlock, and a wrong
  password still leaves the note intact and retryable.

### Added

- **Dismissible announcement bar** on the landing page linking to the launch blog post
  (hidden for returning visitors who dismissed it).
- **DOM-mount test project** (happy-dom): the `createElement`/`textContent` sink
  discipline — the load-bearing XSS defense — is now asserted against a real DOM with
  adversarial fixtures, alongside the focus-management and color-contrast checks.
  Coverage thresholds (80% statements / 70% branches) are enforced in the workerd suite.
- **Release automation:** pushing a `cli-v*` tag runs the full suites and publishes the
  CLI to npm with provenance (`.github/workflows/release.yml`).
- **Official CLI** (`cli/`, published to npm as `binthere`): create, get, and delete notes
  from the terminal. Second client of the same frozen protocol v1 — encryption is local
  (Node ≥ 20 WebCrypto + `CompressionStream`), only ciphertext is uploaded, and the SPEC §11
  vectors are re-verified in plain Node. Zero runtime dependencies.
  - **Website-parity lifecycle:** every note is burn-after-read and expires in 24 hours
    (`bar: true, expire: '1day'`), exactly like the web client — no expiry/burn flags.
  - **Full-screen interactive wizard:** a bare `binthere` on a terminal opens a branded
    menu (hand-rolled ANSI, still zero dependencies) — a left-aligned gradient wordmark
    that materialises in on startup (each glyph flickers ░ → ▒ → █ on its own random
    delay over ~0.9 s, TTY-only) with a wax-red ember dotting the "i" (smouldering while
    the menu idles), described
    menu items in a rounded hairline box, and taglines; arrow keys /
    `1`–`3` hotkeys pick **Create**, **View**, or **Delete**, and each action opens its
    own screen. Create lets
    you write the note and seal it with **Ctrl+Q** (optional password with confirmation),
    shows a braille
    spinner while encrypting and uploading, then clears the typed note and prints the
    share link on stdout plus a scannable compact braille
    **terminal QR code** and the delete token on stderr — `binthere | clip` still copies
    only the link. While the result screen waits, a slanted **shine beam periodically
    sweeps the wordmark** (every 7 s, repainted in place; TTY-only, skipped if the screen
    scrolled). On the result screen, **`c` copies the link and `t` the delete token**
    to the system clipboard (native tool — `clip`/`pbcopy`/`wl-copy`/`xclip`/`xsel`,
    `clip.exe` under WSL — fed
    over stdin, with an OSC 52 escape fallback for SSH; still zero dependencies).
    View and Delete reuse the exact `get`/`delete` command flows, so the
    safe burn ordering is shared. Colors follow the website palette with truecolor →
    16-color → `NO_COLOR`/non-TTY degradation. `--qr` adds a larger half-block QR to scripted `create`.
  - Reads mirror the browser's safe burn flow: non-consuming `?meta=1` peek → password
    verification **before** the destructive read → confirmation → consume. A wrong password
    never burns the note; old non-burn `k…` links still decrypt.
  - Passwords and delete tokens are never accepted as flag values — hidden prompt or
    `--password-env` / `--token-env` only. The delete token travels only in the
    `X-Delete-Token` header. `binthere get -` reads the share URL from stdin to keep the
    fragment secret out of argv/shell history.
  - **Quick one-liners:** `--text`/`-t` passes the note inline (`binthere -t "meet at 6"`
    creates directly, even without piped stdin), `binthere view <url>` is an alias for
    `get`, and common flags gained short forms (`-f` file, `-o` out, `-y` yes, `-j` json,
    `-q` qr, `-s` server).
  - `cli/vendor/` holds byte-identical copies of `public/js/{bytes,format,crypto,qrcode}.js`
    (npm cannot pack outside the package root; `qrcode.js` lands as `qrcode.cjs` for Node's
    CommonJS loader); a drift test fails CI on any divergence and
    `node cli/scripts/sync-shared.mjs` re-aligns them.
  - A Node-environment test suite (frozen vectors, URL parsing, mocked-API round trips
    incl. burn-ordering and wrong-token assertions, wizard/menu e2e, TUI renderers incl.
    the intro and shine-sweep animations, QR rendering, failure paths and raw-mode
    prompts) runs as a second vitest project via `npm test` / `npm run test:cli`.

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
  delete link, status pills (kind + one-time view), and a live **"Deletes in" countdown** on
  the reveal screen (derived from non-secret metadata; the server-side expiry stays
  authoritative).

### Design — the "Iron Gall" system

- The interface is treated as a piece of security printing:
  archival inks, engraved 1px hairlines, tight print-like radii (3px controls / 6px cards), a
  self-drawing guilloché seal on the success screen, a guilloché rosette watermark, and
  stamp-like status pills.
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
[Unreleased]: https://github.com/nxfu/binthere/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/nxfu/binthere/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/nxfu/binthere/releases/tag/v1.0.0
