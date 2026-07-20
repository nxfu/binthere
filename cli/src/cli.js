// cli.js — command dispatch, help/version, and error → exit-code mapping.
//
// Exit codes: 0 ok · 1 crypto/API error · 2 usage error.
// All I/O flows through an injectable `io` object so the command logic is
// testable without spawning processes or a TTY.
import { createRequire } from 'node:module';
import process from 'node:process';
import { DecryptError, PasswordRequired } from '../vendor/crypto.js';
import { FormatError } from '../vendor/format.js';
import { ApiError } from './client.js';
import { cmdCreate } from './commands/create.js';
import { cmdDelete } from './commands/delete.js';
import { cmdGet } from './commands/get.js';
import { AbortError, UsageError } from './errors.js';
import { confirm, promptHidden, promptLine, promptMultiline } from './prompt.js';
import { copyToClipboard } from './tui/clipboard.js';
import { readKey } from './tui/keys.js';
import { center } from './tui/screen.js';
import { DEFAULT_SERVER } from './url.js';
import { runWizard } from './wizard.js';

export const VERSION = createRequire(import.meta.url)('../package.json').version;

const HELP = `binthere ${VERSION} — zero-knowledge encrypted notes CLI

Notes are encrypted locally (AES-256-GCM); the key travels in the URL
#fragment and never reaches the server. Same lifecycle as the website:
every note deletes after one read, or after 24 hours.

Usage:
  binthere                           interactive: write a note, get its link + QR
  binthere create [flags]            encrypt stdin, --text, or --file; print the share URL
  binthere get <share-url | ->       fetch and decrypt a note ("-" reads the URL from stdin)
  binthere view <share-url | ->      alias for get
  binthere delete <share-url | id>   delete a note with its delete token

create flags:
  -t, --text <string>    use the given string as the note content
  -f, --file <path>      read content from a file instead of stdin
  --fmt <fmt>            plaintext (default) | code | markdown
  --password             prompt for a password (hidden)
  --password-env <VAR>   read the password from an environment variable
  -q, --qr               also print a scannable QR code (to stderr)
  -j, --json             print {url, id, deletetoken, expire, burn} as JSON
get flags:
  -o, --out <path>       write plaintext to a file instead of stdout
  -y, --yes              skip the "reading destroys this note" confirmation
  --password-env <VAR>   read the password from an environment variable
delete flags:
  --token-env <VAR>      read the delete token from an environment variable

Global:
  -s, --server <url>     API origin for create/delete (default $BINTHERE_SERVER
                         or ${DEFAULT_SERVER}); get takes it from the share URL
  -h, --help             show this help (also after a command)
  -V, --version          print the version

"create" is assumed when stdin is piped with no command, or when --text is given:
  git diff | binthere
  binthere -t "meet at 6"

The share URL (including its secret #fragment) is visible to other local
processes when passed as an argument; prefer  echo <url> | binthere get -
on shared machines. Exit codes: 0 ok · 1 crypto/API error · 2 usage error · 130 aborted.
`;

export function defaultIo() {
  const io = {
    stdout: (s) => { process.stdout.write(s); },
    stderr: (s) => { process.stderr.write(s); },
    env: process.env,
    fetch: globalThis.fetch.bind(globalThis),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
    columns: () => process.stderr.columns ?? 80,
    rows: () => process.stderr.rows ?? 24,
    readStdin: async () => {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      return Buffer.concat(chunks);
    },
    promptHidden: (question) => promptHidden(question),
    promptLine: (question) => promptLine(question),
    promptMultiline: (prompt) => promptMultiline({ prompt }),
    confirm: (question) => confirm(question),
    readKey: () => readKey(),
    // Swallow keystrokes during a non-interactive stretch (the wizard intro):
    // raw mode stops the terminal echoing them over the animation, and the
    // discard listener keeps them from buffering into the first menu read.
    // Ctrl+C is re-raised as a real SIGINT so aborting still works (the
    // bin/binthere.js handler restores the terminal). Returns an unmute fn.
    muteInput: () => {
      if (!process.stdin.isTTY) return () => {};
      const discard = (buf) => {
        if (buf.includes(0x03)) process.kill(process.pid, 'SIGINT');
      };
      const wasRaw = process.stdin.isRaw === true;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', discard);
      return () => {
        process.stdin.off('data', discard);
        process.stdin.pause();
        process.stdin.setRawMode(wasRaw);
      };
    },
  };
  io.copy = (text) => copyToClipboard(text, io);
  return io;
}

function apiMessage(e) {
  switch (e.status) {
    case 0: return e.message; // network-level: timeout / unreachable (no HTTP status)
    case 404: return 'not found — wrong URL, or the paste has expired';
    case 410: return 'gone — this paste was already burned or has expired';
    case 403: return 'wrong delete token';
    case 400: return `rejected by the server: ${e.message}`;
    case 413: return 'paste too large for the server';
    case 429: return 'rate limited — try again shortly';
    default: return `${e.message} (HTTP ${e.status})`;
  }
}

async function dispatch(argv, io) {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h') {
    io.stdout(HELP);
    return 0;
  }
  if (command === '--version' || command === '-V') {
    io.stdout(VERSION + '\n');
    return 0;
  }
  // `binthere create --help` should show help, not exit 2 with "Unknown option".
  if (rest.includes('--help') || rest.includes('-h')) {
    io.stdout(HELP);
    return 0;
  }
  switch (command) {
    case 'create': return cmdCreate(rest, io);
    case 'get':
    case 'view': return cmdGet(rest, io);
    case 'delete': return cmdDelete(rest, io);
    default: {
      // Default command is create when stdin is piped (`cat notes.md | binthere`)
      // or when the content is inline (`binthere -t "hi"` / `binthere -f notes.md`
      // — no stdin needed for either).
      const inlineInput = argv.some((a) => a === '--text' || a.startsWith('--text=')
        || a === '--file' || a.startsWith('--file=') || /^-[a-z]*[tf]/.test(a));
      if ((command === undefined || command.startsWith('-')) && (!io.stdinIsTTY || inlineInput)) {
        return cmdCreate(argv, io);
      }
      // Bare `binthere` on a terminal: the interactive wizard.
      if (command === undefined) {
        return runWizard(io);
      }
      throw new UsageError(`unknown command "${command}" (expected create, get/view, or delete)`);
    }
  }
}

/** Run the CLI. Returns the process exit code; never throws. */
export async function run(argv, io = defaultIo()) {
  try {
    return await dispatch(argv, io);
  } catch (e) {
    // Bare `binthere` on a TTY ran the wizard, whose screens are centered —
    // its error lines are centered to match; plain commands stay left-aligned.
    const wizard = argv[0] === undefined && io.stdinIsTTY && typeof io.columns === 'function';
    const fail = (message, code) => {
      io.stderr((wizard ? center(message, io.columns()) : message) + '\n');
      return code;
    };
    if (e instanceof AbortError) return fail(`binthere: ${e.message}`, 130);
    if (e instanceof UsageError) return fail(`binthere: ${e.message}`, 2);
    if (e instanceof ApiError) return fail(`binthere: ${apiMessage(e)}`, 1);
    if (e instanceof PasswordRequired) {
      return fail('binthere: this paste requires a password (use --password-env)', 1);
    }
    if (e instanceof DecryptError) {
      return fail('binthere: decryption failed — wrong key/password, or the paste was tampered with', 1);
    }
    if (e instanceof FormatError) {
      return fail(`binthere: the server returned a malformed paste (${e.message})`, 1);
    }
    return fail(`binthere: ${e.message}`, 1);
  }
}
