// highlight.js — tiny, language-agnostic syntax highlighter for decrypted pastes.
//
// binthere treats all notes as plain text (no format picker), but "obvious"
// source code should still read like code. This module:
//   • heuristically decides whether a blob looks like code (looksLikeCode),
//   • tokenizes it with a single regex into comments/strings/numbers/keywords/
//     functions/punctuation, and
//   • mounts the tokens with document.createElement + textContent ONLY.
//
// Security (SECURITY.md §4): an XSS here is a key leak, so there is NO innerHTML
// and NO HTML parsing. Every token's text goes through textContent, so the worst
// a crafted paste can do is get mis-colored — never execute. `tokenize()` is a
// pure function (no DOM) so it stays unit-testable.

// A compact, multi-language keyword set (JS/TS, Python, Go, Rust, C/Java, shell).
// Kept deliberately broad — mis-highlighting a word is harmless, and this runs on
// already-decrypted, user-only content.
const KEYWORDS = new Set([
  'abstract','and','as','async','await','begin','bool','boolean','break','byte','case','catch',
  'char','class','const','continue','debugger','def','default','defer','del','delete','do',
  'double','elif','else','end','enum','except','export','extends','false','final','finally',
  'float','fn','for','from','func','function','global','go','goto','if','impl','implements',
  'import','in','instanceof','int','interface','is','lambda','let','long','match','mod','module',
  'mut','namespace','new','nil','none','not','null','or','package','pass','print','private',
  'protected','pub','public','raise','return','self','short','signed','sizeof','static','struct',
  'super','switch','template','this','throw','throws','trait','true','try','type','typedef',
  'typeof','undefined','union','unsigned','use','using','var','void','volatile','when','where',
  'while','with','yield',
]);

// Single tokenizer regex, ordered so the most specific patterns win. Named-ish
// groups by position: 1 line-comment, 2 block-comment, 3 string, 4 number,
// 5 identifier, 6 whitespace, 7 other punctuation.
const TOKEN_RE = new RegExp(
  [
    '(#[^\\n]*|//[^\\n]*)',                    // 1: line comment (# or //)
    '(/\\*[\\s\\S]*?\\*/)',                    // 2: block comment
    '("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)', // 3: string
    '(\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b|\\b0x[0-9a-fA-F]+\\b)',        // 4: number
    '([A-Za-z_$][\\w$]*)',                     // 5: identifier
    '(\\s+)',                                  // 6: whitespace
    '([^\\w\\s])',                             // 7: punctuation / other
  ].join('|'),
  'g',
);

/**
 * Heuristic: does this text look like source code (vs prose)? Conservative —
 * only returns true when several code-shaped signals are present, so ordinary
 * notes stay unstyled. Pure function.
 */
export function looksLikeCode(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 12) return false;

  const lines = t.split('\n');
  let score = 0;

  // Structural punctuation typical of code.
  if (/[{}]/.test(t)) score++;
  if (/[;]\s*(\n|$)/.test(t)) score++;
  if (/=>|::|->|!=|==|>=|<=|\+\+|--|&&|\|\|/.test(t)) score++;
  // Leading indentation on multiple lines.
  if (lines.filter((l) => /^\s{2,}\S/.test(l) || /^\t+\S/.test(l)).length >= 2) score++;
  // Recognizable code openers.
  if (/\b(function|def|class|import|const|let|var|public|private|package|func|fn|#include|return)\b/.test(t)) score++;
  // Assignment / call shapes.
  if (/[A-Za-z_$][\w$]*\s*\(/.test(t)) score++;
  if (/[A-Za-z_$][\w$]*\s*=[^=]/.test(t)) score++;

  return score >= 3;
}

/**
 * Tokenize `text` into a flat list of { type, value } spans that concatenate
 * back to the exact input (lossless). Pure; no DOM. `type` ∈ {com, str, num,
 * kw, fn, punc, text}.
 */
export function tokenize(text) {
  const src = typeof text === 'string' ? text : String(text ?? '');
  const out = [];
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(src))) {
    if (m.index > last) out.push({ type: 'text', value: src.slice(last, m.index) });
    if (m[1] || m[2]) out.push({ type: 'com', value: m[0] });
    else if (m[3]) out.push({ type: 'str', value: m[0] });
    else if (m[4]) out.push({ type: 'num', value: m[0] });
    else if (m[5]) {
      // Identifier: keyword, or a function name if directly followed by "(".
      // Look ahead in place — slicing the remaining source per identifier made
      // large code pastes O(n²) and could freeze the tab on reveal.
      if (KEYWORDS.has(m[5])) out.push({ type: 'kw', value: m[5] });
      else if (isCallAhead(src, TOKEN_RE.lastIndex)) out.push({ type: 'fn', value: m[5] });
      else out.push({ type: 'text', value: m[5] });
    } else if (m[6]) out.push({ type: 'text', value: m[0] });
    else out.push({ type: 'punc', value: m[0] });
    last = TOKEN_RE.lastIndex;
  }
  if (last < src.length) out.push({ type: 'text', value: src.slice(last) });
  return out;
}

/** Is the next non-whitespace character at/after index `i` an opening paren? */
function isCallAhead(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  return src[i] === '(';
}

const CLASS = { com: 'tok-com', str: 'tok-str', num: 'tok-num', kw: 'tok-kw', fn: 'tok-fn', punc: 'tok-punc' };

// Render budget: highlighting turns every non-text token into a <span>, so a
// punctuation-heavy paste up to the 1 MiB plaintext cap could mint hundreds of
// thousands of DOM nodes and freeze the tab on reveal. Above either budget the
// content is still shown — as one plain text node, which browsers handle fine.
export const MAX_HIGHLIGHT_BYTES = 300_000;
export const MAX_HIGHLIGHT_SPANS = 30_000;

/**
 * Tokenize for highlighting, or return null when the input exceeds the render
 * budget (too large, or would create too many element nodes). Pure; no DOM.
 */
export function highlightTokens(text) {
  const src = typeof text === 'string' ? text : String(text ?? '');
  if (src.length > MAX_HIGHLIGHT_BYTES) return null;
  const toks = tokenize(src);
  let spans = 0;
  for (const t of toks) if (t.type !== 'text') spans++;
  return spans > MAX_HIGHLIGHT_SPANS ? null : toks;
}

/**
 * Highlight `text` into `codeEl` (a <code>/<pre>), cleared first. Uses only
 * createElement + textContent — never innerHTML. Falls back to a single plain
 * text node when the input exceeds the render budget. Browser only.
 */
export function highlightInto(codeEl, text) {
  const toks = highlightTokens(text);
  if (toks === null) { codeEl.textContent = text; return; }
  codeEl.textContent = '';
  for (const tok of toks) {
    if (tok.type === 'text') {
      codeEl.appendChild(document.createTextNode(tok.value));
    } else {
      const span = document.createElement('span');
      span.className = CLASS[tok.type];
      span.textContent = tok.value;
      codeEl.appendChild(span);
    }
  }
}
