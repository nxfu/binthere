import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumePaste, createPaste, deletePaste, fetchPaste, REQUEST_TIMEOUTS_MS } from '../public/js/api.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('consumePaste error certainty', () => {
  it.each([
    [404, 'response'],
    [410, 'response'],
    [429, 'response'],
    [500, 'unknown'],
    [503, 'unknown'],
  ])('preserves HTTP %i as a distinct consume outcome', async (status, consumeState) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'failed' }), { status }));
    vi.stubGlobal('fetch', fetch);

    await expect(consumePaste('b-example')).rejects.toMatchObject({
      name: 'ApiError',
      status,
      consumeState,
      responseStatus: status,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('marks a lost fetch response as ambiguous and never retries', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('network lost'));
    vi.stubGlobal('fetch', fetch);

    await expect(consumePaste('b-example')).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      consumeState: 'unknown',
      responseStatus: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('marks a malformed success response as ambiguous', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>bad proxy</html>', { status: 200 })));

    await expect(consumePaste('b-example')).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      consumeState: 'unknown',
      responseStatus: 200,
    });
  });

  it('marks URL preparation errors as not sent', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(consumePaste('\ud800')).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      consumeState: 'not-sent',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('request deadlines cover response bodies', () => {
  function stallBody(status) {
    const fetch = vi.fn(async (_url, { signal }) => ({
      status,
      ok: status >= 200 && status < 300,
      json: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
    }));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it.each([[200, 'unknown'], [404, 'response'], [410, 'response'], [429, 'response'], [503, 'unknown']])(
    'keeps the correct consume certainty when HTTP %i body stalls', async (status, consumeState) => {
      vi.useFakeTimers();
      const fetch = stallBody(status);
      const result = consumePaste('b-example');
      const assertion = expect(result).rejects.toMatchObject({
        responseStatus: status, consumeState, timedOut: true,
      });
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUTS_MS.consume);
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('marks a dropped successful consume body as uncertain and clears its timer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200, ok: true, json: async () => { throw new TypeError('body connection lost'); },
    })));
    await expect(consumePaste('b-example')).rejects.toMatchObject({
      responseStatus: 200, consumeState: 'unknown', networkError: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['create', () => createPaste({})],
    ['delete', () => deletePaste('b-example', 'token')],
    ['read', () => fetchPaste('k-example')],
  ])('bounds %s body parsing and cleans up', async (operation, perform) => {
    vi.useFakeTimers();
    stallBody(200);
    const assertion = expect(perform()).rejects.toMatchObject({
      operation, timedOut: true, ...(['create', 'delete'].includes(operation) ? { outcomeUnknown: true } : {}),
    });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUTS_MS[operation]);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([['success', { id: 'b-example', deletetoken: 'token' }], ['malformed', null]])(
    'clears the timer after %s create response', async (_name, body) => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
      if (body) await expect(createPaste({})).resolves.toEqual(body);
      else await expect(createPaste({})).rejects.toMatchObject({ outcomeUnknown: true });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
