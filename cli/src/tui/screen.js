// screen.js — pure string builders and ANSI constants for the full-screen UI.
// Nothing here writes to a stream; callers compose frames and send them to
// stderr, keeping stdout clean for machine-readable output.
const ESC = String.fromCharCode(0x1b);

// [2J wipes the viewport only: each wizard page starts on a clean screen but
// the user's scrollback survives. ([3J would erase scrollback too — history
// the CLI didn't create is not ours to destroy.) The final result screen
// still persists — nothing clears after it.
export const CLEAR = `${ESC}[2J${ESC}[H`;
export const HOME = `${ESC}[H`;
// Erase from the cursor to end of line — appended per line by frames whose
// shape changes between redraws (e.g. the header slide), so rows the content
// just vacated don't keep stale glyphs.
export const ERASE_EOL = `${ESC}[K`;
export const HIDE_CURSOR = `${ESC}[?25l`;
export const SHOW_CURSOR = `${ESC}[?25h`;

const BEL = String.fromCharCode(0x07);
// OSC 11: repaint the terminal's default background as a soft blue wash while
// the wizard runs (Yoinks paints its theme background the same way). OSC 111
// restores the terminal's own background on exit. Terminals that don't
// support it ignore the sequence.
export const SET_BG = `${ESC}]11;#24374e${BEL}`;
export const RESET_BG = `${ESC}]111${BEL}`;
export const SAVE_CURSOR = `${ESC}7`;
export const RESTORE_CURSOR = `${ESC}8`;

/** Move the cursor to 1-based viewport `row`, `col`. */
export const moveTo = (row, col) => `${ESC}[${row};${col}H`;

/** Below this many columns the boxes/logo are skipped for plain lines. */
export const MIN_WIDTH = 60;

const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

export const stripAnsi = (s) => s.replace(ANSI_RE, '');

export function center(line, width) {
  const pad = Math.max(0, Math.floor((width - stripAnsi(line).length) / 2));
  return ' '.repeat(pad) + line;
}

// Three-row half-block wordmark: B i N T H E R E (30 columns). Three text
// rows give each letter a 3×5 pixel grid (the Yoinks letterform style), so
// E/T/H keep their proper bars instead of the squashed two-row shapes.
export const LOGO = [
  '█▀▄ █ █▄ █ ▀█▀ █ █ █▀▀ █▀▄ █▀▀',
  '█▀▄ █ █ ▀█  █  █▀█ █▀  █▀▄ █▀ ',
  '▀▀  ▀ ▀  ▀  ▀  ▀ ▀ ▀▀▀ ▀ ▀ ▀▀▀',
];

/** Full-width dim horizontal rule delimiting screen sections. */
export function rule(width, theme) {
  return theme.dim('─'.repeat(width));
}

/**
 * Wrap lines in a rounded hairline box (dim border, one space of padding),
 * sized to the widest visible line.
 */
export function box(lines, theme) {
  const inner = Math.max(...lines.map((l) => stripAnsi(l).length));
  const side = theme.dim('│');
  return [
    theme.dim('╭' + '─'.repeat(inner + 2) + '╮'),
    ...lines.map((l) => `${side} ${l}${' '.repeat(inner - stripAnsi(l).length)} ${side}`),
    theme.dim('╰' + '─'.repeat(inner + 2) + '╯'),
  ];
}

// Logo gradient endpoints: light steel blue fading into the brand iron-gall
// blue, left to right — a truecolor-only flourish.
const GRADIENT_FROM = [170, 205, 235];
const GRADIENT_TO = [58, 96, 130];

/**
 * The ember row above the wordmark: a wax-red spark dotting the "i" (column 4
 * of the logo), padded to the logo's width so centering keeps it aligned.
 * `glow: false` dims it — alternating the two makes it smoulder.
 */
export function logoEmber(theme, glow = true) {
  const spark = glow ? theme.danger('✦') : theme.dim('✦');
  return '    ' + spark + ' '.repeat(LOGO[0].length - 5);
}

function gradientCode(i, span) {
  const t = i / span;
  const [r, g, b] = GRADIENT_FROM.map((f, k) => Math.round(f + (GRADIENT_TO[k] - f) * t));
  return `${ESC}[38;2;${r};${g};${b}m`;
}

