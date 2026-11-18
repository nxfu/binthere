// Reporting only: no Cloudflare writes and no Worker deployment credential.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const marker = '<!-- binthere-preview -->';

export function isCloudflarePreviewComment(comment) {
  return comment?.user?.login === 'cloudflare-workers-and-pages[bot]'
    && typeof comment.body === 'string'
    && (comment.body.includes('-binthere.nxfu.workers.dev')
      || comment.body.includes('/workers/services/view/binthere/'));
}

export async function removeCloudflarePreviewComments(github, number) {
  const comments = [];
  for (let page = 1; ; page++) {
    const batch = await github(`/issues/${number}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  // Keep Cloudflare's link until our replacement is actually present. Collect
  // all pages before deleting so removals cannot shift pagination underneath us.
  if (!comments.some(c => c.user.login === 'github-actions[bot]' && c.body.includes(marker))) return;
  for (const comment of comments.filter(isCloudflarePreviewComment)) {
    await github(`/issues/comments/${comment.id}`, 'DELETE');
    console.log(`Removed duplicate Cloudflare deployment comment ${comment.id}.`);
  }
}

export function verifiedPreviewURL(preview, deployment, commit) {
  if (deployment?.env?.PREVIEW_COMMIT?.text !== commit) return null;
  const address = preview?.urls?.find(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && /^[a-z0-9-]+-binthere\.nxfu\.workers\.dev$/.test(url.hostname)
      && url.pathname === '/' && !url.search && !url.hash;
  });
  return address ?? null;
}

async function report() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repo = process.env.GITHUB_REPOSITORY;
  const github = async (path, method = 'GET', body) => {
    const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method, headers: {
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json', 'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    // Another cleanup job may already have removed the same bot comment.
    if (method === 'DELETE' && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} failed: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  // issue_comment uses trusted default-branch code and no Cloudflare secret.
  // It catches native comments posted or edited after the reporting job ends.
  if (event.comment) {
    if (!event.issue?.pull_request || !isCloudflarePreviewComment(event.comment)) return;
    await removeCloudflarePreviewComments(github, event.issue.number);
    return;
  }
  const pr = event.pull_request;
  if (!pr || pr.base.ref !== 'main' || pr.head.repo?.full_name !== repo) {
    throw new Error('Reporting supports same-repository PRs against main only.');
  }
  const environment = `preview/pr-${pr.number}`;
  if (event.action === 'closed') {
    const deployments = await github(`/deployments?environment=${encodeURIComponent(environment)}&per_page=100`);
    for (const deployment of deployments) {
      await github(`/deployments/${deployment.id}/statuses`, 'POST', { state: 'inactive' });
    }
    await removeCloudflarePreviewComments(github, pr.number);
    console.log('GitHub Preview deployments marked inactive. Native branch-deletion cleanup is unchanged.');
    return;
  }
  if (!process.env.CLOUDFLARE_PREVIEW_READ_TOKEN) throw new Error('CLOUDFLARE_PREVIEW_READ_TOKEN is not configured.');
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!/^[a-f0-9]{32}$/.test(account ?? '')) throw new Error('Invalid Cloudflare account ID.');
  const cf = async path => {
    // Deliberately GET-only; the token must have metadata read permissions only.
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/workers/binthere${path}`, {
      headers: { authorization: `Bearer ${process.env.CLOUDFLARE_PREVIEW_READ_TOKEN}` },
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Cloudflare metadata read failed: HTTP ${response.status}`);
    const body = await response.json();
    if (!body.success) throw new Error('Cloudflare metadata read was unsuccessful.');
    return body.result;
  };
  const deployment = await github('/deployments', 'POST', {
    ref: pr.head.sha, environment, auto_merge: false, required_contexts: [],
    transient_environment: true, production_environment: false,
    description: 'Native Cloudflare Worker Preview',
  });
  await github(`/deployments/${deployment.id}/statuses`, 'POST', { state: 'in_progress' });
  try {
    let url;
    for (let attempt = 0; attempt < 60; attempt++) {
      const preview = await cf(`/previews/${encodeURIComponent(pr.head.ref)}`);
      if (preview) {
        const deployments = await cf(`/previews/${preview.id}/deployments?per_page=1`);
        url = verifiedPreviewURL(preview, deployments?.[0], pr.head.sha);
        if (url) {
          const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
          if (response.status === 200) break;
          url = null;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
    if (!url) throw new Error('No healthy Preview for this exact commit after ten minutes.');
    // Avoid posting an older run's result if the PR advanced or closed meanwhile.
    const current = await github(`/pulls/${pr.number}`);
    if (current.state !== 'open' || current.head.sha !== pr.head.sha) {
      await github(`/deployments/${deployment.id}/statuses`, 'POST', { state: 'inactive' });
      return;
    }
    await github(`/deployments/${deployment.id}/statuses`, 'POST', {
      state: 'success', environment_url: url, description: 'Verified deployed commit and HTTP 200',
      auto_inactive: true,
    });
    const body = `${marker}\nPreview: ${url}\n\nDeployed commit: \`${pr.head.sha.slice(0, 12)}\`. Native Cloudflare Builds updates this stable URL after each successful build. Use disposable data.`;
    // PR discussions may be long. Paginate before deciding whether to create.
    let existing;
    for (let page = 1; !existing; page++) {
      const comments = await github(`/issues/${pr.number}/comments?per_page=100&page=${page}`);
      existing = comments.find(c => c.user.login === 'github-actions[bot]' && c.body.includes(marker));
      if (comments.length < 100) break;
    }
    if (existing) await github(`/issues/comments/${existing.id}`, 'PATCH', { body });
    else await github(`/issues/${pr.number}/comments`, 'POST', { body });
    console.log(`Verified Preview reported on PR #${pr.number}: ${url}`);
  } catch (error) {
    await github(`/deployments/${deployment.id}/statuses`, 'POST', { state: 'failure', description: 'Preview URL reporting failed; inspect workflow logs' });
    throw error;
  }
  await removeCloudflarePreviewComments(github, pr.number);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await report();
