import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
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
import {
  loadMemoryShortRefsFromStore,
  makeMemoryShortRef,
  registerMemoryShortRefs,
  resetMemoryShortRefsForTests,
  resolveMemoryShortRef,
  resolveMemoryShortRefCandidatesWithStore,
  resolveMemoryShortRefWithStore,
} from '../../src/context/memory-short-ref.js';
import { selectStartupObservationItems } from '../../src/context/startup-memory.js';
import { getContextStoreClient, resetContextStoreClientForTests } from '../../src/store/context-store-worker-client.js';
import {
  claimContextJob,
  enqueueContextJob,
  listContextEvents,
  listDirtyTargets,
  listMemoryShortRefsByRef,
  listProcessedProjections,
  recordContextEvent,
  recordTurnUsage,
  resetContextStoreForTests,
  selectTurnUsageSyncBatch,
  upsertMemoryShortRefs,
  writeProcessedProjection,
} from '../../src/store/context-store.js';
import { isMemoryDaemonEnabled, setMemoryDaemonEnabled } from '../../src/store/memory-daemon-switch.js';
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
    delete process.env.IMCODES_MEMORY_SHORT_REF_RECOVERY_PATH;
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

  it('aborts in-flight multi-await background flows with zero subsequent RPCs when disabled mid-flight', async () => {
    const client = getContextStoreClient();
    const ops: string[] = [];

    // 1. selectStartupObservationItems: listContextNamespaces flips switch -> listStartupContextObservations must NOT run.
    setMemoryDaemonEnabled(true);
    let resolveNamespaces!: (rows: Array<Record<string, unknown>>) => void;
    const runMock = vi.spyOn(client, 'run').mockImplementation((op) => {
      ops.push(op);
      if (op === 'listContextNamespaces') {
        return new Promise((resolve) => {
          resolveNamespaces = (rows) => resolve(rows as never);
        }) as never;
      }
      throw new Error(`unexpected subsequent RPC: ${op}`);
    });
    const obsPromise = selectStartupObservationItems({ ...target.namespace, userId: 'user-1' });
    await Promise.resolve();
    setMemoryDaemonEnabled(false);
    resolveNamespaces([{
      id: 'ns-1',
      scope: 'personal',
      projectId: 'repo',
      userId: 'user-1',
    }]);
    expect(await obsPromise).toEqual([]);
    expect(ops).toEqual(['listContextNamespaces']);

    // 2. MaterializationCoordinator.ingestEvent: ingestContextEvent flips switch -> enqueueContextJob must NOT run.
    ops.length = 0;
    runMock.mockReset();
    setMemoryDaemonEnabled(true);
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
    runMock.mockImplementation(async (op) => {
      ops.push(op);
      if (op === 'ingestContextEvent') {
        setMemoryDaemonEnabled(false);
        return {
          event: { id: 'ev-mid', target, eventType: 'assistant.text', content: 'hi', createdAt: 1000 },
          dirtyTarget: { target, eventCount: 5, oldestEventAt: 900, newestEventAt: 1000 },
          stagedTokenUpperBound: 500,
        } as never;
      }
      throw new Error(`unexpected RPC after disable: ${op}`);
    });
    const ingestRes = await coordinator.ingestEvent({
      id: 'ev-mid',
      target,
      eventType: 'assistant.text',
      content: 'hi',
      createdAt: 1000,
    });
    expect(ingestRes).toEqual({
      event: expect.objectContaining({ id: 'ev-mid' }),
    });
    expect(ops).toEqual(['ingestContextEvent']);

    // 3. scheduleDueTargets + selectTrigger: estimateStagedTokenUpperBound flips switch -> getLatestRecentSummaryUpdatedAtForTarget & enqueueContextJob must NOT run; second target must NOT run.
    ops.length = 0;
    runMock.mockReset();
    setMemoryDaemonEnabled(true);
    const target2 = { ...target, sessionName: 'deck_repo_other' };
    runMock.mockImplementation(async (op) => {
      ops.push(op);
      if (op === 'pruneArchiveIfDue') return { deleted: 0, skipped: true } as never;
      if (op === 'listDirtyTargets') {
        return [
          { target, eventCount: 3, oldestEventAt: 100, newestEventAt: 200 },
          { target: target2, eventCount: 4, oldestEventAt: 100, newestEventAt: 200 },
        ] as never;
      }
      if (op === 'estimateStagedTokenUpperBound') {
        setMemoryDaemonEnabled(false);
        return 500 as never;
      }
      throw new Error(`unexpected RPC after disable in scheduleDueTargets: ${op}`);
    });
    expect(await coordinator.scheduleDueTargets(5_000)).toEqual([]);
    expect(ops).toEqual(['pruneArchiveIfDue', 'listDirtyTargets', 'estimateStagedTokenUpperBound']);

    // 4. LiveContextIngestion.hasAnyActivity: getLatestRecentSummaryUpdatedAtForTarget flips switch -> listContextEvents & listArchivedEventsForTarget must NOT run.
    ops.length = 0;
    runMock.mockReset();
    setMemoryDaemonEnabled(true);
    const ingestion = new LiveContextIngestion({
      sessionLookup: () => undefined,
      resolveBootstrap: async () => ({ namespace: target.namespace, diagnostics: [] }),
    });
    runMock.mockImplementation(async (op) => {
      ops.push(op);
      if (op === 'listDirtyTargets') return [] as never;
      if (op === 'getLatestRecentSummaryUpdatedAtForTarget') {
        setMemoryDaemonEnabled(false);
        return undefined as never;
      }
      throw new Error(`unexpected RPC after disable in hasAnyActivity: ${op}`);
    });
    expect(await (ingestion as unknown as { hasAnyActivity: (t: typeof target) => Promise<boolean> }).hasAnyActivity(target)).toBe(false);
    expect(ops).toEqual(['listDirtyTargets', 'getLatestRecentSummaryUpdatedAtForTarget']);
    ingestion.dispose();
  });

  it('recovers journal-only short refs on demand via async resolver after disabled startup + runtime re-enable', async () => {
    const recoveryPath = join(tempDir, 'memory-short-refs.pending.json');
    process.env.IMCODES_MEMORY_SHORT_REF_RECOVERY_PATH = recoveryPath;
    const shortRefNs = { scope: 'personal' as const, userId: 'user-1', projectId: 'repo-1' };
    const id = 'durable-during-worker-self-heal';
    const ref = makeMemoryShortRef('projection', id);
    writeFileSync(recoveryPath, JSON.stringify({
      schemaVersion: 2,
      rows: [{
        ref,
        kind: 'projection',
        id,
        namespaceKey: JSON.stringify([shortRefNs.scope, shortRefNs.userId, shortRefNs.projectId, '', '']),
        namespaceJson: JSON.stringify(shortRefNs),
        lastSeenAt: Date.now(),
      }],
    }), { encoding: 'utf8', mode: 0o600 });

    // 1. Daemon starts with memory disabled -> startup warm-load short-circuits without RPCs or deleting journal.
    const client = getContextStoreClient();
    const runSpy = vi.spyOn(client, 'run');
    expect(await loadMemoryShortRefsFromStore()).toBe(0);
    expect(await resolveMemoryShortRefWithStore(ref, shortRefNs)).toBeUndefined();
    expect(runSpy).not.toHaveBeenCalled();
    expect(existsSync(recoveryPath)).toBe(true);

    // 2. Flip switch back to enabled at runtime WITHOUT calling loadMemoryShortRefsFromStore again.
    setMemoryDaemonEnabled(true);
    const resolved = await resolveMemoryShortRefWithStore(ref, shortRefNs);
    expect(resolved).toMatchObject({ kind: 'projection', id });
    expect(await resolveMemoryShortRefCandidatesWithStore(ref, shortRefNs)).toEqual([
      expect.objectContaining({ kind: 'projection', id }),
    ]);

    // Journal entries flush back to SQLite and the owned recovery journal is atomically removed.
    await expect.poll(() => listMemoryShortRefsByRef(ref)).toHaveLength(1);
    await expect.poll(() => existsSync(recoveryPath)).toBe(false);
  });

  it('releases paused running jobs back to pending on re-enable and pauses post-compressor RPCs without splitting staged rows', async () => {
    setMemoryDaemonEnabled(true);
    const client = getContextStoreClient();

    // Seed an unrelated active running job for a different target — must NOT be reset by our coordinator.
    const otherTarget = { ...target, sessionName: 'deck_repo_unrelated' };
    const otherJob = enqueueContextJob(otherTarget, 'materialize_session', 'manual', 1_000);
    expect(claimContextJob(otherJob.id, 1_001)).toBe(true);

    let compressorCalls = 0;
    let resolveDeferredCompression!: () => void;
    let waitInCompressor = false;
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
      compressor: async () => {
        compressorCalls += 1;
        if (waitInCompressor) {
          await new Promise<void>((resolve) => {
            resolveDeferredCompression = resolve;
          });
        }
        return {
          summary: '## Recent Summary\nRecovered after mid-compression disable.',
          model: 'test-model',
          backend: 'test-backend',
          usedBackup: false,
          fromSdk: true,
          inputTokens: 10,
          outputTokens: 12,
          targetTokens: 100,
          durationMs: 5,
        };
      },
    });

    await coordinator.ingestEvent({
      id: 'ev-claim-pause-1',
      target,
      eventType: 'assistant.text',
      content: 'Work that should materialize cleanly once re-enabled',
      createdAt: 2_000,
    });

    // Case A: Claim wins in real SQLite, then switch turns off immediately before listContextEvents runs.
    const origRun = client.run.bind(client);
    const postPauseOps: string[] = [];
    let flipOnClaim = true;
    const runSpy = vi.spyOn(client, 'run').mockImplementation(async (op, args, opts) => {
      if (!isMemoryDaemonEnabled() && op !== 'releaseClaimedContextJob') {
        postPauseOps.push(op);
      }
      const res = await origRun(op, args, opts);
      if (flipOnClaim && op === 'claimContextJob' && res === true) {
        flipOnClaim = false;
        setMemoryDaemonEnabled(false);
      }
      return res;
    });

    const resA = await coordinator.materializeTarget(target, 'manual', 2_100);
    expect(resA).toEqual({ replicationQueued: false, disabled: true });
    expect(postPauseOps).toEqual([]);
    expect(compressorCalls).toBe(0);
    expect(listContextEvents(target)).toHaveLength(1);
    expect(listProcessedProjections(target.namespace)).toHaveLength(0);

    // Case B: Re-enable on the SAME coordinator -> claim succeeds cleanly (job returned to pending), then disable INSIDE deferred compressor!
    setMemoryDaemonEnabled(true);
    waitInCompressor = true;
    const matPromiseB = coordinator.materializeTarget(target, 'manual', 2_200);
    await vi.waitFor(() => expect(compressorCalls).toBe(1));
    postPauseOps.length = 0;
    setMemoryDaemonEnabled(false);
    resolveDeferredCompression();
    const resB = await matPromiseB;
    expect(resB).toEqual({ replicationQueued: false, disabled: true });
    // After compressor settles while disabled: ZERO recordCompressionRun / countConsecutiveFailedJobs / commitMaterialization / updateContextJob RPCs.
    expect(postPauseOps).toEqual([]);
    expect(listContextEvents(target)).toHaveLength(1);
    expect(listProcessedProjections(target.namespace)).toHaveLength(0);

    // Case C: Re-enable again without recreating coordinator -> releases claimed job back to pending and finishes the batch!
    runSpy.mockRestore();
    waitInCompressor = false;
    setMemoryDaemonEnabled(true);
    const due = await coordinator.scheduleDueTargets(2_300);
    expect(due.length).toBeGreaterThanOrEqual(1);
    const finalRes = await coordinator.materializeTarget(target, 'manual', 2_300);
    expect(finalRes.disabled).toBeUndefined();
    expect(listContextEvents(target)).toHaveLength(0);
    expect(listDirtyTargets(target.namespace)).toHaveLength(0);
    expect(listProcessedProjections(target.namespace)).toHaveLength(1);
    expect(listProcessedProjections(target.namespace)[0]?.summary).toContain('Recovered after mid-compression disable.');
    // Unrelated job owned by another session remains untouched ('running', so another claim returns false).
    expect(claimContextJob(otherJob.id, 2_400)).toBe(false);
  });

  it('pauses short-ref flush after waitForProductionWorkerReady when disabled mid-wait and resumes via normal polling on re-enable', async () => {
    setMemoryDaemonEnabled(true);
    const recoveryPath = join(tempDir, 'memory-short-refs.pending.json');
    process.env.IMCODES_MEMORY_SHORT_REF_RECOVERY_PATH = recoveryPath;

    const client = getContextStoreClient();
    const origRun = client.run.bind(client);
    const isOwnerSpy = vi.spyOn(client, 'isProductionOwner', 'get').mockReturnValue(true);
    const isReadySpy = vi.spyOn(client, 'isReady', 'get').mockReturnValue(false);
    let resolveWorkerReady!: () => void;
    const whenReadySpy = vi.spyOn(client, 'whenReady').mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveWorkerReady = resolve;
      }),
    );
    const opsDuringDisable: string[] = [];
    const runSpy = vi.spyOn(client, 'run').mockImplementation(async (op, args, opts) => {
      opsDuringDisable.push(op);
      return origRun(op, args, opts);
    });

    const shortRefNs = { scope: 'personal' as const, userId: 'user-1', projectId: 'repo-1' };
    const [ref] = registerMemoryShortRefs([
      { kind: 'projection', id: 'deferred-shortref-id', namespace: shortRefNs },
    ]);
    expect(ref).toBeTruthy();

    // Journal was persisted while waiting for worker ready; flip switch off before worker becomes ready.
    await vi.waitFor(() => expect(existsSync(recoveryPath)).toBe(true));
    setMemoryDaemonEnabled(false);
    resolveWorkerReady();
    // Allow microtasks / flushPendingStoreRows async chain to settle.
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Must NOT have called upsertMemoryShortRefs and must preserve recovery journal + SQLite empty.
    expect(opsDuringDisable).toEqual([]);
    expect(existsSync(recoveryPath)).toBe(true);
    expect(listMemoryShortRefsByRef(ref!)).toHaveLength(0);

    // Re-enable at runtime and let worker be ready; normal periodic poll (flushDueTargets) resumes the paused flush.
    isReadySpy.mockReturnValue(true);
    isOwnerSpy.mockReturnValue(true);
    whenReadySpy.mockResolvedValue();
    runSpy.mockRestore();
    setMemoryDaemonEnabled(true);

    const ingestion = new LiveContextIngestion({
      sessionLookup: () => undefined,
      resolveBootstrap: async () => ({ namespace: shortRefNs, diagnostics: [] }),
    });
    try {
      await ingestion.flushDueTargets();
      await expect.poll(() => listMemoryShortRefsByRef(ref!)).toHaveLength(1);
      await expect.poll(() => existsSync(recoveryPath)).toBe(false);
    } finally {
      ingestion.dispose();
    }
  });

  it('abandons noise batches atomically with pause on mid-queue disable and completes on re-enable without orphaned staged state', async () => {
    setMemoryDaemonEnabled(true);
    const client = getContextStoreClient();
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

    await coordinator.ingestEvent({
      id: 'ev-noise-only-1',
      target,
      eventType: 'assistant.text',
      content: '[API Error: Connection error. (cause: fetch failed)]',
      createdAt: 5_000,
    });
    expect(listContextEvents(target)).toHaveLength(1);
    expect(listDirtyTargets(target.namespace)).toHaveLength(1);

    const origRun = client.run.bind(client);
    const opsAfterAbandonBlocked: string[] = [];
    let releaseAbandonGate!: () => void;
    let blockAbandon = true;
    let abandonReached = false;
    const runSpy = vi.spyOn(client, 'run').mockImplementation(async (op, args, opts) => {
      if (abandonReached) opsAfterAbandonBlocked.push(op);
      if (blockAbandon && op === 'abandonMaterializationBatch') {
        abandonReached = true;
        blockAbandon = false;
        await new Promise<void>((resolve) => {
          releaseAbandonGate = resolve;
        });
      }
      return origRun(op, args, opts);
    });

    const matPromise = coordinator.materializeTarget(target, 'manual', 5_100);
    await vi.waitFor(() => expect(abandonReached).toBe(true));
    // Simulate disable happening while abandonMaterializationBatch was queued before worker execution.
    setMemoryDaemonEnabled(false);
    releaseAbandonGate();

    const pausedRes = await matPromise;
    expect(pausedRes).toEqual({ replicationQueued: false, disabled: true });
    // Single atomic op only — zero follow-up deleteStagedEventsByIds / updateContextJob / clearDirtyTarget RPCs.
    expect(opsAfterAbandonBlocked).toEqual([]);
    // Staged event & dirty target remain intact together with the running job (no partial split).
    expect(listContextEvents(target)).toHaveLength(1);
    expect(listDirtyTargets(target.namespace)).toHaveLength(1);

    // Re-enable on the same coordinator -> releases running job to pending and atomically finishes noise abandon.
    runSpy.mockRestore();
    setMemoryDaemonEnabled(true);
    const due = await coordinator.scheduleDueTargets(5_200);
    expect(due.length).toBeGreaterThanOrEqual(1);
    const resumedRes = await coordinator.materializeTarget(target, 'manual', 5_200);
    expect(resumedRes).toEqual({ replicationQueued: false, filteredOut: true });
    expect(listContextEvents(target)).toHaveLength(0);
    expect(listDirtyTargets(target.namespace)).toHaveLength(0);
  });

  it('pauses cleanly when commitMaterialization fails with disabled error without sending updateContextJob or fallback commit', async () => {
    setMemoryDaemonEnabled(true);
    const client = getContextStoreClient();
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
      compressor: async () => ({
        summary: '## Recent Summary\nCommit pause recovery summary.',
        model: 'test-model',
        backend: 'test-backend',
        usedBackup: false,
        fromSdk: true,
        inputTokens: 10,
        outputTokens: 12,
        targetTokens: 100,
        durationMs: 5,
      }),
    });

    await coordinator.ingestEvent({
      id: 'ev-commit-disabled-1',
      target,
      eventType: 'assistant.text',
      content: 'Meaningful turn to commit after re-enable',
      createdAt: 6_000,
    });

    const isReadySpy = vi.spyOn(client, 'isReady', 'get').mockReturnValue(true);
    const origRun = client.run.bind(client);
    const postCommitErrorRunOps: string[] = [];
    let commitCallStarted = false;
    let releaseCommitCall!: () => void;
    const callSpy = vi.spyOn(client, 'call').mockImplementation(async (op, args, opts) => {
      if (op === 'commitMaterialization') {
        commitCallStarted = true;
        await new Promise<void>((resolve) => {
          releaseCommitCall = resolve;
        });
      }
      return origRun(op, args, opts);
    });
    const runSpy = vi.spyOn(client, 'run').mockImplementation(async (op, args, opts) => {
      if (commitCallStarted) postCommitErrorRunOps.push(op);
      return origRun(op, args, opts);
    });

    const matPromise = coordinator.materializeTarget(target, 'manual', 6_100);
    await vi.waitFor(() => expect(commitCallStarted).toBe(true));
    setMemoryDaemonEnabled(false);
    releaseCommitCall();

    const pausedRes = await matPromise;
    expect(pausedRes).toEqual({ replicationQueued: false, disabled: true });
    // Must NOT fall back to a second commitMaterialization run() AND must NOT call updateContextJob('materialization_failed').
    expect(postCommitErrorRunOps).toEqual([]);
    expect(listContextEvents(target)).toHaveLength(1);
    expect(listDirtyTargets(target.namespace)).toHaveLength(1);
    expect(listProcessedProjections(target.namespace)).toHaveLength(0);

    // Re-enable on the same coordinator -> completes the batch cleanly.
    callSpy.mockRestore();
    runSpy.mockRestore();
    isReadySpy.mockRestore();
    setMemoryDaemonEnabled(true);
    const due = await coordinator.scheduleDueTargets(6_200);
    expect(due.length).toBeGreaterThanOrEqual(1);
    await coordinator.materializeTarget(target, 'manual', 6_200);
    expect(listContextEvents(target)).toHaveLength(0);
    expect(listDirtyTargets(target.namespace)).toHaveLength(0);
    expect(listProcessedProjections(target.namespace)).toHaveLength(1);
    expect(listProcessedProjections(target.namespace)[0]?.summary).toContain('Commit pause recovery summary.');
  });
});
