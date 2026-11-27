// note-input.test.js — the create page's NOTE field must cap by Unicode
// code points (like the server's sanitizeNote), never by UTF-16 code
// units: a maxlength attribute or a plain String.slice(0, 100) counts
// code units, truncating 101 emoji to 50 and potentially splitting a
// surrogate pair into a lone surrogate. The server-side truncation is
// covered in test/admin.test.js; these guards pin the frontend side by
// reading the real page + script (same pattern as a11y.test.js reading
// the real stylesheet).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const html = readFileSync(join(process.cwd(), 'public/index.html'), 'utf8');
const appJs = readFileSync(join(process.cwd(), 'public/js/app.js'), 'utf8');

describe('create-page note input — code-point cap', () => {
  it('the note input has no maxlength attribute', () => {
    const tag = html.match(/<input[^>]*id="note-input"[^>]*>/);
    expect(tag).not.toBeNull();
    expect(tag[0]).not.toMatch(/maxlength/i);
  });

  it('app.js truncates the note by code points, not UTF-16 units', () => {
    expect(appJs).toContain("[...noteEl.value.trim()].slice(0, 100).join('')");
    expect(appJs).not.toContain('noteEl.value.trim().slice(0, 100)');
  });

  it('semantics: 101 emoji → 100 whole emoji, surrogate pairs never split', () => {
    const cap = (s) => [...s.trim()].slice(0, 100).join('');
    const emoji = '😀'.repeat(101);
    expect(cap(emoji)).toBe('😀'.repeat(100)); // not 50 (the UTF-16 result)
    expect(emoji.slice(0, 100)).toBe('😀'.repeat(50)); // documents the old bug

    const mixed = `${'a'.repeat(99)}😀`; // 100 code points, 101 UTF-16 units
    expect(cap(mixed)).toBe(mixed); // pair kept whole
    expect(mixed.slice(0, 100)).not.toBe(mixed); // old slice splits the pair
  });
});
