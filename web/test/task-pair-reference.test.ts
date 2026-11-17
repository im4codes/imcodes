import { describe, expect, it } from 'vitest';
import { filterTaskPairReferences, matchTaskPairReferenceTrigger, openTaskPairReferences, replaceTaskPairReferenceTrigger, taskPairReferenceStatusKey } from '../src/util/task-pair-reference.js';

describe('pair task composer references', () => {
  it('matches only a trailing percent trigger at a word boundary', () => {
    expect(matchTaskPairReferenceTrigger('%')).toBe('');
    expect(matchTaskPairReferenceTrigger('before %Fix')).toBe('Fix');
    expect(matchTaskPairReferenceTrigger('before%Fix')).toBeNull();
    expect(matchTaskPairReferenceTrigger('%Fix other')).toBeNull();
  });

  it('keeps authoritative rows, including terminals, and deduplicates task ids', () => {
    const rows = openTaskPairReferences({
      authoritative: true,
      tasks: [
        { taskId: 'a', title: 'Build 中文', pair: { status: 'working' } },
        { taskId: 'a', title: 'duplicate', pair: { status: 'working' } },
        { taskId: 'b', title: 'Done', pair: { status: 'done' } },
        { taskId: 'c', title: 'Queued punctuation!', pair: { status: 'queued' } },
        { taskId: 'd', title: 'Paused', pair: { status: 'working', scheduling: { manual: true, dependsOn: [], since: 1, writer: 'brain' } } },
      ],
    });
    expect(rows.map((row) => row.title)).toEqual(['Build 中文', 'Done', 'Queued punctuation!', 'Paused']);
    expect(rows.find((row) => row.taskId === 'd')?.status).toBe('paused');
    expect(filterTaskPairReferences(rows, '中文').map((row) => row.taskId)).toEqual(['a']);
    expect(openTaskPairReferences({ authoritative: false, tasks: [{ taskId: 'x', title: 'stale', pair: { status: 'working' } }] })).toEqual([]);
  });

  it('maps known, suspension, failed, and unknown statuses to locale keys', () => {
    expect(taskPairReferenceStatusKey('paused')).toBe('taskPair.status.paused');
    expect(taskPairReferenceStatusKey('working')).toBe('taskPair.status.working');
    expect(taskPairReferenceStatusKey('done')).toBe('taskPair.status.done');
    expect(taskPairReferenceStatusKey('cancelled')).toBe('taskPair.status.cancelled');
    expect(taskPairReferenceStatusKey('failed')).toBe('taskPair.status.failed');
    expect(taskPairReferenceStatusKey('future_status')).toBe('taskPair.card_unknown_status');
  });

  it('replaces only the trailing trigger and preserves preceding text', () => {
    expect(replaceTaskPairReferenceTrigger('before %中文', 'Fix punctuation!')).toBe('before %Fix punctuation! ');
    expect(replaceTaskPairReferenceTrigger('%old', 'New task')).toBe('%New task ');
  });
});

