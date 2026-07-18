# Architecture

binthere is a **single Cloudflare Worker** that serves both the static frontend and the paste
API, backed by KV and a Durable Object. Consolidating everything into one Worker (one deploy,
one `wrangler.toml`) keeps the security-sensitive integration surface small.

## Request path

```
                         ┌─────────────────────────── Cloudflare Worker ───────────────────────────┐
                         │                                                                          │
  GET /                  │  run_worker_first = ["/api/*"]                                            │
  GET /p/<id>            │        │                                                                  │
  GET /css/… /js/…       │        ├─ path NOT /api/*  ─▶  Static Assets (public/)                    │
  GET /fonts/…           │        │                       • exact file, else SPA fallback index.html │
                         │        │                                                                  │
  POST   /api/paste      │        └─ path /api/*     ─▶  src/index.js router                          │
  GET    /api/paste/:id  │                                 ├─ POST  create  ─▶ KV or BurnPaste DO     │
  DELETE /api/paste/:id  │                                 ├─ GET   read    ─▶ KV or BurnPaste DO     │
                         │                                 └─ DELETE delete ─▶ KV or BurnPaste DO     │
                         └──────────────────────────────────────────────────────────────────────────┘
```

- `_headers` (in `public/`) applies the strict CSP + security headers to every asset response.
- `not_found_handling = "single-page-application"` makes `/p/<id>` serve `index.html`; the
  client reads the id from the path and the key from the `#fragment`.

## Zero-knowledge boundary

The decryption key is a random 256-bit **fragment secret `F`**, base64url-encoded after `#`.
The browser never puts `F` (or the plaintext) into any request. The Worker only ever sees:
ciphertext, a wrapped content key, non-secret `adata` (IVs, KDF params, format flags), the
expiry option, and — server-side only — a `SHA-256` of the delete token. See `SPEC.md`.

## Storage routing (by id prefix)

Paste ids carry a 1-char class prefix so the read path picks the backend with **no extra
lookup**, and the client knows a burn paste is single-use *before* fetching it:

- `k…` → **KV** (`PASTES`). Immutable value `{ p: paste, dth }`, native `expirationTtl`.
  Reads are idempotent; eventual consistency is fine because the value never changes.
- `b…` → **`BurnPaste` Durable Object**, addressed `idFromName(id)`. The value lives in DO
  storage. Every mutation runs inside `blockConcurrencyWhile`, so read-and-delete is atomic:
  the first `consume()` returns the ciphertext and deletes it; concurrent/later reads get
  `gone` → HTTP `410`. A **non-consuming peek** (`GET …?meta=1`) returns only `adata` + the
  wrapped key — never the ciphertext — so the client can verify a password *before* the single
  destructive read (`SPEC.md` §8). Expiry is a DO `alarm` plus a lazy check on read.

```
create ─┬─ bar=false ─▶ id="k…" ─▶ PASTES.put(id, {p, dth}, {expirationTtl})
        └─ bar=true  ─▶ id="b…" ─▶ BURN.get(idFromName(id)).create(paste, dth, ttl)

read   ─┬─ id[0]="k" ─▶ PASTES.get → 200 | 404
        ├─ id[0]="b" ─▶ BURN…consume() → 200 (once) | 410
        └─ id[0]="b" + ?meta=1 ─▶ BURN…peek() → 200 head (no consume) | 410
```

## Modules

Shared, format-defining code lives in `public/js/` so the **browser imports it as a static
asset** and the **Worker bundles the same file** — one source of truth for the wire format:

| Module | Runs in | Responsibility |
|---|---|---|
| `public/js/bytes.js` | browser + worker + tests | base64url, SHA-256, CSPRNG bytes, constant-time hex compare |
| `public/js/format.js` | browser + worker + tests | paste format v1 validation (fail-closed) + canonical AAD + expiry map |
| `public/js/crypto.js` | browser + tests | the protocol: PBKDF2/HKDF/AES-GCM, gzip with decompression cap |
| `public/js/markdown.js` | browser + tests | safe Markdown → DOM (no raw HTML, href allowlist) |
| `public/js/highlight.js` | browser + tests | code detection + `textContent`-only syntax highlighting |
| `public/js/{api,ui,app}.js` | browser | fetch client, DOM helpers, controller/router |
| `public/js/{theme,theme-init}.js` | browser | light/dark toggle; pre-paint theme apply (no flash) |
| `public/js/qrcode.js` | browser | vendored MIT `qrcode-generator` (rendered as a `data:` image) |
| `src/index.js` | worker | API routing, size guard, id allocation, error mapping |
| `src/burn-do.js` | worker | `BurnPaste` Durable Object |
| `src/lib/{ids,store,ratelimit}.js` | worker | id/token gen + hashing, KV/DO routing + expiry, rate-limit wrapper |

## Error semantics

Unlike the legacy PrivateBin API (which returned HTTP 200 for everything and signaled errors
in the JSON body to appease jQuery), binthere uses **real status codes**: `201` create, `200`
read/delete, `400` invalid, `403` wrong delete token, `404` missing, `410` burned/expired burn,
`413` too large, `429` rate-limited. The client reads them directly. API JSON responses also
carry `cache-control: no-store` and `x-content-type-options: nosniff` (static assets get their
security headers from `public/_headers`).

## Testing

`@cloudflare/vitest-pool-workers` runs every suite in the real `workerd` runtime, so Web
Crypto, `CompressionStream`, KV, and the Durable Object behave as in production. The burn
concurrency test fires 25 simultaneous reads and asserts exactly one `200` and the rest `410`.
The frozen crypto vectors are regenerated with `node test/genvectors.mjs` (spec-first, never
hand-edited) and independently cross-checked by a from-scratch Python implementation
(`tools/verify-vectors.py`). CI (`.github/workflows/ci.yml`) runs lint, a byte-for-byte diff
of the regenerated vectors against `test/vectors.expected.txt`, and the full suite on every
push/PR.
