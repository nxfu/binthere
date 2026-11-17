import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureSite } from '../tools/configure-site.mjs';

const fixtures = [];
const targets = ['public/index.html', 'public/.well-known/security.txt', 'wrangler.toml'];
const config = {
  canonicalOrigin: 'https://paste.example.com', repository: 'example/notes',
  developerUrl: 'https://example.com/?x=1&y=2',
  announcementUrl: 'https://example.com/news', securityEmail: 'security@example.com',
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'binthere-site-'));
  fixtures.push(root);
  await mkdir(join(root, 'public/.well-known'), { recursive: true });
  await writeFile(join(root, 'public/site-config.json'), JSON.stringify(config));
  const markers = ['canonical-url', 'opengraph-image', 'repository-url', 'security-policy-url', 'developer-url', 'announcement-url'];
  await writeFile(join(root, targets[0]), markers.map((name) => (
    `<${name.endsWith('url') && name !== 'canonical-url' ? 'a href' : 'meta content'}="old" data-site="${name}">`
  )).join('\n'));
  await writeFile(join(root, targets[1]), 'Contact: old\nCanonical: old\nPolicy: old\nExpires: 2027-01-01T00:00:00.000Z\n');
  await writeFile(join(root, targets[2]), '[vars]\nGITHUB_REPOSITORY = "old/repo"\n');
  return root;
}

async function snapshot(root) {
  return Promise.all(targets.map((path) => readFile(join(root, path), 'utf8')));
}

afterEach(async () => {
  // Only remove directories created by this test's mkdtemp calls.
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('site identity configuration', () => {
  it('previews/checks without writes, applies all fields, and leaves repeat runs untouched', async () => {
    const root = await fixture();
    const before = await snapshot(root);
    expect((await configureSite({ root, check: true })).changed).toEqual(targets);
    expect((await configureSite({ root, dryRun: true })).changed).toEqual(targets);
    expect(await snapshot(root)).toEqual(before);
    expect((await configureSite({ root })).changed).toEqual(targets);
    const after = await snapshot(root);
    expect(after[0]).toContain('content="https://paste.example.com/"');
    expect(after[0]).toContain('href="https://example.com/?x=1&amp;y=2"');
    expect(after[0]).toContain('https://github.com/example/notes/blob/main/SECURITY.md');
    expect(after[1]).toContain('Contact: mailto:security@example.com');
    expect(after[1]).toContain('Canonical: https://paste.example.com/.well-known/security.txt');
    expect(after[1]).toContain('Expires: 2027-01-01T00:00:00.000Z');
    expect(after[2]).toContain('GITHUB_REPOSITORY = "example/notes"');
    const timestamps = await Promise.all(targets.map(async (path) => (await stat(join(root, path))).mtimeMs));
    expect((await configureSite({ root })).changed).toEqual([]);
    expect(await snapshot(root)).toEqual(after);
    expect(await Promise.all(targets.map(async (path) => (await stat(join(root, path))).mtimeMs))).toEqual(timestamps);
  });

  it.each([
    ['canonicalOrigin', 'javascript:alert(1)'], ['canonicalOrigin', 'https://example.com/path'],
    ['canonicalOrigin', 'https://user:pass@example.com'], ['repository', 'owner/repo/extra'],
    ['developerUrl', 'ftp://example.com'], ['securityEmail', 'bad\nContact: x@example.com'],
  ])('rejects invalid %s without touching targets', async (key, value) => {
    const root = await fixture();
    const before = await snapshot(root);
    await writeFile(join(root, 'public/site-config.json'), JSON.stringify({ ...config, [key]: value }));
    await expect(configureSite({ root })).rejects.toThrow();
    expect(await snapshot(root)).toEqual(before);
  });

  it.each([
    [0, 'data-site="developer-url"', 'data-site="missing"'],
    [1, 'Contact: old', 'Missing: old'],
    [1, 'Policy: old', 'Policy: old\nPolicy: duplicate'],
    [2, 'GITHUB_REPOSITORY', 'MISSING_REPOSITORY'],
    [2, 'GITHUB_REPOSITORY = "old/repo"', 'GITHUB_REPOSITORY = "old/repo"\nGITHUB_REPOSITORY = "duplicate/repo"'],
  ])('validates all targets before writing when file %i is malformed', async (index, from, to) => {
    const root = await fixture();
    const path = join(root, targets[index]);
    await writeFile(path, (await readFile(path, 'utf8')).replace(from, to));
    const before = await snapshot(root);
    await expect(configureSite({ root })).rejects.toThrow();
    expect(await snapshot(root)).toEqual(before);
  });
});
