# binthere — Protocol Specification (v1)

> **Status: FROZEN.** This document defines the binthere paste format v1 and the exact
> byte-level cryptographic protocol. Implementation follows this spec; the spec is not
> changed silently. Any protocol change requires a new `v` value, an updated spec, and new
> test vectors *before* code changes.

This is a zero-knowledge pastebin: paste plaintext is encrypted and decrypted **only on the
client** (the browser, or the official CLI — both implement this spec and are verified against
the same vectors). The decryption secret lives in the URL **fragment** (`#…`) and is never sent
to the server. See `SECURITY.md` for the threat model and trust boundaries.

---

## 1. Notation & primitives

- All byte-level values are produced with the CSPRNG `crypto.getRandomValues()`.
  `Math.random()` is **never** used for any security-sensitive value.
- `b64url(x)` = unpadded, URL-safe Base64 (RFC 4648 §5, no `=` padding, `-`/`_` for `+`/`/`).
  Decoders MUST accept only the **canonical** encoding: characters outside the base64url
  alphabet, lengths `≡ 1 (mod 4)`, and encodings whose final character has non-zero unused
  bits (RFC 4648 §3.5 — e.g. `Zh` aliasing `Zg` → `0x66`) are all rejected. Every byte string
  has exactly one valid encoding, so ids, tokens, `skdf`, IVs, and fragments cannot alias.
  *(Errata 2026-07: canonicity was underspecified and decoders accepted non-zero padding
  bits; no exploitable consequence was found, and the tightening is applied to both official
  clients as a protocol-compatibility fix.)*
- `UTF8(s)` = UTF-8 encoding of string `s`.
- `‖` = byte concatenation.
- Crypto primitives are **Web Crypto** (`crypto.subtle`) only:
  - **AES-256-GCM** — authenticated encryption. 96-bit (12-byte) IV, 128-bit tag.
  - **PBKDF2-HMAC-SHA256** — password stretching.
  - **HKDF-SHA256** — high-entropy key combination / derivation.
  - **SHA-256** — delete-token hashing.

### Random values (per paste)

| Value          | Size      | Purpose                                                        |
|----------------|-----------|---------------------------------------------------------------|
| `CEK`          | 32 bytes  | Content-encryption key (AES-256-GCM). Encrypts the paste.      |
| `F`            | 32 bytes  | Fragment secret ("URL key"). Placed in the URL fragment.      |
| `iv_content`   | 12 bytes  | GCM nonce for the content encryption.                         |
| `iv_wrap`      | 12 bytes  | GCM nonce for the CEK-wrap encryption (distinct from above).  |
| `salt_kdf`     | 16 bytes  | PBKDF2 salt. Present **only** for password-protected pastes.  |
| `id` (random)  | 16 bytes  | 128-bit paste identifier entropy.                             |
| `deleteToken`  | 32 bytes  | 256-bit delete authorization token.                           |

IVs are freshly generated per paste and per encryption operation; an `(key, iv)` pair is
never reused.

---

## 2. Key hierarchy (CEK / KEK)

The paste is always encrypted with a random **CEK**. The CEK is then *wrapped* (encrypted)
with a **KEK** derived from the fragment secret `F` and, if set, the password. There is **no**
ad-hoc `PBKDF2(F ‖ password)` construction.

```
CEK      = random(32)                                              # AES-256-GCM content key

# Password stretching (only when a password is set; otherwise pw_ikm is empty)
pw_ikm   = password ? PBKDF2(hash=SHA-256, pw=UTF8(password),
                             salt=salt_kdf, iterations=ITER, dkLen=32)
                    : ""                                           # zero-length byte string

# Key-encryption key: combine the high-entropy fragment secret with the (stretched) password
KEK      = HKDF(hash=SHA-256, ikm=F, salt=pw_ikm, info=UTF8("binthere/v1 kek"), L=32)

# Wrap the CEK and encrypt the content, both binding the canonical AAD (§4)
wk       = AES-256-GCM(key=KEK, iv=iv_wrap,    plaintext=CEK,          additionalData=AAD)
ct       = AES-256-GCM(key=CEK, iv=iv_content, plaintext=comp(data),   additionalData=AAD)
```

