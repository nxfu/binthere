import { describe, expect, it } from 'vitest';
import { parse } from '../public/js/markdown.js';

describe('Discord-style subtext blocks', () => {
  it('splits ordinary paragraphs around subtext and parses its inline formatting', () => {
    const blocks = parse('before\n-# small **bold** and _italic_\nafter');
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'subtext', 'paragraph']);
    expect(blocks[1].inline).toEqual([
      { type: 'text', value: 'small ' },
      { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
      { type: 'text', value: ' and ' },
      { type: 'em', children: [{ type: 'text', value: 'italic' }] },
    ]);
  });

  it.each(['-#nospace', 'inside -# text', ' -# indented', '-#\ttab'])('leaves %j literal', (source) => {
    expect(parse(source)).toEqual([{ type: 'paragraph', inline: [{ type: 'text', value: source }] }]);
  });

  it('handles consecutive subtext lines and CRLF without swallowing the following paragraph', () => {
    const blocks = parse('-# first\r\n-# second\r\n\r\nnormal');
    expect(blocks.map((block) => block.type)).toEqual(['subtext', 'subtext', 'paragraph']);
    expect(blocks[1].inline).toEqual([{ type: 'text', value: 'second' }]);
  });

  it('does not interpret subtext inside inline or fenced code', () => {
    expect(parse('`-# literal`')[0].inline).toEqual([{ type: 'code', value: '-# literal' }]);
    expect(parse('```\n-# literal\n```')).toEqual([{ type: 'code_block', text: '-# literal', language: '' }]);
  });

  it('includes subtext nodes in the existing render budget', () => {
    const source = '-# x\n'.repeat(16_000);
    expect(parse(source)).toEqual([{ type: 'code_block', text: source }]);
  });
});
