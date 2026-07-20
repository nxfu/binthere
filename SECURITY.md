# binthere — Security Policy & Threat Model

binthere is a **zero-knowledge pastebin**: paste content is encrypted and decrypted only in
the browser, and the decryption secret never leaves the client in normal operation. This
document is the authoritative statement of what binthere does and does **not** protect. Read it
alongside `SPEC.md` (the frozen cryptographic protocol).

Treat binthere as a **security-sensitive cryptographic application**, not a normal web app.

---

## 1. Security goals

1. **Confidentiality of plaintext from the storage/server layer.** The server, the KV store,
   the Durable Object, and Cloudflare's infrastructure store only ciphertext and non-secret
   metadata. They cannot read paste plaintext, because the decryption secret (`F`, the URL
   fragment) is never transmitted to them.
2. **Integrity / authenticity of ciphertext and its security-relevant metadata.** AES-256-GCM
   authenticates the ciphertext, and the canonical AAD (`SPEC.md` §4) binds every field that
   affects decryption, rendering, compression, or burn semantics. Tampering fails closed.
3. **Password gating that is independent of the URL secret.** For password-protected pastes,
   neither the URL fragment secret alone nor the password alone can decrypt (`SPEC.md` §2).
4. **Strict single-consumer burn-after-read.** A burn paste is delivered to exactly one reader;
   concurrent or later reads get `410 Gone` (`SPEC.md` §8). A password on a burn paste is
   verified against a **non-consuming metadata peek** *before* the single destructive read, so a
   wrong or missing password never burns the note. The peek returns the wrapped key but never
   the ciphertext; the trade-off (offline password guessing for someone who already holds the
   URL secret) is documented in `SPEC.md` §8 — use a strong password.
5. **No client-side key exfiltration via the app's own code.** A strict CSP, self-hosted
   assets, DOM-construction-only rendering, and a raw-HTML-free Markdown renderer prevent the
   application from turning attacker-controlled paste content into script execution — which, in
   a zero-knowledge app, would be equivalent to leaking the key (see §4).

## 2. Explicit non-goals

binthere does **not** provide, and does not claim:

- **Anonymity or metadata privacy.** See §3.
- **Protection against a compromised or malicious deployment.** See §4.
- **Protection of a secret you disclose.** Anyone with the full URL (id **and** fragment) — and
  the password, if set — can read the paste. Sharing the link shares the content. Fragments may
  be retained in browser history, referrer chains (mitigated by `Referrer-Policy`), chat-app
  link previews, etc. This is inherent to URL-fragment key delivery.
- **Guaranteed deletion from all layers/backups.** Expiry and burn remove data from the live
  store; operational copies/logs are outside this boundary.
- **Denial-of-service protection.** Rate limiting is best-effort abuse mitigation (§6), not a
  DoS defense.
- **Forward secrecy, deniability, or post-compromise recovery** of individual pastes.

## 3. Zero-knowledge boundary & metadata leakage

The zero-knowledge property covers **plaintext only**. binthere is **not** anonymous and **not**
metadata-free. The service and Cloudflare can still observe, and may log:

- Client **IP addresses** and approximate geolocation.
- **Timestamps** of creation, reads, and deletion.
- **Paste IDs** (they are the storage keys and appear in request paths).
- **Ciphertext size** (an upper bound on, and correlate of, plaintext size).
- **Expiry** and **burn-after-read** flags and lifecycle events.
- **Access patterns** (how often / from where a paste is fetched).
- **User-Agent** and other standard request metadata.

The **delete token is deliberately kept out of this metadata**: it is sent in the
`X-Delete-Token` request header, never in the URL, so it does not appear in logged request
URLs; the server stores and compares only its SHA-256 (`SPEC.md` §7, §10). The decryption
secret `F` never appears in **any** request — URL, header, or body.

If you need anonymity or traffic-analysis resistance, use additional tooling (e.g. Tor); it is
outside binthere's scope.

## 4. Frontend / XSS threat model — "XSS = key exfiltration"

Because the decryption key is in `location.hash`, **any script running on the page can read the
key and the decrypted plaintext.** A cross-site-scripting bug is therefore equivalent to a full
key/plaintext compromise. binthere treats XSS as a top-severity class and defends in depth:

- **Strict Content-Security-Policy** on every static-asset response (`public/_headers`):
  ```
  default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self';
  frame-ancestors 'none'; object-src 'none'
  ```
  No `unsafe-inline`, no `unsafe-eval`, no third-party origins. This CSP governs the HTML
  document and every asset the browser executes; the JSON `/api/*` responses (which the
  browser never renders as a document) instead carry `cache-control: no-store` and
  `x-content-type-options: nosniff` (`src/index.js`).
- **No third-party JavaScript, no CDN scripts, no analytics.** All scripts, styles, and fonts
  are first-party and self-hosted.
- **Decrypted content is rendered by DOM construction only** (`document.createElement` +
  `textContent`). Decrypted user content is **never** assigned to `innerHTML`.
- **Markdown supports a safe subset with no raw HTML.** Link `href`s are restricted to an
  `http` / `https` / `mailto` scheme allowlist; `javascript:`, `data:`, and unknown schemes are
  dropped. A dedicated adversarial test suite (`test/markdown.test.js`) exercises `<script>`,
  `onerror`, `javascript:` URLs, `data:` images, and raw-HTML injection.
