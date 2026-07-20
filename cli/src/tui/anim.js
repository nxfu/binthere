// anim.js — subtle TTY-only motion. Everything degrades to static output when
// stderr is not a TTY, so scripted runs and tests see the same plain frames.
import { CLEAR, center, HIDE_CURSOR, HOME, SHOW_CURSOR, SWEEP_MS } from './screen.js';

const ESC = String.fromCharCode(0x1b);

/** Carriage return + erase-line: rewrite an animated line in place. */
export const CLEAR_LINE = `\r${ESC}[2K`;

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const INTRO_MS = 900;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Play a short full-screen intro on stderr: `frameFor(t)` builds the frame
 * lines for elapsed ms `t`, redrawn ~30fps by overwriting in place (the frame
 * shape must stay constant). No-op without a TTY. The caller draws the final
 * resolved screen right after, so the last animation frame is never stale.
 */
export async function playIntro(io, frameFor, duration = INTRO_MS) {
  if (io.stderrIsTTY !== true) return;
  const start = Date.now();
  let drawn = false;
  io.stderr(HIDE_CURSOR);
  try {
    for (;;) {
      const t = Date.now() - start;
      if (t >= duration) return;
      io.stderr((drawn ? HOME : CLEAR) + frameFor(t).join('\n') + '\n');
      drawn = true;
      await sleep(33);
    }
  } finally {
    io.stderr(SHOW_CURSOR);
  }
}

export const SWEEP_EVERY_MS = 7000;

const TICK = Symbol('tick');

/** Race `pending` against a cancellable timer, so timers never outlive the wait. */
function raceDelay(pending, ms) {
  let timer;
  return Promise.race([
    pending,
    new Promise((resolve) => { timer = setTimeout(() => resolve(TICK), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Wait for `pending` while playing periodic shine sweeps: after each idle
 * `everyMs`, a ~30fps sweep runs for `sweepMs` via `drawFrame(t)`, and
 * `drawFrame(null)` restores the resting frame. Resolves with pending's value
 * the moment it settles, mid-sweep or not.
 */
export async function shimmerWhile(pending, drawFrame, { everyMs = SWEEP_EVERY_MS, sweepMs = SWEEP_MS } = {}) {
  for (;;) {
    let key = await raceDelay(pending, everyMs);
    if (key !== TICK) return key;
    const start = Date.now();
    for (;;) {
      const t = Date.now() - start;
      if (t >= sweepMs) { drawFrame(null); break; }
      drawFrame(t);
      key = await raceDelay(pending, 33);
      if (key !== TICK) { drawFrame(null); return key; }
    }
  }
}

/**
 * Run `fn` while a braille spinner ticks next to `label` on stderr, erasing
 * the line when the work settles. The line is centered like the rest of the
 * wizard (io without `columns` gets no pad). Without a TTY the label prints
 * once as a plain dim line instead.
 */
export async function withSpinner(io, theme, label, fn) {
  if (io.stderrIsTTY !== true) {
    io.stderr(theme.dim(label) + '\n');
    return fn();
  }
  const cols = typeof io.columns === 'function' ? io.columns() : 0;
  let frame = 0;
  const draw = () => {
    io.stderr(CLEAR_LINE + center(`${theme.accent(SPINNER[frame % SPINNER.length])} ${theme.dim(label)}`, cols));
    frame++;
  };
  draw();
  const timer = setInterval(draw, 80);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    io.stderr(CLEAR_LINE);
  }
}
