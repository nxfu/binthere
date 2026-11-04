// cli.test.js — end-to-end command tests against a mocked fetch that
// implements the SPEC.md §10 contract (create/get/peek/consume/delete, real
// HTTP status codes, delete-token hashing; consumption only via the non-simple
// POST /consume + X-Burn-Intent header). The crucial burn assertions: the
// consuming POST is NEVER sent before key verification succeeds, and a wrong
// password leaves the paste intact.
import { describe, it, expect } from 'vitest';
import { b64urlFromBytes, randomBytes, sha256Hex, utf8 } from '../vendor/bytes.js';
import { validatePaste, FormatError } from '../vendor/format.js';
import { run } from '../src/cli.js';
import { UsageError } from '../src/errors.js';

const SERVER = 'https://binthere.test.example';

/** In-memory mock of the paste API (SPEC.md §10) as a fetch implementation. */
function makeServer() {
  const store = new Map(); // id → { paste, dth }
  const calls = []; // { method, path, meta }
  const fetchImpl = async (rawUrl, init = {}) => {
    const u = new URL(rawUrl);
    const method = init.method ?? 'GET';
    const meta = u.searchParams.get('meta') === '1';
    calls.push({ method, path: u.pathname, meta });
    const json = (status, body) => new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    });

    if (method === 'POST' && u.pathname === '/api/paste') {
      let clean;
      try {
        clean = validatePaste(JSON.parse(init.body));
      } catch (e) {
        if (e instanceof FormatError || e instanceof SyntaxError) {
          return json(400, { error: 'invalid paste' });
        }
        throw e;
      }
      if (!clean.adata.bar || clean.meta.expire !== '1day') return json(400, { error: 'unsupported lifecycle' });
      const id = 'b' + b64urlFromBytes(randomBytes(16));
      const deletetoken = b64urlFromBytes(randomBytes(32));
      clean.meta.created = 1234567890;
      store.set(id, { paste: clean, dth: await sha256Hex(utf8(deletetoken)) });
      return json(201, { id, deletetoken });
    }

    const mc = /^\/api\/paste\/([^/]+)\/consume$/.exec(u.pathname);
    if (mc) {
      if (method !== 'POST') return json(405, { error: 'method not allowed' });
      if ((init.headers?.['x-burn-intent'] ?? '') !== 'consume') {
        return json(400, { error: 'missing X-Burn-Intent header' });
      }
      const id = mc[1];
      if (!id.startsWith('b')) return json(404, { error: 'not found' });
      const record = store.get(id);
      if (!record) return json(410, { error: 'gone' });
      store.delete(id); // the single destructive read
      return json(200, record.paste);
    }

    const m = /^\/api\/paste\/([^/]+)$/.exec(u.pathname);
    if (!m) return json(404, { error: 'no such route' });
    const id = m[1];
    const record = store.get(id);
    const burn = id.startsWith('b');

    if (method === 'GET') {
      if (!record) return json(burn ? 410 : 404, { error: burn ? 'gone' : 'not found' });
      const { paste } = record;
      if (burn || meta) {
        // Burn GETs never consume (head only); ?meta=1 is a head for every class.
        const { ct: _ct, ...head } = paste;
        return json(200, head);
      }
      return json(200, paste);
    }
    if (method === 'DELETE') {
      const token = init.headers?.['x-delete-token'];
      if (!token) return json(400, { error: 'missing token' });
      if (!record) return json(404, { error: 'not found' });
      if (await sha256Hex(utf8(token)) !== record.dth) return json(403, { error: 'wrong token' });
      store.delete(id);
      return json(200, {});
    }
    return json(405, { error: 'method not allowed' });
  };
  return { fetchImpl, calls, store };
}

