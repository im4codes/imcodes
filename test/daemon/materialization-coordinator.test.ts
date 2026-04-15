import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import { MaterializationCoordinator } from '../../src/context/materialization-coordinator.js';
import { setContextModelRuntimeConfig } from '../../src/context/context-model-config.js';
import { getReplicationState } from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

describe('MaterializationCoordinator', () => {
  let tempDir: string;
  let namespace: ContextNamespace;
  let target: ContextTargetRef;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('materialization-coordinator');
    setContextModelRuntimeConfig(null);
    namespace = { scope: 'personal', projectId: 'repo', userId: 'user-1' };
    target = { namespace, kind: 'session', sessionName: 'deck_repo_brain' };
  });

  afterEach(async () => {
    setContextModelRuntimeConfig(null);
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('queues threshold jobs when event counts exceed the configured threshold', () => {
    const coordinator = new MaterializationCoordinator({
      thresholds: { eventCount: 2, idleMs: 1000, scheduleMs: 10_000 },
      modelConfig: {
        primaryContextBackend: 'codex-sdk',
        primaryContextModel: 'gpt-5.2',
        backupContextBackend: 'qwen',
        backupContextModel: 'qwen',
      },
    });

    const first = coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'hello', createdAt: 100 });
    const second = coordinator.ingestEvent({ target, eventType: 'assistant.turn', content: 'world', createdAt: 200 });

    expect(first.queuedJob).toBeUndefined();
    expect(second.trigger).toBe('threshold');
    expect(second.queuedJob).toEqual(expect.objectContaining({
      target,
      trigger: 'threshold',
      jobType: 'materialize_session',
    }));
  });

  it('schedules idle and periodic jobs for dirty targets', () => {
    const idleCoordinator = new MaterializationCoordinator({
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });

    idleCoordinator.ingestEvent({ target, eventType: 'user.turn', createdAt: 100 });
    expect(idleCoordinator.scheduleDueTargets(120)).toHaveLength(0);
    expect(idleCoordinator.scheduleDueTargets(180)).toEqual([
      expect.objectContaining({ trigger: 'idle' }),
    ]);

    const scheduleCoordinator = new MaterializationCoordinator({
      thresholds: { eventCount: 99, idleMs: 500, scheduleMs: 200 },
    });
    const projectTarget: ContextTargetRef = { namespace, kind: 'project' };
    scheduleCoordinator.ingestEvent({ target: projectTarget, eventType: 'decision', content: 'keep api stable', createdAt: 100 });
    expect(scheduleCoordinator.scheduleDueTargets(350)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: projectTarget,
        trigger: 'schedule',
        jobType: 'materialize_project',
      }),
    ]));
  });

  it('materializes recent summaries and durable memory candidates and queues replication', () => {
    const coordinator = new MaterializationCoordinator({
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
      modelConfig: {
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'sonnet',
        backupContextBackend: 'codex-sdk',
        backupContextModel: 'gpt-5.2',
      },
    });

    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'open the issue', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'decision', content: 'ship the migration', createdAt: 101 });

    const result = coordinator.materializeTarget(target, 'manual', 500);

    expect(result.summaryProjection.summary).toContain('User intent: open the issue');
    expect(result.summaryProjection.summary).toContain('Key constraints: ship the migration');
    expect(result.summaryProjection.summary).toContain('Compressed from 2 events.');
    expect(result.summaryProjection.content).toEqual(expect.objectContaining({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-5.2',
      trigger: 'manual',
      eventCount: 2,
    }));
    expect(result.durableProjection?.class).toBe('durable_memory_candidate');
    expect(result.durableProjection?.summary).toContain('Pinned decisions: ship the migration');
    expect(result.durableProjection?.summary).toContain('Compressed from 1 durable signal.');
    expect(getReplicationState(namespace)).toEqual(expect.objectContaining({
      namespace,
      pendingProjectionIds: expect.arrayContaining([
        result.summaryProjection.id,
        result.durableProjection?.id,
      ]),
    }));
  });

  it('reads primary/backup context models from the synced runtime config when explicit overrides are absent', () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.2',
      backupContextBackend: 'qwen',
      backupContextModel: 'qwen',
    });
    const coordinator = new MaterializationCoordinator();
    expect(coordinator.modelConfig).toEqual({
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.2',
      backupContextBackend: 'qwen',
      backupContextModel: 'qwen3-coder-plus',
      enablePersonalMemorySync: false,
    });
  });

  it('defers repeat materialization for the same target until the cooldown window expires', () => {
    const coordinator = new MaterializationCoordinator({
      thresholds: { eventCount: 1, idleMs: 50, scheduleMs: 200, minIntervalMs: 10_000 },
    });

    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'first', createdAt: 100 });
    coordinator.materializeTarget(target, 'manual', 100);

    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'second', createdAt: 200 });
    expect(coordinator.scheduleDueTargets(5_000)).toHaveLength(0);
    expect(coordinator.canMaterializeTarget(target, 5_000)).toBe(false);

    expect(coordinator.scheduleDueTargets(10_200)).toEqual([
      expect.objectContaining({
        target,
        trigger: 'threshold',
      }),
    ]);
    expect(coordinator.canMaterializeTarget(target, 10_200)).toBe(true);
  });
});
