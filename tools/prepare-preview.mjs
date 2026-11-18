// Build-time only. Provision branch storage, then let native Workers Previews
// deploy/report URLs. Never upload a version with production bindings.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { experimental_readRawConfig } from 'wrangler';

export function previewIdentity(worker, branch) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(worker)
      || typeof branch !== 'string' || branch === 'main'
      || !/^[a-zA-Z0-9]([a-zA-Z0-9\-_/.+=]*[a-zA-Z0-9])?$/.test(branch)
      || branch.length > 256) throw new Error('A valid non-production branch is required.');
  const hash = createHash('sha256').update(`${worker}\0${branch}`).digest('hex');
  return {
    namespaceTitle: `${worker}-pr-${hash.slice(0, 32)}`,
    // Separate from production 1001; stays within the signed 64-bit ID range.
    rateLimitId: (BigInt(`0x${hash.slice(0, 15)}`) + 10000n).toString(),
  };
}

export function previewConfig(raw, branch, namespaceId, root) {
  const identity = previewIdentity(raw.name, branch);
  if (!/^[a-f0-9]{32}$/.test(namespaceId)
      || raw.kv_namespaces?.some(ns => ns.id === namespaceId || ns.preview_id === namespaceId)) {
    throw new Error('Refusing an invalid, production, or local-development KV namespace.');
  }
  // Allowlist rather than cloning production config: no production variables,
  // secrets, routes, service bindings, cron triggers, or external DO namespaces.
  return {
    name: raw.name,
    account_id: raw.account_id,
    main: resolve(root, raw.main),
    compatibility_date: raw.compatibility_date,
    compatibility_flags: raw.compatibility_flags,
    assets: { ...raw.assets, directory: resolve(root, raw.assets.directory) },
    migrations: raw.migrations,
    observability: raw.observability,
    previews: {
      vars: { GITHUB_REPOSITORY: raw.vars?.GITHUB_REPOSITORY ?? 'nxfu/binthere' },
      kv_namespaces: [{ binding: 'PASTES', id: namespaceId }],
      durable_objects: { bindings: [{ name: 'BURN', class_name: 'BurnPaste' }] },
      ratelimits: [{ name: 'CREATE_RL', namespace_id: identity.rateLimitId, simple: { limit: 30, period: 60 } }],
    },
  };
}

async function prepare() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const configPath = resolve(root, 'wrangler.toml');
  const { rawConfig } = experimental_readRawConfig({ config: configPath });
  const branch = process.env.WORKERS_CI_BRANCH
    || execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
  const { namespaceTitle } = previewIdentity(rawConfig.name, branch);
  const require = createRequire(import.meta.url);
  const cli = resolve(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
  const wrangler = args => execFileSync(process.execPath, [cli, ...args, '--config', configPath], {
    cwd: root, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const find = () => JSON.parse(wrangler(['kv', 'namespace', 'list']))
    .find(ns => ns.title === namespaceTitle);
  let namespace = find();
  if (!namespace) {
    try {
      wrangler(['kv', 'namespace', 'create', namespaceTitle, '--update-config', 'false']);
    } catch (error) {
      // A simultaneous build may have won the create race. Never fall back to
      // production or a shared namespace if creation failed for another reason.
      namespace = find();
      if (!namespace) throw error;
    }
    namespace ??= find();
  }
  if (!namespace) throw new Error('Preview namespace was not provisioned.');
  const config = previewConfig(rawConfig, branch, namespace.id, root);
  const output = resolve(root, '.wrangler/preview/wrangler.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Prepared isolated KV ${namespace.title} (${namespace.id}) for ${branch}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepare();
}
