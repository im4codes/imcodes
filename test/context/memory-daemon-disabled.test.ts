import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { generateEmbedding } from '../../src/context/embedding.js';
import { searchLocalMemory } from '../../src/context/memory-recall-core.js';
import { LiveContextIngestion } from '../../src/context/live-context-ingestion.js';
import { MaterializationCoordinator } from '../../src/context/materialization-coordinator.js';
import {
  searchLocalMemorySemanticFrontOfTurn,
  searchLocalMemorySemanticViaWorker,
  searchLocalMemoryViaWorker,
  selectStartupMemoryForBootstrap,
  selectStartupMemoryViaWorker,
} from '../../src/context/memory-recall-client.js';
import { loadMemoryShortRefsFromStore, makeMemoryShortRef, resetMemoryShortRefsForTests, resolveMemoryShortRef } from '../../src/context/memory-short-ref.js';
import { selectStartupObservationItems } from '../../src/context/startup-memory.js';
import { getContextStoreClient, resetContextStoreClientForTests } from '../../src/store/context-store-worker-client.js';
import {
  listContextEvents,
  listProcessedProjections,
  recordContextEvent,
  recordTurnUsage,
  resetContextStoreForTests,
  selectTurnUsageSyncBatch,
  upsertMemoryShortRefs,
  writeProcessedProjection,
} from '../../src/store/context-store.js';
import { setMemoryDaemonEnabled } from '../../src/store/memory-daemon-switch.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

