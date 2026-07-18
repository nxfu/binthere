// burn-do.js — BurnPaste Durable Object: strict, single-consumer burn-after-read
// (SPEC.md §8). One DO instance per paste id. Because a DO is single-threaded and
// every mutation runs inside blockConcurrencyWhile, the read-and-delete is atomic:
// the first consumer gets the ciphertext, everyone else gets "gone".

import { DurableObject } from 'cloudflare:workers';
import { verifyToken } from './lib/ids.js';

const KEY = 'rec';

export class BurnPaste extends DurableObject {
  /**
   * Store a burn paste. Returns false if this instance already holds one (an id
   * collision), so the caller can regenerate the id. `paste` excludes `dth`,
   * which is stored separately and never returned to a reader.
   */
  async create(paste, dth, ttlSec) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get(KEY)) return false;
      const exp = ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0;
      await this.ctx.storage.put(KEY, { paste, dth, exp });
      if (exp > 0) await this.ctx.storage.setAlarm(exp);
      return true;
    });
  }

  /**
   * Non-consuming metadata read: returns the paste head (everything EXCEPT the
   * ciphertext `ct`) so the client can verify a password before the single
   * destructive read. Does not delete. The content itself is never released here.
   */
  async peek() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const rec = await this.ctx.storage.get(KEY);
      if (!rec) return { status: 'gone' };
      if (rec.exp && Date.now() > rec.exp) { await this.#purge(); return { status: 'gone' }; }
      const p = rec.paste;
      return { status: 'ok', head: { v: p.v, wk: p.wk, adata: p.adata, meta: p.meta } };
    });
  }

  /** Atomically return-and-delete. { status:'ok', paste } once, then 'gone'. */
  async consume() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const rec = await this.ctx.storage.get(KEY);
      if (!rec) return { status: 'gone' };
      await this.#purge();
      if (rec.exp && Date.now() > rec.exp) return { status: 'gone' };
      return { status: 'ok', paste: rec.paste };
    });
  }

  /** Delete via delete token. 'ok' | 'bad' (wrong token) | 'notfound'. */
  async remove(token) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const rec = await this.ctx.storage.get(KEY);
      if (!rec) return { status: 'notfound' };
      if (!(await verifyToken(token, rec.dth))) return { status: 'bad' };
      await this.#purge();
      return { status: 'ok' };
    });
  }

  /** Alarm fires at expiry → drop the paste. */
  async alarm() {
    await this.#purge();
  }

  async #purge() {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
}