- `ITER` (PBKDF2 iterations) = **310000** for v1. Stored in the format (`adata.iter`); a
  reader uses the stored value, so the parameter is versioned and upgradable.
- **Password normalization:** `UTF8(password)` means `UTF8(NFC(password))` — clients MUST
  Unicode-normalize the password to NFC before encoding, so "café" typed on macOS (NFD) and
  on Windows (NFC) stretches to the same `pw_ikm`. ASCII passwords are unaffected.
  *(Errata 2026-07: normalization was previously unspecified and clients used the raw
  input bytes; the fix removes the cross-device/input-method hazard while adoption is low.
  Compatibility cost, stated plainly: a pre-errata paste whose password was entered in a
  non-NFC form can no longer be unlocked by a normalizing client — its `pw_ikm` was
  stretched from the un-normalized bytes. ASCII and already-NFC passwords, i.e. the
  overwhelmingly common case, are unaffected.)*
- **HKDF salt carries the second secret.** HKDF-Extract computes
  `PRK = HMAC-SHA256(salt = pw_ikm, key = F)`. Recovering `KEK` therefore requires **both**
  `F` (as IKM) and `pw_ikm` (as salt, ⇒ the password). This is a deliberate, documented use of
  the HKDF salt input as an additional secret; it only strengthens the derivation.
- **No password:** `pw_ikm` is empty ⇒ per RFC 5869 HKDF-Extract uses an all-zero salt of
  `HashLen` bytes. `KEK` is then a deterministic function of `F` alone, so a non-password paste
  decrypts from the fragment secret without further input. Intended.

### Security properties

| Paste type      | Inputs needed to derive KEK        | F alone | password alone |
|-----------------|------------------------------------|---------|----------------|
| No password     | `F`                                | ✅ works | n/a            |
| Password (`pw`) | `F` **and** `password`             | ❌ fails | ❌ fails        |

`info = "binthere/v1 kek"` provides domain separation and version binding of the derivation.

---

## 3. Compression

`comp(data)` is applied to the UTF-8 plaintext bytes before content encryption:

- `comp = "gzip"` — `CompressionStream('gzip')` output, when available.
- `comp = "none"` — identity (no compression). Used when `CompressionStream` is unavailable,
  and in deterministic test vectors (gzip output is not guaranteed byte-identical across
  implementations, so vectors are pinned with `comp="none"`).

Decompression enforces a **maximum decompressed size** (`MAX_PLAINTEXT`, §6) with a running
byte counter and aborts if exceeded (gzip-bomb defense). The plaintext is also capped at
`MAX_PLAINTEXT` **before** compression on create.

The chosen `comp` value is part of the authenticated `adata` (§4), so it cannot be altered by
a tampering server without breaking GCM authentication.

---

## 4. Canonical Additional Authenticated Data (AAD)

The AAD binds every field that affects decryption, rendering, compression, or burn semantics
to **both** GCM operations (`wk` and `ct`). It is a **fixed-order** byte string and **never**
depends on JSON object key ordering.

```
AAD = UTF8(
  "binthere/v1" + "\n" +
  "alg="  + alg          + "\n" +   // "A256GCM"
  "kdf="  + kdf          + "\n" +   // "hkdf" | "pbkdf2-hkdf"
  "iter=" + iter         + "\n" +   // decimal integer; 0 when no password
  "comp=" + comp         + "\n" +   // "gzip" | "none"
  "fmt="  + fmt          + "\n" +   // "plaintext" | "code" | "markdown"
  "bar="  + (bar?"1":"0")+ "\n" +   // burn-after-read flag
  "ivc="  + b64url(iv_content) + "\n" +
  "ivw="  + b64url(iv_wrap)    + "\n" +
  "skdf=" + skdf         + "\n"     // b64url(salt_kdf), or "" when no password
)
```

The AAD is recomputed by the reader from the received `adata` and fed to both GCM
decryptions. Any mismatch (a flipped `bar`, changed `fmt`, swapped IV, altered `iter`, …)
causes authentication to fail — decryption fails closed.

---

## 5. Paste format v1 (wire / storage)

The client `POST`s this JSON to create a paste. The server persists it (adding server fields
in §5.2) and returns it (minus private fields) on read.

### 5.1 Client-supplied object

