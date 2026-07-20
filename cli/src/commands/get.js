// get — fetch and decrypt a paste from its share URL.
//
// Burn pastes (id prefix "b") mirror the browser's safe flow (SPEC.md §8):
// non-consuming peek → fail-closed head validation → deriveContentKey verifies
// the password BEFORE the destructive read → confirm → consume (a deliberate
// POST /consume with the X-Burn-Intent header, SPEC §10) → decryptContent. A
// wrong password must never burn the paste: the consuming request is only sent
// after the key has been proven correct.
import { open, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  decryptContent, decryptPaste, deriveContentKey, PasswordRequired,
} from '../../vendor/crypto.js';
import { validateHead, validatePaste } from '../../vendor/format.js';
import { Client } from '../client.js';
import { UsageError } from '../errors.js';
import { resolveSecret } from '../secret.js';
import { isBurnId, parseShareUrl } from '../url.js';

const OPTIONS = {
  out: { type: 'string', short: 'o' },
  yes: { type: 'boolean', default: false, short: 'y' },
  'password-env': { type: 'string' },
};

function promptPassword(io) {
  if (!io.stdinIsTTY) {
    throw new UsageError('this paste requires a password — pass it with --password-env (no TTY to prompt on)');
  }
  return io.promptHidden('Password: ');
}

async function writeOutput(io, outPath, text) {
  if (outPath !== undefined) {
    try {
      // 0600: the decrypted note is a secret; don't create it world-readable.
      await writeFile(outPath, text, { mode: 0o600 });
    } catch (e) {
      throw new UsageError(`cannot write --out ${outPath}: ${e.code ?? e.message}`);
    }
  } else {
    io.stdout(text);
  }
}

export async function cmdGet(args, io) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true }));
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (positionals.length !== 1) {
    throw new UsageError('usage: binthere get <share-url | -> (use "-" to read the URL from stdin)');
  }

  let rawUrl = positionals[0];
  if (rawUrl === '-') {
    rawUrl = (await io.readStdin()).toString('utf8').trim();
    if (!rawUrl) throw new UsageError('no share URL on stdin');
  }
  const { server, id, fragment } = parseShareUrl(rawUrl);
  const client = new Client(server, io.fetch);

  let password = await resolveSecret({ envVar: values['password-env'], promptWanted: false, io });

  if (isBurnId(id)) {
    // 1. Peek (never consumes; never returns ct) + fail-closed validation.
    const head = validateHead(await client.fetchPasteMeta(id));

    // 2. Verify the password / key BEFORE the destructive read.
    let cek;
    try {
      cek = await deriveContentKey({ adata: head.adata, wk: head.wk, fragment, password });
    } catch (e) {
      if (!(e instanceof PasswordRequired)) throw e;
      password = await promptPassword(io);
      cek = await deriveContentKey({ adata: head.adata, wk: head.wk, fragment, password });
    }

    // 3. Confirm the destructive read (skippable; auto-skipped without a TTY).
    if (!values.yes && io.stdinIsTTY) {
      const ok = await io.confirm('Burn-after-read: displaying this paste destroys it. Continue? [y/N] ');
      if (!ok) {
        io.stderr('aborted — the paste was NOT read and still exists.\n');
        return 0;
      }
    }

    // 4. Open --out BEFORE the destructive read: an unwritable path must fail
    // while the paste still exists, not after the only copy has been consumed.
    let outFile = null;
    if (values.out !== undefined) {
      try {
        // 0600 — see writeOutput.
        outFile = await open(values.out, 'w', 0o600);
      } catch (e) {
        throw new UsageError(`cannot write --out ${values.out}: ${e.code ?? e.message}`);
      }
    }

    // 5. Consume — the single destructive read — then decrypt.
    try {
      const paste = validatePaste(await client.consumePaste(id));
      const out = await decryptContent({ adata: paste.adata, ct: paste.ct, cek });
      if (outFile) {
        try {
          await outFile.writeFile(out.text);
        } catch (e) {
          // The paste is already gone; the plaintext is the only copy left.
          // Never swallow it — fall back to stdout so nothing is lost.
          io.stderr(`warning: writing --out ${values.out} failed (${e.code ?? e.message}); printing to stdout instead.\n`);
          io.stdout(out.text);
        }
      } else {
        io.stdout(out.text);
      }
    } finally {
      if (outFile) await outFile.close();
    }
    return 0;
  }

  // Normal (KV) paste: reads are not destructive, so fetch-then-decrypt.
  const paste = await client.fetchPaste(id);
  let out;
  try {
    out = await decryptPaste({ paste, fragment, password });
  } catch (e) {
    if (!(e instanceof PasswordRequired)) throw e;
    password = await promptPassword(io);
    out = await decryptPaste({ paste, fragment, password });
  }
  await writeOutput(io, values.out, out.text);
  return 0;
}
