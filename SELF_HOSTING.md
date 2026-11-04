# Self-hosting binthere

This guide deploys a separate binthere instance to your Cloudflare account. It uses one
Cloudflare Worker for the static site and API, a Workers KV namespace for legacy paste
records and the star snapshot, and the `BurnPaste` Durable Object for new one-time pastes.
Paste contents are encrypted by the client before upload. Self-hosting does not change that
protocol, but the browser must trust the JavaScript served by your deployment; see
[`SECURITY.md`](./SECURITY.md).

## Prerequisites

Required:

- A Cloudflare account with Workers enabled. A custom domain is optional; the `workers.dev`
  hostname is enough to start.
- Node.js 20 or later and npm. The repository's `.nvmrc` pins Node 22.
- Git and a terminal.
- A Cloudflare account member or API token authorized to create KV namespaces and deploy
  Workers. Wrangler's browser-based login is the simplest local setup.

Optional:

- A domain managed as an active Cloudflare zone, if you want a custom hostname.
- A GitHub fork if you plan to keep your deployment configuration and customizations in your
  own repository.

## Create or prepare a Cloudflare account

If you do not already have an account, [create one](https://dash.cloudflare.com/sign-up) and
verify the email address. Sign in to the dashboard and review the available Workers plan and
current pricing before proceeding. You do not need to create a Worker, KV namespace, or
Durable Object manually in the dashboard; Wrangler and the configuration below handle those
resources. If you plan to use a custom domain, first add that domain as an active Cloudflare
zone and complete any nameserver setup Cloudflare requests. A custom domain is optional for
initial deployment.

## 1. Clone and install

```bash
git clone https://github.com/nxfu/binthere.git
cd binthere
npm ci
```

If you deploy a fork, replace the clone URL with your fork's URL. Do not run commands against
the public binthere instance; all commands below operate on the account selected by Wrangler.

## 2. Create your configuration and KV namespaces

Start from the example configuration. This replaces the tracked origin configuration in your
local checkout; it does not change the upstream repository or Cloudflare resources.

```bash
cp wrangler.toml.example wrangler.toml
```

Authenticate Wrangler and confirm the account it will use:

```bash
npx wrangler login
npx wrangler whoami
```

Create a production KV namespace and a separate preview namespace:

```bash
npm run kv:create
```

The command prints IDs for both namespaces. Copy the production ID to `id` and the preview
ID to `preview_id` in the `[[kv_namespaces]]` block in `wrangler.toml`. These IDs are resource
identifiers, not credentials, but they must refer to namespaces in the account selected by
Wrangler. Keep the two IDs distinct.

The `CREATE_RL` rate-limit binding does not need a separately provisioned Cloudflare resource.
Its `namespace_id` is a positive integer that identifies the rate-limit namespace within your
Cloudflare account. Choose a value that is not used by another rate-limit binding in that
account, then set it as a quoted string in `wrangler.toml`. Bindings sharing that number in
the same account share counters. The configured per-location limit is abuse mitigation, not
authentication or a strict global cap; it can be exceeded. The check fails open if the binding
is unavailable.

The `BurnPaste` Durable Object namespace is declared by the `new_sqlite_classes` migration in
the configuration. Wrangler provisions it when the first deployment is created. Do not remove
or rename the migration for an existing deployment; Durable Object migration history is
persistent. No maintainer Durable Object ID is copied into your configuration.

## 3. Set your site identity (optional)

If your checkout includes `public/site-config.json` and the `configure-site` npm script, edit
that JSON file for your deployment. Set the canonical HTTPS origin, repository (`owner/name`),
developer and announcement URLs, and a security contact email. These values are public site
metadata, not secrets.

```bash
npm run configure-site
git diff -- public/index.html public/.well-known/security.txt wrangler.toml
```

Review the generated changes before continuing. The configurator writes crawler-facing page
metadata, security contact information, and the repository variable used by the stars
endpoint. If this optional configuration is absent in the version you checked out, skip this
section and set any supported branding fields in that version manually.

## 4. Run locally

```bash
npm run dev
```

Open <http://127.0.0.1:8787>. Default `wrangler dev` uses local storage emulation for KV and
Durable Objects; local writes do not go to your production namespaces. The native rate-limit
binding is not emulated, and the application fails open when it is unavailable locally. Do not
use `--remote` for ordinary development unless you intentionally want to use remote Cloudflare
resources.

Create a test paste, open it in a second browser context, and confirm that a successful read
consumes it. Restart local development and confirm that the local Worker still starts. For
automated checks, run the commands documented in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## 5. Deploy

Check that Wrangler is authenticated to the intended account, then deploy:

```bash
npx wrangler whoami
npm run deploy
```

On first deploy, Wrangler applies the Durable Object migration and creates the namespace for
`BurnPaste`. It publishes the Worker and static assets. If prompted, enable a `workers.dev`
subdomain for your account. With the example's `name = "binthere"`, the site is typically
available at `https://binthere.<your-subdomain>.workers.dev`.

The repository tracks `wrangler.toml` because Wrangler needs a config file to deploy. Replace
the example IDs with your own IDs before deployment. Treat `.dev.vars`, API tokens, and other
secret values as credentials: do not commit them, put them in source files, or paste them into
logs. This project does not require application secrets for its normal deployment.

## 6. Add a custom domain (optional)

A custom domain must be an active zone in your Cloudflare account, and the hostname cannot
already have a conflicting CNAME record. After deploying the Worker:

1. In the Cloudflare dashboard, open **Workers & Pages**, choose your `binthere` Worker, then
   **Settings → Domains & Routes → Add → Custom Domain**.
2. Enter the exact hostname you want, such as `paste.example.com`, and confirm.
3. Wait for Cloudflare to create the DNS record and issue the TLS certificate.
4. Visit the HTTPS hostname and complete the verification checklist below.

The custom domain points all paths on that hostname to the Worker. A domain at
`example.com` does not automatically include `www.example.com`; add a separate hostname or a
redirect if you want both. See Cloudflare's [Custom Domains documentation](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
for supported routing and certificate details.

## 7. Deployment verification checklist

- [ ] `npx wrangler whoami` shows the intended Cloudflare account.
- [ ] `wrangler.toml` binds `PASTES` to your own production KV ID and a distinct preview ID.
- [ ] The first deployment reports the `BurnPaste` SQLite migration successfully applied.
- [ ] The homepage and static assets load over HTTPS without browser console errors.
- [ ] A new test paste can be created, opened, decrypted, and consumed once.
- [ ] A second attempt to open that test paste reports it unavailable; do not use a real secret
      for this check.
- [ ] `GET /api/statistics` returns an aggregate response. Its baseline is zero for a fresh
      statistics deployment; it is not a reconstructed lifetime count.
- [ ] `GET /api/stars` may return `503` until the first scheduled snapshot succeeds; this does
      not prevent paste creation or reading.
- [ ] If configured, the custom hostname has a valid HTTPS certificate and serves the same
      application.
- [ ] Review the Cloudflare dashboard for Worker errors, binding status, usage, and billing
      alerts.

## Updates

To update an existing self-hosted deployment, fetch the latest changes and review them before
applying them. For a fork, add the official repository as `upstream` once, then fetch and
review it:

```bash
git remote add upstream https://github.com/nxfu/binthere.git
git fetch upstream
git log --oneline HEAD..upstream/main
git merge upstream/main
```

For a direct clone, use `origin` instead:

```bash
git fetch origin
git log --oneline HEAD..origin/main
git merge origin/main
```

After reviewing and merging the update, reinstall, verify, and deploy:

```bash
npm ci
npm run lint
npm test
npm run deploy
```

Review `wrangler.toml`, `wrangler.toml.example`, and the migration history whenever upstream
changes them. Preserve your KV IDs, site identity, and any custom domain configuration. Do not
remove a Durable Object migration that has already been applied. A deployment can change
Worker code immediately, while data already stored in your KV namespaces and Durable Objects
has its own lifecycle; code rollback does not restore deleted data.

## Troubleshooting

| Symptom | Checks |
| --- | --- |
| KV namespace not found or binding error | Confirm both IDs in `wrangler.toml` belong to the account shown by `npx wrangler whoami`; create missing namespaces with `npm run kv:create`. |
| Local development fails after copying the example | Placeholder KV IDs are intended for local emulation. Confirm `wrangler.toml` parses and that `npm ci` completed. |
| Deploy asks to apply a Durable Object migration | Review the `BurnPaste` migration in the config. On an existing deployment, do not delete or invent migration tags; deploy the repository's declared migration in sequence. |
| `workers.dev` returns an error shortly after first deploy | Confirm the Worker deployment succeeded and the `workers.dev` subdomain is enabled; allow DNS/edge provisioning time, then retry. |
| Custom domain does not resolve or has no certificate | Confirm the zone is active in the same account, remove any conflicting DNS record, and check the Worker’s Domains & Routes settings. |
| Statistics endpoint returns `503` | The aggregate store may be unavailable. Paste creation is designed not to depend on statistics writes; retry later and check Worker logs for storage errors. |
| Star badge is absent | The scheduled GitHub snapshot may not have run yet. Check the Cron Trigger and Worker logs; paste functionality is separate. |
| Local rate-limit behavior differs from production | Expected: the binding is not emulated by local Wrangler. Production limiting is approximate and fails open if unavailable. |

## Quotas and possible charges

Workers, KV, and Durable Objects have separate usage limits, included allowances, and billing
rules. Low-traffic personal use may fit within the current Free plan allowances, but this
cannot be guaranteed: traffic, stored data, request patterns, plan changes, and the resources
you enable can affect cost. Exceeding allowances can incur charges on a paid plan or be
throttled/limited on a free plan. Review the current [Workers pricing and limits](https://developers.cloudflare.com/workers/platform/pricing/),
[Workers KV pricing](https://developers.cloudflare.com/kv/platform/pricing/), and your account's
usage and billing dashboard before public launch. Enable budget or billing alerts where
available. Do not rely on quota values copied into this guide; Cloudflare may change them.

## Cloudflare references

- [Wrangler configuration and resource bindings](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Workers KV namespaces](https://developers.cloudflare.com/kv/concepts/kv-namespaces/)
- [Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
