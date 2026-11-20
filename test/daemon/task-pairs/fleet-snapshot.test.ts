import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GLOBAL_TASK_FLEET_SNAPSHOT_MSG,
  GLOBAL_TASK_TERMINAL_WINDOW_MS,
} from '../../../shared/global-task-mode.js';
import type { TaskPairState } from '../../../shared/task-pair.js';
import { buildGlobalTaskFleetSnapshotPayload } from '../../../src/daemon/task-pairs/fleet-snapshot.js';
import { setTaskPairStoreForTests, TaskPairStore } from '../../../src/daemon/task-pairs/store.js';
import { removeSession, upsertSession, type SessionRecord } from '../../../src/store/session-store.js';

function makePairState(overrides: Partial<TaskPairState> & { taskId: string }): TaskPairState {
  return {
    brain: 'deck_proj_brain',
    executor: 'deck_sub_exec',
    auditor: 'deck_sub_aud',
    title: 'Sample task',
    status: 'working',
    flags: [],
    flagSides: {},
    round: 1,
    blocking: ['P0'],
    previousAuditors: [],
    capCounts: {},
    capRound: 0,
    brief: '- [x][x] Item 1\n- [x][ ] Item 2\n- [ ][ ] Item 3',
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe('buildGlobalTaskFleetSnapshotPayload', () => {
  let store: TaskPairStore;

  beforeEach(() => {
    store = new TaskPairStore(':memory:');
    setTaskPairStoreForTests(store);
    upsertSession({
      name: 'deck_sub_exec',
      projectName: 'proj',
      role: 'w1',
      agentType: 'claude-code',
      projectDir: '/tmp/proj',
      state: 'idle',
      label: 'Exec One',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    } as SessionRecord);
    upsertSession({
      name: 'deck_sub_aud',
      projectName: 'proj',
      role: 'w2',
      agentType: 'codex',
      projectDir: '/tmp/proj',
      state: 'idle',
      label: 'Aud One',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    } as SessionRecord);
  });

  afterEach(() => {
    removeSession('deck_sub_exec');
    removeSession('deck_sub_aud');
    store.close();
  });

  it('includes all active pairs and up to 50 recent 24h terminal pairs with checklist counts and labels', () => {
    const now = 1_000_000_000;
    store.savePair('proj', makePairState({
      taskId: 'tsk_active',
      status: 'in_audit',
      updatedAt: now - 5_000,
    }));
    store.savePair('proj', makePairState({
      taskId: 'tsk_recent_done',
      status: 'done',
      updatedAt: now - 60_000,
    }));
    store.savePair('proj', makePairState({
      taskId: 'tsk_old_done',
      status: 'done',
      updatedAt: now - GLOBAL_TASK_TERMINAL_WINDOW_MS - 1_000,
    }));

    const frame = buildGlobalTaskFleetSnapshotPayload(now);
    expect(frame.type).toBe(GLOBAL_TASK_FLEET_SNAPSHOT_MSG);
    expect(frame.pairs.map((p) => p.taskId)).toEqual(['tsk_active', 'tsk_recent_done']);

    const active = frame.pairs[0]!;
    expect(active.checklist).toEqual({ total: 3, implemented: 2, audited: 1 });
    expect(active.executorLabel).toBe('Exec One');
    expect(active.auditorLabel).toBe('Aud One');
    expect(active.projectName).toBe('proj');
  });
});
