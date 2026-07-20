// prompt.test.js — the raw-mode secret prompt against a fake TTY stream: the
// least-tested, most platform-sensitive code in the CLI. Covers UTF-8 chunk
// boundaries, code-point-aware backspace (surrogate pairs), Ctrl+C/Ctrl+D, and
// the no-TTY rejection — plus decodeKey's pasted-burst handling.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { confirm, promptHidden, promptLine, promptMultiline } from '../src/prompt.js';
import { AbortError, UsageError } from '../src/errors.js';
import { decodeKey, readKey, releaseKeys, splitKeys } from '../src/tui/keys.js';

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

describe('readKey — real-terminal chunking (conpty/ssh)', () => {

  it('assembles an arrow split across chunks instead of emitting a false Esc', async () => {
    const input = fakeTty();
    const p = readKey({ input });
    input.emit('data', Buffer.from('\x1b'));      // conpty flushes mid-sequence…
    input.emit('data', Buffer.from('[A'));        // …then the rest
    await expect(p).resolves.toBe('up');
    // The reader intentionally stays attached (raw) between reads — per-key
    // pause/raw churn is what wedged the conpty read loop.
    expect(input.isRaw).toBe(true);
    releaseKeys({ input });
    expect(input.isRaw).toBe(true); // raw stays on for the whole wizard session
  });

  it('queues every key of a coalesced burst — held arrows are not dropped', async () => {
    const input = fakeTty();
    const p = readKey({ input });
    input.emit('data', Buffer.from('\x1b[B\x1b[B\x1b[A\r'));
    await expect(p).resolves.toBe('down');
    // Subsequent reads drain the queue with no further input events.
    await expect(readKey({ input })).resolves.toBe('down');
    await expect(readKey({ input })).resolves.toBe('up');
    await expect(readKey({ input })).resolves.toBe('enter');
  });

  it('a bare Esc still decodes (after the brief sequence grace)', async () => {
    const input = fakeTty();
    const p = readKey({ input });
    input.emit('data', Buffer.from('\x1b'));
    await expect(p).resolves.toBe('esc');
  });

  it('ctrl-c resolves immediately, no grace delay', async () => {
    const input = fakeTty();
    const t0 = Date.now();
    const p = readKey({ input });
    input.emit('data', Buffer.from('\x03'));
    await expect(p).resolves.toBe('ctrl-c');
    expect(Date.now() - t0).toBeLessThan(30);
  });

  it('splitKeys keeps sequences whole, collapses CRLF, splits code points', () => {
    expect(splitKeys('\x1b[A\x1b[1;5Cq😀\r\n')).toEqual(['\x1b[A', '\x1b[1;5C', 'q', '😀', '\r']);
    expect(splitKeys('\x1bx')).toEqual(['\x1b', 'x']); // ESC + junk = Esc, then the key
  });
});

describe('releaseKeys — handing the stream back to prompts', () => {
  it('detaches, keeps raw mode on, and drops buffered keys so they cannot leak', async () => {
    const input = fakeTty();
    const p = readKey({ input });
    input.emit('data', Buffer.from('\r\x1b[B')); // enter + a leftover down
    await expect(p).resolves.toBe('enter');
    expect(input.isRaw).toBe(true); // still attached between reads
    releaseKeys({ input });
    // Raw mode is deliberately untouched (conpty mode-toggle race); only the
    // exit handler in bin/binthere.js restores the terminal.
    expect(input.isRaw).toBe(true);
    // The leftover 'down' was dropped with the release — a fresh read waits
    // for genuinely new input instead of replaying stale menu keys.
    const q = readKey({ input });
    input.emit('data', Buffer.from('q'));
    await expect(q).resolves.toBe('q');
    releaseKeys({ input });
  });

  it('is idempotent and a no-op when never attached', () => {
    const input = fakeTty();
    releaseKeys({ input });
    releaseKeys({ input });
    expect(input.isRaw).toBe(false);
  });
});

describe('readline prompts — must read from an explicitly-paused stream', () => {
  // The key-driven screens leave stdin explicitly paused (releaseKeys), and in
  // TERMINAL mode (TTY output — the wizard's reality) readline does NOT resume
  // the input itself; it relies on listener-attach auto-flow, which Node skips
  // after an explicit pause. Every prompt must resume() or the user types
  // blind. Real streams + terminal-mode readline here: with the resume removed
  // these tests hang, in non-terminal mode they would pass vacuously.
  const pausedTty = () => {
    const s = new PassThrough();
    s.isTTY = true;
    s.setRawMode = () => s; // terminal-mode readline toggles raw
    s.pause();
    return s;
  };
  const ttySink = () => {
    const s = new PassThrough();
    s.isTTY = true; // forces readline into terminal mode, like a real wizard run
    s.columns = 80;
    s.resume(); // discard echo so the sink never backpressures
    return s;
  };

  it('promptLine resolves after the menu paused stdin', async () => {
    const input = pausedTty();
    const p = promptLine('URL: ', { input, output: ttySink() });
    input.write('https://example.com/p/x#y\r');
    await expect(p).resolves.toBe('https://example.com/p/x#y');
  });

  it('confirm resolves after the menu paused stdin', async () => {
    const input = pausedTty();
    const p = confirm('sure? ', { input, output: ttySink() });
    input.write('y\r');
    await expect(p).resolves.toBe(true);
  });

  it('promptMultiline resolves after the menu paused stdin', async () => {
    const input = pausedTty();
    const p = promptMultiline({ input, output: ttySink() });
    input.write('line one\rline two\r\x04'); // Ctrl+D on the empty line ends the note
    await expect(p).resolves.toBe('line one\nline two');
  });
});
