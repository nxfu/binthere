// wizard.js — the full-screen interactive flow behind a bare `binthere` on a
// TTY: a menu of Create / View / Delete, styled to match the website. Every
// note is one-time view and deletes after one read, or after 24 hours.
//
// All decoration goes to stderr; stdout carries only machine-readable output
// (the share URL on create, the plaintext on view), so `binthere | clip`
// still copies just the link even in interactive mode. View and Delete reuse
// cmdGet/cmdDelete verbatim — the safe burn ordering (peek → verify password →
// confirm → consume) lives in one place only.
import { encryptPaste, MAX_PLAINTEXT } from '../vendor/crypto.js';
import { Client } from './client.js';
import { LIFECYCLE_NOTE } from './commands/create.js';
import { cmdDelete } from './commands/delete.js';
import { cmdGet } from './commands/get.js';
import { UsageError } from './errors.js';
import { renderQrCompact } from './qr.js';
import { CLEAR_LINE, playIntro, reducedMotion, SHINE_CYCLE_MS, shimmerWhile, withSpinner } from './tui/anim.js';
import { selectMenu } from './tui/menu.js';
import { center, CLEAR, ERASE_EOL, footer, HIDE_CURSOR, introDelays, LOGO, logoEmber, logoIntroFrame, logoSweepFrame, MIN_WIDTH, moveTo, paintedLogo, RESET_BG, RESTORE_CURSOR, rule, SAVE_CURSOR, SET_BG, SHOW_CURSOR, SWEEP_MS } from './tui/screen.js';
import { makeTheme } from './tui/theme.js';
import { buildShareUrl, DEFAULT_SERVER, isBurnId, normalizeServer, parseShareUrl } from './url.js';

const LIFECYCLE_SENTENCE = LIFECYCLE_NOTE.charAt(0).toUpperCase() + LIFECYCLE_NOTE.slice(1) + '.';

/**
 * Clear the viewport and draw a centered page header. Narrow terminals omit
 * the logo.
 */
function screenHeader(io, theme, title, subtitle = '') {
  const cols = io.columns();
  const width = Math.min(cols, 100);
  if (io.stderrIsTTY === true) io.stderr(CLEAR);
  const titled = theme.bold(title) + (subtitle ? ` ${theme.dim(subtitle)}` : '');
  const lines = width >= MIN_WIDTH
    ? [
      center(logoEmber(theme), cols),
      ...paintedLogo(theme).map((l) => center(l, cols)),
      '',
      center(titled, cols),
      '',
    ]
    : ['', center(titled, cols), ''];
  io.stderr(lines.join('\n') + '\n');
  return width;
}

/** Left pad that puts the logo where centered header lines drew it. */
const logoPad = (io) => Math.max(0, Math.floor((io.columns() - LOGO[0].length) / 2));

/**
 * Build the absolute-position result-logo painter. It returns false after a
 * resize so the scheduler stops using invalid coordinates.
 */
export function resultShine(io, theme, { width, used }) {
  const initialColumns = io.columns();
  const initialRows = io.rows();
  if (reducedMotion(io) || width < MIN_WIDTH || initialRows < used + 3) return null;
  return (t) => {
    if (io.columns() !== initialColumns || io.rows() !== initialRows) return false;
    io.stderr(SAVE_CURSOR
      + (t === null ? paintedLogo(theme) : logoSweepFrame(theme, t))
        .map((l, i) => moveTo(2 + i, 1) + ' '.repeat(logoPad(io)) + l).join('')
      + RESTORE_CURSOR);
    return true;
  };
}

// A pasted share URL runs ~96 columns; the input line starts where one would
// sit centered, so the paste lands visually centered under its label (narrow
// terminals get no pad — the URL wraps anyway).
const PASTE_COLS = 96;
const pastePad = (io) => ' '.repeat(Math.max(0, Math.floor((io.columns() - PASTE_COLS) / 2)));

/**
 * The reused commands (cmdGet/cmdDelete) print plain left-aligned prompts and
 * notices; on the wizard screens they're centered to match. stdout is left
 * untouched — it carries the machine-readable plaintext.
 */
