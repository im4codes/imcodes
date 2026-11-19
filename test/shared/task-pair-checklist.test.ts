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
});
