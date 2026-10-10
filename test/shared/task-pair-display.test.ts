import { describe, expect, it } from 'vitest';
import { taskPairDisplaySessionLabel, taskPairDisplayTitle, taskPairSessionLabel, taskPairResolveDisplaySessionLabel } from '../../shared/task-pair-display.js';

const auto = 'deck_sub_pair_auto_0123456789abcdef';
describe('task-pair display identity', () => {
  it.each(['tsk_service_preexecution_fee_20261010', 'a'.repeat(180), 'task-1', '7c52-450a'])('never uses an identifier as its title: %s', (id) => {
    expect(taskPairDisplayTitle(` ${id} `, id)).toBeUndefined();
    expect(taskPairDisplayTitle(undefined, id)).toBeUndefined();
    expect(taskPairDisplayTitle(' ', id)).toBeUndefined();
    expect(taskPairDisplayTitle('修复排序任务', id)).toBe('修复排序任务');
  });
  it.each(['executor', 'auditor'] as const)('projects the complete old %s label, including truncated CJK and absent title', (role) => {
    for (const taskId of ['tsk_service_preexecution_fee_20261010', 'task-1', '7c52-450a']) {
      for (const ending of ['', ': 中文任务', `: ${'中'.repeat(37)}...`]) {
        expect(taskPairDisplaySessionLabel(auto, `Pair ${taskId} ${role}${ending}`)).toBe(taskPairSessionLabel(role));
      }
    }
  });
  it('preserves custom Pair-style labels and non-generated session identities', () => {
    for (const label of ['Pair designer', 'Pair tsk_x executor: custom title longer than the old producer allowed'.repeat(2), 'Pair tsk_x executor: ', 'Pair tsk_x executor\ncustom', ' Pair tsk_x executor: custom', 'Pair tsk_x editor: custom']) {
      expect(taskPairDisplaySessionLabel(auto, label)).toBe(label.trim());
    }
    expect(taskPairDisplaySessionLabel('deck_custom', 'Pair tsk_x executor: Custom')).toBe('Pair tsk_x executor: Custom');
    expect(taskPairDisplaySessionLabel(`${auto}x`, 'Pair tsk_x executor: Custom')).toBe('Pair tsk_x executor: Custom');
    expect(taskPairDisplaySessionLabel(auto, 'Pair auditor')).toBe('Pair auditor');
  });
  it('does not relabel an old session on reuse in the other role', () => {
    expect(taskPairDisplaySessionLabel(auto, 'Pair old-task executor: Old title')).toBe('Pair executor');
  });
});

describe('label authority without default-data rewriting', () => {
  it('uses live labels, respects explicit null/empty clears, then payload and watch fallback', () => {
    expect(taskPairResolveDisplaySessionLabel(auto, 'Snapshot', { label: 'New name' }, 'Watch')).toBe('New name');
    for (const label of [null, '']) {
      expect(taskPairResolveDisplaySessionLabel(auto, 'Snapshot', { label }, 'Watch')).toBeUndefined();
    }
    expect(taskPairResolveDisplaySessionLabel(auto, 'Snapshot', {}, 'Watch')).toBe('Snapshot');
    expect(taskPairResolveDisplaySessionLabel(auto, 'Snapshot', { label: undefined }, 'Watch')).toBe('Snapshot');
    expect(taskPairResolveDisplaySessionLabel(auto, undefined, {}, 'Watch')).toBe('Watch');
    expect(taskPairResolveDisplaySessionLabel(auto, undefined)).toBeUndefined();
  });
});