function centeredIo(io) {
  const c = (s) => center(s, io.columns());
  return {
    ...io,
    stderr: (s) => io.stderr(s.split('\n').map((l) => (l === '' ? '' : c(l))).join('\n')),
    promptHidden: (q) => io.promptHidden(c(q)),
    confirm: (q) => io.confirm(c(q)),
  };
}

async function askPassword(io) {
  const c = (s) => center(s, io.columns());
  if (!await io.confirm(c('Add a password? [y/N] '))) return '';
  for (let attempt = 1; ; attempt++) {
    const first = await io.promptHidden(c('Password: '));
    const repeat = await io.promptHidden(c('Repeat:   '));
    if (first !== '' && first === repeat) return first;
    const problem = first === '' ? 'empty password' : 'passwords do not match';
    if (attempt === 2) throw new UsageError(problem);
    io.stderr(c(`${problem} — try again (the note is unrecoverable without it).`) + '\n');
  }
}

async function tuiCreate(io, theme, server) {
  const c = (s) => center(s, io.columns());
  const width = screenHeader(io, theme, 'Create a note', `· ${server}`);
  io.stderr(c(footer([
    ['↵', 'new line'],
    ['^q', 'create'],
    ['^c', 'abort'],
  ], theme)) + '\n');
  io.stderr(c(rule(width, theme)) + '\n');

  // Typed note lines start at the rule's left edge, keeping the input inside
  // the centered content column instead of hugging the terminal edge.
  const notePad = ' '.repeat(Math.max(0, Math.floor((io.columns() - width) / 2)));
  let text = await io.promptMultiline(notePad);
  if (text.trim() === '') {
    io.stderr(c('The note is empty — nothing was sent. Try again.') + '\n\n');
    text = await io.promptMultiline(notePad);
    if (text.trim() === '') throw new UsageError('empty note — nothing was sent');
  }
  if (new TextEncoder().encode(text).byteLength > MAX_PLAINTEXT) {
    throw new UsageError('note too large (max 1 MiB before compression)');
  }

  io.stderr(c(rule(width, theme)) + '\n\n');
  const password = await askPassword(io);

  io.stderr('\n');
  const { id, deletetoken, fragment } = await withSpinner(
    io, theme, 'encrypting locally and uploading ciphertext…',
    async () => {
      const enc = await encryptPaste({
        text, password, fmt: 'plaintext',
      });
      const client = new Client(server, io.fetch);
      const created = await client.createPaste(enc.body);
      return { ...created, fragment: enc.fragment };
    },
  );
  const url = buildShareUrl(server, id, fragment);

  // Fresh result screen; the typed note disappears from view, and the result
  // stays in scrollback after exit (the delete token is shown only once).
  // Everything except the bare URL is stderr decoration; the URL itself stays
  // unpadded on stdout so `binthere | clip` copies exactly the link.
  const rw = screenHeader(io, theme, 'Note sealed', `· ${server}`);
  io.stderr(c(theme.bold('Share this link — it is the only key:')) + '\n');
  // Pad the URL only when stdout is a terminal — piped stdout must stay
  // exactly the bare link.
  io.stdout((io.stdoutIsTTY === true ? ' '.repeat(Math.max(0, Math.floor((io.columns() - url.length) / 2))) : '') + url + '\n');
  let used = 11; // header (7) + share line + link + token + lifecycle rows
  const qr = renderQrCompact(url);
  if (qr) {
    const qrLines = qr.split('\n');
    // Header/link/token lines take ~13 rows; draw the QR only when the whole
    // screen fits so the logo never scrolls out of view.
    if (qrLines[0].length <= rw && io.rows() >= qrLines.length + 13) {
      io.stderr('\n' + qrLines.map((l) => c(l)).join('\n') + '\n\n');
      used += qrLines.length + 2;
    } else {
      io.stderr('\n' + c(theme.dim('(window too small for a QR — enlarge it and run `binthere create --qr`)')) + '\n\n');
      used += 3;
    }
  }
  io.stderr(c(theme.dim('delete token: ') + deletetoken) + '\n');
  io.stderr(c(theme.danger(LIFECYCLE_SENTENCE) + ' ' + theme.dim(`Anyone with the link${password ? ' and the password' : ''} can read it — once.`)) + '\n');

  // While the result screen waits for a key, a shine beam periodically sweeps
  // the wordmark (viewport rows 2–4, repainted in place around a saved
  // cursor). Skipped when the narrow header drew no logo, or when the screen
  // scrolled (+3 = copy footer rows and the cursor line) and rows 2–4 no
  // longer hold it.
  const sweep = resultShine(io, theme, { width: rw, used });
  await copyKeys(io, theme, url, deletetoken, sweep);
  return 0;
}

