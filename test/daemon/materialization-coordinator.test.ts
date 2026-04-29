import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import { MaterializationCoordinator } from '../../src/context/materialization-coordinator.js';
import { localOnlyCompressor } from '../../src/context/summary-compressor.js';
import { setContextModelRuntimeConfig } from '../../src/context/context-model-config.js';
import { getArchivedEvent, getReplicationState, listContextEvents } from '../../src/store/context-store.js';
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
      primaryContextPreset: undefined,
      primaryContextSdk: undefined,
      backupContextBackend: 'qwen',
      backupContextModel: 'qwen3-coder-plus',
      backupContextPreset: undefined,
      backupContextSdk: undefined,
      enablePersonalMemorySync: false,
      materializationMinIntervalMs: undefined,
      memoryRecallMinScore: 0.4,
      memoryScoringWeights: {
        similarity: 0.4,
        recency: 0.25,
        frequency: 0.15,
        project: 0.2,
      },
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

  it('records template-prompt content at ingestion (filtering is a recall-side concern, not ingestion)', async () => {
    // Built-in / templated prompts (OpenSpec workflow invocations, slash
    // commands, harness command tags) are still written to memory — the
    // template filter applies only on the recall path, not at record time.
    // See shared/template-prompt-patterns.ts and Phase L.
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 1, idleMs: 1000, scheduleMs: 10_000 },
    });

    const openspec = coordinator.ingestEvent({
      target,
      eventType: 'assistant.text',
      content: 'Drove the implementation of @openspec/changes/my-feature by orchestrating subagents.',
      createdAt: 100,
    });
    expect(openspec.filtered).toBeUndefined();
    expect(openspec.queuedJob).toEqual(expect.objectContaining({ trigger: 'threshold' }));
  });


  it('drops pure API connection failure summaries instead of persisting them as memory', async () => {
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });

    coordinator.ingestEvent({ id: 'evt-api-noise-user', target, eventType: 'user.turn', content: 'continue the run', createdAt: 100 });
    coordinator.ingestEvent({ id: 'evt-api-noise-assistant', target, eventType: 'assistant.text', content: '[API Error: Connection error. (cause: fetch failed)]', createdAt: 120 });

    const result = await coordinator.materializeTarget(target, 'manual', 500);

    expect(result.filteredOut).toBe(true);
    expect(result.summaryProjection).toBeUndefined();
    expect(getReplicationState(namespace)?.pendingProjectionIds ?? []).toEqual([]);
    expect(getArchivedEvent('evt-api-noise-user')?.content).toBe('continue the run');
    expect(getArchivedEvent('evt-api-noise-assistant')?.content).toContain('[API Error');
    expect(listContextEvents(target)).toEqual([]);
  });

  it('archives staged events before deleting them when SDK retry budget is exhausted', async () => {
    const coordinator = new MaterializationCoordinator({
      compressor: async () => ({
        summary: '',
        model: 'local-fallback',
        backend: 'none',
        usedBackup: false,
        fromSdk: false,
      }),
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });

    coordinator.ingestEvent({ id: 'evt-retry-user', target, eventType: 'user.turn', content: 'please remember this outage batch', createdAt: 100 });
    coordinator.ingestEvent({ id: 'evt-retry-assistant', target, eventType: 'assistant.text', content: 'working on the durable archive path', createdAt: 120 });

    for (let i = 0; i < 3; i++) {
      const result = await coordinator.materializeTarget(target, 'manual', 500 + i);
      expect(result.filteredOut).toBeUndefined();
      expect(listContextEvents(target).map((event) => event.id).sort()).toEqual(['evt-retry-assistant', 'evt-retry-user']);
    }

    const exhausted = await coordinator.materializeTarget(target, 'manual', 600);
    expect(exhausted.filteredOut).toBe(true);
    expect(exhausted.summaryProjection).toBeUndefined();
    expect(getArchivedEvent('evt-retry-user')?.content).toBe('please remember this outage batch');
    expect(getArchivedEvent('evt-retry-assistant')?.content).toBe('working on the durable archive path');
    expect(listContextEvents(target)).toEqual([]);
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


  it('uses composite token-density triggers with count floor and force-fire ceiling', async () => {
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { autoTriggerTokens: 50, minEventCount: 3, maxBatchTokens: 200, idleMs: 10_000, scheduleMs: 20_000, minIntervalMs: 0 },
    });

    const jumbo = coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'x '.repeat(80), createdAt: 100 });
    expect(jumbo.queuedJob).toBeUndefined();

    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'short one', createdAt: 110 });
    const third = coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'short two', createdAt: 120 });
    expect(third.trigger).toBe('threshold');

    await coordinator.materializeTarget(target, 'threshold', 130);
    const force = coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'y '.repeat(300), createdAt: 200 });
    expect(force.trigger).toBe('threshold');
  });

  it('loads token trigger thresholds from .imc/memory.yaml when no explicit override is provided', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(join(tempDir, '.imc'), { recursive: true });
    // Note: idleMs/scheduleMs floor is 1000 in the validator (memory-config P1).
    // Use values above the floor; the assertion still proves yaml overrides flow.
    await writeFile(join(tempDir, '.imc', 'memory.yaml'), 'autoTriggerTokens: 42\nminEventCount: 2\nidleMs: 1111\nscheduleMs: 2222\nmaxBatchTokens: 333\n', 'utf8');
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor, memoryConfigCwd: tempDir });
    expect(coordinator.thresholds).toMatchObject({
      autoTriggerTokens: 42,
      minEventCount: 2,
      idleMs: 1111,
      scheduleMs: 2222,
      maxBatchTokens: 333,
    });
  });

  it('creates durable memory automatically from structured summary key decisions even without explicit durable events', async () => {
    const coordinator = new MaterializationCoordinator({
      compressor: async () => ({
        summary: [
          '## User Problem',
          'Need startup memory to preserve key decisions',
          '',
          '## Resolution',
          'Added automatic durable extraction from structured summaries.',
          '',
          '## Key Decisions',
          '- Key decisions: Preserve startup architecture notes',
          '- Constraints: Do not require manual memory tagging',
          '- Preferences: Prefer durable-first startup context',
          '',
          '## Active State',
          'Tests pending.',
        ].join('\n'),
        model: 'test-model',
        backend: 'none',
        usedBackup: false,
        fromSdk: true,
      }),
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });

    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'keep startup notes stable', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'implemented durable extraction', createdAt: 120 });

    const result = await coordinator.materializeTarget(target, 'manual', 500);

    expect(result.durableProjection?.class).toBe('durable_memory_candidate');
    expect(result.durableProjection?.summary).toContain('Preserve startup architecture notes');
    expect(result.durableProjection?.summary).toContain('Do not require manual memory tagging');
    expect(result.durableProjection?.summary).toContain('Prefer durable-first startup context');
    expect(result.durableProjection?.sourceEventIds).toEqual(result.summaryProjection.sourceEventIds);
    expect(result.durableProjection?.content).toEqual(expect.objectContaining({
      source: 'summary',
      durableSignals: {
        decisions: ['Preserve startup architecture notes'],
        constraints: ['Do not require manual memory tagging'],
        preferences: ['Prefer durable-first startup context'],
      },
    }));
  });
});
