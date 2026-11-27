import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GLOBAL_TASK_FLEET_SNAPSHOT_MSG,
  GLOBAL_TASK_TERMINAL_WINDOW_MS,
} from '../../../shared/global-task-mode.js';
import { TASK_PAIR_NO_AUDITOR, type TaskPairState } from '../../../shared/task-pair.js';
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

  it('includes all active pairs (even >2d old) and recent <=2d terminal pairs up to 50 with checklist counts and labels', () => {
    expect(GLOBAL_TASK_TERMINAL_WINDOW_MS).toBe(2 * 24 * 60 * 60 * 1000);
    const now = 1_000_000_000;
    store.savePair('proj', makePairState({
      taskId: 'tsk_active',
      status: 'in_audit',
      startedAt: now - 45_000,
      updatedAt: now - 5_000,
    }));
    store.savePair('proj', makePairState({
      taskId: 'tsk_queued',
      status: 'queued',
      updatedAt: now - 10_000,
    }));
    store.savePair('proj', makePairState({
      taskId: 'tsk_old_active',
      status: 'paused',
      updatedAt: now - GLOBAL_TASK_TERMINAL_WINDOW_MS * 3,
    }));
    store.savePair('proj', makePairState({
      taskId: 'tsk_recent_done',
      status: 'done',
      startedAt: now - 180_000,
      updatedAt: now - 60_000,
      workspace: {
        kind: 'worktree',
        path: '/tmp/wt',
        createdAt: now - 180_000,
        status: 'ended',
        endedAt: now - 62_000,
      },
    }));
    store.savePair('proj', makePairState({
      taskId: 'tsk_boundary_done',
      status: 'cancelled',
      updatedAt: now - GLOBAL_TASK_TERMINAL_WINDOW_MS,
    }));
    store.savePair('proj', makePairState({
      taskId: 'tsk_old_done',
      status: 'done',
      updatedAt: now - GLOBAL_TASK_TERMINAL_WINDOW_MS - 1,
    }));

    const frame = buildGlobalTaskFleetSnapshotPayload(now);
    expect(frame.type).toBe(GLOBAL_TASK_FLEET_SNAPSHOT_MSG);
    expect(frame.pairs.map((p) => p.taskId)).toEqual([
      'tsk_active',
      'tsk_queued',
      'tsk_old_active',
      'tsk_recent_done',
      'tsk_boundary_done',
    ]);

    const active = frame.pairs[0]!;
    expect(active.checklist).toEqual({ total: 3, implemented: 2, audited: 1 });
    expect(active.executorLabel).toBe('Exec One');
    expect(active.auditorLabel).toBe('Aud One');
    expect(active.projectName).toBe('proj');
    expect(active.startedAt).toBe(now - 45_000);
    expect(active.endedAt).toBeUndefined();

    const queued = frame.pairs[1]!;
    expect(queued.startedAt).toBeUndefined();
    expect(queued.endedAt).toBeUndefined();

    const done = frame.pairs[3]!;
    expect(done.startedAt).toBe(now - 180_000);
    expect(done.endedAt).toBe(now - 62_000);

    const cancelledNoWorkspace = frame.pairs[4]!;
    expect(cancelledNoWorkspace.endedAt).toBe(now - GLOBAL_TASK_TERMINAL_WINDOW_MS);
  });

  it('filters internal session IDs from labels and falls back to W<n> for unlabeled named workers', () => {
    upsertSession({
      name: 'deck_proj_w1',
      projectName: 'proj',
      role: 'w1',
      agentType: 'claude-code',
      projectDir: '/tmp/proj',
      state: 'idle',
      label: 'deck_proj_w1',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    } as SessionRecord);
    upsertSession({
      name: 'deck_sub_pair_auto_6ac6fe82aa0aecfc',
      projectName: 'proj',
      role: 'sub',
      agentType: 'codex-sdk',
      projectDir: '/tmp/proj',
      state: 'idle',
      label: 'deck_sub_pair_auto_6ac6fe82aa0aecfc',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    } as SessionRecord);

    try {
      store.savePair('proj', makePairState({
        taskId: 'tsk_labels',
        executor: 'deck_proj_w1',
        auditor: 'deck_sub_pair_auto_6ac6fe82aa0aecfc',
        updatedAt: 5_000,
      }));
      const frame = buildGlobalTaskFleetSnapshotPayload(10_000);
      const row = frame.pairs.find((p) => p.taskId === 'tsk_labels');
      expect(row?.executorLabel).toBe('W1');
      expect(row?.auditorLabel).toBeUndefined();
    } finally {
      removeSession('deck_proj_w1');
      removeSession('deck_sub_pair_auto_6ac6fe82aa0aecfc');
    }
  });

  it('propagates executorModel and auditorModel from session records and pair fallback while omitting auditorModel for __none__', () => {
    upsertSession({
      name: 'deck_sub_m_exec',
      projectName: 'proj',
      role: 'sub',
      agentType: 'claude-code',
      projectDir: '/tmp/proj',
      state: 'running',
      label: 'Exec M',
      modelDisplay: 'claude-opus-4-6-high',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    } as SessionRecord);
    upsertSession({
      name: 'deck_sub_m_aud',
      projectName: 'proj',
      role: 'sub',
      agentType: 'codex-sdk',
      projectDir: '/tmp/proj',
      state: 'idle',
      label: 'Aud M',
      requestedModel: 'gpt-6.2-sol',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    } as SessionRecord);

    try {
      store.savePair('proj', makePairState({
        taskId: 'tsk_models_live',
        executor: 'deck_sub_m_exec',
        auditor: 'deck_sub_m_aud',
        updatedAt: 6_000,
      }));
      store.savePair('proj', makePairState({
        taskId: 'tsk_models_none_auditor',
        executor: 'deck_sub_missing_exec',
        executorModel: 'sonnet',
        auditor: TASK_PAIR_NO_AUDITOR,
        auditorModel: TASK_PAIR_NO_AUDITOR,
        updatedAt: 6_000,
      }));

      const frame = buildGlobalTaskFleetSnapshotPayload(10_000);
      const live = frame.pairs.find((p) => p.taskId === 'tsk_models_live');
      expect(live?.executorModel).toBe('claude-opus-4-6-high');
      expect(live?.auditorModel).toBe('gpt-6.2-sol');

      const noAud = frame.pairs.find((p) => p.taskId === 'tsk_models_none_auditor');
      expect(noAud?.executorModel).toBe('sonnet');
      expect(noAud?.auditorModel).toBeUndefined();
    } finally {
      removeSession('deck_sub_m_exec');
      removeSession('deck_sub_m_aud');
    }
  });

  it('emits compact lastAudit summary for fleet snapshot cards and keeps blockedNote priority', () => {
    store.savePair('proj', makePairState({
      taskId: 'tsk_rework_card',
      status: 'rework',
      round: 4,
      blocking: ['P0'],
      lastVerdict: {
        verb: 'REWORK',
        counts: { P0: 2, P1: 1, P2: 0, P3: 0, P4: 0 },
        judgement: 'consistent',
        round: 4,
        fullNoticeText: [
          'Summary: Two blocking regressions found.',
          '- [P0] Missing validation guard on empty payload',
          '- [P0] Broken retry backoff',
          '- [P1] Minor label alignment',
        ].join('\n'),
        noticeText: 'Summary: Two blocking regressions found.',
      },
      updatedAt: 9_000,
    }));

    store.savePair('proj', makePairState({
      taskId: 'tsk_blocked_with_audit',
      status: 'awaiting_brain_decision',
      flags: ['blocked'],
      round: 2,
      blockedNote: 'SSH target unreachable on port 2222',
      lastVerdict: {
        verb: 'REWORK',
        counts: { P0: 1, P1: 0, P2: 0, P3: 0, P4: 0 },
        judgement: 'consistent',
        round: 2,
        noticeText: '- [P0] Previous round defect',
      },
      updatedAt: 9_500,
    }));

    const frame = buildGlobalTaskFleetSnapshotPayload(10_000);
    const reworkPair = frame.pairs.find((p) => p.taskId === 'tsk_rework_card');
    expect(reworkPair?.lastAudit).toEqual({
      verb: 'REWORK',
      round: 4,
      counts: { p0: 2, p1: 1, p2: 0, p3: 0, p4: 0 },
      blocking: ['P0'],
      blockingCount: 2,
      findingsCount: 3,
      summary: 'Two blocking regressions found.',
    });
    expect(reworkPair?.liveSummary).toBe('Two blocking regressions found.');

    const blockedPair = frame.pairs.find((p) => p.taskId === 'tsk_blocked_with_audit');
    expect(blockedPair?.liveSummary).toBe('SSH target unreachable on port 2222');
    expect(blockedPair?.lastAudit?.blockingCount).toBe(1);
  });
});
