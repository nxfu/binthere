// mount.test.js — the XSS sink surface, tested against a real DOM (happy-dom).
//
// In this threat model an XSS is a decryption-key leak (SECURITY.md §4). The
// pure parsers are adversarially tested in test/, but the load-bearing defense
// is the mount layer: renderMarkdown/highlightInto must only ever produce
// nodes via createElement + textContent. These tests mount hostile fixtures
// and assert the rendered tree contains no live HTML — so a future innerHTML
// slip fails the suite instead of shipping.
import { describe, it, expect } from 'vitest';
import { renderMarkdown, MAX_MD_BYTES } from '../public/js/markdown.js';
import { highlightInto, MAX_HIGHLIGHT_BYTES } from '../public/js/highlight.js';

const ALLOWED_MD_TAGS = new Set([
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'BLOCKQUOTE', 'PRE', 'CODE',
  'STRONG', 'EM', 'A', 'HR', 'UL', 'OL', 'LI', 'DIV',
]);

/** Assert `root` contains no script-capable content anywhere. */
function assertInert(root) {
  // No live elements beyond the renderer's whitelist.
  for (const el of root.querySelectorAll('*')) {
    expect(ALLOWED_MD_TAGS.has(el.tagName)).toBe(true);
    // No event handler or style attributes, ever.
    for (const attr of el.getAttributeNames()) {
      expect(attr.startsWith('on')).toBe(false);
      expect(attr).not.toBe('style');
      expect(attr).not.toBe('srcdoc');
    }
  }
  expect(root.querySelector('script, iframe, img, svg, object, embed, video, audio, form, input, template')).toBeNull();
  // No element href may carry an unsafe scheme (text content may legitimately
  // mention "javascript:" — only attributes are live).
  for (const a of root.querySelectorAll('a')) {
    expect(a.getAttribute('href')).toMatch(/^(https?:|mailto:)/);
  }
  // Serialized markup must not contain a live <script — text nodes escape it.
  expect(root.innerHTML).not.toMatch(/<script/i);
}

describe('renderMarkdown — mounted tree is inert', () => {
  const hostile = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '# <iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '**bold <b onmouseover=alert(1)>b</b>**',
    '[click](javascript:alert(1))',
    '[click](JAVAscript:alert(1))',
    '[click](java\tscript:alert(1))',
    '[click](data:text/html,<script>alert(1)</script>)',
    '`<script>alert(1)</script>`',
    '```\n<script>alert(1)</script>\n```',
    '> <script>alert(1)</script>',
    '- <img src=x onerror=alert(1)>',
  ];

  for (const md of hostile) {
    it(`inert for: ${md.slice(0, 48).replace(/\n/g, '\\n')}`, () => {
      const div = document.createElement('div');
      renderMarkdown(div, md);
      assertInert(div);
    });
  }

  it('raw HTML becomes literal, visible text — never nodes', () => {
    const div = document.createElement('div');
    renderMarkdown(div, 'before <script>alert(1)</script> after');
    expect(div.textContent).toContain('<script>alert(1)</script>');
    expect(div.querySelector('script')).toBeNull();
  });

  it('links carry rel/target hardening and only safe schemes', () => {
    const div = document.createElement('div');
    renderMarkdown(div, '[ok](https://example.com) and [mail](mailto:a@b.c) and [bad](javascript:alert(1))');
    const links = [...div.querySelectorAll('a')];
    expect(links.length).toBe(2); // the javascript: link is dropped, text kept
    for (const a of links) {
      expect(a.getAttribute('href')).toMatch(/^(https:|mailto:)/);
      expect(a.getAttribute('rel')).toContain('noopener');
      expect(a.getAttribute('rel')).toContain('noreferrer');
      expect(a.getAttribute('target')).toBe('_blank');
    }
    expect(div.textContent).toContain('bad');
  });

  it('over-budget input mounts as one verbatim code block (#13)', () => {
    const div = document.createElement('div');
    const big = '<b>'.repeat(MAX_MD_BYTES / 3 + 1);
    renderMarkdown(div, big);
    const pre = div.querySelectorAll('pre');
    expect(pre.length).toBe(1);
    expect(pre[0].textContent).toBe(big);
    assertInert(div);
  });
});

describe('highlightInto — mounted tree is inert', () => {
  it('only ever produces class-carrying spans and text nodes', () => {
    const code = document.createElement('code');
    const src = 'const x = "<img src=x onerror=alert(1)>"; // <script>alert(1)</script>';
    highlightInto(code, src);
    expect(code.textContent).toBe(src); // lossless in the DOM, not just in tokens
    for (const el of code.querySelectorAll('*')) {
      expect(el.tagName).toBe('SPAN');
      expect(el.getAttributeNames()).toEqual(['class']);
    }
    expect(code.innerHTML).not.toMatch(/<script|<img/i);
  });

  it('over-budget input falls back to a single plain text node (#13)', () => {
    const code = document.createElement('code');
    const big = ';'.repeat(MAX_HIGHLIGHT_BYTES + 1);
    highlightInto(code, big);
    expect(code.childNodes.length).toBe(1);
    expect(code.childNodes[0].nodeType).toBe(3); // Text
    expect(code.textContent).toBe(big);
  });

  it('punctuation-dense input under the byte cap still falls back (span budget)', () => {
    const code = document.createElement('code');
    const dense = ';{}()'.repeat(20_000); // 100k non-text tokens > span budget
    highlightInto(code, dense);
    expect(code.querySelectorAll('span').length).toBe(0);
    expect(code.textContent).toBe(dense);
  });
});
