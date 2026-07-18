// highlight.test.js — unit tests for the syntax highlighter's pure core.
// The DOM mount (highlightInto) only ever uses createElement + textContent, so
// the security-relevant property is that tokenize() is LOSSLESS: concatenating
// the token values must reproduce the input exactly, byte for byte. If that
// holds, highlighting can only mis-color — never drop, duplicate, or alter the
// decrypted content. We also check the classifier and the code/prose heuristic.
import { describe, it, expect } from 'vitest';
import { tokenize, looksLikeCode } from '../public/js/highlight.js';

const roundtrips = (s) => tokenize(s).map((t) => t.value).join('') === s;

describe('tokenize — lossless', () => {
  const samples = [
    '',
    'hello world',
    'const x = 42; // a comment',
    'def f(a, b):\n    return a + b  # add',
    's = "he said \\"hi\\"" + \'x\'',
    '/* block\n comment */ value = 0x1F',
    'a.b.c(1, 2)[3] && d || !e',
    'emoji 🔥 and unicode ✓ stay intact',
    '\n\n\t  mixed\twhitespace \n',
    '`template ${notInterpolated}` end',
    '#include <stdio.h>\nint main(){return 0;}',
  ];
  for (const s of samples) {
    it(`round-trips ${JSON.stringify(s.slice(0, 24))}`, () => {
      expect(roundtrips(s)).toBe(true);
    });
  }

  it('round-trips a large random-ish blob', () => {
    let blob = '';
    for (let i = 0; i < 500; i++) blob += `line${i} = fn(${i}) /* ${i} */ "str${i}";\n`;
    expect(roundtrips(blob)).toBe(true);
  });
});

describe('tokenize — classification', () => {
  const kinds = (s) => tokenize(s).filter((t) => t.type !== 'text').map((t) => `${t.type}:${t.value}`);

  it('tags keywords, not identifiers', () => {
    const out = kinds('const foo = 1');
    expect(out).toContain('kw:const');
    expect(out.some((k) => k === 'kw:foo')).toBe(false);
  });

  it('tags a call target as a function', () => {
    expect(kinds('doThing(x)')).toContain('fn:doThing');
  });

  it('tags strings, numbers and comments', () => {
    expect(kinds('"hi"')).toContain('str:"hi"');
    expect(kinds('x = 3.14')).toContain('num:3.14');
    expect(kinds('// note')).toContain('com:// note');
  });

  it('does not treat text inside a string as code', () => {
    // The whole quoted span is one string token; the inner "if" is not a keyword.
    expect(kinds('"if while for"')).toEqual(['str:"if while for"']);
  });
});

describe('looksLikeCode — heuristic', () => {
  it('flags obvious source code', () => {
    expect(looksLikeCode('function add(a, b) {\n  return a + b;\n}')).toBe(true);
    expect(looksLikeCode('def main():\n    for i in range(10):\n        print(i)')).toBe(true);
  });

  it('leaves ordinary prose unstyled', () => {
    expect(looksLikeCode('Hey, just wanted to share the meeting notes with you.')).toBe(false);
    expect(looksLikeCode('short')).toBe(false);
    expect(looksLikeCode('A grocery list: milk, eggs, bread, and some coffee.')).toBe(false);
  });

  it('tolerates non-string input', () => {
    expect(looksLikeCode(null)).toBe(false);
    expect(looksLikeCode(undefined)).toBe(false);
  });
});