function makeIo({
  stdin = '', tty = false, stderrIsTTY = false, env = {}, server,
  promptHidden, promptLine, promptMultiline, confirm, readKey, copy,
} = {}) {
  const out = [];
  const err = [];
  const io = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    env: { BINTHERE_SERVER: SERVER, ...env },
    fetch: server.fetchImpl,
    stdinIsTTY: tty,
    stderrIsTTY,
    columns: () => 80,
    rows: () => 40,
    readStdin: async () => Buffer.from(stdin, 'utf8'),
    promptHidden: promptHidden ?? (() => Promise.reject(new UsageError('no prompt available in test'))),
    promptLine: promptLine ?? (() => Promise.reject(new UsageError('no line prompt in test'))),
    promptMultiline: promptMultiline ?? (() => Promise.reject(new UsageError('no multiline prompt in test'))),
    confirm: confirm ?? (() => Promise.resolve(false)),
    readKey: readKey ?? (() => Promise.reject(new UsageError('no key reader in test'))),
    copy: copy ?? (() => Promise.reject(new UsageError('no clipboard in test'))),
  };
  return { io, out, err, text: { out: () => out.join(''), err: () => err.join('') } };
}

/** Seed a pre-existing v1 non-burn paste directly to cover legacy read support. */
async function seedLegacyPaste(server, text) {
  expect(text).toBe('legacy link');
  const id = 'k' + b64urlFromBytes(randomBytes(16));
  const fragment = b64urlFromBytes(Uint8Array.from({ length: 32 }, (_, i) => i));
  const adata = {
    alg: 'A256GCM', kdf: 'hkdf', iter: 0, comp: 'none', fmt: 'plaintext', bar: false,
    ivc: 'ERERERERERERERER', ivw: 'IiIiIiIiIiIiIiIi', skdf: '',
  };
  server.store.set(id, {
    paste: {
      v: 1,
      ct: b64urlFromBytes(Buffer.from('51541cd10292619073e3adbab99d55c8839d57470ec512ba5d5edc785ab314316870323b42928ccf3cf019e7d978e06397fe19127efa', 'hex')),
      wk: b64urlFromBytes(Buffer.from('07adc270949ba48117e0553655023ae11d326766c13f9dc06b05a69085f5306bd0de61efac880cc08a63ac800daf2a39', 'hex')),
      adata,
      meta: { expire: '1week', created: 1234567890 },
    },
    dth: await sha256Hex(utf8('legacy-delete-token')),
  });
  return `${SERVER}/p/${id}#${fragment}`;
}

const consumes = (calls) => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/consume'));

