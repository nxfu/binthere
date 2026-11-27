// burn-do.js — BurnPaste Durable Object: strict burn-after-read with a
// per-paste view budget (custom fork; upstream was strictly single-consumer).
// One DO instance per paste id. Because a DO is single-threaded and every
// mutation runs inside blockConcurrencyWhile, the read-and-decrement (and the
// final read-and-delete) is atomic: concurrent readers can never exceed the
// view budget, and the last reader destroys the record.

import { DurableObject } from 'cloudflare:workers';
import { verifyToken } from './lib/ids.js';

const KEY = 'rec';
const STATISTICS_KEY = 'anonymous-successful-creations';

export class BurnPaste extends DurableObject {
  /** Update an anonymous aggregate held in a statistics-only named instance. */
  async incrementStatistics() {
    const count = (await this.ctx.storage.get(STATISTICS_KEY)) ?? 0;
    const next = count + 1;
    await this.ctx.storage.put(STATISTICS_KEY, next);
    return next;
  }

  /** Read the aggregate from a statistics-only named instance. */
  async readStatistics() {
    return (await this.ctx.storage.get(STATISTICS_KEY)) ?? 0;
  }

  /**
   * Store a burn paste. Returns false if this instance already holds one (an id
   * collision), so the caller can regenerate the id. `paste` excludes `dth`,
   * which is stored separately and never returned to a reader. `views` is the
   * total read budget (>= 1; the Worker validates the range).
   */
  async create(paste, dth, ttlSec, views = 1) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get(KEY)) return false;
      const exp = ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0;
      const viewsLeft = Number.isInteger(views) && views >= 1 ? views : 1;
      await this.ctx.storage.put(KEY, { paste, dth, exp, viewsLeft });
      if (exp > 0) await this.ctx.storage.setAlarm(exp);
      return true;
    });
  }

  /**
   * Non-consuming metadata read: returns the paste head (everything EXCEPT the
   * ciphertext `ct`) so the client can verify a password before a destructive
   * read. Does not delete and does not spend a view. The head's meta carries
   * the server-attached `viewsLeft` and `expiresAt` (unix seconds, 0 = none)
   * so the reader UI can show the remaining budget and countdown.
   */
  async peek() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const rec = await this.ctx.storage.get(KEY);
      if (!rec) return { status: 'gone' };
      if (rec.exp && Date.now() > rec.exp) { await this.#purge(); return { status: 'gone' }; }
      const p = rec.paste;
      return {
        status: 'ok',
        head: { v: p.v, wk: p.wk, adata: p.adata, meta: this.#metaWithBudget(rec) },
      };
    });
  }

  /**
   * Atomically spend one view and return the paste. While views remain after
   * this read the record (and its expiry alarm) is kept with the decremented
   * budget; on the last view the record is purged before returning. The
   * returned paste's meta carries `viewsLeft` (after this read) + `expiresAt`.
   */
  async consume() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const rec = await this.ctx.storage.get(KEY);
      if (!rec) return { status: 'gone' };
      if (rec.exp && Date.now() > rec.exp) { await this.#purge(); return { status: 'gone' }; }
      const left = Number.isInteger(rec.viewsLeft) && rec.viewsLeft >= 1 ? rec.viewsLeft : 1;
      const after = left - 1;
      const paste = {
        ...rec.paste,
        meta: { ...rec.paste.meta, viewsLeft: after, expiresAt: rec.exp ? Math.floor(rec.exp / 1000) : 0 },
      };
      if (after > 0) {
        await this.ctx.storage.put(KEY, { ...rec, viewsLeft: after });
      } else {
        await this.#purge();
      }
      return { status: 'ok', paste };
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

  /**
   * Owner revoke via the admin API (custom fork): purge without a delete
   * token. The Worker only calls this after verifying the owner's create
   * token, so no per-paste credential is needed here. 'ok' | 'notfound'.
   */
  async destroy() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const rec = await this.ctx.storage.get(KEY);
      if (!rec) return { status: 'notfound' };
      await this.#purge();
      return { status: 'ok' };
    });
  }

  /** Alarm fires at expiry → drop the paste. */
  async alarm() {
    await this.#purge();
  }

  #metaWithBudget(rec) {
    const left = Number.isInteger(rec.viewsLeft) && rec.viewsLeft >= 1 ? rec.viewsLeft : 1;
    return {
      ...rec.paste.meta,
      viewsLeft: left,
      expiresAt: rec.exp ? Math.floor(rec.exp / 1000) : 0,
    };
  }

  async #purge() {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
}
