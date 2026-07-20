// keys.js — one keypress at a time from a raw-mode TTY, decoded to a small
// set of names. VT input sequences are assumed (Node enables
// ENABLE_VIRTUAL_TERMINAL_PROCESSING on Windows 10+, so arrows arrive as
// `ESC [ A` there too).
import process from 'node:process';

const ESC = String.fromCharCode(0x1b);
const CTRL_C = String.fromCharCode(0x03);

/** Decode one raw-mode chunk to 'up'|'down'|'enter'|'ctrl-c'|'esc' or itself. */
export function decodeKey(data) {
  const s = data.toString('utf8');
  if (s === `${ESC}[A` || s === `${ESC}OA`) return 'up';
  if (s === `${ESC}[B` || s === `${ESC}OB`) return 'down';
  if (s === '\r' || s === '\n') return 'enter';
  if (s === CTRL_C) return 'ctrl-c';
  if (s === ESC) return 'esc';
  // A pasted burst arrives as one chunk; "one keypress at a time" means the
  // first key, not the concatenated string (which would match no hotkey).
  // Unrecognized ESC-prefixed sequences (other arrows, F-keys) pass through
  // whole so they keep matching nothing rather than becoming a false Esc.
  if (s.length > 1 && s[0] !== ESC) return [...s][0];
  return s;
}

/** Read a single decoded keypress, restoring the previous raw-mode state. */
export function readKey({ input = process.stdin } = {}) {
  return new Promise((resolve) => {
    const wasRaw = input.isRaw === true;
    input.setRawMode(true);
    input.resume();
    input.once('data', (buf) => {
      input.setRawMode(wasRaw);
      input.pause();
      resolve(decodeKey(buf));
    });
  });
}
