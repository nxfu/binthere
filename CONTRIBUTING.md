# Contributing to binthere

Thanks for your interest in binthere. Issues and PRs are welcome.

**Read this first:** binthere is a **security-sensitive cryptographic application, not a normal
web app.** A bug here can leak the very secrets the app exists to protect. Before touching
anything, skim [`SPEC.md`](./SPEC.md) (the frozen protocol + paste format v1) and
[`SECURITY.md`](./SECURITY.md) (threat model and non-goals). [`ARCHITECTURE.md`](./ARCHITECTURE.md)
covers the request path.

## The two hard rules

Everything else is negotiable. These are not:

1. **Crypto is spec-first.** Any change to the cryptographic protocol, the paste format, or the
   canonical AAD **must** update [`SPEC.md`](./SPEC.md) **first** — never silently — then
   regenerate the frozen test vectors with `node test/genvectors.mjs`: paste its output into
   `test/crypto.test.js` **and** refresh the pinned copy CI diffs against
   (`node test/genvectors.mjs > test/vectors.expected.txt`). Never edit the pinned hexes by
   hand. The format is versioned (`v`); a format-breaking change ships under a new `v`,
   keeping older links working.
2. **Keep the CSP strict and rendering XSS-safe.** In this app, **XSS = key exfiltration.** No
   inline styles or scripts, no CDNs, no `innerHTML` on user content. Decrypted/user content is
   rendered with `createElement` + `textContent` only. Any new rendering path needs a case in
   `test/markdown.test.js`.

## Getting set up

Requires Node.js ≥ 20 (`.nvmrc` pins 22) and npm. From the `binthere/` directory:

```bash
npm install
npm run dev      # wrangler dev → http://127.0.0.1:8787 (KV + DO + rate limit emulated locally)
npm test         # vitest in the real workerd runtime — all suites
npm run test:watch   # same, watch mode
npm run test:coverage  # istanbul coverage (v8 provider can't run inside workerd)
npm run lint     # ESLint 9 flat config (eslint.config.js)
```

There is **no frontend build step**: `public/js/*.js` are native ES modules served as-is. The
Worker under `src/` is bundled by wrangler. In `wrangler dev`, `request.cf` is absent, so
country/edge-only behavior won't show locally.

## Where things live

| Area | Files |
|---|---|
| **Format & AAD** (shared browser + Worker) | `public/js/format.js` — change ⇒ bump `v`, update `SPEC.md`, add vectors |
| **Crypto primitives** | `public/js/crypto.js`, `public/js/bytes.js` |
| **Backend** | `src/index.js` (routing/limits/errors), `src/burn-do.js` (DO), `src/lib/*` (ids, store, ratelimit) |
| **Frontend** | `public/index.html`, `public/css/styles.css`, `public/js/{api,ui,app,markdown}.js` |
| **CSP** | `public/_headers` |
| **Config** | `wrangler.toml` (assets, KV `PASTES`, `BurnPaste` DO + migration, `CREATE_RL`) — tracked in git; for your own deployment replace the KV ids (pristine template: `wrangler.toml.example`) |
| **Tests** | `test/*.test.js` (+ `test/genvectors.mjs` vector regenerator, `test/vectors.expected.txt` pinned output, `tools/verify-vectors.py` Python cross-check) |
| **CI** | `.github/workflows/ci.yml` — lint + byte-for-byte vector diff + full suite on every push/PR |

`public/js/{bytes,crypto,format,markdown}.js` are **shared** — the browser imports them as static
assets and the Worker bundles the same files, so the paste format stays a single source of truth.
Keep these modules dependency-light and free of Node/DOM globals *at import time* (functions may
use `document`; top-level code must not).

## Non-negotiable invariants

Beyond the two hard rules, preserve these (see [`SECURITY.md`](./SECURITY.md) and [`SPEC.md`](./SPEC.md) for the full rationale):

- **Fail closed.** All parsing/validation rejects on any anomaly. `public/js/format.js` is the
  single source of truth for format v1 and is prototype-pollution-safe. Keep it that way.
- **CSPRNG only.** Every key/IV/salt/id/token uses `crypto.getRandomValues` — never
  `Math.random`. IVs are never reused per key.
- **Burn-after-read stays atomic.** It lives in the `BurnPaste` Durable Object under
  `blockConcurrencyWhile`. Don't move burn semantics to KV (eventual consistency breaks
  single-consumer). Keep `test/burn.test.js` green.
- **Real HTTP status codes** — don't revert to a PrivateBin-style "always 200".
- **No new third-party runtime dependencies** on the client (no CDN scripts, no bundled libs
  beyond the vendored MIT `qrcode.js`). Fonts stay self-hosted in `public/fonts/`.

## Tests

Every PR must keep `npm run lint` and `npm test` green (CI enforces both, plus a byte-for-byte
diff of `node test/genvectors.mjs` output against `test/vectors.expected.txt`). The suites
(all run in `workerd`):

| Suite | Covers |
|---|---|
| `test/crypto.test.js` | Frozen crypto vectors — regenerate with `node test/genvectors.mjs` when the spec changes (also refresh `test/vectors.expected.txt`) |
| `test/format.test.js` | Paste format v1 parsing / fail-closed behavior |
| `test/markdown.test.js` | Markdown XSS safety — **add a case for any new rendering path** |
| `test/highlight.test.js` | Code tokenizer / classification |
| `test/ids.test.js` | ID and delete-token generation |
| `test/burn.test.js` | Backend API + atomic single-consumer burn concurrency + password peek |

Add or update tests alongside behavior changes. New rendering paths and any crypto/format change
**require** test coverage, not just passing existing suites.

**Coverage honesty:** the DOM-driven frontend (`public/js/{app,ui,api,theme,theme-init}.js`) has
no automated coverage — there is no browser test harness — so changes there need a manual pass
in `wrangler dev`. Backend, crypto, and the shared pure modules are covered by the suites above.

> [!NOTE]
> **Windows:** after the suite passes you may see `vitest-pool-worker: Unable to remove
> temporary directory: EBUSY …` lines at teardown. This is cosmetic miniflare temp-dir cleanup
> noise on Windows — the tests have already passed; it does not indicate a failure.

## Pull requests

1. Keep changes focused; one logical concern per PR.
2. Update the relevant docs when behavior changes: `SPEC.md` (protocol/format), `SECURITY.md`
   (threat model), `ARCHITECTURE.md` (request path), `README.md` (user-facing), and add a
   `## [Unreleased]` entry to [`CHANGELOG.md`](./CHANGELOG.md).
3. Run `npm run lint` and `npm test` and confirm everything passes before opening the PR.
4. Describe **what** changed and **why**, and call out anything you could not verify.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`
(e.g. `feat(burn): verify password before consuming`, `fix(...)`, `docs(...)`, `test(...)`,
`chore(...)`, `refactor(...)`). Prefer a few small, self-contained commits over one large one.

## Reporting vulnerabilities

**Do not open a public issue with exploit details.** Report suspected vulnerabilities privately
to the maintainer at [nxfu@proton.me](mailto:nxfu@proton.me) with reproduction steps and
affected versions, per [`SECURITY.md`](./SECURITY.md) §8. There is no bug-bounty program.

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](./LICENSE).