- **No dangerous sinks:** no `eval`, `new Function`, `document.write`, inline event handlers,
  `javascript:` URLs, or dynamic `<script>` creation anywhere in the codebase.

### Deployment-compromise limitation (important)

binthere's client-side encryption protects plaintext from the **storage/server** layer, but the
browser still **downloads and trusts JavaScript from the server**. An attacker who can modify
what the server serves (a compromised deployment, a malicious operator, a supply-chain
compromise, or a TLS/CDN MITM) could serve **malicious JavaScript that reads the fragment key
and the decrypted plaintext**. Zero-knowledge server storage does **not** defend against a
compromised delivery of the application itself. This is a fundamental limitation of all
in-browser end-to-end encryption delivered over the web, binthere included. Mitigations
(HTTPS-only, strict CSP, minimal first-party surface, no third-party code) reduce but cannot
eliminate this trust.

### The CLI client

The official CLI (`cli/`, npm package `binthere`) is a **second client of the same frozen
protocol**: it runs the vendored copies of the shared crypto/format modules in Node ≥ 20 and
is tested against the same `SPEC.md` §11 vectors. The zero-knowledge boundary is identical —
encryption is local and the fragment secret is never sent. Differences from the browser
client worth knowing:

- The §4 deployment-compromise limitation does **not** apply in the same way: the CLI's code
  is installed from npm and pinned locally, not re-downloaded from the paste server on every
  use. Its trust anchor is the npm supply chain instead (mitigated by zero runtime
  dependencies).
- Share URLs passed as command-line arguments are visible to other local processes and may
  enter shell history; `binthere get -` (URL on stdin) avoids this. Passwords and delete
  tokens are never accepted as flag values — hidden prompt or environment variable only.

## 5. Trust boundaries

| Boundary | Trusted with plaintext? | Notes |
|---|---|---|
| The user's browser + the served JS | **Yes** (unavoidable) | See the deployment-compromise limitation, §4. |
| The CLI process + its installed code | **Yes** (unavoidable) | Installed from npm, not served by the paste server — see "The CLI client", §4. |
| Network in transit | No | TLS protects transport; the fragment is never sent regardless. |
| Cloudflare Worker / edge | No (plaintext) | Sees ciphertext + metadata (§3). |
| KV store / `BurnPaste` DO | No (plaintext) | Stores ciphertext + `SHA-256(deleteToken)` + metadata. |
| Anyone holding the full URL (+password) | **Yes** | By design — that is the capability being shared. |

## 6. Rate limiting

Paste creation is rate-limited using Cloudflare's native Workers Rate Limiting binding, keyed
by client IP. This is **abuse mitigation, not authentication**, and is **fail-open**: if the
limiter is unavailable, requests are allowed rather than blocked. Limits are documented in
`SPEC.md`/`wrangler.toml`.

### API surface hardening

- **No CORS headers, deliberately.** The API never sends `Access-Control-Allow-Origin`, so
  browsers on other origins cannot read API responses. Both official clients need no CORS:
  the web app is same-origin and the CLI is not subject to the browser's CORS model. Adding
  CORS would only widen the abuse surface (third-party pages driving reads/creates from a
  visitor's browser and network).
- **`POST /api/paste` requires `Content-Type: application/json`** (else `415`). A cross-origin
  `application/json` POST is not a CORS "simple request", so the browser sends a preflight —
  which fails without CORS headers. A hostile page therefore cannot spend a visitor's creation
  quota (or create pastes from their IP) with a no-preflight `text/plain` POST. Both official
  clients already send the correct header.
- **Burn consumption is never a simple request.** `GET` on a burn id only ever returns the
  non-consuming head; the single destructive read is `POST /api/paste/:id/consume` with the
  custom `X-Burn-Intent: consume` header (CORS non-simple ⇒ cross-origin preflight fails), and
  `Sec-Fetch-Site: cross-site` senders are rejected with `403`. Merely knowing a burn id —
  via an `<img>` tag, a prefetching proxy, or a link-scanning bot — grants no power to destroy
  the note.

## 7. Cryptographic summary

See `SPEC.md` for exact byte-level details. In brief: per-paste random 256-bit CEK; AES-256-GCM
with fresh 96-bit IVs (never reused per key); password stretched with PBKDF2-HMAC-SHA256
(310 000 iterations, versioned); high-entropy fragment secret combined with the stretched
password via HKDF-SHA256 to wrap the CEK; canonical AAD binding all security-relevant metadata;
128-bit CSPRNG paste IDs; 256-bit CSPRNG delete tokens stored only as `SHA-256` and compared in
constant time; decompression bounded to defend against gzip bombs. All parsing fails closed and
is prototype-pollution-safe.

## 8. Reporting a vulnerability

This is a personal/portfolio project. Report suspected vulnerabilities privately to the
maintainer at **[nxfu@proton.me](mailto:nxfu@proton.me)** (do not open a public issue with
exploit details). Please include reproduction steps and affected versions. There is no
bug-bounty program. This contact is also published at
[`/.well-known/security.txt`](./public/.well-known/security.txt) ([RFC 9116](https://www.rfc-editor.org/rfc/rfc9116)).

## 9. Supported versions

Only the latest `main` is supported. The paste format is versioned (`v`); format-breaking
changes ship under a new `v` with an updated `SPEC.md` and new test vectors.
