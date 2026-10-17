import { describe, expect, it } from 'vitest';
import { repairStreamingMarkdown } from '../src/streaming-markdown';

describe('repairStreamingMarkdown', () => {
  it('leaves finished text untouched', () => {
    for (const text of ['', 'plain', '**done** and `code`', '# h\n\n- a\n- b', '```ts\nconst a = 1;\n```\n']) {
      expect(repairStreamingMarkdown(text)).toBe(text);
    }
  });

  it('closes a dangling bold, inline code or strikethrough of the last paragraph', () => {
    expect(repairStreamingMarkdown('**深夜的便')).toBe('**深夜的便**');
    expect(repairStreamingMarkdown('run `npm test')).toBe('run `npm test`');
    expect(repairStreamingMarkdown('~~gone')).toBe('~~gone~~');
    expect(repairStreamingMarkdown('a **b `c')).toBe('a **b `c`**');
  });

  it('drops an opener that has no text after it yet', () => {
    expect(repairStreamingMarkdown('hello **')).toBe('hello ');
    expect(repairStreamingMarkdown('hello `')).toBe('hello ');
  });

  it('only the last paragraph can be open; earlier ones are not touched', () => {
    expect(repairStreamingMarkdown('**a\n\nnext')).toBe('**a\n\nnext');
    expect(repairStreamingMarkdown('done\n\n**b')).toBe('done\n\n**b**');
  });

  it('does not treat markers inside code as emphasis and leaves an open fence alone', () => {
    expect(repairStreamingMarkdown('use `a ** b` here')).toBe('use `a ** b` here');
    expect(repairStreamingMarkdown('```ts\nconst a = "**";\nnext')).toBe('```ts\nconst a = "**";\nnext');
    expect(repairStreamingMarkdown('```ts\nx\n```\n\n**tail')).toBe('```ts\nx\n```\n\n**tail**');
  });

  it('respects escapes', () => {
    expect(repairStreamingMarkdown('a \\** b')).toBe('a \\** b');
  });

  it('never changes the text that is already there (only appends a closer or drops a bare trailing opener)', () => {
    const reply = '好的。\n\n---\n\n**深夜的便利店**\n\n- 第一条 **重点\n- 第二条 `code';
    for (let end = 1; end <= reply.length; end += 1) {
      const partial = reply.slice(0, end);
      const repaired = repairStreamingMarkdown(partial);
      const stripped = repaired.replace(/(\*\*|`|~~)+$/, '');
      expect(partial.startsWith(stripped) || repaired.startsWith(partial)).toBe(true);
    }
  });
});
