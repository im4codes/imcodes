import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import { MaterializationCoordinator } from '../../src/context/materialization-coordinator.js';
import { localOnlyCompressor } from '../../src/context/summary-compressor.js';
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

  it('queues threshold jobs when event counts exceed the configured threshold', async () => {
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 2, idleMs: 1000, scheduleMs: 10_000 },
      modelConfig: {
        primaryContextBackend: 'codex-sdk',
        primaryContextModel: 'gpt-5.2',
        backupContextBackend: 'qwen',
        backupContextModel: 'qwen',
      },
    });

    const first = coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'hello', createdAt: 100 });
    const second = coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'world', createdAt: 200 });

    expect(first.queuedJob).toBeUndefined();
    expect(second.trigger).toBe('threshold');
    expect(second.queuedJob).toEqual(expect.objectContaining({
      target,
      trigger: 'threshold',
      jobType: 'materialize_session',
    }));
  });

  it('filters out non-eligible events from materialization triggers but still records them', async () => {
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 2, idleMs: 1000, scheduleMs: 10_000 },
    });

    // assistant.delta and tool.call are recorded but filtered — don't count toward threshold
    const delta = coordinator.ingestEvent({ target, eventType: 'assistant.delta', content: 'partial', createdAt: 100 });
    expect(delta.event).toBeDefined();
    expect(delta.filtered).toBe(true);
    expect(delta.queuedJob).toBeUndefined();

    const toolCall = coordinator.ingestEvent({ target, eventType: 'tool.call', content: 'readFile', createdAt: 101 });
    expect(toolCall.filtered).toBe(true);
    expect(toolCall.queuedJob).toBeUndefined();

    const toolResult = coordinator.ingestEvent({ target, eventType: 'tool.result', content: 'file content', createdAt: 102 });
    expect(toolResult.filtered).toBe(true);

    const stateChange = coordinator.ingestEvent({ target, eventType: 'session.state', content: 'running', createdAt: 103 });
    expect(stateChange.filtered).toBe(true);

    // assistant.text IS eligible — not filtered
    const eligible1 = coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'final response', createdAt: 200 });
    expect(eligible1.filtered).toBeUndefined();
    // Note: dirty target event_count includes ALL recorded events (including filtered ones),
    // so threshold may have already been reached from the 4 filtered events above + this one
  });

  it('schedules idle and periodic jobs for dirty targets', async () => {
    const idleCoordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });

    idleCoordinator.ingestEvent({ target, eventType: 'user.turn', createdAt: 100 });
    expect(idleCoordinator.scheduleDueTargets(120)).toHaveLength(0);
    expect(idleCoordinator.scheduleDueTargets(180)).toEqual([
      expect.objectContaining({ trigger: 'idle' }),
    ]);

    const scheduleCoordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
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

  it('materializes structured problem-resolution summaries from eligible events', async () => {
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
      modelConfig: {
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'sonnet',
        backupContextBackend: 'codex-sdk',
        backupContextModel: 'gpt-5.2',
      },
    });

    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'fix the download button', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'removed stale constants file and added retry logic', createdAt: 101 });
    coordinator.ingestEvent({ target, eventType: 'decision', content: 'extend handle TTL to 4 hours', createdAt: 102 });

    const result = await coordinator.materializeTarget(target, 'manual', 500);

    // Structured summary with problem → resolution → key decisions
    expect(result.summaryProjection.summary).toContain('**User:** fix the download button');
    expect(result.summaryProjection.summary).toContain('**Assistant:** removed stale constants file and added retry logic');
    expect(result.summaryProjection.summary).toContain('extend handle TTL to 4 hours');
    expect(result.summaryProjection.content).toEqual(expect.objectContaining({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      trigger: 'manual',
    }));
    expect(result.durableProjection?.class).toBe('durable_memory_candidate');
    expect(result.durableProjection?.summary).toContain('extend handle TTL to 4 hours');
    expect(getReplicationState(namespace)).toEqual(expect.objectContaining({
      namespace,
      pendingProjectionIds: expect.arrayContaining([
        result.summaryProjection.id,
        result.durableProjection?.id,
      ]),
    }));
  });

  it('excludes tool.call and assistant.delta from materialized summaries even when present in staged events', async () => {
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });

    // Ingest a mix of eligible and ineligible events
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'investigate the bug', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.delta', content: 'Let me check', createdAt: 101 });
    coordinator.ingestEvent({ target, eventType: 'tool.call', content: 'readFile src/main.ts', createdAt: 102 });
    coordinator.ingestEvent({ target, eventType: 'tool.result', content: 'import { foo } from...', createdAt: 103 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'found the root cause in the import', createdAt: 104 });

    const result = await coordinator.materializeTarget(target, 'manual', 500);

    // Summary uses only eligible events
    expect(result.summaryProjection.summary).toContain('**User:** investigate the bug');
    expect(result.summaryProjection.summary).toContain('**Assistant:** found the root cause in the import');
    // Tool/delta content should NOT appear in summary
    expect(result.summaryProjection.summary).not.toContain('Let me check');
    expect(result.summaryProjection.summary).not.toContain('readFile');
    expect(result.summaryProjection.summary).not.toContain('import { foo }');
  });

  it('reads primary/backup context models from the synced runtime config when explicit overrides are absent', async () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.2',
      backupContextBackend: 'qwen',
      backupContextModel: 'qwen',
    });
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor });
    expect(coordinator.modelConfig).toEqual({
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.2',
      backupContextBackend: 'qwen',
      backupContextModel: 'qwen3-coder-plus',
      enablePersonalMemorySync: false,
    });
  });

  it('defers repeat materialization for the same target until the cooldown window expires', async () => {
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 1, idleMs: 50, scheduleMs: 200, minIntervalMs: 10_000 },
    });

    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'first', createdAt: 100 });
    await coordinator.materializeTarget(target, 'manual', 100);

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

  it('pairs final assistant.text output with the user request in structured summaries', async () => {
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });

    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'fix the flaky build', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'updated the import and reran the build', createdAt: 120 });

    const result = await coordinator.materializeTarget(target, 'manual', 500);

    expect(result.summaryProjection.summary).toContain('**User:** fix the flaky build');
    expect(result.summaryProjection.summary).toContain('**Assistant:** updated the import and reran the build');
  });
});
