import { describe, expect, it } from 'vitest';
import { filterTaskPairReferences, matchTaskPairReferenceTrigger, openTaskPairReferences, replaceTaskPairReferenceTrigger } from '../src/util/task-pair-reference.js';

describe('pair task composer references', () => {
  it('matches only a trailing percent trigger at a word boundary', () => {
    expect(matchTaskPairReferenceTrigger('%')).toBe('');
    expect(matchTaskPairReferenceTrigger('before %Fix')).toBe('Fix');
    expect(matchTaskPairReferenceTrigger('before%Fix')).toBeNull();
    expect(matchTaskPairReferenceTrigger('%Fix other')).toBeNull();
  });

  it('keeps authoritative open rows, excludes terminals, and deduplicates task ids', () => {
    const rows = openTaskPairReferences({
      authoritative: true,
      tasks: [
        { taskId: 'a', title: 'Build 中文', pair: { status: 'working' } },
        { taskId: 'a', title: 'duplicate', pair: { status: 'working' } },
        { taskId: 'b', title: 'Done', pair: { status: 'done' } },
        { taskId: 'c', title: 'Queued punctuation!', pair: { status: 'queued' } },
      ],
    });
    expect(rows.map((row) => row.title)).toEqual(['Build 中文', 'Queued punctuation!']);
    expect(filterTaskPairReferences(rows, '中文').map((row) => row.taskId)).toEqual(['a']);
    expect(openTaskPairReferences({ authoritative: false, tasks: [{ taskId: 'x', title: 'stale', pair: { status: 'working' } }] })).toEqual([]);
  });

  it('replaces only the trailing trigger and preserves preceding text', () => {
    expect(replaceTaskPairReferenceTrigger('before %中文', 'Fix punctuation!')).toBe('before %Fix punctuation! ');
    expect(replaceTaskPairReferenceTrigger('%old', 'New task')).toBe('%New task ');
  });
});

