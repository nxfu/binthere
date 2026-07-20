// a11y.test.js — focus management (#16) and WCAG AA contrast tokens (#17).
//
// The contrast check parses the real stylesheet's theme tokens and computes
// WCAG 2.x contrast ratios, so a future palette tweak that drops informative
// text below AA fails here instead of shipping.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { showView } from '../public/js/ui.js';

// ── #16: view transitions move focus ────────────────────────────────────────

const VIEW_IDS = ['view-create', 'view-success', 'view-password', 'view-paste', 'view-status'];

function buildViews() {
  document.body.innerHTML = '';
  for (const id of VIEW_IDS) {
    const s = document.createElement('section');
    s.id = id;
    s.tabIndex = -1;
    s.hidden = true;
    document.body.appendChild(s);
  }
  const btn = document.createElement('button');
  btn.id = 'inside-create';
  document.getElementById('view-create').appendChild(btn);
}

describe('showView — keyboard/screen-reader focus follows the transition', () => {
  it('shows exactly one view and focuses it', () => {
    buildViews();
    showView('success');
    for (const id of VIEW_IDS) {
      expect(document.getElementById(id).hidden).toBe(id !== 'view-success');
    }
    expect(document.activeElement).toBe(document.getElementById('view-success'));
  });

  it('moves focus off a control that just became hidden', () => {
    buildViews();
    showView('create');
    document.getElementById('inside-create').focus();
    showView('status');
    expect(document.activeElement).toBe(document.getElementById('view-status'));
  });

  it('does not yank focus on repeated transitions to the same view', () => {
    buildViews();
    showView('create');
    const btn = document.getElementById('inside-create');
    btn.focus();
    showView('create'); // e.g. repeated status()/re-render of the same screen
    expect(document.activeElement).toBe(btn);
  });
});

// ── #17: theme tokens meet WCAG AA for normal text ──────────────────────────

// happy-dom rewrites import.meta.url to an http: URL, so resolve from the
// vitest root (the repo root) instead.
const css = readFileSync(join(process.cwd(), 'public/css/styles.css'), 'utf8');

/** Pull `--name: #hex;` token values out of one top-level CSS block. */
function tokensOf(selectorRe) {
  const block = css.match(selectorRe)?.[1];
  expect(block, 'theme block present').toBeTruthy();
  const out = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  return out;
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('theme tokens — WCAG AA (4.5:1) for every non-decorative ink', () => {
  const themes = {
    light: tokensOf(/:root\s*\{([^}]*)\}/),
    dark: tokensOf(/html\.dark\s*\{([^}]*)\}/),
  };
  // --ink-4 is exempt by contract: decorative only (watermark, separator
  // dots) — the stylesheet must not use it for text.
  const textTokens = ['ink', 'ink-2', 'ink-3'];
  const surfaces = ['paper', 'sheet', 'sheet-2'];

  for (const [name, t] of Object.entries(themes)) {
    for (const ink of textTokens) {
      for (const bg of surfaces) {
        it(`${name}: --${ink} on --${bg} ≥ 4.5:1`, () => {
          expect(t[ink], `--${ink} defined`).toBeTruthy();
          expect(t[bg], `--${bg} defined`).toBeTruthy();
          expect(contrast(t[ink], t[bg])).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }

  it('--ink-4 styles no text: no color declaration uses it outside the watermark/separator', () => {
    // The two sanctioned decorative uses; anything else must use --ink-3+.
    const uses = [...css.matchAll(/^.*var\(--ink-4\).*$/gm)].map((m) => m[0].trim());
    for (const line of uses) {
      expect(
        /\.watermark|\.feat \+ \.feat::before|--ink-4:/.test(line),
        `unexpected --ink-4 use: ${line}`,
      ).toBe(true);
    }
  });
});
