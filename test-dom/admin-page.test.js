// admin-page.test.js — the /admin page controller (public/js/admin.js)
// driven against a real DOM (happy-dom) with a stubbed fetch.
//
// Covers the pagination no-progress guard: the final page returns
// cursor=null, which on the first page equals the initial cursor — the
// guard must only fire on a repeated NON-NULL cursor, or empty and
// single-page lists would report "Malformed response." Also covers the
// token trim on submit (pasted tokens carry stray whitespace).
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const fetchCalls = [];
let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ pastes: [], cursor: null }) });

const jsonRes = (data) => ({ ok: true, status: 200, json: async () => data });
const statusText = () => document.getElementById('admin-status').textContent;

function submitWithToken(value) {
  const input = document.getElementById('admin-token');
  input.value = value;
  document.getElementById('admin-auth')
    .dispatchEvent(new Event('submit', { cancelable: true }));
}

beforeAll(async () => {
  // admin.js captures its elements at import time — build the DOM first.
  document.body.innerHTML = '';
  const form = document.createElement('form');
  form.id = 'admin-auth';
  const token = document.createElement('input');
  token.id = 'admin-token';
  form.appendChild(token);
  const status = document.createElement('p');
  status.id = 'admin-status';
  const wrap = document.createElement('div');
  wrap.id = 'admin-table-wrap';
  wrap.hidden = true;
  const rows = document.createElement('tbody');
  rows.id = 'admin-rows';
  wrap.appendChild(rows);
  document.body.append(form, status, wrap);

  vi.stubGlobal('fetch', async (path, opts) => {
    fetchCalls.push({ path, opts });
    return fetchImpl(path, opts);
  });
  await import('../public/js/admin.js');
});

beforeEach(() => {
  fetchCalls.length = 0;
  document.getElementById('admin-rows').replaceChildren();
});

describe('admin page — pagination cursor guard', () => {
  it('empty list (cursor null on first page) completes normally', async () => {
    fetchImpl = async () => jsonRes({ pastes: [], cursor: null });
    submitWithToken('tok');
    await vi.waitFor(() => expect(statusText()).toBe('No links yet.'));
    expect(fetchCalls).toHaveLength(1);
  });

  it('single-page list (cursor null) completes and renders', async () => {
    fetchImpl = async () => jsonRes({
      pastes: [{
        id: `b${'A'.repeat(22)}`, createdAt: 1700000000, expiresAt: 1700003600,
        viewsLeft: 1, viewsTotal: 2, kind: 'burn', note: 'hi', gone: false,
      }],
      cursor: null,
    });
    submitWithToken('tok');
    await vi.waitFor(() => expect(statusText()).toBe('1 link(s).'));
    expect(fetchCalls).toHaveLength(1);
    expect(document.getElementById('admin-rows').children).toHaveLength(1);
  });

  it('repeated non-null cursor still errors (no-progress guard)', async () => {
    fetchImpl = async () => jsonRes({ pastes: [], cursor: 'abc' });
    submitWithToken('tok');
    await vi.waitFor(() => expect(statusText()).toBe('Malformed response.'));
    expect(fetchCalls).toHaveLength(2); // first page + one repeat, then stop
  });

  it('multi-page list follows distinct cursors to the end', async () => {
    const pages = [
      { pastes: [], cursor: 'c1' },
      { pastes: [], cursor: 'c2' },
      { pastes: [], cursor: null },
    ];
    let i = 0;
    fetchImpl = async () => jsonRes(pages[i++]);
    submitWithToken('tok');
    await vi.waitFor(() => expect(statusText()).toBe('No links yet.'));
    expect(fetchCalls).toHaveLength(3);
  });
});

describe('admin page — token handling', () => {
  it('trims whitespace from the pasted token before sending', async () => {
    fetchImpl = async () => jsonRes({ pastes: [], cursor: null });
    submitWithToken('  tok-with-spaces \n');
    await vi.waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0].opts.headers['x-create-token']).toBe('tok-with-spaces');
  });
});