/**
 * One-keystroke clipboard access on the result screen (TTY only — scripted
 * runs keep the plain output and can pipe stdout instead). `c` copies the
 * link, `t` the delete token; the status line is rewritten in place, and any
 * other key leaves the screen intact in scrollback.
 */
async function copyKeys(io, theme, url, deletetoken, sweep = null) {
  if (io.stderrIsTTY !== true) return;
  const c = (s) => center(s, io.columns());
  io.stderr('\n' + c(footer([
    ['c', 'copy link'],
    ['t', 'copy token'],
    ['↵', 'done'],
  ], theme)) + '\n');
  // Reuse the schedule so copy actions do not restart the cadence.
  const shineSchedule = sweep ? { nextAt: performance.now() } : null;
  if (sweep) io.stderr(HIDE_CURSOR);
  try {
    let activeSweep = sweep;
    for (;;) {
      const key = activeSweep
        ? await shimmerWhile(io.readKey(), (t) => {
          if (activeSweep?.(t) === false) { activeSweep = null; return false; }
          return true;
        }, { schedule: shineSchedule })
        : await io.readKey();
      if (key !== 'c' && key !== 't') {
        io.stderr('\n');
        return;
      }
      const what = key === 'c' ? 'link' : 'delete token';
      const ok = await io.copy(key === 'c' ? url : deletetoken);
      io.stderr(CLEAR_LINE + c(ok
        ? theme.accent('✔') + ' ' + theme.dim(`${what} copied to clipboard`)
        : theme.danger('✘') + ' ' + theme.dim(`no clipboard tool found — select the ${what} manually`)));
    }
  } finally {
    if (sweep) io.stderr(SHOW_CURSOR);
    if (typeof io.releaseKeys === 'function') io.releaseKeys();
  }
}

async function tuiView(io, theme) {
  const c = (s) => center(s, io.columns());
  screenHeader(io, theme, 'View a note');
  io.stderr(c(theme.dim('Reading a note destroys it — you will be asked to confirm first.')) + '\n\n');
  io.stderr(c('Share URL:') + '\n');
  const url = await io.promptLine(pastePad(io));
  if (url === '') throw new UsageError('no share URL given');
  const { id } = parseShareUrl(url);

  // Track whether the plaintext was actually printed so the "burned" notice
  // never shows when the user declines the destructive-read confirmation.
  let printed = false;
  const wrapped = { ...centeredIo(io), stdout: (s) => { printed = true; io.stdout(s); } };
  io.stderr('\n');
  const code = await cmdGet([url], wrapped);
  if (code === 0 && printed && isBurnId(id)) {
    io.stderr('\n' + c(`${theme.danger('This note is now burned.')} ${theme.dim('The link no longer works.')}`) + '\n\n');
  }
  return code;
}

async function tuiDelete(io, theme) {
  const c = (s) => center(s, io.columns());
  screenHeader(io, theme, 'Delete a note');
  io.stderr(c(theme.dim('You will need the delete token shown when the note was created.')) + '\n\n');
  io.stderr(c('Share URL or id:') + '\n');
  const target = await io.promptLine(pastePad(io));
  if (target === '') throw new UsageError('no note given');
  io.stderr('\n');
  return cmdDelete([target], centeredIo(io));
}

