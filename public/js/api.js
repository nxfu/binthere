// api.js — same-origin fetch client for the paste API (connect-src 'self').
// Every request has a deadline that covers both the response headers and body.
// Burn consumption is destructive: after fetch is invoked, a timeout or lost
// response cannot tell us whether the Worker consumed the paste.

export const REQUEST_TIMEOUTS_MS = Object.freeze({
  create: 15_000,
  read: 15_000,
  peek: 15_000,
  consume: 20_000,
  delete: 15_000,
});

export class ApiError extends Error {
  constructor(message, status, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    Object.assign(this, details);
  }
}

async function readJson(res) {
  try {
    return await res.json();
  } catch (error) {
    // Preserve abort/network errors so the request wrapper can distinguish a
    // deadline or dropped body from an ordinary malformed JSON response.
    if (error?.name === 'AbortError') throw error;
    if (error instanceof TypeError) throw error;
    return null;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const malformed = (details = {}) => new ApiError('Malformed response.', 502, details);

/** A success body that must be a JSON object (paste/head; validated further by format.js). */
function requireObject(data, details) {
  if (!isPlainObject(data)) throw malformed(details);
  return data;
}

async function throwHttpError(res, fallback, operation) {
  const data = await readJson(res);
  const details = { operation, responseStatus: res.status };
  if (operation === 'consume') {
    details.consumeState = res.status >= 500 ? 'unknown' : 'response';
  }
  if (['create', 'delete'].includes(operation) && res.status >= 500) {
    details.outcomeUnknown = true;
  }
  throw new ApiError(
    (isPlainObject(data) && typeof data.error === 'string' && data.error) || fallback,
    res.status,
    details,
  );
}

/** Run the whole request, including response parsing, with an abort deadline. */
async function withTimeout(operation, timeoutMs, perform) {
  const controller = new AbortController();
  let requestInvoked = false;
  let timedOut = false;
  let responseStatus = null;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const result = await perform(
      controller.signal,
      () => { requestInvoked = true; },
      (status) => { responseStatus = status; },
    );
    if (timedOut) {
      throw new ApiError(`The ${operation} request timed out.`, responseStatus ?? 0, {
        operation,
        timedOut: true,
        ...(responseStatus !== null ? { responseStatus } : {}),
        ...(operation === 'consume' ? {
          consumeState: responseStatus === null || responseStatus >= 500 ? 'unknown' : 'response',
        } : {}),
        ...(['create', 'delete'].includes(operation) && requestInvoked
          && (responseStatus === null || responseStatus >= 500 || responseStatus < 300)
          ? { outcomeUnknown: true } : {}),
      });
    }
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;

    if (timedOut) {
      throw new ApiError(`The ${operation} request timed out.`, responseStatus ?? 0, {
        operation,
        timedOut: true,
        ...(responseStatus !== null ? { responseStatus } : {}),
        ...(operation === 'consume' ? {
          consumeState: responseStatus === null || responseStatus >= 500 ? 'unknown' : 'response',
        } : {}),
        ...(['create', 'delete'].includes(operation) && requestInvoked
          && (responseStatus === null || responseStatus >= 500 || responseStatus < 300)
          ? { outcomeUnknown: true } : {}),
      });
    }

    // A rejected fetch after invocation may mean the request reached the Worker.
    // This matters for operations that consume, create, or delete state.
    throw new ApiError(`Could not reach the server during the ${operation} request.`, responseStatus ?? 0, {
      operation,
      networkError: true,
      ...(responseStatus !== null ? { responseStatus } : {}),
      ...(operation === 'consume' ? {
        consumeState: responseStatus === null || responseStatus >= 500 ? 'unknown' : 'response',
      } : {}),
      ...(['create', 'delete'].includes(operation) && requestInvoked
        && (responseStatus === null || responseStatus >= 500 || responseStatus < 300)
        ? { outcomeUnknown: true } : {}),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(operation, path, init, timeoutMs, fallback) {
  return withTimeout(operation, timeoutMs, async (signal, markInvoked, markResponse) => {
    markInvoked();
    const res = await fetch(path, { ...init, signal });
    markResponse(res.status);
    if (!res.ok) await throwHttpError(res, fallback, operation);
    return readJson(res);
  });
}

/** Create a paste. `body` is the format-v1 object. Returns { id, deletetoken }. */
export async function createPaste(body) {
  const operation = 'create';
  const data = await requestJson(operation, '/api/paste', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, REQUEST_TIMEOUTS_MS.create, 'Request failed.');

  if (!isPlainObject(data)
      || typeof data.id !== 'string' || data.id.length === 0
      || typeof data.deletetoken !== 'string' || data.deletetoken.length === 0) {
    throw malformed({ operation, outcomeUnknown: true });
  }
  return { id: data.id, deletetoken: data.deletetoken };
}

/** Fetch a paste (never consumes — burn ids answer with their head). */
export async function fetchPaste(id) {
  const data = await requestJson('read', `/api/paste/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  }, REQUEST_TIMEOUTS_MS.read, 'Not found.');
  return requireObject(data, { operation: 'read' });
}

/**
 * Fetch a paste's head (adata + wrapped key, no ciphertext). For burn pastes
 * this is the non-consuming peek used to verify a password/key before the
 * single destructive read.
 */
export async function fetchPasteMeta(id) {
  const data = await requestJson('peek', `/api/paste/${encodeURIComponent(id)}?meta=1`, {
    cache: 'no-store',
  }, REQUEST_TIMEOUTS_MS.peek, 'Not found.');
  return requireObject(data, { operation: 'peek' });
}

/**
 * The single destructive read of a burn paste. Deliberately a non-simple
 * request (POST + custom header, SPEC §10): consumption must never be
 * reachable by an ambient cross-origin GET.
 */
export async function consumePaste(id) {
  let path;
  try {
    path = `/api/paste/${encodeURIComponent(id)}/consume`;
  } catch {
    throw new ApiError('Could not prepare the consume request.', 0, { consumeState: 'not-sent' });
  }

  const data = await requestJson('consume', path, {
    method: 'POST',
    headers: { 'x-burn-intent': 'consume' },
    cache: 'no-store',
  }, REQUEST_TIMEOUTS_MS.consume, 'Consume request failed.');
  return requireObject(data, { consumeState: 'unknown', responseStatus: 200, operation: 'consume' });
}

/**
 * Delete a paste with its delete token. The token is sent in a header — never
 * in the URL — so it cannot end up in server/proxy request-URL logs.
 */
export async function deletePaste(id, token) {
  const data = await requestJson('delete', `/api/paste/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'x-delete-token': token },
  }, REQUEST_TIMEOUTS_MS.delete, 'Delete failed.');
  if (!isPlainObject(data) || data.status !== 'deleted') {
    throw malformed({ operation: 'delete', outcomeUnknown: true });
  }
  return data;
}
