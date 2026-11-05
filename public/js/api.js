// api.js — same-origin fetch client for the paste API (connect-src 'self').
// Uses real HTTP status codes (unlike the legacy PrivateBin JSON-status hack).
// Success responses are shape-validated here, at the trust boundary, so a
// server/proxy regression fails closed as a protocol error instead of leaking
// into UI state (e.g. a "/p/undefined#…" share link).

export class ApiError extends Error {
  constructor(message, status, consumeState = null, responseStatus = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.consumeState = consumeState;
    this.responseStatus = responseStatus;
  }
}

async function readJson(res) {
  try { return await res.json(); } catch { return null; }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const malformed = () => new ApiError('Malformed response.', 502);

/** A success body that must be a JSON object (paste/head; validated further by format.js). */
function requireObject(data) {
  if (!isPlainObject(data)) throw malformed();
  return data;
}

async function throwHttpError(res, fallback, consumeState = null) {
  const data = await readJson(res);
  throw new ApiError(
    (isPlainObject(data) && typeof data.error === 'string' && data.error) || fallback,
    res.status,
    consumeState,
    res.status,
  );
}

/** Create a paste. `body` is the format-v1 object. Returns { id, deletetoken }. */
export async function createPaste(body) {
  const res = await fetch('/api/paste', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwHttpError(res, 'Request failed.');
  const data = await readJson(res);
  if (!isPlainObject(data)
      || typeof data.id !== 'string' || data.id.length === 0
      || typeof data.deletetoken !== 'string' || data.deletetoken.length === 0) {
    throw malformed();
  }
  return { id: data.id, deletetoken: data.deletetoken };
}

/** Fetch a paste (never consumes — burn ids answer with their head). */
export async function fetchPaste(id) {
  const res = await fetch(`/api/paste/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!res.ok) await throwHttpError(res, 'Not found.');
  return requireObject(await readJson(res));
}

/**
 * Fetch a paste's head (adata + wrapped key, no ciphertext). For burn pastes
 * this is the non-consuming peek used to verify a password/key before the
 * single destructive read.
 */
export async function fetchPasteMeta(id) {
  const res = await fetch(`/api/paste/${encodeURIComponent(id)}?meta=1`, { cache: 'no-store' });
  if (!res.ok) await throwHttpError(res, 'Not found.');
  return requireObject(await readJson(res));
}

/**
 * The single destructive read of a burn paste. Deliberately a non-simple
 * request (POST + custom header, SPEC §10): consumption must never be
 * reachable by an ambient cross-origin GET.
 */
export async function consumePaste(id) {
  let url;
  try {
    url = `/api/paste/${encodeURIComponent(id)}/consume`;
  } catch {
    throw new ApiError('Could not prepare the consume request.', 0, 'not-sent');
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'x-burn-intent': 'consume' },
      cache: 'no-store',
    });
  } catch {
    // Once fetch has been invoked, a rejected promise cannot establish whether
    // the Worker received and consumed the paste.
    throw new ApiError('No response was received for the consume request.', 0, 'unknown');
  }

  if (!res.ok) {
    const consumeState = res.status >= 500 ? 'unknown' : 'response';
    await throwHttpError(res, 'Consume request failed.', consumeState);
  }

  const data = await readJson(res);
  if (!isPlainObject(data)) {
    throw new ApiError('Malformed consume response.', 502, 'unknown', res.status);
  }
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
  if (!res.ok) await throwHttpError(res, 'Delete failed.');
  const data = await readJson(res);
  if (!isPlainObject(data) || data.status !== 'deleted') throw malformed();
  return data;
}