/**
 * The wordmark rows, painted: a horizontal gradient on truecolor terminals,
 * flat accent on 16-color ones, plain text otherwise.
 */
export function paintedLogo(theme) {
  if (!theme.on) return [...LOGO];
  if (!theme.truecolor) return LOGO.map((line) => theme.accent(line));
  const span = LOGO[0].length - 1;
  return LOGO.map((row) => {
    let out = '';
    for (let i = 0; i < row.length; i++) {
      if (row[i] === ' ') { out += ' '; continue; }
      out += gradientCode(i, span) + row[i];
    }
    return `${out}${ESC}[0m`;
  });
}

// Full-cell blocks flicker in through lighter shades; half blocks (▀ ▄) would
// spill outside the letterform if swapped, so they only dim while arriving.
const HALF_BLOCKS = new Set(['▀', '▄']);

function paintCell(theme, ch, i, span) {
  if (!theme.on) return ch;
  return theme.truecolor ? `${gradientCode(i, span)}${ch}${ESC}[0m` : theme.accent(ch);
}

/** Per-cell random arrival delays (ms) for the intro, one per logo cell. */
export function introDelays(spreadMs = 550) {
  return LOGO.map((row) => [...row].map(() => Math.random() * spreadMs));
}

/**
 * One frame of the materialise-in intro at elapsed time `t`: each glyph waits
 * its delay, flickers in as ░, sharpens to ▒, then resolves to the painted
 * glyph. Frame shape is constant (unresolved cells are spaces), so redraws
 * can overwrite in place.
 */
export function logoIntroFrame(theme, t, delays) {
  if (delays.every((row) => row.every((d) => t - d >= 220))) return paintedLogo(theme);
  const span = LOGO[0].length - 1;
  return LOGO.map((row, r) => {
    let out = '';
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === ' ') { out += ' '; continue; }
      const dt = t - delays[r][i];
      if (dt < 0) { out += ' '; continue; }
      if (dt < 220) {
        out += theme.dim(HALF_BLOCKS.has(ch) ? ch : (dt < 110 ? '░' : '▒'));
        continue;
      }
      out += paintCell(theme, ch, i, span);
    }
    return out;
  });
}

// Shine-sweep geometry (ported from Yoinks): the beam leans like / — TILT
// columns of lean per row — and fades out HALF columns from its centre line.
const SWEEP_TILT = 2;
const SWEEP_HALF = 2.4;
export const SWEEP_MS = 1000;

const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);

/**
 * One frame of the shine sweep at elapsed time `t` ∈ [0, SWEEP_MS]: a slanted
 * light beam crosses the wordmark left to right, lightening full blocks to ▒
 * as it passes (half blocks dim instead — swapping them would spill outside
 * the letterform). At either end of the sweep the beam sits off-logo, so the
 * frame equals the resting painted logo.
 */
export function logoSweepFrame(theme, t) {
  const rows = LOGO.length;
  const cols = LOGO[0].length;
  const span = cols - 1;
  const pMin = -SWEEP_TILT * rows - SWEEP_HALF;
  const pMax = cols + SWEEP_HALF;
  const p = pMin + easeOutCubic(Math.min(Math.max(t / SWEEP_MS, 0), 1)) * (pMax - pMin);
  return LOGO.map((row, r) => {
    let out = '';
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === ' ') { out += ' '; continue; }
      const d = Math.abs(i - (rows - 1 - r) * SWEEP_TILT - p);
      if (d > SWEEP_HALF || 1 - d / SWEEP_HALF <= 0.35) {
        out += paintCell(theme, ch, i, span);
        continue;
      }
      out += HALF_BLOCKS.has(ch) ? theme.dim(ch) : paintCell(theme, '▒', i, span);
    }
    return out;
  });
}

/** Key-hint footer line: `↵ select · ↑↓ move · ^c quit`. */
export function footer(hints, theme) {
  return hints
    .map(([key, label]) => `${theme.bold(key)} ${theme.dim(label)}`)
    .join(theme.dim('  ·  '));
}
