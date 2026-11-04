#!/usr/bin/env node
// Apply the public, non-secret site identity from public/site-config.json to
// the crawler-facing metadata, footer links, and security.txt before dev/deploy.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(ROOT, 'public/site-config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));

function requireUrl(value, name, { originOnly = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute URL`); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${name} must be an http(s) URL without credentials`);
  }
  if (originOnly && (url.pathname !== '/' || url.search || url.hash)) {
    throw new Error(`${name} must be an origin without a path`);
  }
  return url;
}

const origin = requireUrl(config.canonicalOrigin, 'canonicalOrigin', { originOnly: true }).origin;
const repository = String(config.repository ?? '');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error('repository must have the form owner/name');
}
const developerUrl = requireUrl(config.developerUrl, 'developerUrl').href;
const announcementUrl = requireUrl(config.announcementUrl, 'announcementUrl').href;
const email = String(config.securityEmail ?? '');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('securityEmail must be an email address');

const htmlPath = join(ROOT, 'public/index.html');
let html = await readFile(htmlPath, 'utf8');
const values = {
  'canonical-url': `${origin}/`,
  'opengraph-image': `${origin}/opengraph.png`,
  'repository-url': `https://github.com/${repository}`,
  'security-policy-url': `https://github.com/${repository}/blob/main/SECURITY.md`,
  'developer-url': developerUrl,
  'announcement-url': announcementUrl,
};
for (const [name, value] of Object.entries(values)) {
  const marker = `data-site="${name}"`;
  const tags = new RegExp(`<[^>]*${marker}[^>]*>`, 'g');
  let seen = 0;
  html = html.replace(tags, (tag) => {
    const attr = name === 'canonical-url' ? 'content'
      : name === 'opengraph-image' ? 'content' : 'href';
    const escaped = value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const pattern = new RegExp(`\\b${attr}="[^"]*"`);
    if (!pattern.test(tag)) throw new Error(`could not update ${name} in public/index.html`);
    seen++;
    return tag.replace(pattern, `${attr}="${escaped}"`);
  });
  if (seen === 0) throw new Error(`missing data-site marker ${name} in public/index.html`);
}
await writeFile(htmlPath, html);

const securityPath = join(ROOT, 'public/.well-known/security.txt');
let security = await readFile(securityPath, 'utf8');
security = security.replace(/^Contact:.*$/m, `Contact: mailto:${email}`)
  .replace(/^Canonical:.*$/m, `Canonical: ${origin}/.well-known/security.txt`)
  .replace(/^Policy:.*$/m, `Policy: https://github.com/${repository}/blob/main/SECURITY.md`);
await writeFile(securityPath, security);
const wranglerPath = join(ROOT, 'wrangler.toml');
let wrangler = await readFile(wranglerPath, 'utf8');
const repoVar = /^GITHUB_REPOSITORY\s*=\s*"[^"]*"$/m;
if (!repoVar.test(wrangler)) throw new Error('missing GITHUB_REPOSITORY in wrangler.toml');
wrangler = wrangler.replace(repoVar, `GITHUB_REPOSITORY = "${repository}"`);
await writeFile(wranglerPath, wrangler);
console.log(`Configured static site identity for ${origin} (${repository}).`);