describe('daemon-wide memory disable gate', () => {
  let tempDir: string;
  const target = { namespace: { scope: 'personal' as const, projectId: 'repo' }, kind: 'session' as const, sessionName: 'deck_repo_brain' };

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('memory-daemon-disabled');
    process.env.IMCODES_MEMORY_DAEMON_SWITCH_PATH = join(tempDir, 'memory-switch.json');
    setMemoryDaemonEnabled(false);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetMemoryShortRefsForTests();
    resetContextStoreClientForTests();
    setMemoryDaemonEnabled(true);
    delete process.env.IMCODES_MEMORY_DAEMON_SWITCH_PATH;
    resetContextStoreForTests();
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('does not stage events, write projections, search, or start embedding while disabled', async () => {
    const event = recordContextEvent({ id: 'disabled-event', target, eventType: 'user.message', content: 'must not persist', createdAt: 1 });
    expect(event.id).toBe('disabled-event');
    expect(listContextEvents(target)).toEqual([]);
    expect(() => writeProcessedProjection({ namespace: target.namespace, class: 'recent_summary', sourceEventIds: [], summary: 'must not persist', content: {}, createdAt: 1, updatedAt: 1 })).toThrowError(/memory.*disabled/i);
    expect(listProcessedProjections(target.namespace)).toEqual([]);
    expect(searchLocalMemory({ query: 'must not persist' }).items).toEqual([]);
    expect(await generateEmbedding('must not compute')).toBeNull();
  });

  it('preserves existing rows when disabled and resumes only after explicit enable', () => {
    setMemoryDaemonEnabled(true);
    writeProcessedProjection({ namespace: target.namespace, class: 'recent_summary', sourceEventIds: [], summary: 'existing memory', content: {}, createdAt: 1, updatedAt: 1 });
    setMemoryDaemonEnabled(false);
    expect(listProcessedProjections(target.namespace)).toHaveLength(1);
    setMemoryDaemonEnabled(true);
    expect(() => writeProcessedProjection({ namespace: target.namespace, class: 'recent_summary', sourceEventIds: [], summary: 'new memory', content: {}, createdAt: 2, updatedAt: 2 })).not.toThrow();
    expect(listProcessedProjections(target.namespace)).toHaveLength(2);
  });

  it('short-circuits background context-store RPC callers with zero worker IPC while disabled and recovers on enable', async () => {
    const client = getContextStoreClient();
    const runSpy = vi.spyOn(client, 'run');
    const callSpy = vi.spyOn(client, 'call');
    const readySpy = vi.spyOn(client, 'isReady', 'get').mockReturnValue(true);

    // 1. MaterializationCoordinator: ingestEvent & listDirtyTargets & summary checks make zero RPCs.
    const coordinator = new MaterializationCoordinator({
      memoryConfig: {
        enabled: true,
        autoTriggerTokens: 1,
        minEventCount: 1,
        idleMs: 1,
        scheduleMs: 1,
        maxBatchTokens: 1000,
        batchTargetTokens: 500,
        manualCompactTargetTokens: 500,
        masterIdleHours: 1,
        archiveRetentionDays: 30,
        extraRedactPatterns: [],
      },
    });
    const eligibleRes = await coordinator.ingestEvent({
      id: 'ev-eligible-disabled',
      target,
      eventType: 'assistant.text',
      content: 'Response while disabled',
      createdAt: 1234,
    });
    expect(eligibleRes).toEqual({
      event: expect.objectContaining({ id: 'ev-eligible-disabled', eventType: 'assistant.text', createdAt: 1234 }),
    });
    const filteredRes = await coordinator.ingestEvent({
      target,
      eventType: 'tool.call',
      content: 'tool call while disabled',
      createdAt: 1235,
    });
    expect(filteredRes.filtered).toBe(true);
    expect(filteredRes.event.id).toBeTruthy();
    expect(await coordinator.listDirtyTargets(target.namespace)).toEqual([]);
    expect(await coordinator.canMaterializeTarget(target, 2000)).toBe(true);
    expect(await coordinator.scheduleDueTargets(2000)).toEqual([]);
    expect(await coordinator.materializeTarget(target, 'manual', 2000)).toEqual({ replicationQueued: false, disabled: true });
    expect(await coordinator.materializeDueMasterSummaries(2000)).toEqual([]);

    // 2. LiveContextIngestion: handleTimelineEvent, backfillSessionFromEvents, hasAnyActivity make zero RPCs and skip resolveBootstrap.
    const resolveBootstrap = vi.fn(async () => ({ namespace: target.namespace, diagnostics: [] }));
    const ingestion = new LiveContextIngestion({
      sessionLookup: (name) => ({
        name,
        projectName: 'repo',
        role: 'brain',
        agentType: 'claude-code-sdk',
        state: 'idle',
        projectDir: tempDir,
        createdAt: 1,
        updatedAt: 1,
      }),
      resolveBootstrap,
    });
    await ingestion.handleTimelineEvent({
      eventId: 'tl-1',
      sessionId: 'deck_repo_brain',
      ts: 2000,
      seq: 1,
      epoch: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'Hello while disabled', streaming: false },
    });
    await ingestion.handleTimelineEvent({
      eventId: 'tl-2',
      sessionId: 'deck_repo_brain',
      ts: 2001,
      seq: 2,
      epoch: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'session.state',
      payload: { state: 'idle' },
    });
    await ingestion.backfillSessionFromEvents('deck_repo_brain', [
      {
        eventId: 'tl-bf-1',
        sessionId: 'deck_repo_brain',
        ts: 2002,
        seq: 3,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'assistant.text',
        payload: { text: 'Backfill while disabled', streaming: false },
      },
    ]);
    expect(await (ingestion as unknown as { hasAnyActivity: (t: typeof target) => Promise<boolean> }).hasAnyActivity(target)).toBe(false);
    expect(resolveBootstrap).not.toHaveBeenCalled();

    // 3. loadMemoryShortRefsFromStore, selectStartupObservationItems, memory-recall-client make zero RPCs.
    expect(await loadMemoryShortRefsFromStore()).toBe(0);
    expect(await selectStartupObservationItems(target.namespace)).toEqual([]);
    expect(await selectStartupMemoryViaWorker(target.namespace)).toBeNull();
    expect(await selectStartupMemoryForBootstrap(target.namespace)).toEqual([]);
    expect(await searchLocalMemorySemanticViaWorker({ query: 'recent timeout', namespace: target.namespace })).toBeNull();
    expect(await searchLocalMemoryViaWorker({ query: 'recent timeout', namespace: target.namespace })).toBeNull();
    expect((await searchLocalMemorySemanticFrontOfTurn({ query: 'recent timeout', namespace: target.namespace })).items).toEqual([]);

    expect(runSpy).not.toHaveBeenCalled();
    expect(callSpy).not.toHaveBeenCalled();

    // 4. Independent turn token usage recording & sync remain unaffected while memory is disabled.
    recordTurnUsage({
      sessionName: 'deck_repo_brain',
      agentType: 'claude-code-sdk',
      model: 'claude-sonnet-4',
      inputTokens: 120,
      outputTokens: 30,
      eventId: 'usage-while-disabled',
      createdAt: 3000,
    });
    const usageBatch = selectTurnUsageSyncBatch({ now: 3001 });
    expect(usageBatch).toHaveLength(1);
    expect(usageBatch[0]).toMatchObject({
      fact: expect.objectContaining({
        sessionName: 'deck_repo_brain',
        inputTokens: 120,
        outputTokens: 30,
      }),
    });

    // 5. Runtime re-enable: short-circuit does not permanently stick (including loadMemoryShortRefsFromStore persistedLoaded).
    setMemoryDaemonEnabled(true);
    const shortRefNs = { ...target.namespace, userId: 'user-1' };
    const shortRef = makeMemoryShortRef('projection', 'proj-enabled-1');
    upsertMemoryShortRefs([{
      ref: shortRef,
      kind: 'projection',
      id: 'proj-enabled-1',
      namespaceKey: JSON.stringify([shortRefNs.scope, shortRefNs.userId, shortRefNs.projectId ?? '', '', '']),
      namespaceJson: JSON.stringify(shortRefNs),
      lastSeenAt: 4000,
    }]);
    readySpy.mockRestore(); // Use normal in-process run() path when re-enabled.
    const reloadedShortRefs = await loadMemoryShortRefsFromStore();
    expect(reloadedShortRefs).toBe(1);
    expect(resolveMemoryShortRef(shortRef, shortRefNs)).toMatchObject({
      kind: 'projection',
      id: 'proj-enabled-1',
    });

    await coordinator.ingestEvent({
      id: 'ev-eligible-reenabled',
      target,
      eventType: 'assistant.text',
      content: 'Response after re-enable',
      createdAt: 4001,
    });
    expect(runSpy).toHaveBeenCalledWith('listMemoryShortRefs', expect.any(Array), expect.any(Object));
    expect(runSpy).toHaveBeenCalledWith('ingestContextEvent', expect.any(Array));
    const dirtyAfter = await coordinator.listDirtyTargets(target.namespace);
    expect(dirtyAfter).toHaveLength(1);
    expect(await (ingestion as unknown as { hasAnyActivity: (t: typeof target) => Promise<boolean> }).hasAnyActivity(target)).toBe(true);
    ingestion.dispose();
  });
});
