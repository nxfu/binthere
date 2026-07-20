// prompt.test.js — the raw-mode secret prompt against a fake TTY stream: the
// least-tested, most platform-sensitive code in the CLI. Covers UTF-8 chunk
// boundaries, code-point-aware backspace (surrogate pairs), Ctrl+C/Ctrl+D, and
// the no-TTY rejection — plus decodeKey's pasted-burst handling.
import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import { promptHidden } from '../src/prompt.js';
import { AbortError, UsageError } from '../src/errors.js';
import { decodeKey } from '../src/tui/keys.js';

/** Minimal stand-in for a raw-mode TTY stdin. */
function fakeTty() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (on) => { input.isRaw = on; return input; };
  input.resume = () => input;
  input.pause = () => input;
  return input;
}

const sink = () => {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join('') };
};

/** Start the prompt, feed it chunks, and return its settled result. */
function drive(chunks) {
  const input = fakeTty();
  const output = sink();
  const p = promptHidden('Password: ', { input, output });
  for (const c of chunks) input.emit('data', Buffer.isBuffer(c) ? c : Buffer.from(c, 'utf8'));
  return p;
}

describe('promptHidden — raw-mode decoding', () => {
  it('reads a simple secret terminated by Enter', async () => {
    await expect(drive(['s3cret', '\r'])).resolves.toBe('s3cret');
  });

  it('Ctrl+D accepts what was typed (EOF chord)', async () => {
    await expect(drive(['abc', '\x04'])).resolves.toBe('abc');
  });

  it('reassembles a multi-byte UTF-8 character split across chunks', async () => {
    // 'é' = 0xC3 0xA9 — a paste or IME can deliver the bytes in separate
    // chunks; naive per-chunk toString would corrupt both into U+FFFD.
    await expect(drive([Buffer.from([0xc3]), Buffer.from([0xa9]), '\r'])).resolves.toBe('é');
  });

  it('backspace removes a full astral code point, not half a surrogate pair', async () => {
    // '😀' is two UTF-16 units; slicing one off would leave a lone surrogate
    // that silently derives a different key than the visible input.
    await expect(drive(['😀', '\x7f', 'a', '\r'])).resolves.toBe('a');
  });

  it('backspace on an empty value is a no-op', async () => {
    await expect(drive(['\x7f', 'x', '\r'])).resolves.toBe('x');
  });

  it('Ctrl+C rejects with AbortError and restores raw mode', async () => {
    const input = fakeTty();
    const p = promptHidden('Password: ', { input, output: sink() });
    input.emit('data', Buffer.from('\x03'));
    await expect(p).rejects.toBeInstanceOf(AbortError);
    expect(input.isRaw).toBe(false);
  });

  it('restores the previous raw-mode state on completion', async () => {
    const input = fakeTty();
    const p = promptHidden('Password: ', { input, output: sink() });
    expect(input.isRaw).toBe(true);
    input.emit('data', Buffer.from('x\r'));
    await p;
    expect(input.isRaw).toBe(false);
  });

  it('rejects with UsageError when stdin is not a TTY', async () => {
    const input = fakeTty();
    input.isTTY = false;
    await expect(promptHidden('Password: ', { input, output: sink() }))
      .rejects.toBeInstanceOf(UsageError);
  });
});

describe('decodeKey — pasted bursts', () => {
  it('returns the first key of a multi-character non-escape chunk', () => {
    expect(decodeKey(Buffer.from('abc'))).toBe('a');
    expect(decodeKey(Buffer.from('😀x'))).toBe('😀'); // full code point, not half
  });

  it('leaves unrecognized escape sequences whole (no false Esc)', () => {
    expect(decodeKey(Buffer.from('\x1b[C'))).toBe('\x1b[C'); // right arrow: ignored, not "esc"
  });

  it('still decodes the named keys', () => {
    expect(decodeKey(Buffer.from('\x1b[A'))).toBe('up');
    expect(decodeKey(Buffer.from('\x1b[B'))).toBe('down');
    expect(decodeKey(Buffer.from('\r'))).toBe('enter');
    expect(decodeKey(Buffer.from('\x03'))).toBe('ctrl-c');
    expect(decodeKey(Buffer.from('\x1b'))).toBe('esc');
  });
});
