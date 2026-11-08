import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumePaste } from '../public/js/api.js';

afterEach(() => vi.unstubAllGlobals());

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
