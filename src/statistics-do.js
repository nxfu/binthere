// statistics-do.js — stores only one aggregate creation count per shard.
// No paste identifier, content, token, key, IP address, or request metadata is
// accepted by this object.

import { DurableObject } from 'cloudflare:workers';

const COUNT_KEY = 'successful-creations';

export class PasteStatistics extends DurableObject {
  async increment() {
    const count = (await this.ctx.storage.get(COUNT_KEY)) ?? 0;
    const next = count + 1;
    await this.ctx.storage.put(COUNT_KEY, next);
    return next;
  }

  async read() {
    return (await this.ctx.storage.get(COUNT_KEY)) ?? 0;
  }
}
