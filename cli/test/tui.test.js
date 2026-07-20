// tui.test.js — pure renderers and key decoding for the full-screen wizard UI.
import { describe, expect, it } from 'vitest';
import { CLEAR_LINE, playIntro, shimmerWhile, SPINNER, withSpinner } from '../src/tui/anim.js';
import { osc52, tools } from '../src/tui/clipboard.js';
import { decodeKey } from '../src/tui/keys.js';
import { renderMenu, selectMenu } from '../src/tui/menu.js';
import { box, center, footer, introDelays, LOGO, logoIntroFrame, logoSweepFrame, MIN_WIDTH, paintedLogo, rule, stripAnsi, SWEEP_MS } from '../src/tui/screen.js';
import { makeTheme } from '../src/tui/theme.js';

const ESC = String.fromCharCode(0x1b);

const ttyTheme = makeTheme({ stderrIsTTY: true, env: { COLORTERM: 'truecolor' } });
const plainTheme = makeTheme({ stderrIsTTY: false, env: {} });

describe('decodeKey', () => {
  it('maps CSI and SS3 arrows', () => {
    expect(decodeKey(Buffer.from(`${ESC}[A`))).toBe('up');
    expect(decodeKey(Buffer.from(`${ESC}OA`))).toBe('up');
    expect(decodeKey(Buffer.from(`${ESC}[B`))).toBe('down');
    expect(decodeKey(Buffer.from(`${ESC}OB`))).toBe('down');
  });

  it('maps enter, ctrl-c and bare escape', () => {
    expect(decodeKey(Buffer.from('\r'))).toBe('enter');
    expect(decodeKey(Buffer.from('\n'))).toBe('enter');
    expect(decodeKey(Buffer.from(String.fromCharCode(0x03)))).toBe('ctrl-c');
    expect(decodeKey(Buffer.from(ESC))).toBe('esc');
  });

  it('passes ordinary characters through', () => {
    expect(decodeKey(Buffer.from('j'))).toBe('j');
    expect(decodeKey(Buffer.from('2'))).toBe('2');
  });
});

describe('theme', () => {
  it('paints with truecolor brand codes on a TTY', () => {
    expect(ttyTheme.on).toBe(true);
    expect(ttyTheme.accent('x')).toBe(`${ESC}[38;2;106;148;186mx${ESC}[0m`);
    expect(ttyTheme.danger('x')).toBe(`${ESC}[38;2;192;85;74mx${ESC}[0m`);
  });

  it('falls back to 16-color without COLORTERM/WT_SESSION', () => {
    const t = makeTheme({ stderrIsTTY: true, env: {} });
    expect(t.accent('x')).toBe(`${ESC}[34mx${ESC}[0m`);
    expect(t.danger('x')).toBe(`${ESC}[31mx${ESC}[0m`);
  });

  it('is plain when NO_COLOR is set or stderr is not a TTY', () => {
    const noColor = makeTheme({ stderrIsTTY: true, env: { NO_COLOR: '1' } });
    expect(noColor.on).toBe(false);
    expect(noColor.accent('x')).toBe('x');
    expect(plainTheme.bold('x')).toBe('x');
  });
});

