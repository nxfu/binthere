# Pull request previews

binthere uses native [Workers Previews](https://developers.cloudflare.com/workers/previews/)
under the existing `binthere` Worker. Production deploys only from `main`.
Previews are publicly accessible, so use disposable data when reviewing a PR.

Each branch has a stable URL, for example:

```
https://infra-isolated-pr-previews-binthere.nxfu.workers.dev
```

Cloudflare Builds posts the URL and deployment status on the PR. New pushes update
that branch's Preview; each deployment also has its own immutable URL. Different
branches keep independent code and data. No deployment workflow or Cloudflare
credential is added to GitHub Actions.

## Cloudflare Builds settings

For the Worker connected to `nxfu/binthere`:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Production build command | None |
| Production deploy command | `npx wrangler deploy` |
| Preview builds | Enabled, using native Workers Previews |
| Preview build command | `node tools/prepare-preview.mjs` |
| Preview deploy command | `npx wrangler preview --config .wrangler/preview/wrangler.json --ignore-base-config` |
| Root directory | `/` |
| Preview host | `workers.dev`, enabled |

Existing Workers connected to Builds require the
[one-time switch to Worker Previews](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/#existing-workers-connected-to-builds).
The migration replaces the legacy non-production trigger; it does not deploy code
to production, migrate production Durable Objects, or move production traffic.
Keep the production trigger restricted to `main`.

Wrangler is pinned to `4.158.0`, which supports Previews and reports their URLs to
Workers Builds. The minimum supported version is 4.135.0. `preview_urls = true`
keeps the workers.dev preview host enabled. The production custom domain is not
changed. Compatibility date and the existing DO migration remain unchanged.

## Resource isolation

`preview:prepare` reads `wrangler.toml` with the pinned Wrangler parser and writes
an ignored `.wrangler/preview/wrangler.json`. It constructs that file using an
allowlist; it never copies production bindings, credentials, routes, or cron
triggers into the Preview. The tracked config and example show the native
Preview DO binding; KV is deliberately supplied only after preparation.

| Resource | Preview behavior |
| --- | --- |
| `PASTES` KV | One account-level namespace per exact Worker/branch pair, named `<worker>-pr-<128-bit SHA-256 prefix>`. Reused on subsequent builds; never the production `id` or local development `preview_id`. |
| `BURN` Durable Objects | A separate native Preview namespace per branch, including the anonymous statistics shards. No `script_name` points to production. State survives updates to the same Preview. |
| `CREATE_RL` | Separate namespace ID derived from the Worker/branch hash, with the same 30 requests per 60 seconds limit. |
| Static Assets | Uploaded from the branch being built; the same CSP applies. |
| Variables | Only public `GITHUB_REPOSITORY` is passed to the Preview. |
| Runtime secrets | None needed. `--ignore-base-config` prevents accidental inheritance of future dashboard Base secrets/bindings. |
| Scheduled triggers | Cloudflare does not invoke cron handlers on Previews. Production's daily star refresh is unchanged. |

Native Previews automatically isolate Durable Objects, but
[do not automatically provision KV namespaces](https://developers.cloudflare.com/workers/previews/resources/).
The preparation script fills that gap without changing runtime code or the frozen
encryption protocol. The current app creates one-time, 24-hour DO pastes; KV is
still needed for legacy paste reads/deletes and the star snapshot. Since Preview
cron does not run, `/api/stars` can return 502 until a test snapshot is seeded in
that Preview's KV; this does not prevent creating or reading notes.

The preparation script rejects `main`, invalid branch names, and production/local
KV IDs. Provisioning errors abort the build, with no fallback to shared storage.
Builds require Workers Scripts edit and Workers KV edit permissions. The build
credential stays in Cloudflare Builds and is never a Worker runtime binding.
Repository contributors able to change build code are a trust boundary: runtime
isolation does not sandbox a malicious build script holding deployment credentials.
Do not give untrusted fork code a production-capable build token. Fork PRs need
maintainer review and a trusted same-repository branch before preview deployment.

## Local deployment and checks

Use Node 22+ for repository tooling (the separately published CLI supports Node
20+). Authenticate Wrangler to the intended account first, then run:

```sh
npm ci
npm run lint
npm run test:preview
npm test
npm run preview
```

`WORKERS_CI_BRANCH` supplies the branch in Workers Builds; local commands use the
current Git branch. Deploy with `npm run preview`, not bare `wrangler preview` or
`wrangler versions upload`. Version URLs use production resources and are not
isolated environments. Use the generated configuration with every manual
Preview deployment. Do not deploy that generated file to production.

Existing PR branches need the implementation commit (rebase or cherry-pick) before
the new build command can run. Their next push then provisions the Preview; an
old successful version-upload build does not become an isolated Preview retroactively.
Existing PRs are not merged, closed, or rewritten during setup.

To verify one or two live Preview origins with disposable encrypted data:

```sh
node tools/smoke-preview.mjs https://BRANCH-binthere.nxfu.workers.dev
node tools/smoke-preview.mjs https://FIRST-binthere.nxfu.workers.dev https://SECOND-binthere.nxfu.workers.dev
```

The smoke check keeps fragment secrets in memory and tests frontend delivery,
password-protected encryption/decryption, non-consuming metadata, eight concurrent
burn attempts (exactly one success), and cross-Preview DO isolation. The existing
workerd suite verifies expiry via DO alarms; a live 24-hour expiry requires waiting
the full supported retention period. Never shorten it by changing the protocol.

## Cleanup and retention

Cloudflare's Preview build settings expose `auto_delete`: deleting the tracked Git
branch deletes its Preview when enabled. Check that flag on the Preview. Closing
a PR alone does not delete its branch. This repository does not automatically
delete branches on merge, so retained branches retain their Previews. Delete a
finished branch when its Preview is no longer needed, or explicitly delete the
Preview from the dashboard. No existing branches are deleted during setup.

Deleting a Preview deletes its DO namespace and deployments. Its external KV
namespace is retained; Cloudflare does not delete account-level KV resources with
a Preview. After confirming no active Preview uses it, remove only the exact
`<worker>-pr-<hash>` namespace shown by the preparation log or the Preview's
bindings. Do not delete the production or local-development namespace. Until
removed, a retained namespace can keep legacy records and a star snapshot; the
current app stores new paste ciphertext in DOs instead.

There is no time-based Preview expiry. At the platform limit (100 Previews per
Worker on Free, 500 on paid), Cloudflare evicts the least recently deployed Preview.
Each Preview retains at most 100 deployments. This eviction also does not clean up
external KV. Check stale KV namespaces periodically, especially in a busy fork.

Previews, build minutes, KV operations/storage, Durable Object operations/storage,
and logs consume the account's normal allowances. Creating one namespace per
branch also consumes the KV namespace quota. See
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Builds pricing](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/),
and [KV limits](https://developers.cloudflare.com/kv/platform/limits/).