```jsonc
{
  "v": 1,                              // integer, MUST equal 1
  "ct": "<b64url>",                    // content ciphertext + GCM tag
  "wk": "<b64url>",                    // wrapped CEK + GCM tag (32B CEK + 16B tag = 48B)
  "adata": {
    "alg":  "A256GCM",                 // only supported value
    "kdf":  "hkdf" | "pbkdf2-hkdf",    // "pbkdf2-hkdf" iff password-protected
    "iter": 310000 | 0,               // PBKDF2 iterations; MUST be 0 iff kdf == "hkdf"
    "comp": "gzip" | "none",
    "fmt":  "plaintext" | "code" | "markdown",
    "bar":  false | true,              // burn after reading
    "ivc":  "<b64url>",                // exactly 12 bytes
    "ivw":  "<b64url>",                // exactly 12 bytes
    "skdf": "<b64url>" | ""            // 16 bytes iff kdf=="pbkdf2-hkdf", else ""
  },
  "meta": {
    "expire": "5min"|"10min"|"1hour"|"1day"|"1week"|"1month"|"1year"|"never"
  }
}
```

### 5.2 Server-added fields

On create the server augments `meta` and stores private data never returned to a reader:

- `meta.created` — integer Unix seconds (server clock).
- `dth` — hex `SHA-256(deleteToken)` (**private**; stored, never serialized to a reader).

On read the server returns the stored object with `dth` removed and `meta.created` present.

### 5.3 Validation (fail-closed, prototype-pollution-safe)

Parsing is strict. The validator:

1. `JSON.parse`, then rebuild a clean object **field-by-field from an allowlist**. Untrusted
   objects are never spread/merged into a result. Own keys `__proto__`, `constructor`,
   `prototype` cause rejection.
2. Enforces, and rejects on any violation:
   - `v === 1`.
   - `ct`, `wk` are non-empty valid b64url within size caps (§6).
   - `adata` contains **exactly** the allowed keys — unknown keys are rejected.
   - `alg === "A256GCM"`.
   - `kdf ∈ {"hkdf","pbkdf2-hkdf"}`; `iter` is an integer, `=== 0` iff `kdf==="hkdf"`, else
     within `[ITER_MIN, ITER_MAX]` (§6).
   - `comp ∈ {"gzip","none"}`; `fmt ∈ {"plaintext","code","markdown"}`; `bar` is a boolean.
   - `ivc`, `ivw` decode to exactly 12 bytes; `skdf` decodes to exactly 16 bytes iff
     `kdf==="pbkdf2-hkdf"`, else is `""`.
   - `meta.expire` ∈ the allowed set.
3. Any malformed JSON, bad base64url, wrong type, wrong length, unknown field, unsupported
   version/alg, out-of-range iteration count, or pollution-shaped key ⇒ **HTTP 400**, no
   storage, no partial state.

---

## 6. Limits

| Constant         | Value        | Enforced where                                            |
|------------------|--------------|-----------------------------------------------------------|
| `MAX_PLAINTEXT`  | 1 MiB        | Client, before compression; and as decompression cap.     |
| `MAX_CT_B64`     | 3 000 000    | Server: max length of `ct` (b64url chars). Else **413**.  |
| `MAX_BODY`       | 4 MiB        | Server: max request body bytes. Else **413**.             |
| `MAX_BURN_RECORD`| 1 900 000    | Server: max serialized burn record (`{paste,dth,exp}` JSON chars) — SQLite-backed DO storage caps a value at ~2 MB, below what `MAX_CT_B64` admits. Burn creates over this get **413**; KV pastes are unaffected. |
| `ITER` (v1)      | 310000      | PBKDF2 iterations for new pastes.                         |
| `ITER_MIN`       | 100000      | Validation floor for `adata.iter` on password pastes.     |
| `ITER_MAX`       | 1000000     | Validation ceiling for `adata.iter`.                      |

---

## 7. Identifiers, storage classes, delete tokens

- **Paste id** = `classPrefix ‖ b64url(random(16))`, where `classPrefix ∈ {"k","b"}`:
  - `"k"` — normal paste, stored in **KV** (`PASTES`), immutable, with native TTL expiry.
  - `"b"` — burn-after-read paste, stored in the **`BurnPaste` Durable Object**.
  The 16 random bytes provide 128 bits of entropy independent of the 1-char class prefix.
  The read path selects the store by inspecting the prefix — no extra lookup.
