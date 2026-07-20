// menu.js — arrow-key menu for the full-screen wizard. renderMenu is pure;
// selectMenu drives frames on stderr and reads keys via the injected io, so
// tests can script the whole interaction without a TTY.
import { AbortError } from '../errors.js';
import { box, center, CLEAR, footer, HIDE_CURSOR, HOME, MIN_WIDTH, SHOW_CURSOR } from './screen.js';
import { makeTheme } from './theme.js';

/**
 * Render the menu as two-column lines: `❯` marker + hotkey + label, then the
 * item's dim description aligned past the widest label (skipped when narrow).
 */
export function renderMenu(items, selected, theme, { descs = true } = {}) {
  const labelWidth = Math.max(...items.map((item) => item.label.length));
  return items.map((item, i) => {
    const hotkey = theme.dim(`${i + 1}`);
    const marker = i === selected ? theme.accent('❯') : ' ';
    const label = i === selected ? theme.bold(item.label) : item.label;
    const desc = descs && item.desc
      ? `${' '.repeat(labelWidth - item.label.length)}   ${theme.dim(item.desc)}`
      : '';
    return `${marker} ${hotkey} ${label}${desc}`;
  });
}

/**
 * Full-screen menu: caller-built header on top, items with descriptions in a
 * rounded hairline box (wide terminals), key-hint footer, optional status
 * lines at the bottom — every line centered (Yoinks-style), and the whole
 * frame vertically centered on a TTY. `header` may be a function of an
 * animation frame counter; with `tick` (a delay in ms, or a function of the
 * frame returning one) on a TTY, idle redraws advance it (the frame shape
 * must stay constant — redraws overwrite in place).
 * Resolves with the selected item's `value`. Ctrl+C / Esc / q abort.
 */
export async function selectMenu(items, io, { header = [], status = [], tick = 0 } = {}) {
  const fancy = io.stderrIsTTY === true;
  let selected = 0;
  let frame = 0;
  let drawn = false;
  let drawnShape = '';

  const drawFrame = (theme) => {
    const cols = io.columns();
    const width = Math.min(cols, 100);
    const wide = width >= MIN_WIDTH;
    const headerLines = typeof header === 'function' ? header(frame) : header;
    const out = [...headerLines, ''];
    const lines = renderMenu(items, selected, theme, { descs: wide });
    const hints = footer([
      ['↑↓', 'move'],
      ['↵', 'select'],
      ['1-' + items.length, 'jump'],
      ['^c', 'quit'],
    ], theme);
    if (wide) {
      out.push(...box(lines, theme).map((l) => center(l, cols)));
    } else {
      out.push(...lines.map((l) => center(l, cols)));
    }
    out.push('', center(hints, cols));
    if (wide && status.length > 0) out.push('', ...status.map((l) => center(l, cols)));
    if (fancy) {
      const rows = typeof io.rows === 'function' ? io.rows() : 24;
      out.unshift(...Array.from({ length: Math.max(0, Math.floor((rows - 1 - out.length) / 2)) }, () => ''));
    }
    // First paint clears the screen; later paints just re-home the cursor and
    // overwrite (same frame shape), so the idle animation never flickers. A
    // resize changes the shape, so that repaint clears again.
    const shape = `${out.length}x${cols}`;
    io.stderr((fancy ? (drawn && drawnShape === shape ? HOME : CLEAR) : '') + out.join('\n') + '\n');
    drawn = true;
    drawnShape = shape;
  };

  const theme = makeTheme(io);
  const animate = fancy && (typeof tick === 'function' || tick > 0);
  const TICK = Symbol('tick');
  if (fancy) io.stderr(HIDE_CURSOR);
  try {
    let pending = null;
    for (;;) {
      drawFrame(theme);
      let key;
      if (animate) {
        pending = pending ?? io.readKey();
        let timer;
        const delay = typeof tick === 'function' ? tick(frame) : tick;
        key = await Promise.race([
          pending,
          new Promise((resolve) => { timer = setTimeout(() => resolve(TICK), delay); }),
        ]);
        clearTimeout(timer);
        if (key === TICK) { frame++; continue; }
        pending = null;
      } else {
        key = await io.readKey();
      }
      if (key === 'up' || key === 'k') selected = (selected - 1 + items.length) % items.length;
      else if (key === 'down' || key === 'j') selected = (selected + 1) % items.length;
      else if (key === 'enter') return items[selected].value;
      else if (key === 'ctrl-c' || key === 'esc' || key === 'q') {
        throw new AbortError();
      } else {
        const n = Number.parseInt(key, 10);
        if (n >= 1 && n <= items.length) return items[n - 1].value;
      }
    }
  } finally {
    if (fancy) io.stderr(SHOW_CURSOR);
  }
}
