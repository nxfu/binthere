// delete — remove a paste with its delete token. The token is supplied via
// --token-env or a hidden prompt (never a bare flag value, so it can't land in
// shell history/ps) and is sent only in the X-Delete-Token header (SPEC.md §10).
import { parseArgs } from 'node:util';
import { Client } from '../client.js';
import { UsageError } from '../errors.js';
import { resolveSecret } from '../secret.js';
import { DEFAULT_SERVER, parseUrlOrId } from '../url.js';

const OPTIONS = {
  'token-env': { type: 'string' },
  server: { type: 'string', short: 's' },
};

export async function cmdDelete(args, io) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true }));
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (positionals.length !== 1) {
    throw new UsageError('usage: binthere delete <share-url | id>');
  }

  const fallback = values.server ?? io.env.BINTHERE_SERVER ?? DEFAULT_SERVER;
  const { server, id } = parseUrlOrId(positionals[0], fallback);

  const token = await resolveSecret({
    envVar: values['token-env'],
    promptWanted: true,
    promptLabel: 'Delete token: ',
    io,
  });

  const client = new Client(server, io.fetch);
  await client.deletePaste(id, token);
  io.stderr(`deleted ${id}\n`);
  return 0;
}
