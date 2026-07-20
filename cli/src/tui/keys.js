// keys.js — one keypress at a time from a raw-mode TTY, decoded to a small
// set of names. VT input sequences are assumed (Node enables
// ENABLE_VIRTUAL_TERMINAL_PROCESSING on Windows 10+, so arrows arrive as
// `ESC [ A` there too). Three terminal realities this must survive:
//   • one sequence can be SPLIT across reads (conpty, ssh): decoding a chunk
//     in isolation turns half an arrow into a spurious Esc — which aborts
//     the menu the user was navigating;
//   • several keys can be COALESCED into one chunk (held-down or fast arrow
//     presses, paste): exact-matching the whole chunk silently drops them;
//   • stopping and restarting stdin reads per keypress (pause/setRawMode
//     churn) can WEDGE the Windows conpty read loop — the first key works,
//     then nothing is ever delivered again, not even Ctrl+C (which in raw
//     mode is data, not a signal).
// So the reader is PERSISTENT: one data listener per input feeds a key queue
// while a key-driven screen is active, and `releaseKeys` hands the stream
// back before readline-based prompts take over. Raw mode is deliberately NOT
// restored on release: conpty applies console-mode changes asynchronously,
// and a raw-off here racing readline's immediate raw-on can land out of
// order — leaving the console line-buffered with echo off (the user types
// blind until Enter). Raw goes on once and stays on for the whole wizard
// session; bin/binthere.js restores the terminal on exit and signals.
import process from 'node:process';

const ESC = String.fromCharCode(0x1b);
const CTRL_C = String.fromCharCode(0x03);

// The bytes AFTER an ESC that complete one VT sequence: CSI `[ params final`
// or SS3 `O final`.
const SEQ_RE = /^(?:\[[0-9;]*[@-~]|O[@-~])/;
// Post-ESC bytes that could still grow into a complete sequence.
const PARTIAL_RE = /^(?:\[[0-9;]*|O)?$/;

/**
 * Split raw input into atomic keys: complete escape sequences stay whole,
 * CRLF collapses to CR, everything else is a single code point. Pure.
 */
export function splitKeys(s) {
  const keys = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === ESC) {
      const m = SEQ_RE.exec(s.slice(i + 1));
      if (m) { keys.push(ESC + m[0]); i += 1 + m[0].length; continue; }
      keys.push(ESC);
      i += 1;
      continue;
    }
    if (s[i] === '\r' && s[i + 1] === '\n') { keys.push('\r'); i += 2; continue; }
    const ch = String.fromCodePoint(s.codePointAt(i));
    keys.push(ch);
    i += ch.length;
  }
  return keys;
}

function mapKey(k) {
  if (k === `${ESC}[A` || k === `${ESC}OA`) return 'up';
  if (k === `${ESC}[B` || k === `${ESC}OB`) return 'down';
  if (k === '\r' || k === '\n') return 'enter';
  if (k === CTRL_C) return 'ctrl-c';
  if (k === ESC) return 'esc';
  return k;
}

/** Decode the FIRST key in a raw-mode chunk (see splitKeys). */
export function decodeKey(data) {
  const s = data.toString('utf8');
  return s === '' ? s : mapKey(splitKeys(s)[0]);
}

// How long to wait for the rest of a split escape sequence. Also the extra
// latency of a bare Esc keypress — imperceptible at 40ms.
const SEQ_GRACE_MS = 40;

// Per-input persistent reader state. WeakMap keeps fake test streams isolated.
const readers = new WeakMap();

function reader(input) {
  let r = readers.get(input);
  if (r === undefined) {
    r = { queue: [], waiters: [], acc: '', timer: null, attached: false, onData: null };
    readers.set(input, r);
  }
  return r;
}

/** Does `s` end in an incomplete escape sequence more bytes could finish? */
function incompleteTail(s) {
  const i = s.lastIndexOf(ESC);
  if (i === -1) return false;
  const tail = s.slice(i + 1);
  return !SEQ_RE.test(tail) && PARTIAL_RE.test(tail);
}

/** Decode everything assembled so far to waiting readers, queueing the rest. */
function flush(r) {
  if (r.timer !== null) { clearTimeout(r.timer); r.timer = null; }
  if (r.acc === '') return;
  const keys = splitKeys(r.acc).map(mapKey);
  r.acc = '';
  for (const key of keys) {
    const waiter = r.waiters.shift();
    if (waiter) waiter(key);
    else r.queue.push(key);
  }
}

function attach(input, r) {
  if (r.attached) return;
  r.attached = true;
  input.setRawMode(true); // no-op when already raw — the mode never toggles mid-wizard
  input.resume();
  r.onData = (buf) => {
    r.acc += buf.toString('utf8');
    if (r.timer !== null) { clearTimeout(r.timer); r.timer = null; }
    // Wait briefly when the tail could still complete a sequence — flushing
    // early would decode half an arrow as a spurious Esc.
    if (incompleteTail(r.acc)) { r.timer = setTimeout(() => flush(r), SEQ_GRACE_MS); return; }
    flush(r);
  };
  input.on('data', r.onData);
}

/**
 * Read a single decoded keypress. The underlying stream stays in raw mode
 * with the listener attached between calls (see header) — call `releaseKeys`
 * when the key-driven screen is done and prompts need the stream back.
 */
export function readKey({ input = process.stdin } = {}) {
  const r = reader(input);
  if (r.queue.length > 0) return Promise.resolve(r.queue.shift());
  attach(input, r);
  return new Promise((resolve) => { r.waiters.push(resolve); });
}

/**
 * Detach the persistent reader: pause the stream and drop buffered keys
 * (leftover menu keystrokes must not leak into the next screen or a readline
 * prompt). Raw mode is intentionally left as-is — see the header on why
 * toggling it here races conpty. Idempotent.
 */
export function releaseKeys({ input = process.stdin } = {}) {
  const r = readers.get(input);
  if (!r || !r.attached) return;
  if (r.timer !== null) { clearTimeout(r.timer); r.timer = null; }
  input.off('data', r.onData);
  r.onData = null;
  input.pause();
  r.attached = false;
  r.acc = '';
  r.queue.length = 0;
}