- **Delete token** = `b64url(random(32))` (256 bits). The server stores only
  `dth = hex(SHA-256(deleteToken))`. On delete, the presented token is length/encoding
  validated, hashed, and compared to `dth` with a **timing-safe, fixed-length** comparison.
  The raw token is never stored.

---

## 8. Burn-after-read semantics (strict)

Burn pastes (`bar:true`, id prefix `"b"`) are stored in the `BurnPaste` Durable Object, one
instance per id (`idFromName(id)`). Because a DO instance is single-threaded, the consume
operation is **atomic**:

- The first `POST /api/paste/:id/consume` transactionally reads the blob, deletes it, and
  returns it (**200**).
- Any concurrent or subsequent consume finds no blob and returns **410 Gone**.
- Expiry is enforced by a DO `alarm` (set to `created + ttl`) and by a lazy check on read
  (an expired blob is deleted and yields 410).
- Consumption is **never reachable by `GET`**. A plain `GET` on a burn id (with or without
  `?meta=1`) returns the non-consuming head (below), so an ambient GET — an `<img>` tag, a
  navigation prefetch, a link-scanning bot — can never destroy a note whose id it learned.
  The consume request is deliberately CORS *non-simple*: it must be a `POST` carrying the
  custom header `X-Burn-Intent: consume`, which forces a cross-origin browser to preflight;
  the API serves no CORS headers, so the preflight fails and the consume never happens.
  Requests bearing `Sec-Fetch-Site: cross-site` are rejected outright (**403**) as defense
  in depth. Non-browser clients simply set the header.

This provides genuine single-consumer semantics that eventually-consistent KV cannot.

### Non-consuming metadata peek

A burn paste's *head* — `adata` and the wrapped key `wk`, but **never** the ciphertext `ct` —
is what any `GET /api/paste/:id` returns for a burn id, with or without `?meta=1`, and reading
it never consumes. This lets the client verify a password by unwrapping the CEK from `wk`
**before** the single destructive read, so a wrong or absent password never burns the paste
(only the explicit `POST …/consume` does). The content `ct` is never returned by a peek. The
client validates the peeked head
with the same fail-closed rules as §5.3 (minus `ct`) **before** deriving any key, so a hostile
response cannot demand an out-of-range `iter` or feed malformed fields into key derivation.

Trade-off: because `wk` is released without consuming, a password-protected paste's password is
subject to *offline* guessing by anyone who already holds the fragment secret `F`. Use a strong
password. This does not weaken the AES-256-GCM confidentiality/integrity of the content itself;
it only removes the "an attacker's guess also burns the note" side effect.

### Delete vs. expiry

`DELETE` on a burn id verifies the delete token and removes the record; unlike `peek`/`consume`
it does **not** apply a lazy expiry check first. A valid delete-token holder may therefore
delete a burn record that has expired but has not yet been purged by its `alarm`. This is
harmless — an expired record is destined for deletion either way, and only the token holder can
trigger it — and never releases content (`DELETE` returns no paste body).

---

## 9. Expiry

`meta.expire` maps to a TTL in seconds:

| key     | seconds   |   | key      | seconds    |
|---------|-----------|---|----------|------------|
| `5min`  | 300       |   | `1month` | 2592000    |
| `10min` | 600       |   | `1year`  | 31536000   |
| `1hour` | 3600      |   | `never`  | 0 (no TTL) |
| `1day`  | 86400     |   |          |            |
| `1week` | 604800    |   |          |            |

- KV pastes: passed as `expirationTtl` (omitted when `never`).
- Burn (DO) pastes: an `alarm` is scheduled at `created + ttl` (none when `never`).

---

## 10. HTTP API

| Method & path            | Body / params                    | Success        | Errors                          |
|--------------------------|----------------------------------|----------------|---------------------------------|
| `POST /api/paste`        | format v1 JSON (§5.1)            | `201` + result | `400` invalid · `413` too large · `415` wrong content-type · `429` rate-limited |
| `GET /api/paste/:id`     | — (burn ids: head only, no consume) | `200` + paste (KV) / head (burn) | `404` missing/expired · `410` burned/expired |
| `GET /api/paste/:id?meta=1` | — (head for every class, no consume) | `200` + head | `404` missing · `410` burned/expired |
| `POST /api/paste/:id/consume` | `X-Burn-Intent: consume` header (burn ids only) | `200` + paste | `400` missing header · `403` cross-site · `404` malformed/non-burn id · `410` burned/expired |
| `DELETE /api/paste/:id`  | `X-Delete-Token: <deleteToken>` header | `200`    | `400` missing token · `403` wrong token · `404` missing |

