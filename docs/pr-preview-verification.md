# Preview rollout verification — 2026-11-18

Implementation: [PR #17](https://github.com/nxfu/binthere/pull/17), branch
`infra/isolated-pr-previews`. The implementation PR remains unmerged.

## Live environments

| PR | Stable Preview URL | Dedicated KV | Dedicated `BurnPaste` namespace |
| --- | --- | --- | --- |
| [#17](https://github.com/nxfu/binthere/pull/17) | https://infra-isolated-pr-previews-binthere.nxfu.workers.dev | `d0b7cc92ee464f9e8ef671ae5b88c029` | `da806e80af0b4372a2bb6f470a1f705b` |
| [#16](https://github.com/nxfu/binthere/pull/16) | https://docs-final-product-documentation-binthere.nxfu.workers.dev | `9ac14a77c07f4a6b8afb54eb4e99a6c2` | `3476fc377a07424c9a73d908b1767735` |

The production KV remains `fd20757b64cf4491a67a96b36263613e`; its DO namespace
remains `fb7eeb739e264a778cb7a52fc873240e`. Both Previews have separate rate-limit
namespace IDs, and no runtime secrets. No permanent Worker was created.

PR #16 received an empty commit solely to trigger its Preview registration; its
source tree was unchanged. Its temporary Cloudflare build override installs the
pinned Wrangler in an isolated tooling directory and fetches the preparation
script at immutable commit `bd0c1dbc2228ce66461cf8fee887bd3e0df3f60e`.
After incorporating the implementation, reset that Preview's build settings to
the standard commands in [the deployment guide](pr-previews.md).

## Verified

- Production custom domain returns HTTP 200. Its HTML SHA-256 was unchanged:
  `7a4a582898dc509e9d3decb81fb2f4abb0ae091c3be378f4ef81cd263fb840ba`.
- Production remains 100% on version `245afc1a-d4ac-45fa-8fff-433306bdf080`,
  deployment `dc4be63a-896b-448a-a670-d5e2df0093c9`, from before the rollout.
  The production build trigger still matches only `main`, using `npx wrangler deploy`.
- With maintainer approval, the legacy non-production trigger was migrated to
  native Worker Previews. Preview builds run preparation, then `wrangler preview`
  with the generated isolated config and `--ignore-base-config`.
- A real push to the implementation PR produced a successful native build and a
  new deployment at the same stable Preview URL. The KV and DO namespace IDs
  stayed constant across updates.
- Both live Preview pages and their JavaScript load. Their CSP remains strict;
  workers.dev serves `X-Robots-Tag: noindex`.
- Encrypted, password-protected create/read/decrypt round trips passed on both
  Previews. Eight concurrent consume attempts returned exactly one HTTP 200 and
  seven HTTP 410 responses; later consumes also returned 410.
- Each Preview returned 410 for the other Preview's burn paste ID. These test IDs
  were never queried against production's DOs, avoiding even empty production
  object instantiation.
- A Chromium browser check composed a note, checked that plaintext and the
  fragment key were absent from the creation request body, revealed/decrypted it,
  and confirmed a fresh page could not reread the consumed link.
- An encrypted disposable KV probe, written only to PR #17's KV with a 60-second
  TTL, expired. A prefix lookup in production KV returned no such key.
- Preview rate limiting returned HTTP 429 after approximate counters converged.
  An initial burst was allowed before synchronization; the subsequent sequential
  probe returned 40 HTTP 429 responses. Other Previews use different namespaces.
- Disposable [test PR #18](https://github.com/nxfu/binthere/pull/18) served
  `generation=1`, then a push served `generation=2` at the same stable URL. Closing
  the PR alone left HTTP 200. Deleting its test branch automatically removed the
  Preview and its DO namespace, and its URL returned 404. Its separately retained
  test KV namespace was then removed after checking that no active Preview used it.
- The reporting script created a real GitHub Deployment and linked the verified
  Preview URL directly on PR #17 when run locally with existing authenticated
  sessions. No credentials were uploaded to GitHub during that check. Its
  closed-PR path also marked a disposable GitHub Deployment inactive.

## Checks and limits

Lint, Preview safety assertions, the Wrangler production packaging dry run, and
the byte-for-byte crypto vector comparison passed. The existing suites passed:
151 workerd tests, 50 DOM tests, and 154 CLI tests. Coverage was 85.73% statements
and 80.50% branches, above the configured floors. GitHub's Linux, macOS, and
Windows CI checks also passed. Runtime and client cryptographic source was not
changed.

DO alarm expiry passed in the real workerd test suite. The application's full
24-hour live paste expiry was not waited out or shortened. The live short-TTL
check was for isolated KV storage, not the current DO paste lifecycle.

Native Cloudflare GitHub checks succeeded, but native URL comments did not appear
or update during verification, including on a fresh non-draft PR. The reporting
fallback was tested locally, but its GitHub Actions run currently fails because
`CLOUDFLARE_PREVIEW_READ_TOKEN` has not been configured. The existing Cloudflare
OAuth connection returned 403 for token management and lacks
`account-api-tokens.write`. Finishing automatic URL reporting requires either
securely setting the dedicated metadata-read repository secret, or reconnecting
with token-management permission so it can be provisioned. Do not substitute the
production deployment credential.

The account's npm 10 failed twice while replacing Wrangler in PR #16's existing
dependency tree (`edgesOut` error). Installing the pinned tool in a separate
directory resolved this; the final native build and live tests succeeded.

Future branches need the implementation's repository tooling, normally by merging
PR #17 after review. Other existing branches can rebase/cherry-pick it or receive
a similarly pinned temporary build override. Fork PRs require review and a trusted
same-repository branch; no production-capable credential is exposed to forks.

Native cleanup follows branch deletion, not PR closure. External KV requires
separate cleanup and consumes namespace quota while retained. Builds, KV, DOs,
runtime requests, observability, and the reporting job use their normal account
or GitHub allowances. No new subscription or permanent per-PR Worker is required.