describe('screen builders', () => {
  it('centers on visible length, ignoring ANSI paint', () => {
    expect(center('ab', 10)).toBe('    ab');
    const painted = ttyTheme.accent('ab');
    expect(center(painted, 10)).toBe('    ' + painted);
    expect(center('too wide for this', 4)).toBe('too wide for this');
  });

  it('logo is three rows of equal width', () => {
    expect(LOGO).toHaveLength(3);
    expect(LOGO[1].length).toBe(LOGO[0].length);
    expect(LOGO[2].length).toBe(LOGO[0].length);
    expect(LOGO[0].length).toBeLessThan(MIN_WIDTH);
  });

  it('rule spans the width as a dim line', () => {
    expect(stripAnsi(rule(12, ttyTheme))).toBe('─'.repeat(12));
    expect(rule(5, plainTheme)).toBe('─────');
  });

  it('paintedLogo gradients per column on truecolor, stays plain otherwise', () => {
    const painted = paintedLogo(ttyTheme);
    expect(painted).toHaveLength(3);
    expect(painted[0]).toContain(`${ESC}[38;2;`);
    expect(painted.map(stripAnsi)).toEqual(LOGO);
    expect(paintedLogo(plainTheme)).toEqual(LOGO);
    const basic = makeTheme({ stderrIsTTY: true, env: {} });
    expect(paintedLogo(basic)[0]).toBe(`${ESC}[34m${LOGO[0]}${ESC}[0m`);
  });

  it('box wraps lines in a rounded border padded to the widest line', () => {
    const lines = box(['ab', 'a'], plainTheme);
    expect(lines).toEqual([
      '╭────╮',
      '│ ab │',
      '│ a  │',
      '╰────╯',
    ]);
    const painted = box([ttyTheme.accent('ab')], ttyTheme);
    expect(stripAnsi(painted[1])).toBe('│ ab │');
  });

  it('footer joins key hints with separators', () => {
    const line = footer([['↵', 'select'], ['^c', 'quit']], plainTheme);
    expect(line).toBe('↵ select  ·  ^c quit');
  });

  it('renderMenu marks only the selected item', () => {
    const items = [{ label: 'Create', value: 'c' }, { label: 'View', value: 'v' }];
    const lines = renderMenu(items, 1, plainTheme);
    expect(lines[0]).toBe('  1 Create');
    expect(lines[1]).toBe('❯ 2 View');
  });

  it('renderMenu aligns descriptions past the widest label, and can drop them', () => {
    const items = [
      { label: 'Create', desc: 'seal a note', value: 'c' },
      { label: 'View it', desc: 'burn on read', value: 'v' },
    ];
    const lines = renderMenu(items, 0, plainTheme);
    expect(lines[0]).toBe('❯ 1 Create    seal a note');
    expect(lines[1]).toBe('  2 View it   burn on read');
    const bare = renderMenu(items, 0, plainTheme, { descs: false });
    expect(bare[0]).toBe('❯ 1 Create');
  });

  it('NO_COLOR frames contain no escape codes', () => {
    const lines = [
      ...paintedLogo(plainTheme),
      rule(24, plainTheme),
      footer([['↵', 'ok']], plainTheme),
      center('mid', 24),
    ];
    for (const line of lines) expect(line).not.toContain(ESC);
  });
});

describe('logo intro', () => {
  const zeroDelays = LOGO.map((row) => [...row].map(() => 0));

  it('introDelays matches the logo shape with bounded values', () => {
    const delays = introDelays(500);
    expect(delays).toHaveLength(LOGO.length);
    delays.forEach((row, r) => {
      expect(row).toHaveLength(LOGO[r].length);
      for (const d of row) {
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(500);
      }
    });
  });

  it('cells are blank before their delay, keeping the frame shape', () => {
    const late = LOGO.map((row) => [...row].map(() => 400));
    const frame = logoIntroFrame(plainTheme, 100, late);
    expect(frame).toEqual(LOGO.map((row) => ' '.repeat(row.length)));
  });

  it('full blocks flicker ░ then ▒ while half blocks keep their glyph', () => {
    const early = logoIntroFrame(plainTheme, 0, zeroDelays);
    expect(early).toEqual(LOGO.map((row) => row.replaceAll('█', '░')));
    const mid = logoIntroFrame(plainTheme, 150, zeroDelays);
    expect(mid).toEqual(LOGO.map((row) => row.replaceAll('█', '▒')));
  });

  it('resolves to exactly the painted logo', () => {
    expect(logoIntroFrame(plainTheme, 300, zeroDelays)).toEqual(paintedLogo(plainTheme));
    expect(logoIntroFrame(ttyTheme, 300, zeroDelays)).toEqual(paintedLogo(ttyTheme));
  });

  it('playIntro is a no-op without a TTY', async () => {
    let err = '';
    await playIntro({ stderr: (s) => { err += s; }, stderrIsTTY: false }, () => ['x']);
    expect(err).toBe('');
  });

  it('playIntro redraws frames in place for the given duration', async () => {
    let err = '';
    const ts = [];
    const io = { stderr: (s) => { err += s; }, stderrIsTTY: true };
    await playIntro(io, (t) => { ts.push(t); return ['line']; }, 120);
    expect(ts.length).toBeGreaterThanOrEqual(2);
    expect(err).toContain('line');
    expect(err).toContain(`${ESC}[2J`); // first paint clears
    expect(err).toContain(`${ESC}[H`); // later paints re-home
  });
});

