// prompt.js — interactive terminal prompts, zero dependencies (node:readline +
// raw mode). Prompts write to stderr so stdout stays clean for piping
// (`binthere create | pbcopy` copies only the URL). Secrets are read with the
// terminal in raw mode and are never echoed.
import process from 'node:process';
import readline from 'node:readline/promises';
import { StringDecoder } from 'node:string_decoder';
import { AbortError, UsageError } from './errors.js';

// Raw-mode key codes (kept out of string literals so they stay visible).
const CTRL_C = String.fromCharCode(0x03);
const CTRL_D = String.fromCharCode(0x04); // EOF → accept what was typed
const DEL = String.fromCharCode(0x7f);    // most terminals send DEL for Backspace

/**
 * Read a secret (password / delete token) without echoing it. Requires a TTY:
 * when stdin is a pipe (content or URL arriving on it), secrets must come from
 * the corresponding --*-env flag instead.
 */
export function promptHidden(question, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) {
    return Promise.reject(new UsageError(
      'cannot prompt for a secret: stdin is not a terminal (use --password-env / --token-env)'));
  }
  return new Promise((resolve, reject) => {
    output.write(question);
    const wasRaw = input.isRaw === true;
    input.setRawMode(true);
    input.resume();
    // Raw-mode chunks can split a multi-byte UTF-8 sequence (IME input, paste);
    // a stateful decoder carries the partial bytes to the next chunk instead of
    // corrupting them into U+FFFD.
    const decoder = new StringDecoder('utf8');
    let value = '';
    const done = (settle, arg) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      settle(arg);
    };
    const onData = (buf) => {
      for (const ch of decoder.write(buf)) {
        if (ch === CTRL_C) return done(reject, new AbortError());
        if (ch === '\r' || ch === '\n' || ch === CTRL_D) return done(resolve, value);
        if (ch === DEL || ch === '\b') {
          // Remove one code point, not one UTF-16 unit — half a surrogate pair
          // is a corrupted (and silently different) password.
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        value += ch;
      }
    };
    input.on('data', onData);
  });
}

/**
 * Read a multi-line note interactively. Lines are echoed as typed; input ends
 * on Ctrl+Q from anywhere (even mid-line), or the classic EOF chords — Ctrl+D
 * (all platforms) or Ctrl+Z (Windows) on an empty line. Ctrl+C aborts.
 * `prompt` (typically spaces) indents every typed line — the wizard uses it
 * to start input at its centered content column.
 */
export function promptMultiline({ input = process.stdin, output = process.stderr, prompt = '' } = {}) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input, output, prompt });
    const lines = [];
    let settled = false;
    // Ctrl+Q finishes (raw mode disables XON/XOFF flow control, so the chord
    // reaches us); the partial line is kept since no 'line' event fires.
    // Readline's raw mode also ignores Ctrl+Z on win32 (the cooked-console EOF
    // convention doesn't apply), so map it to "finish" ourselves.
    const onKeypress = (ch, key) => {
      if (key?.ctrl !== true) return;
      if (key.name === 'q') {
        if (rl.line !== '') lines.push(rl.line);
        rl.close();
      } else if (key.name === 'z' && process.platform === 'win32' && rl.line === '') {
        rl.close();
      }
    };
    if (input.isTTY) input.on('keypress', onKeypress);
    if (prompt !== '') rl.prompt();
    rl.on('line', (line) => {
      lines.push(line);
      if (prompt !== '') rl.prompt();
    });
    rl.on('close', () => {
      input.off('keypress', onKeypress);
      if (!settled) {
        settled = true;
        output.write('\n');
        resolve(lines.join('\n'));
      }
    });
    rl.on('SIGINT', () => {
      settled = true;
      rl.close();
      output.write('\n');
      reject(new AbortError());
    });
  });
}

/** Ask a single-line question (echoed). Requires a TTY; Ctrl+C aborts. */
export async function promptLine(question, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) {
    throw new UsageError('cannot prompt: stdin is not a terminal');
  }
  const rl = readline.createInterface({ input, output });
  let aborted = false;
  rl.on('SIGINT', () => {
    aborted = true;
    rl.close();
    output.write('\n');
  });
  try {
    const answer = await rl.question(question);
    if (aborted) throw new AbortError();
    return answer.trim();
  } catch (e) {
    if (e instanceof AbortError) throw e;
    throw new AbortError();
  } finally {
    rl.close();
  }
}

/**
 * Ask a yes/no question (default no). Echoed input; requires a TTY. Ctrl+C
 * resolves to `false` — on a destructive confirmation ("reading burns this
 * note"), an interrupt must mean "no", never fall through undefined.
 */
export async function confirm(question, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) return false;
  const rl = readline.createInterface({ input, output });
  let aborted = false;
  rl.on('SIGINT', () => {
    aborted = true;
    rl.close();
    output.write('\n');
  });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return !aborted && (answer === 'y' || answer === 'yes');
  } catch {
    return false;
  } finally {
    rl.close();
  }
}
