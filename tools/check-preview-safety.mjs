import assert from 'node:assert/strict';
import { previewConfig, previewIdentity } from './prepare-preview.mjs';
import { verifiedPreviewURL, isCloudflarePreviewComment, removeCloudflarePreviewComments } from './report-preview.mjs';

const prod = 'a'.repeat(32), dev = 'b'.repeat(32), isolated = 'c'.repeat(32);
const raw = {
  name: 'binthere', main: 'src/index.js', compatibility_date: '2025-10-11',
  assets: { directory: './public', binding: 'ASSETS' },
  kv_namespaces: [{ binding: 'PASTES', id: prod, preview_id: dev }],
  vars: { GITHUB_REPOSITORY: 'nxfu/binthere', PRODUCTION_SECRET: 'must-not-inherit' },
  triggers: { crons: ['0 0 * * *'] }, routes: ['production.example/*'],
  durable_objects: { bindings: [{ name: 'BURN', class_name: 'BurnPaste', script_name: 'production' }] },
  ratelimits: [{ name: 'CREATE_RL', namespace_id: '1001' }],
  previews: { vars: { ALSO_UNTRUSTED: 'must-not-inherit' } },
};
const before = structuredClone(raw);
for (const branch of ['main', '', 'HEAD detached', '../bad', 'a'.repeat(257)]) {
  assert.throws(() => previewConfig(raw, branch, isolated, '/project'));
}
for (const id of [prod, dev, '', 'invalid']) {
  assert.throws(() => previewConfig(raw, 'feature/a', id, '/project'));
}
const config = previewConfig(raw, 'feature/a', isolated, '/project');
assert.deepEqual(raw, before);
assert.equal(config.main, '/project/src/index.js');
assert.equal(config.assets.directory, '/project/public');
assert.deepEqual(config.previews.kv_namespaces, [{ binding: 'PASTES', id: isolated }]);
assert.deepEqual(config.previews.durable_objects.bindings, [{ name: 'BURN', class_name: 'BurnPaste' }]);
assert.deepEqual(config.previews.vars, { GITHUB_REPOSITORY: 'nxfu/binthere' });
for (const value of [prod, dev, 'must-not-inherit', 'production.example', 'crons', 'script_name', '"1001"']) {
  assert.ok(!JSON.stringify(config).includes(value), value);
}
// Branches which collapse to the same URL slug must still have distinct storage.
assert.notDeepEqual(previewIdentity('binthere', 'feature/a'), previewIdentity('binthere', 'feature-a'));
assert.deepEqual(previewIdentity('binthere', 'feature/a'), previewIdentity('binthere', 'feature/a'));
const commit = 'd'.repeat(40);
const preview = { urls: ['https://feature-a-binthere.nxfu.workers.dev'] };
const deployment = { env: { PREVIEW_COMMIT: { text: commit } } };
assert.equal(verifiedPreviewURL(preview, deployment, commit), preview.urls[0]);
assert.equal(verifiedPreviewURL(preview, deployment, 'e'.repeat(40)), null);
for (const address of ['https://binthere.nxfu.workers.dev', 'https://binthere.gaury.dev', 'https://evil.example', 'https://feature-a-binthere.nxfu.workers.dev/#key']) {
  assert.equal(verifiedPreviewURL({ urls: [address] }, deployment, commit), null);
}
assert.equal(previewConfig(raw, 'feature/a', isolated, '/project', commit).previews.vars.PREVIEW_COMMIT, commit);
const cloudflare = { id: 1, user: { login: 'cloudflare-workers-and-pages[bot]' }, body: 'Preview: https://feature-a-binthere.nxfu.workers.dev' };
const actions = { id: 2, user: { login: 'github-actions[bot]' }, body: '<!-- binthere-preview -->\nPreview verified.' };
const otherWorker = { ...cloudflare, id: 3, body: 'Preview: https://feature-a-other.nxfu.workers.dev' };
const human = { ...cloudflare, id: 4, user: { login: 'nxfu' } };
assert.equal(isCloudflarePreviewComment(cloudflare), true);
assert.equal(isCloudflarePreviewComment({ ...cloudflare, body: 'Logs: https://dash.cloudflare.com/workers/services/view/binthere/production/builds/123' }), true);
for (const comment of [actions, otherWorker, human, null]) assert.equal(isCloudflarePreviewComment(comment), false);
const calls = [];
const github = async (path, method = 'GET') => {
  calls.push({ path, method });
  return method === 'GET' ? [cloudflare, actions, otherWorker, human] : null;
};
await removeCloudflarePreviewComments(github, 17);
assert.deepEqual(calls.filter(c => c.method === 'DELETE'), [{ path: '/issues/comments/1', method: 'DELETE' }]);
const withoutReplacement = [];
await removeCloudflarePreviewComments(async (path, method = 'GET') => {
  withoutReplacement.push({ path, method });
  return [cloudflare];
}, 17);
assert.ok(withoutReplacement.every(c => c.method === 'GET'));
console.log('Preview safety checks passed: production bindings excluded, branch storage distinct.');
