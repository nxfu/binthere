#!/usr/bin/env node
// Apply public site identity only after every input and target has validated.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function requireUrl(value, name, { originOnly = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute URL`); }
  if (typeof value !== 'string' || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${name} must be an http(s) URL without credentials`);
  }
  if (originOnly && (url.pathname !== '/' || url.search || url.hash)) {
    throw new Error(`${name} must be an origin without a path`);
  }
  return url;
}

function replaceSetting(text, pattern, replacement, name) {
  if ([...text.matchAll(new RegExp(pattern.source, 'gm'))].length !== 1) {
    throw new Error(`expected exactly one ${name}`);
  }
  return text.replace(pattern, () => replacement);
}

/** Prepare all edits before writing; check/dry-run modes never modify files. */
export async function configureSite({ root = ROOT, check = false, dryRun = false } = {}) {
  const config = JSON.parse(await readFile(join(root, 'public/site-config.json'), 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('site configuration must be a JSON object');
  }
  const origin = requireUrl(config.canonicalOrigin, 'canonicalOrigin', { originOnly: true }).origin;
  const repository = config.repository;
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('repository must have the form owner/name');
  }
  const developerUrl = requireUrl(config.developerUrl, 'developerUrl').href;
  const announcementUrl = requireUrl(config.announcementUrl, 'announcementUrl').href;
  const email = config.securityEmail;
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('securityEmail must be an email address');
  }

  const paths = ['public/index.html', 'public/.well-known/security.txt', 'wrangler.toml'];
  const originals = await Promise.all(paths.map((path) => readFile(join(root, path), 'utf8')));
  let html = originals[0];
  const values = {
    'canonical-url': `${origin}/`,
    'opengraph-image': `${origin}/opengraph.png`,
    'repository-url': `https://github.com/${repository}`,
    'security-policy-url': `https://github.com/${repository}/blob/main/SECURITY.md`,
    'developer-url': developerUrl,
    'announcement-url': announcementUrl,
  };
  for (const [name, value] of Object.entries(values)) {
    const tags = new RegExp(`<[^>]*data-site="${name}"[^>]*>`, 'g');
    let seen = 0;
    html = html.replace(tags, (tag) => {
      const attr = ['canonical-url', 'opengraph-image'].includes(name) ? 'content' : 'href';
      const escaped = value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
      const pattern = new RegExp(`\\b${attr}="[^"]*"`);
      if (!pattern.test(tag)) throw new Error(`could not update ${name} in public/index.html`);
      seen++;
      return tag.replace(pattern, () => `${attr}="${escaped}"`);
    });
    if (!seen) throw new Error(`missing data-site marker ${name} in public/index.html`);
  }

  let security = originals[1];
  for (const [name, value] of Object.entries({
    Contact: `mailto:${email}`,
    Canonical: `${origin}/.well-known/security.txt`,
    Policy: `https://github.com/${repository}/blob/main/SECURITY.md`,
  })) {
    security = replaceSetting(security, new RegExp(`^${name}:.*$`, 'm'), `${name}: ${value}`, `security.txt ${name}`);
  }
  const wrangler = replaceSetting(originals[2], /^GITHUB_REPOSITORY\s*=\s*"[^"]*"$/m,
    `GITHUB_REPOSITORY = "${repository}"`, 'GITHUB_REPOSITORY in wrangler.toml');
  const prepared = [html, security, wrangler];
  const changed = paths.filter((_path, index) => prepared[index] !== originals[index]);
  if (!check && !dryRun) {
    for (let i = 0; i < paths.length; i++) {
      if (prepared[i] !== originals[i]) await writeFile(join(root, paths[i]), prepared[i]);
    }
  }
  return { origin, repository, changed };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => !['--check', '--dry-run'].includes(arg)) || new Set(args).size !== args.length
        || args.length > 1) {
      throw new Error('Usage: node tools/configure-site.mjs [--check | --dry-run]');
    }
    const check = args.includes('--check');
    const dryRun = args.includes('--dry-run');
    const result = await configureSite({ check, dryRun });
    console.log(`${check ? 'Checked' : dryRun ? 'Previewed' : 'Configured'} site identity for ${result.origin} (${result.repository}).`);
    console.log(result.changed.length ? `${check || dryRun ? 'Would update' : 'Updated'}: ${result.changed.join(', ')}` : 'All files are up to date.');
    if (check && result.changed.length) process.exitCode = 1;
  } catch (error) {
    console.error(`Site configuration failed: ${error.message}`);
    process.exitCode = 1;
  }
}
