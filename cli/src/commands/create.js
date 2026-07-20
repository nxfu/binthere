// create — encrypt locally, POST ciphertext, print the share URL.
//
// Lifecycle matches the website exactly: every note is one-time view and
// deletes after one read, or after 24 hours (bar: true, expire: '1day') — the
// wire format supports more, but the clients don't expose it.
//
// stdout carries ONLY the share URL (or the --json object), so
// `binthere create | pbcopy` copies just the link; the delete token, lifecycle
// note, and optional --qr code go to stderr. The fragment secret F never leaves
// the process except inside the printed URL.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { encryptPaste, MAX_PLAINTEXT } from '../../vendor/crypto.js';
import { FORMATS } from '../../vendor/format.js';
import { Client } from '../client.js';
import { UsageError } from '../errors.js';
import { renderQr } from '../qr.js';
import { resolveSecret } from '../secret.js';
import { buildShareUrl, DEFAULT_SERVER, normalizeServer } from '../url.js';

export const EXPIRE = '1day';
export const LIFECYCLE_NOTE = 'deletes after one read, or in 24 hours';

const OPTIONS = {
  text: { type: 'string', short: 't' },
  file: { type: 'string', short: 'f' },
  fmt: { type: 'string', default: 'plaintext' },
  password: { type: 'boolean', default: false },
  'password-env': { type: 'string' },
  server: { type: 'string', short: 's' },
  json: { type: 'boolean', default: false, short: 'j' },
  qr: { type: 'boolean', default: false, short: 'q' },
};

export async function cmdCreate(args, io) {
  let values;
  try {
    // allowPositionals: false → parseArgs throws on any positional.
    ({ values } = parseArgs({ args, options: OPTIONS, allowPositionals: false, strict: true }));
  } catch (e) {
    throw new UsageError(e.message);
  }

  if (!FORMATS.includes(values.fmt)) {
    throw new UsageError(`invalid --fmt "${values.fmt}" (one of: ${FORMATS.join(', ')})`);
  }
  if (values.password && values['password-env'] !== undefined) {
    throw new UsageError('--password and --password-env are mutually exclusive');
  }
  if (values.text !== undefined && values.file !== undefined) {
    throw new UsageError('--text and --file are mutually exclusive');
  }

  const server = normalizeServer(values.server ?? io.env.BINTHERE_SERVER ?? DEFAULT_SERVER);

  let raw;
  if (values.text !== undefined) {
    raw = Buffer.from(values.text, 'utf8');
  } else if (values.file !== undefined) {
    try {
      raw = await readFile(values.file);
    } catch (e) {
      throw new UsageError(`cannot read --file ${values.file}: ${e.code ?? e.message}`);
    }
  } else {
    if (io.stdinIsTTY) {
      throw new UsageError('no input: pipe content on stdin, or pass --text <string> / --file <path>');
    }
    raw = await io.readStdin();
  }
  if (raw.byteLength === 0) throw new UsageError('refusing to create an empty paste');
  if (raw.byteLength > MAX_PLAINTEXT) {
    throw new UsageError('input too large (max 1 MiB before compression)');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new UsageError('input is not valid UTF-8 (binthere stores text)');
  }

  const password = await resolveSecret({
    envVar: values['password-env'],
    promptWanted: values.password,
    promptLabel: 'Password: ',
    io,
  });

  const { body, fragment } = await encryptPaste({
    text,
    password,
    fmt: values.fmt,
    bar: true,
    expire: EXPIRE,
  });

  const client = new Client(server, io.fetch);
  const { id, deletetoken } = await client.createPaste(body);
  const url = buildShareUrl(server, id, fragment);

  if (values.json) {
    io.stdout(JSON.stringify({ url, id, deletetoken, expire: EXPIRE, burn: true }) + '\n');
  } else {
    io.stdout(url + '\n');
    io.stderr(`delete token: ${deletetoken}\n`);
    io.stderr(`${LIFECYCLE_NOTE}\n`);
  }
  if (values.qr) {
    const qr = renderQr(url);
    if (qr) io.stderr(qr);
  }
  return 0;
}