describe('logo shine sweep', () => {
  it('rests on the painted logo at both ends of the sweep', () => {
    expect(logoSweepFrame(plainTheme, 0)).toEqual(LOGO);
    expect(logoSweepFrame(plainTheme, SWEEP_MS)).toEqual(LOGO);
  });

  it('lightens full blocks to ▒ mid-sweep and never swaps half blocks', () => {
    const mid = logoSweepFrame(plainTheme, 450);
    expect(mid).not.toEqual(LOGO);
    expect(mid.join('\n')).toContain('▒');
    for (let t = 0; t <= SWEEP_MS; t += 50) {
      logoSweepFrame(ttyTheme, t).forEach((row, r) => {
        const glyphs = stripAnsi(row);
        for (let i = 0; i < LOGO[r].length; i++) {
          if (LOGO[r][i] === '▀' || LOGO[r][i] === '▄' || LOGO[r][i] === ' ') {
            expect(glyphs[i]).toBe(LOGO[r][i]);
          }
        }
      });
    }
  });

  it('shimmerWhile resolves immediately when the key is already pressed', async () => {
    const frames = [];
    const out = await shimmerWhile(Promise.resolve('enter'), (t) => frames.push(t), { everyMs: 5 });
    expect(out).toBe('enter');
    expect(frames).toEqual([]);
  });

  it('shimmerWhile plays sweep frames while idle and restores the resting frame', async () => {
    const frames = [];
    const pending = new Promise((resolve) => setTimeout(() => resolve('enter'), 150));
    const out = await shimmerWhile(pending, (t) => frames.push(t), { everyMs: 20, sweepMs: 60 });
    expect(out).toBe('enter');
    expect(frames.some((t) => typeof t === 'number')).toBe(true);
    expect(frames[frames.length - 1]).toBe(null);
  });
});

describe('clipboard', () => {
  it('osc52 wraps the text as a base64 set-clipboard sequence', () => {
    const BEL = String.fromCharCode(0x07);
    expect(osc52('hi')).toBe(`${ESC}]52;c;aGk=${BEL}`);
  });

  it('picks the platform tool, preferring clip.exe under WSL', () => {
    expect(tools('win32')).toEqual([['clip', []]]);
    expect(tools('darwin')).toEqual([['pbcopy', []]]);
    expect(tools('linux', '6.6.0-generic')[0][0]).toBe('wl-copy');
    expect(tools('linux', '5.15.167.4-microsoft-standard-WSL2')[0][0]).toBe('clip.exe');
    expect(tools('linux', '4.4.0-19041-Microsoft')[0][0]).toBe('clip.exe');
  });
});

