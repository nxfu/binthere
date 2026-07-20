// client.js — HTTP client for the paste API (SPEC.md §10). A port of
// public/js/api.js: same endpoints, same real-HTTP-status semantics, and the
// delete token travels only in the X-Delete-Token header — never in a URL.
// Differences from the browser client: an absolute, configurable base URL
// (the browser fetches same-origin) and an injectable fetch for tests. The
// `cache: 'no-store'` hint is dropped — Node's fetch has no HTTP cache.
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

// Server-supplied error strings are echoed to the user's terminal, so a
// hostile/compromised server must not be able to steer it: strip every C0/C1
// control character (including ESC — no ANSI/OSC injection) and cap the length.
function serverError(data, fallback) {
  const s = data && typeof data.error === 'string'
    // eslint-disable-next-line no-control-regex
    ? data.error.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 300)
    : '';
  return s || fallback;
}

// Node's fetch has no default timeout: without one, an unresponsive server
// hangs the CLI forever (and a burn `get` mid-consume would leave the user
// unsure whether the paste survived).
const TIMEOUT_MS = 30_000;

export class Client {
  constructor(server, fetchImpl = globalThis.fetch) {
    this.server = server;
    this.fetchImpl = fetchImpl;
  }

  async fetch(url, init) {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new ApiError(`No response from the server after ${TIMEOUT_MS / 1000}s.`, 0);
      }
      // Node buries the useful part ("ECONNREFUSED", "ENOTFOUND", TLS errors)
      // in e.cause and surfaces only "fetch failed" — name the host and the
      // real reason instead.
      if (e && e.name === 'TypeError') {
        const why = e.cause?.code ?? e.cause?.message ?? e.message;
        let host = '';
        try { host = ` ${new URL(url).host}` } catch { /* keep the bare message */ }
        throw new ApiError(`cannot reach the server${host}: ${why}`, 0);
      }
      throw e;
    }
  }

  /** Create a paste. `body` is the format-v1 object. Returns { id, deletetoken }. */
  async createPaste(body) {
    const res = await this.fetch(`${this.server}/api/paste`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await readJson(res);
    if (!res.ok) throw new ApiError(serverError(data, 'Request failed.'), res.status);
    if (!data || typeof data.id !== 'string' || typeof data.deletetoken !== 'string') {
      throw new ApiError('Malformed response.', 502);
    }
    return data;
  }

  /** Fetch a paste (never consumes — burn ids answer with their head). */
  async fetchPaste(id) {
    const res = await this.fetch(`${this.server}/api/paste/${encodeURIComponent(id)}`);
    if (!res.ok) {
      const data = await readJson(res);
      throw new ApiError(serverError(data, 'Not found.'), res.status);
    }
    const data = await readJson(res);
    if (!data) throw new ApiError('Malformed response.', 502);
    return data;
  }

  /**
   * The single destructive read of a burn paste. A non-simple POST with a
   * custom intent header (SPEC §10): consumption is never reachable through an
   * ambient GET, so link scanners/prefetchers can't destroy a note.
   */
  async consumePaste(id) {
    const res = await this.fetch(`${this.server}/api/paste/${encodeURIComponent(id)}/consume`, {
      method: 'POST',
      headers: { 'x-burn-intent': 'consume' },
    });
    if (!res.ok) {
      const data = await readJson(res);
      throw new ApiError(serverError(data, 'Not found.'), res.status);
    }
    const data = await readJson(res);
    if (!data) throw new ApiError('Malformed response.', 502);
    return data;
  }

  /**
   * Fetch a burn paste's head (adata + wrapped key, no ciphertext) WITHOUT
   * consuming it. Used to verify a password before the single destructive read.
   */
  async fetchPasteMeta(id) {
    const res = await this.fetch(`${this.server}/api/paste/${encodeURIComponent(id)}?meta=1`);
    if (!res.ok) {
      const data = await readJson(res);
      throw new ApiError(serverError(data, 'Not found.'), res.status);
    }
    const data = await readJson(res);
    if (!data) throw new ApiError('Malformed response.', 502);
    return data;
  }

  /**
   * Delete a paste with its delete token. The token is sent in a header — never
   * in the URL — so it cannot end up in server/proxy request-URL logs.
   */
  async deletePaste(id, token) {
    const res = await this.fetch(`${this.server}/api/paste/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'x-delete-token': token },
    });
    const data = await readJson(res);
    if (!res.ok) throw new ApiError(serverError(data, 'Delete failed.'), res.status);
    return data;
  }
}
