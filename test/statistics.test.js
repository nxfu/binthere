// statistics.test.js — privacy-preserving aggregate paste count.
import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { encryptPaste } from '../public/js/crypto.js';
import { recordPasteCreation } from '../src/lib/statistics.js';

const ORIGIN = 'https://binthere.test';
const JSON_HEADERS = { 'content-type': 'application/json' };
const readStatistics = () => SELF.fetch(`${ORIGIN}/api/statistics`);
const postPaste = (body) => SELF.fetch(`${ORIGIN}/api/paste`, {
  method: 'POST',
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

describe('anonymous paste statistics', () => {
  it('counts successful paste storage commits, not failed create requests', async () => {
    const initialResponse = await readStatistics();
    expect(initialResponse.status).toBe(200);
    const initial = await initialResponse.json();
    expect(initial).toMatchObject({
      baseline: 0,
      scope: 'successfully created pastes since statistics deployment',
    });

    expect((await postPaste({ not: 'a paste' })).status).toBe(400);
    const afterFailure = await readStatistics();
    expect(afterFailure.status).toBe(200);
    expect((await afterFailure.json()).totalPastes).toBe(initial.totalPastes);

    const { body } = await encryptPaste({ text: 'count only after storage succeeds' });
    const created = await postPaste(body);
    expect(created.status).toBe(201);
    const response = await readStatistics();
    expect(response.status).toBe(200);
    expect((await response.json()).totalPastes).toBe(initial.totalPastes + 1);
  });

  it('counts concurrent successful creations exactly once each', async () => {
    const before = (await (await readStatistics()).json()).totalPastes;
    const creations = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
      const { body } = await encryptPaste({ text: `concurrent ${i}` });
      return postPaste(body);
    }));
    expect(creations.every((response) => response.status === 201)).toBe(true);
    expect((await (await readStatistics()).json()).totalPastes).toBe(before + creations.length);
  });

  it('is public read-only and counter storage failures do not reject the caller', async () => {
    const write = await SELF.fetch(`${ORIGIN}/api/statistics`, { method: 'POST' });
    expect(write.status).toBe(405);
    expect(write.headers.get('allow')).toBe('GET');

    const pending = [];
    recordPasteCreation({ waitUntil: (promise) => pending.push(promise) }, {
      PASTE_STATS: { idFromName() { throw new Error('simulated unavailable counter'); } },
    });
    await expect(Promise.all(pending)).resolves.toEqual([undefined]);
  });
});