describe('withSpinner', () => {
  it('prints the label once and returns the result without a TTY', async () => {
    let err = '';
    const io = { stderr: (s) => { err += s; }, stderrIsTTY: false };
    const out = await withSpinner(io, plainTheme, 'working…', async () => 42);
    expect(out).toBe(42);
    expect(err).toBe('working…\n');
  });

  it('ticks braille frames on a TTY and erases the line when done', async () => {
    let err = '';
    const io = { stderr: (s) => { err += s; }, stderrIsTTY: true, env: { NO_COLOR: '1' } };
    const theme = makeTheme(io);
    const out = await withSpinner(io, theme, 'sealing…', () => new Promise((resolve) => {
      setTimeout(() => resolve('ok'), 200);
    }));
    expect(out).toBe('ok');
    expect(err).toContain(SPINNER[0]);
    expect(err).toContain(SPINNER[1]);
    expect(err.endsWith(CLEAR_LINE)).toBe(true);
  });

  it('erases the line even when the work throws', async () => {
    let err = '';
    const io = { stderr: (s) => { err += s; }, stderrIsTTY: true, env: { NO_COLOR: '1' } };
    const theme = makeTheme(io);
    await expect(withSpinner(io, theme, 'x', () => Promise.reject(new Error('boom'))))
      .rejects.toThrow('boom');
    expect(err.endsWith(CLEAR_LINE)).toBe(true);
  });
});

describe('selectMenu', () => {
  const items = [
    { label: 'Create', value: 'create' },
    { label: 'View', value: 'view' },
    { label: 'Delete', value: 'delete' },
  ];
  const makeIo = (keys) => {
    let err = '';
    return {
      io: {
        stderr: (s) => { err += s; },
        stderrIsTTY: false,
        columns: () => 80,
        env: {},
        readKey: () => Promise.resolve(keys.shift()),
      },
      stderr: () => err,
    };
  };

  it('moves with arrows, wraps, and selects on enter', async () => {
    const { io } = makeIo(['down', 'down', 'down', 'enter']); // wraps back to Create
    await expect(selectMenu(items, io)).resolves.toBe('create');
  });

  it('wraps upward from the first item', async () => {
    const { io } = makeIo(['up', 'enter']);
    await expect(selectMenu(items, io)).resolves.toBe('delete');
  });

  it('jumps with number hotkeys', async () => {
    const { io } = makeIo(['3']);
    await expect(selectMenu(items, io)).resolves.toBe('delete');
  });

  it('aborts on ctrl-c, esc, and q', async () => {
    for (const key of ['ctrl-c', 'esc', 'q']) {
      const { io } = makeIo([key]);
      await expect(selectMenu(items, io)).rejects.toThrow(/aborted/);
    }
  });

  it('renders frames to stderr without clearing when not a TTY', async () => {
    const { io, stderr } = makeIo(['enter']);
    await selectMenu(items, io, { header: ['welcome'], status: ['-- status --'] });
    expect(stderr()).toContain('welcome');
    expect(stderr()).toContain('❯ 1 Create');
    expect(stderr()).toContain('-- status --');
    expect(stderr()).not.toContain(ESC);
  });

  it('renders a header function at frame 0 without a TTY (no animation)', async () => {
    const { io, stderr } = makeIo(['enter']);
    await selectMenu(items, io, { header: (frame) => [`frame ${frame}`], tick: 40 });
    expect(stderr()).toContain('frame 0');
    expect(stderr()).not.toContain('frame 1');
  });

  it('advances the header frame on idle ticks on a TTY', async () => {
    let err = '';
    const frames = [];
    const io = {
      stderr: (s) => { err += s; },
      stderrIsTTY: true,
      columns: () => 80,
      env: { NO_COLOR: '1' },
      readKey: () => new Promise((resolve) => setTimeout(() => resolve('enter'), 150)),
    };
    await expect(selectMenu(items, io, {
      header: (frame) => { frames.push(frame); return [`frame ${frame}`]; },
      tick: 40,
    })).resolves.toBe('create');
    expect(Math.max(...frames)).toBeGreaterThanOrEqual(2);
    expect(err).toContain('frame 2');
  });

  it('boxes and centers the items on wide terminals', async () => {
    const { io, stderr } = makeIo(['enter']);
    await selectMenu(items, io);
    expect(stderr()).toMatch(/^ +╭─+╮$/m);
    expect(stderr()).toMatch(/^ +│ ❯ 1 Create │$/m);
    expect(stderr()).toMatch(/^ +│ {3}2 View {3}│$/m);
    expect(stderr()).toMatch(/^ +╰─+╯$/m);
  });
});