`POST /api/paste` requires `Content-Type: application/json` (parameters such as `charset`
are allowed); anything else is a `415`. This forces a CORS preflight for cross-origin browser
requests — since the API sends no CORS headers, a hostile page cannot create pastes from a
visitor's browser with a no-preflight `text/plain` POST. Any other method on `/api/paste`,
`/api/paste/:id`, or `/api/paste/:id/consume` returns `405` with an `Allow` header.

`GET /api/paste/:id` is **always safe**: for a KV id it returns the full paste; for a burn id
it returns only the head and never consumes. `?meta=1` returns the head (no `ct`) for every
storage class — ciphertext must not ride along on a metadata request. The only destructive
read is `POST /api/paste/:id/consume`, which requires the `X-Burn-Intent: consume` header
(making it CORS non-simple, §8); a missing/wrong header is a `400`, a `Sec-Fetch-Site:
cross-site` sender is a `403`, and a well-formed non-burn id is a `404`. The delete token is presented in the
`X-Delete-Token` request header — **never** in the URL — so the raw token cannot land in
request-URL logs (the server stores and compares only its SHA-256, §7). A *missing* token is a
`400`; a present-but-wrong or malformed token fails closed as `403`. Ids with malformed
percent-encoding are a `404`.

`POST` success result: `{ "id": "<id>", "deletetoken": "<deleteToken>" }`. The client builds
the shareable URL `"/p/" + id + "#" + b64url(F)` locally; **`F` is never sent to the server.**
Unlike the legacy PrivateBin API, real HTTP status codes are used (the client reads them).

**`404` vs `410` for burn ids.** A `404` means the id was malformed (failed structural
parsing). For a *well-formed* burn (DO) id, the Durable Object cannot distinguish "never
existed" from "already consumed or expired" — its single-consumer state is deleted on read —
so both return **`410 Gone`**, the honest answer. `404` for burn ids is therefore effectively
limited to malformed ids; KV (non-burn) ids return `404` for missing/expired as usual. This
per-storage-class asymmetry is deliberate and clients should treat `410` on a burn id as
"not available: never existed, already read, or expired".

**No CORS, by design.** The API serves no `Access-Control-*` headers. Browsers may call it
same-origin only (the official web client); non-browser clients (the CLI, scripts, other
spec implementations) are unaffected, since CORS is a browser-enforcement mechanism. The
absence of CORS is a load-bearing part of the abuse posture: together with the `415`
content-type requirement and the non-simple consume POST, it means a hostile third-party
page can neither create pastes from a visitor's browser nor destroy a one-time note whose
id it has learned. Do not add permissive CORS headers without revisiting §8 and the create
endpoint's protections.

---

## 11. Test vectors

Fixed vectors (pinned in `test/crypto.test.js`) use `comp="none"` for determinism and cover:

1. **No-password wrap/unwrap:** given `F`, `CEK`, `iv_wrap`, `AAD` ⇒ expected `wk`; unwrap
   returns `CEK`.
2. **Content encrypt/decrypt:** given `CEK`, `iv_content`, `AAD`, plaintext ⇒ expected `ct`;
   decrypt returns plaintext.
3. **Password wrap:** given `F`, `password`, `salt_kdf`, `iter`, `iv_wrap`, `AAD`, `CEK` ⇒
   expected `wk`; unwrap with correct `F`+password returns `CEK`; wrong password fails; `F`
   alone fails; password alone (wrong `F`) fails.
4. **AAD binding:** altering any `adata` field flips the AAD and causes decryption to fail.

Each vector records `F`, `password` (where applicable), `salt_kdf`, `iter`, `iv`, plaintext,
the exact `AAD` bytes, and expected ciphertext (hex), so any conforming Web Crypto
implementation reproduces them. They are regenerated with `node test/genvectors.mjs` (never
hand-edited) whenever this spec changes.
