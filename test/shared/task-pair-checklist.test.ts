import { describe, expect, it } from 'vitest';
import { hasAuditedPairChecklistItem, parseTaskPairChecklist, taskPairChecklistCounts, updateTaskPairChecklist } from '../../shared/task-pair-checklist.js';

describe('task pair markdown checklist', () => {
  it('parses two boxes and treats a single box as unaudited', () => {
    const items = parseTaskPairChecklist('- [x][ ] one\n- [ ][x] two\n- [x] three');
    expect(items.map(({ implemented, audited }) => ({ implemented, audited }))).toEqual([
      { implemented: true, audited: false }, { implemented: false, audited: true }, { implemented: true, audited: false },
    ]);
    expect(taskPairChecklistCounts('- [x][ ] one\n- [ ][x] two\n- [x] three')).toEqual({ total: 3, implemented: 2, audited: 1 });
  });

  it('does not parse or rewrite fenced code examples', () => {
    const markdown = '```md\n- [ ][ ] example\n```\n- [ ][ ] real';
    expect(parseTaskPairChecklist(markdown)).toHaveLength(1);
    expect(updateTaskPairChecklist(markdown, [1], 'implemented', true)).toContain('- [x][ ] real');
    expect(updateTaskPairChecklist(markdown, [1], 'implemented', true)).toContain('- [ ][ ] example');
  });

  it('validates unchecked non-empty dual-box checklist acceptance items outside code fences', () => {
    expect(hasAuditedPairChecklistItem('## Acceptance\n- [ ][ ] 1. Verify route')).toBe(true);
    expect(hasAuditedPairChecklistItem('## Goal\r\n- [ ][ ] 1. Handle CRLF\r\n')).toBe(true);
    expect(hasAuditedPairChecklistItem('No checklist at all')).toBe(false);
    expect(hasAuditedPairChecklistItem('- [ ] single box only')).toBe(false);
    expect(hasAuditedPairChecklistItem('- [x][x] already done')).toBe(false);
    expect(hasAuditedPairChecklistItem('- [x][ ] already implemented')).toBe(false);
    expect(hasAuditedPairChecklistItem('- [ ][x] already audited')).toBe(false);
    expect(hasAuditedPairChecklistItem('- [ ][ ]   ')).toBe(false);
    expect(hasAuditedPairChecklistItem('- [ ][ ]')).toBe(false);
    expect(hasAuditedPairChecklistItem('```md\n- [ ][ ] fenced backtick\n```')).toBe(false);
    expect(hasAuditedPairChecklistItem('~~~\r\n- [ ][ ] fenced tilde\r\n~~~')).toBe(false);
  });

  it('tracks fence length and info strings per CommonMark so nested, info-bearing, or unclosed fences never leak or corrupt updates', () => {
    const nestedBacktickOnly = '````markdown\n```\n- [ ][ ] only code example\n```\n````';
    expect(parseTaskPairChecklist(nestedBacktickOnly)).toEqual([]);
    expect(taskPairChecklistCounts(nestedBacktickOnly)).toEqual({ total: 0, implemented: 0, audited: 0 });
    expect(hasAuditedPairChecklistItem(nestedBacktickOnly)).toBe(false);

    const innerInfoString = '```md\n```js\n- [ ][ ] inside inner info fence\n```';
    expect(parseTaskPairChecklist(innerInfoString)).toEqual([]);
    expect(hasAuditedPairChecklistItem(innerInfoString)).toBe(false);

    const nestedTildeOnly = '~~~~\r\n~~~\r\n- [ ][ ] inside tilde fence\r\n~~~\r\n~~~~';
    expect(parseTaskPairChecklist(nestedTildeOnly)).toEqual([]);
    expect(hasAuditedPairChecklistItem(nestedTildeOnly)).toBe(false);

    const unclosedFence = '```md\n- [ ][ ] unclosed code block';
    expect(parseTaskPairChecklist(unclosedFence)).toEqual([]);
    expect(hasAuditedPairChecklistItem(unclosedFence)).toBe(false);

    // A matching-length or longer closing fence restores normal parsing, and updateTaskPairChecklist ticks only the real item.
    const nestedThenRealCrlf = '````markdown\r\n```\r\n- [ ][ ] fake item\r\n```\r\n`````\r\n- [ ][ ] real item\r\n';
    expect(hasAuditedPairChecklistItem(nestedThenRealCrlf)).toBe(true);
    expect(parseTaskPairChecklist(nestedThenRealCrlf).map((item) => item.text)).toEqual(['real item']);
    const updated = updateTaskPairChecklist(nestedThenRealCrlf, [1], 'implemented', true);
    expect(updated).toContain('- [ ][ ] fake item\r\n');
    expect(updated).toContain('- [x][ ] real item\r\n');

    // Longer tilde close + backtick inline code line-start control.
    const longerTildeClose = '~~~md\n- [ ][ ] fenced tilde\n~~~~~\n- [ ][ ] after tilde';
    expect(parseTaskPairChecklist(longerTildeClose).map((item) => item.text)).toEqual(['after tilde']);
    const inlineCodeLine = '```foo`bar`\n- [ ][ ] real outside inline code';
    expect(hasAuditedPairChecklistItem(inlineCodeLine)).toBe(true);
  });
});