describe('create → get round trip', () => {
  it('creates from a positional text argument', async () => {
    const server = makeServer();
    const a = makeIo({ server });
    expect(await run(['create', 'positional note'], a.io)).toBe(0);
    const b = makeIo({ server });
    expect(await run(['get', a.text.out().trim()], b.io)).toBe(0);
    expect(b.text.out()).toBe('positional note');
  });

  it('quiet suppresses create diagnostics while keeping the URL on stdout', async () => {
    const server = makeServer();
    const a = makeIo({ stdin: 'quiet note', server });
    expect(await run(['create', '--quiet'], a.io)).toBe(0);
    expect(a.text.out()).toMatch(/\/p\/b[A-Za-z0-9_-]{22}#/);
    expect(a.text.err()).toBe('');
  });

  it('creates from stdin and decrypts from the printed share URL', async () => {
    const server = makeServer();
    const a = makeIo({ stdin: 'round trip me\n', server });
    expect(await run(['create'], a.io)).toBe(0);
    const url = a.text.out().trim();
    // Every note is burn-after-read now → "b…" ids, website-parity lifecycle.
    expect(url).toMatch(new RegExp(`^${SERVER}/p/b[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$`));
    expect(a.text.err()).toMatch(/delete token: /);
    expect(a.text.err()).toMatch(/deletes after one read, or in 24 hours/);

    const b = makeIo({ server });
    expect(await run(['get', url], b.io)).toBe(0);
    expect(b.text.out()).toBe('round trip me\n');
  });

  it('shows help when no explicit command is given, even with piped input', async () => {
    const server = makeServer();
    const a = makeIo({ stdin: 'implicit create', server });
    expect(await run([], a.io)).toBe(0);
    expect(a.text.out()).toMatch(/Usage:/);
    expect(server.calls).toHaveLength(0);
  });

  it('--json emits the documented object on stdout only', async () => {
    const server = makeServer();
    const a = makeIo({ stdin: 'json me', server });
    expect(await run(['create', '--json'], a.io)).toBe(0);
    const parsed = JSON.parse(a.text.out());
    expect(Object.keys(parsed).sort()).toEqual(['deletetoken', 'id', 'url']);
    expect(a.text.err()).toBe('');
  });

  it('still decrypts old non-burn "k…" share links', async () => {
    const server = makeServer();
    const url = await seedLegacyPaste(server, 'legacy link');
    const a = makeIo({ server });
    expect(await run(['get', url], a.io)).toBe(0);
    expect(a.text.out()).toBe('binthere vector — zero knowledge ✓');
    // Non-destructive: a second read still works.
    const b = makeIo({ server });
    expect(await run(['get', url], b.io)).toBe(0);
    expect(b.text.out()).toBe('binthere vector — zero knowledge ✓');
  });

  it('the fragment secret is never sent to the server', async () => {
    const server = makeServer();
    let posted = '';
    const spyFetch = async (url, init) => {
      if (init?.method === 'POST') posted = String(init.body) + url;
      return server.fetchImpl(url, init);
    };
    const a = makeIo({ stdin: 'keep the key local', server });
    a.io.fetch = spyFetch;
    expect(await run(['create'], a.io)).toBe(0);
    const fragment = a.text.out().trim().split('#')[1];
    expect(fragment).toHaveLength(43);
    expect(posted).not.toContain(fragment);
  });
});

describe('create validation', () => {
  it('rejects removed --expire/--burn, bad --fmt, and unknown flags with exit 2', async () => {
    const server = makeServer();
    for (const args of [
      ['create', '--expire', '1week'], // lifecycle is fixed; the flag no longer exists
      ['create', '--burn'],
      ['create', '--fmt', 'html'],
      ['create', '--nonsense'],
    ]) {
      const a = makeIo({ stdin: 'x', server });
      expect(await run(args, a.io)).toBe(2);
      expect(server.calls).toHaveLength(0);
    }
  });

  it('rejects empty and oversized input', async () => {
    const server = makeServer();
    const empty = makeIo({ stdin: '', server });
    expect(await run(['create'], empty.io)).toBe(2);
    const big = makeIo({ stdin: 'a'.repeat((1 << 20) + 1), server });
    expect(await run(['create'], big.io)).toBe(2);
    expect(big.text.err()).toMatch(/too large/);
    expect(server.calls).toHaveLength(0);
  });

  it('requires input when stdin is a TTY and no --file is given', async () => {
    const server = makeServer();
    const a = makeIo({ tty: true, server });
    expect(await run(['create'], a.io)).toBe(2);
    expect(a.text.err()).toMatch(/pipe content|--file/);
  });

  it('--text and --file are mutually exclusive; empty --text is refused', async () => {
    const server = makeServer();
    const both = makeIo({ tty: true, server });
    expect(await run(['create', '--text', 'x', '--file', 'y.txt'], both.io)).toBe(2);
    expect(both.text.err()).toMatch(/mutually exclusive/);
    const empty = makeIo({ tty: true, server });
    expect(await run(['create', '--text', ''], empty.io)).toBe(2);
    expect(empty.text.err()).toMatch(/empty/);
    expect(server.calls).toHaveLength(0);
  });
});

describe('inline --text and short flags', () => {
  it('creates from --text on a TTY (no stdin) and round-trips via the view alias', async () => {
    const server = makeServer();
    const a = makeIo({ tty: true, server });
    expect(await run(['create', '--text', 'inline note'], a.io)).toBe(0);
    const url = a.text.out().trim();
    expect(url).toMatch(/\/p\/b[A-Za-z0-9_-]{22}#/);

    const b = makeIo({ server });
    expect(await run(['view', url], b.io)).toBe(0);
    expect(b.text.out()).toBe('inline note');
  });

  it('requires an explicit create command instead of accepting bare flags', async () => {
    const server = makeServer();
    const a = makeIo({ tty: true, server });
    expect(await run(['-t', 'quick one'], a.io)).toBe(2);
    expect(a.text.err()).toMatch(/unknown command/);
  });

  it('short flags: -t -j on create, -y on get, -s on delete', async () => {
    const server = makeServer();
    const a = makeIo({ tty: true, server });
    expect(await run(['create', '-t', 'shorty', '-j'], a.io)).toBe(0);
    const { url } = JSON.parse(a.text.out());

    const b = makeIo({ server, tty: true, confirm: () => Promise.reject(new Error('must not prompt')) });
    expect(await run(['get', url, '-y'], b.io)).toBe(0);
    expect(b.text.out()).toBe('shorty');

    const c = makeIo({ tty: true, server });
    expect(await run(['create', '-t', 'doomed', '-j'], c.io)).toBe(0);
    const made = JSON.parse(c.text.out());
    const d = makeIo({ server, env: { TK: made.deletetoken } });
    expect(await run(['delete', made.id, '-s', SERVER, '--token-env', 'TK'], d.io)).toBe(0);
    expect(server.store.has(made.id)).toBe(false);
  });
});

describe('password pastes', () => {
  it('round-trips via --password-env on both ends', async () => {
    const server = makeServer();
    const a = makeIo({ stdin: 'sekrit', server, env: { PW: 'correct horse' } });
    expect(await run(['create', '--password-env', 'PW'], a.io)).toBe(0);
    const url = a.text.out().trim();

    const b = makeIo({ server, env: { PW: 'correct horse' } });
    expect(await run(['get', url, '--password-env', 'PW'], b.io)).toBe(0);
    expect(b.text.out()).toBe('sekrit');
  });

  it('prompts on a TTY, errors clearly otherwise', async () => {
    const server = makeServer();
    const a = makeIo({ stdin: 'sekrit', server, env: { PW: 'pw' } });
    expect(await run(['create', '--password-env', 'PW'], a.io)).toBe(0);
    const url = a.text.out().trim();

    // Non-consuming failures first: notes are burn-after-read, so a successful
    // read destroys the paste.
    const noTty = makeIo({ server });
    expect(await run(['get', url], noTty.io)).toBe(2);
    expect(noTty.text.err()).toMatch(/--password-env|--token-env/);

    const wrong = makeIo({ server, env: { PW: 'wrong' } });
    expect(await run(['get', url, '--password-env', 'PW'], wrong.io)).toBe(1);
    expect(wrong.text.err()).toMatch(/decryption failed/);

    const prompted = makeIo({ server, tty: true, promptHidden: () => Promise.resolve('pw') });
    expect(await run(['get', url, '--yes'], prompted.io)).toBe(0);
    expect(prompted.text.out()).toBe('sekrit');
  });

  it('an unset --password-env variable is a usage error', async () => {
    const server = makeServer();
    const a = makeIo({ stdin: 'x', server });
    expect(await run(['create', '--password-env', 'MISSING'], a.io)).toBe(2);
  });
});

describe('burn-after-read flow (SPEC.md §8 ordering)', () => {
  async function createBurn(server, { password } = {}) {
    const env = password ? { PW: password } : {};
    const args = ['create', ...(password ? ['--password-env', 'PW'] : [])];
    const a = makeIo({ stdin: 'burn me once', server, env });
    expect(await run(args, a.io)).toBe(0);
    return a.text.out().trim();
  }

  it('peeks (meta) and verifies BEFORE the destructive consume', async () => {
    const server = makeServer();
    const url = await createBurn(server, { password: 'pw' });
    server.calls.length = 0;

    const b = makeIo({ server, env: { PW: 'pw' } });
    expect(await run(['get', url, '--password-env', 'PW'], b.io)).toBe(0);
    expect(b.text.out()).toBe('burn me once');

    // Exact request order: peek first, consume last — never the reverse.
    expect(server.calls.map((c) => (c.path.endsWith('/consume') ? 'consume' : 'peek')))
      .toEqual(['peek', 'consume']);
    expect(consumes(server.calls)).toHaveLength(1);

    // Consumed: a second read is 410 "gone".
    const c = makeIo({ server, env: { PW: 'pw' } });
    expect(await run(['get', url, '--password-env', 'PW'], c.io)).toBe(1);
    expect(c.text.err()).toMatch(/burned or.*expired|gone/i);
  });

  it('a wrong password NEVER consumes the paste', async () => {
    const server = makeServer();
    const url = await createBurn(server, { password: 'pw' });
    server.calls.length = 0;

    const b = makeIo({ server, env: { PW: 'wrong' } });
    expect(await run(['get', url, '--password-env', 'PW'], b.io)).toBe(1);
    expect(consumes(server.calls)).toHaveLength(0); // only the peek happened
    expect(server.store.size).toBe(1); // still burnable with the right password

    const c = makeIo({ server, env: { PW: 'pw' } });
    expect(await run(['get', url, '--password-env', 'PW'], c.io)).toBe(0);
    expect(c.text.out()).toBe('burn me once');
  });

  it('declining the TTY confirmation leaves the paste intact', async () => {
    const server = makeServer();
    const url = await createBurn(server);
    server.calls.length = 0;

    const b = makeIo({ server, tty: true, confirm: () => Promise.resolve(false) });
    expect(await run(['get', url], b.io)).toBe(0);
    expect(b.text.out()).toBe('');
    expect(b.text.err()).toMatch(/NOT read/);
    expect(consumes(server.calls)).toHaveLength(0);
    expect(server.store.size).toBe(1);
  });

  it('--yes and non-TTY both skip the confirmation', async () => {
    const server = makeServer();
    const url1 = await createBurn(server);
    const a = makeIo({ server, tty: true, confirm: () => Promise.resolve(true) });
    expect(await run(['get', url1, '--yes'], a.io)).toBe(0);
    expect(a.text.out()).toBe('burn me once');

    const url2 = await createBurn(server);
    const b = makeIo({ server }); // not a TTY → auto-skip
    expect(await run(['get', url2], b.io)).toBe(0);
    expect(b.text.out()).toBe('burn me once');
  });

  it('reads the share URL from stdin with "-"', async () => {
    const server = makeServer();
    const url = await createBurn(server);
    const b = makeIo({ server, stdin: url + '\n' });
    expect(await run(['get', '-'], b.io)).toBe(0);
    expect(b.text.out()).toBe('burn me once');
  });
});

describe('delete', () => {
  it('deletes with the right token; wrong token is 403 and keeps the paste', async () => {
    const server = makeServer();
    const a = makeIo({ stdin: 'delete me', server });
    expect(await run(['create', '--json'], a.io)).toBe(0);
    const { url, deletetoken } = JSON.parse(a.text.out());

    const wrong = makeIo({ server, env: { TK: 'not-the-token' } });
    expect(await run(['delete', url, '--token-env', 'TK'], wrong.io)).toBe(1);
    expect(wrong.text.err()).toMatch(/wrong delete token/);
    expect(server.store.size).toBe(1);

    const right = makeIo({ server, env: { TK: deletetoken } });
    expect(await run(['delete', url, '--token-env', 'TK'], right.io)).toBe(0);
    expect(server.store.size).toBe(0);

    const gone = makeIo({ server });
    expect(await run(['get', url], gone.io)).toBe(1);
    expect(gone.text.err()).toMatch(/gone|burned/);
  });

  it('accepts a bare id resolved against the configured server', async () => {
    const server = makeServer();
    const a = makeIo({ stdin: 'by id', server });
    expect(await run(['create', '--json'], a.io)).toBe(0);
    const { id, deletetoken } = JSON.parse(a.text.out());
    const b = makeIo({ server, env: { TK: deletetoken } });
    expect(await run(['delete', id, '--token-env', 'TK'], b.io)).toBe(0);
    expect(server.store.size).toBe(0);
  });
});

describe('network and server failure paths', () => {
  const netFail = (code) => async () => {
    const e = new TypeError('fetch failed');
    e.cause = { code };
    throw e;
  };

  it('names the host and cause when the server is unreachable', async () => {
    const server = makeServer();
    const a = makeIo({ stdin: 'x', server });
    a.io.fetch = netFail('ECONNREFUSED');
    expect(await run(['create'], a.io)).toBe(1);
    expect(a.text.err()).toContain('ECONNREFUSED');
    expect(a.text.err()).toContain('binthere.test.example');
    expect(a.text.err()).not.toContain('HTTP 0'); // network errors have no HTTP status
  });

  it('maps a non-JSON success body to a malformed-response error', async () => {
    const server = makeServer();
    const a = makeIo({ stdin: 'x', server });
    a.io.fetch = async () => new Response('<html>proxy error</html>', { status: 200 });
    expect(await run(['create'], a.io)).toBe(1);
    expect(a.text.err()).toMatch(/malformed response/i);
  });

  it.each([
    [413, /too large/],
    [429, /rate limited/],
    [500, /HTTP 500/],
  ])('maps HTTP %i to a readable message', async (status, re) => {
    const server = makeServer();
    const a = makeIo({ stdin: 'x', server });
    a.io.fetch = async () => new Response(JSON.stringify({ error: 'nope' }), { status });
    expect(await run(['create'], a.io)).toBe(1);
    expect(a.text.err()).toMatch(re);
  });

  it('sanitizes ANSI escapes out of server-controlled error strings', async () => {
    const server = makeServer();
    const a = makeIo({ stdin: 'x', server });
    const hostile = 'bad]52;c;evilrequest[2J' + 'x'.repeat(500);
    a.io.fetch = async () => new Response(JSON.stringify({ error: hostile }), { status: 400 });
    expect(await run(['create'], a.io)).toBe(1);
    expect(a.text.err()).not.toContain('');
    expect(a.text.err()).not.toContain('');
    expect(a.text.err().length).toBeLessThan(400); // capped
  });
});

describe('file I/O failure paths', () => {
  it('unreadable --file fails with exit 2 and touches nothing', async () => {
    const server = makeServer();
    const a = makeIo({ server });
    expect(await run(['create', '-f', 'definitely/does-not-exist.txt'], a.io)).toBe(2);
    expect(a.text.err()).toMatch(/cannot read --file/);
    expect(server.calls).toHaveLength(0);
  });

  it('unwritable --out on a burn get fails BEFORE the destructive read (#7)', async () => {
    const server = makeServer();
    const c = makeIo({ stdin: 'precious one-time note', server });
    expect(await run(['create'], c.io)).toBe(0);
    const url = c.text.out().trim();

    const a = makeIo({ server });
    expect(await run(['get', '--yes', '-o', 'no-such-dir/deep/out.txt', url], a.io)).toBe(2);
    expect(a.text.err()).toMatch(/cannot write --out/);
    expect(consumes(server.calls)).toHaveLength(0); // the paste was never consumed
    expect(server.store.size).toBe(1); // and still exists

    // The same URL still works afterwards — nothing was lost.
    const b = makeIo({ server });
    expect(await run(['get', '--yes', url], b.io)).toBe(0);
    expect(b.text.out()).toBe('precious one-time note');
  });

  it('writes --out with owner-only permissions', async () => {
    const { mkdtemp, readFile: read, stat, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'binthere-test-'));
    const outPath = join(dir, 'note.txt');
    try {
      const server = makeServer();
      const c = makeIo({ stdin: 'to disk', server });
      expect(await run(['create'], c.io)).toBe(0);
      const url = c.text.out().trim();

      const a = makeIo({ server });
      expect(await run(['get', '--yes', '-o', outPath, url], a.io)).toBe(0);
      expect((await read(outPath, 'utf8'))).toBe('to disk');
      if (process.platform !== 'win32') {
        expect((await stat(outPath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('dispatch and help ergonomics', () => {
  it('binthere <command> --help shows help instead of exit 2', async () => {
    for (const args of [['create', '--help'], ['get', '-h'], ['delete', '--help']]) {
      const server = makeServer();
      const a = makeIo({ server });
      expect(await run(args, a.io)).toBe(0);
      expect(a.text.out()).toMatch(/Usage:/);
      expect(server.calls).toHaveLength(0);
    }
  });

  it('requires `create` before create options', async () => {
    const server = makeServer();
    const a = makeIo({ server, tty: true });
    expect(await run(['-f', 'definitely/does-not-exist.txt'], a.io)).toBe(2);
    expect(a.text.err()).toMatch(/unknown command/);
  });
});

describe('update', () => {
  function updateIo(responses, options = {}) {
    const server = makeServer();
    const a = makeIo({ server });
    const calls = [];
    a.io.platform = options.platform ?? 'linux';
    a.io.runProcess = async (command, args) => {
      calls.push([command, args]);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    };
    if (options.global !== undefined) {
      a.io.isGlobalInstall = async () => options.global;
    }
    return { ...a, calls };
  }

  const ok = (stdout = '', stderr = '') => ({ code: 0, stdout, stderr });

  it('reports when the installed version is current', async () => {
    const a = updateIo([ok('"0.1.0"\n')]);
    expect(await run(['update'], a.io)).toBe(0);
    expect(a.text.out()).toBe('binthere 0.1.0 is up to date\n');
    expect(a.calls).toEqual([['npm', ['view', 'binthere@latest', 'version', '--json']]]);
  });

  it('version reports an available version without locating or changing npm globals', async () => {
    const a = updateIo([ok('"0.2.0"\n')]);
    expect(await run(['version'], a.io)).toBe(0);
    expect(a.text.out()).toBe('binthere 0.1.0; update available: 0.2.0\n');
    expect(a.calls).toHaveLength(1);
  });

  it('-v aliases version', async () => {
    const a = updateIo([ok('"0.1.0"\n')]);
    expect(await run(['-v'], a.io)).toBe(0);
    expect(a.text.out()).toBe('binthere 0.1.0 is up to date\n');
    expect(a.calls).toHaveLength(1);
  });

  it('updates a global installation without invoking a shell', async () => {
    const a = updateIo([
      ok('"0.2.0"\n'),
      ok('/usr/local/lib/node_modules\n'),
      ok('changed 1 package\n'),
    ], { global: true });
    expect(await run(['update'], a.io)).toBe(0);
    expect(a.text.err()).toBe('updating binthere 0.1.0 → 0.2.0…\n');
    expect(a.text.out()).toBe('updated binthere 0.1.0 → 0.2.0\n');
    expect(a.calls[2]).toEqual(['npm', [
      'install', '--global', '--no-audit', '--no-fund', 'binthere@latest',
    ]]);
  });

  it('uses npm.cmd on Windows', async () => {
    const a = updateIo([ok('"0.1.0"\n')], { platform: 'win32' });
    a.io.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    expect(await run(['version'], a.io)).toBe(0);
    expect(a.calls[0]).toEqual([
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'npm.cmd', 'view', 'binthere@latest', 'version', '--json'],
    ]);
  });

  it('refuses to modify a checkout or temporary npx copy', async () => {
    const a = updateIo([
      ok('"0.2.0"\n'),
      ok('/usr/local/lib/node_modules\n'),
    ], { global: false });
    expect(await run(['update'], a.io)).toBe(1);
    expect(a.text.err()).toContain('npm install -g binthere@latest');
    expect(a.calls).toHaveLength(2);
  });

  it('rejects malformed registry versions and npm failures', async () => {
    const malformed = updateIo([ok('"latest; rm -rf /"\n')]);
    expect(await run(['version'], malformed.io)).toBe(1);
    expect(malformed.text.err()).toContain('invalid version');

    const failed = updateIo([{ code: 1, stdout: '', stderr: 'network error' }]);
    expect(await run(['version'], failed.io)).toBe(1);
    expect(failed.text.err()).toContain('checking for updates failed');
    expect(failed.text.err()).not.toContain('network error');
  });

  it('rejects unknown options as usage errors', async () => {
    const a = updateIo([]);
    expect(await run(['update', '--force'], a.io)).toBe(2);
    expect(a.text.err()).toContain('unknown update option');
    expect(a.calls).toHaveLength(0);

    expect(await run(['version', '--json'], a.io)).toBe(2);
    expect(a.text.err()).toContain('unknown version option');
    expect(a.calls).toHaveLength(0);
  });
});
