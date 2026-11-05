// stars.test.js — daily GitHub count refresh and the KV-backed public endpoint.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, afterEach } from 'vitest';
import { parseStars, fetchStars, readStoredStars, updateStarCount, STAR_COUNT_KEY } from '../src/lib/stars.js';

const ORIGIN = 'https://binthere.test';
const REPO_API = 'https://api.github.com/repos/nxfu/binthere';
const realFetch = globalThis.fetch;

function mockFetch(status, body) {
  const calls = [];
  globalThis.fetch = (input, init) => {
    calls.push(new Request(input, init));
    return Promise.resolve(new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      { status, headers: { 'content-type': 'application/json' } },
    ));
  };
  return calls;
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  await env.PASTES.delete(STAR_COUNT_KEY);
});

describe('GET /api/stars', () => {
  it('serves the stored count without calling GitHub', async () => {
    await env.PASTES.put(STAR_COUNT_KEY, '49');
    let requests = 0;
    globalThis.fetch = () => { requests++; return Promise.reject(new Error('unexpected GitHub request')); };

    const res = await SELF.fetch(`${ORIGIN}/api/stars`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stars: 49 });
    expect(res.headers.get('cache-control')).toBe('public, max-age=1800');
    expect(requests).toBe(0);
  });

  it('returns 503 before the first successful scheduled refresh', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/stars`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Star count has not been initialized yet.' });
  });

  it('rejects non-GET methods with an Allow header', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/stars`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });
});

describe('daily scheduled refresh', () => {
  it('makes one REST request and initializes KV on the first successful fetch', async () => {
    const calls = mockFetch(200, { stargazers_count: 49, full_name: 'nxfu/binthere' });
    const result = await updateStarCount(env);

    expect(result).toEqual({ status: 'initialized', stars: 49 });
    expect(await env.PASTES.get(STAR_COUNT_KEY)).toBe('49');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(REPO_API);
    expect(calls[0].headers.get('user-agent')).toBeTruthy();
  });

  it('skips the KV write when the count is unchanged', async () => {
    const writes = [];
    const fakeEnv = {
      GITHUB_REPOSITORY: 'nxfu/binthere',
      PASTES: {
        get: async () => '49',
        put: async (...args) => writes.push(args),
      },
    };
    mockFetch(200, { stargazers_count: 49 });

    expect(await updateStarCount(fakeEnv)).toEqual({ status: 'unchanged', stars: 49 });
    expect(writes).toEqual([]);
  });

  it('updates KV only when the count changes', async () => {
    const writes = [];
    const fakeEnv = {
      GITHUB_REPOSITORY: 'nxfu/binthere',
      PASTES: {
        get: async () => '48',
        put: async (...args) => writes.push(args),
      },
    };
    mockFetch(200, { stargazers_count: 49 });

    expect(await updateStarCount(fakeEnv)).toEqual({ status: 'updated', stars: 49 });
    expect(writes).toEqual([[STAR_COUNT_KEY, '49']]);
  });

  it('keeps the previous count when GitHub is unavailable', async () => {
    const writes = [];
    const fakeEnv = {
      GITHUB_REPOSITORY: 'nxfu/binthere',
      PASTES: {
        get: async () => '48',
        put: async (...args) => writes.push(args),
      },
    };
    mockFetch(403, { message: 'API rate limit exceeded' });

    expect(await updateStarCount(fakeEnv)).toEqual({ status: 'unavailable' });
    expect(writes).toEqual([]);
  });

  it('reads only valid stored integer counts', async () => {
    expect(await readStoredStars({ PASTES: { get: async () => '273' } })).toBe(273);
    for (const value of [null, '', '-1', '4.5', 'many', '9007199254740992']) {
      expect(await readStoredStars({ PASTES: { get: async () => value } })).toBeNull();
    }
  });

  it('returns null when a GitHub request fails', async () => {
    globalThis.fetch = () => Promise.reject(new Error('network down'));
    await expect(fetchStars('nxfu/binthere')).resolves.toBeNull();
    await expect(fetchStars('../invalid')).resolves.toBeNull();
  });
});

describe('parseStars', () => {
  it('accepts non-negative safe integer counts', () => {
    expect(parseStars({ stargazers_count: 0 })).toBe(0);
    expect(parseStars({ stargazers_count: 1234 })).toBe(1234);
  });

  it('rejects anything that is not a non-negative safe integer count', () => {
    for (const bad of [
      null, undefined, 'nope', 42, [], [{ stargazers_count: 5 }], {},
      { stargazers_count: null }, { stargazers_count: '5' }, { stargazers_count: -1 },
      { stargazers_count: 1.5 }, { stargazers_count: NaN },
      { stargazers_count: Number.MAX_SAFE_INTEGER + 1 },
    ]) expect(parseStars(bad)).toBeNull();
  });
});
