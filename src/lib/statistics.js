// Anonymous aggregate paste-creation statistics. Shards are selected with
// fresh randomness independent of the paste ID, and receive no paste data.

export const STATISTICS_SHARDS = 16;

function shardStub(env, shard) {
  const name = `paste-creations-${shard.toString(16)}`;
  return env.PASTE_STATS.get(env.PASTE_STATS.idFromName(name));
}

/** Record one successful storage commit without delaying its HTTP response. */
export function recordPasteCreation(ctx, env) {
  const random = new Uint8Array(1);
  crypto.getRandomValues(random);
  const shard = random[0] & (STATISTICS_SHARDS - 1);

  // Statistics are best-effort and cannot turn an already stored paste into a
  // failed creation. Catch errors so waitUntil never carries a rejected promise.
  ctx.waitUntil(
    Promise.resolve()
      .then(() => shardStub(env, shard).increment())
      .catch(() => {}),
  );
}

/** Sum the independent shard totals for the public aggregate response. */
export async function readPasteCreationCount(env) {
  const counts = await Promise.all(
    Array.from({ length: STATISTICS_SHARDS }, (_, shard) => shardStub(env, shard).read()),
  );
  return counts.reduce((total, count) => total + count, 0);
}