export async function runWizard(io) {
  const theme = makeTheme(io);
  const server = normalizeServer(io.env.BINTHERE_SERVER ?? DEFAULT_SERVER);
  const width = Math.min(io.columns(), 100);
  const motion = !reducedMotion(io);

  const home = (logoRows, ember) => {
    const cols = io.columns();
    return [
      center(theme.dim('binthere'), cols),
      '',
      center(ember, cols),
      ...logoRows.map((line) => center(line, cols)),
      '',
      center(theme.bold('Zero-knowledge encrypted notes.'), cols),
      center(theme.dim('encrypted locally · one read · gone in 24 hours'), cols),
      '',
      center(theme.dim('server  ') + theme.accent(server), cols),
    ];
  };

  // Restore the terminal background even when a step aborts.
  const washed = theme.on && theme.truecolor && io.stderrIsTTY === true;
  if (washed) io.stderr(SET_BG);
  try {
    // Materialize the wordmark, then move it to the menu's centered position.
    if (motion && width >= MIN_WIDTH && io.env.TERM !== 'dumb') {
      // Keystrokes during the intro would echo over the animation and buffer
      // into the menu's first read — swallow them until the menu takes over.
      const unmute = typeof io.muteInput === 'function' ? io.muteInput() : null;
      try {
        const delays = introDelays();
        await playIntro(io, (t) => home(logoIntroFrame(theme, t, delays), logoEmber(theme)));
        // Account for the menu body so the intro ends at its resting row.
        const MENU_BODY_ROWS = 3 + 5;
        const SLIDE_MS = 520;
        const glide = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
        const drop = (lines) => Math.max(0, Math.floor((io.rows() - 1 - (lines.length + MENU_BODY_ROWS)) / 2));
        if (drop(home(paintedLogo(theme), logoEmber(theme))) > 0) {
          await playIntro(io, (t) => {
            const lines = home(paintedLogo(theme), logoEmber(theme));
            const pad = Math.round(glide(Math.min(t / SLIDE_MS, 1)) * drop(lines));
            // Clear the unused part of rows as the frame height changes.
            return [...Array.from({ length: pad }, () => ''), ...lines].map((l) => l + ERASE_EOL);
          }, SLIDE_MS);
        }
      } finally {
        unmute?.();
      }
    }

    const EMBER_CYCLE = 1800;
    const EMBER_FRAME = theme.on && theme.truecolor ? 80 : 700;
    const t0 = Date.now();
    const phase = () => (Date.now() - t0) % SHINE_CYCLE_MS;
    const header = () => {
      if (width < MIN_WIDTH) {
        const cols = io.columns();
        return [
          center(theme.bold('binthere'), cols),
          center(theme.dim('zero-knowledge encrypted notes'), cols),
          center(theme.dim(server), cols),
        ];
      }
      const elapsed = Date.now() - t0;
      const p = phase();
      const logoRows = motion && p < SWEEP_MS ? logoSweepFrame(theme, p) : paintedLogo(theme);
      const breath = motion
        ? 0.2 + 0.8 * (0.5 + 0.5 * Math.cos((elapsed / EMBER_CYCLE) * Math.PI * 2))
        : 1;
      return home(logoRows, logoEmber(theme, breath));
    };
    const tick = () => {
      const p = phase();
      if (p < SWEEP_MS) return 1000 / 60;
      return Math.max(16, Math.min(SHINE_CYCLE_MS - p, EMBER_FRAME));
    };

    const action = await selectMenu([
      { label: 'Create a note', desc: 'write, seal, and get a one-time link', value: 'create' },
      { label: 'View a note', desc: 'paste a share URL — reading burns it', value: 'view' },
      { label: 'Delete a note', desc: 'remove it early with the delete token', value: 'delete' },
    ], io, { header, tick });

    if (action === 'create') return await tuiCreate(io, theme, server);
    if (action === 'view') return await tuiView(io, theme);
    return await tuiDelete(io, theme);
  } finally {
    if (washed) io.stderr(RESET_BG);
  }
}
