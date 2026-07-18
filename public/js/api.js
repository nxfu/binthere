// api.js — same-origin fetch client for the paste API (connect-src 'self').
// Uses real HTTP status codes (unlike the legacy PrivateBin JSON-status hack).

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function readJson(res) {
  try { return await res.json(); } catch { return null; }
}

/** Create a paste. `body` is the format-v1 object. Returns { id, deletetoken }. */
export async function createPaste(body) {
  const res = await fetch('/api/paste', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await readJson(res);
  if (!res.ok) throw new ApiError((data && data.error) || 'Request failed.', res.status);
  return data;
}

/** Fetch (and, for burn pastes, consume) a paste. Returns the paste object. */
export async function fetchPaste(id) {
  const res = await fetch(`/api/paste/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!res.ok) {
    const data = await readJson(res);
    throw new ApiError((data && data.error) || 'Not found.', res.status);
  }
  const data = await readJson(res);
  if (!data) throw new ApiError('Malformed response.', 502);
  return data;
}

/**
 * Fetch a burn paste's head (adata + wrapped key, no ciphertext) WITHOUT
 * consuming it. Used to verify a password before the single destructive read.
 */
export async function fetchPasteMeta(id) {
  const res = await fetch(`/api/paste/${encodeURIComponent(id)}?meta=1`, { cache: 'no-store' });
  if (!res.ok) {
    const data = await readJson(res);
    throw new ApiError((data && data.error) || 'Not found.', res.status);
  }
  const data = await readJson(res);
  if (!data) throw new ApiError('Malformed response.', 502);
  return data;
}

/**
 * Delete a paste with its delete token. The token is sent in a header — never
 * in the URL — so it cannot end up in server/proxy request-URL logs.
 */
export async function deletePaste(id, token) {
  const res = await fetch(`/api/paste/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'x-delete-token': token },
  });
  const data = await readJson(res);
  if (!res.ok) throw new ApiError((data && data.error) || 'Delete failed.', res.status);
  return data;
}
