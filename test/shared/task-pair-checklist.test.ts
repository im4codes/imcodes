import { describe, expect, it } from 'vitest';
import { parseTaskPairChecklist, taskPairChecklistCounts, updateTaskPairChecklist } from '../../shared/task-pair-checklist.js';

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
});
