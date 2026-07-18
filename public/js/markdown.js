// markdown.js — a deliberately small, safe Markdown subset for rendering
// decrypted pastes. In a zero-knowledge app an XSS is a key leak (SECURITY.md
// §4), so this renderer:
//   • parses to a node tree (pure `parse()` — testable without a DOM),
//   • NEVER interprets raw HTML — any HTML in the source becomes literal text,
//   • sanitizes link hrefs to an http/https/mailto allowlist,
//   • and mounts via document.createElement + textContent only (no innerHTML).
//
// `parse()` and `sanitizeUrl()` are exported for the adversarial test suite.

const SAFE_SCHEME = /^(https?:|mailto:)/;
// ASCII control chars + space (0x00–0x20). Browsers ignore these inside a URL
// scheme, which enables "java\tscript:" style bypasses — so strip them first.
// eslint-disable-next-line no-control-regex -- matching control chars is the point
const CTRL_WS = /[\u0000-\u0020]/g;

/** Return a safe href, or null if the URL is not on the scheme allowlist. */
export function sanitizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(CTRL_WS, '').toLowerCase();
  if (SAFE_SCHEME.test(cleaned)) return raw.trim().replace(CTRL_WS, '');
  return null;
}

// ── inline parsing (code → links → emphasis) ─────────────────────────────────

function parseEmphasis(str) {
  const nodes = [];
  const re = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3/g;
  let m, last = 0;
  while ((m = re.exec(str))) {
    if (m.index > last) nodes.push({ type: 'text', value: str.slice(last, m.index) });
    if (m[1]) nodes.push({ type: 'strong', children: parseEmphasis(m[2]) });
    else nodes.push({ type: 'em', children: parseEmphasis(m[4]) });
    last = re.lastIndex;
  }
  if (last < str.length) nodes.push({ type: 'text', value: str.slice(last) });
  return nodes;
}

function parseLinks(str) {
  const nodes = [];
  const re = /\[([^\]]*)\]\(([^)\s]*)\)/g;
  let m, last = 0;
  while ((m = re.exec(str))) {
    if (m.index > last) nodes.push(...parseEmphasis(str.slice(last, m.index)));
    const href = sanitizeUrl(m[2]);
    const children = parseEmphasis(m[1]);
    // Unsafe/absent URL → drop the link, keep its text. Never emit a bad href.
    if (href) nodes.push({ type: 'link', href, children });
    else nodes.push(...children);
    last = re.lastIndex;
  }
  if (last < str.length) nodes.push(...parseEmphasis(str.slice(last)));
  return nodes;
}

function parseInline(str) {
  const nodes = [];
  const re = /`([^`]+)`/g;
  let m, last = 0;
  while ((m = re.exec(str))) {
    if (m.index > last) nodes.push(...parseLinks(str.slice(last, m.index)));
    nodes.push({ type: 'code', value: m[1] });
    last = re.lastIndex;
  }
  if (last < str.length) nodes.push(...parseLinks(str.slice(last)));
  return nodes;
}

// ── block parsing ────────────────────────────────────────────────────────────

const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const RE_ULI = /^\s*[-*+]\s+(.*)$/;
const RE_OLI = /^\s*\d+\.\s+(.*)$/;

/** Parse Markdown source into a safe block-node tree. Pure; no DOM. */
export function parse(md) {
  const src = typeof md === 'string' ? md : String(md ?? '');
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  const para = [];
  const flushPara = () => {
    if (para.length) blocks.push({ type: 'paragraph', inline: parseInline(para.join('\n')) });
    para.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      flushPara();
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++; // consume closing fence (if present)
      blocks.push({ type: 'code_block', text: body.join('\n') });
      continue;
    }

    if (line.trim() === '') { flushPara(); i++; continue; }

    if (RE_HR.test(line)) { flushPara(); blocks.push({ type: 'hr' }); i++; continue; }

    const h = RE_HEADING.exec(line);
    if (h) {
      flushPara();
      blocks.push({ type: 'heading', level: h[1].length, inline: parseInline(h[2]) });
      i++;
      continue;
    }

    if (line.startsWith('>')) {
      flushPara();
      const quote = [];
      while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ type: 'blockquote', inline: parseInline(quote.join('\n')) });
      continue;
    }

    if (RE_ULI.test(line) || RE_OLI.test(line)) {
      flushPara();
      const ordered = RE_OLI.test(line);
      const items = [];
      while (i < lines.length) {
        const mm = ordered ? RE_OLI.exec(lines[i]) : RE_ULI.exec(lines[i]);
        if (!mm) break;
        items.push(parseInline(mm[1]));
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return blocks;
}

// ── DOM mounting (browser only; uses createElement + textContent) ────────────

function mountInline(parent, nodes) {
  for (const n of nodes) {
    if (n.type === 'text') {
      parent.appendChild(document.createTextNode(n.value));
    } else if (n.type === 'code') {
      const el = document.createElement('code');
      el.textContent = n.value;
      parent.appendChild(el);
    } else if (n.type === 'strong' || n.type === 'em') {
      const el = document.createElement(n.type === 'strong' ? 'strong' : 'em');
      mountInline(el, n.children);
      parent.appendChild(el);
    } else if (n.type === 'link') {
      const el = document.createElement('a');
      el.setAttribute('href', n.href);          // href already scheme-checked
      el.setAttribute('rel', 'noopener noreferrer nofollow ugc');
      el.setAttribute('target', '_blank');
      mountInline(el, n.children);
      parent.appendChild(el);
    }
  }
}

/** Render Markdown into `container` (cleared first). Browser only. */
export function renderMarkdown(container, md) {
  container.textContent = '';
  for (const b of parse(md)) {
    if (b.type === 'heading') {
      const el = document.createElement('h' + b.level);
      mountInline(el, b.inline);
      container.appendChild(el);
    } else if (b.type === 'paragraph') {
      const el = document.createElement('p');
      mountInline(el, b.inline);
      container.appendChild(el);
    } else if (b.type === 'blockquote') {
      const el = document.createElement('blockquote');
      mountInline(el, b.inline);
      container.appendChild(el);
    } else if (b.type === 'code_block') {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = b.text;
      pre.appendChild(code);
      container.appendChild(pre);
    } else if (b.type === 'hr') {
      container.appendChild(document.createElement('hr'));
    } else if (b.type === 'list') {
      const list = document.createElement(b.ordered ? 'ol' : 'ul');
      for (const item of b.items) {
        const li = document.createElement('li');
        mountInline(li, item);
        list.appendChild(li);
      }
      container.appendChild(list);
    }
  }
}
