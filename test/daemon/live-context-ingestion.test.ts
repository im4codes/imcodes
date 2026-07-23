import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';
import type { TimelineEvent } from '../../src/daemon/timeline-event.js';
import type { MaterializationSkillReviewJob } from '../../src/context/materialization-coordinator.js';

const scheduleMarkdownMemoryIngestMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/context/md-ingest-worker.js', () => ({
  scheduleMarkdownMemoryIngest: scheduleMarkdownMemoryIngestMock,
}));

import {
  closeLiveContextMaterializationAdmission,
  INGEST_RETRY_WALL_CLOCK_TTL_MS,
  LiveContextIngestion,
  reopenLiveContextMaterializationAdmission,
} from '../../src/context/live-context-ingestion.js';
import { localOnlyCompressor, type CompressionInput, type CompressionResult } from '../../src/context/summary-compressor.js';
import { ContextStoreError, resetContextStoreClientForTests } from '../../src/store/context-store-worker-client.js';
import { CONTEXT_STORE_RPC_ERROR, CONTEXT_STORE_RPC_SELF_HEAL } from '../../shared/context-store-rpc.js';
import { getProcessedProjectionStats, listContextEvents, listDirtyTargets, queryProcessedProjections } from '../../src/store/context-store.js';
import { getCounter, resetMetricsForTests } from '../../src/util/metrics.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

async function successfulCompressor(input: CompressionInput): Promise<CompressionResult> {
  return {
    summary: `Compressed ${input.events.length} events after tool work.`,
    model: 'test-model',
    backend: 'test',
    usedBackup: false,
    fromSdk: true,
  };
}

async function echoCompressor(input: CompressionInput): Promise<CompressionResult> {
  return {
    summary: input.events.map((event) => event.content).join('\n'),
    model: 'test-model',
    backend: 'test',
    usedBackup: false,
    fromSdk: true,
  };
}

describe('LiveContextIngestion', () => {
  let tempDir: string;
  const namespace: ContextNamespace = { scope: 'personal', projectId: 'github.com/acme/repo' };
  const session = {
    name: 'deck_repo_brain',
    projectName: 'repo',
    role: 'brain' as const,
    agentType: 'codex',
    projectDir: '/tmp/repo',
    state: 'idle' as const,
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
  };

  beforeEach(async () => {
    reopenLiveContextMaterializationAdmission();
    resetMetricsForTests();
    scheduleMarkdownMemoryIngestMock.mockReset();
    tempDir = await createIsolatedSharedContextDb('live-context-ingestion');
  });

  afterEach(async () => {
    vi.useRealTimers();
    resetContextStoreClientForTests();
    reopenLiveContextMaterializationAdmission();
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('stages live timeline events and materializes them when the session becomes idle', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'Investigate memory pipeline' }));
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 110, { text: 'Tracing the staged events path' }));

    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      totalRecords: 0,
      stagedEventCount: 2,
      dirtyTargetCount: 1,
    });

    await ingestion.handleTimelineEvent(makeEvent('session.state', 120, { state: 'idle' }));

    expect(queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, limit: 10 })).toEqual([
      expect.objectContaining({
        class: 'recent_summary',
        summary: expect.stringContaining('**User:** Investigate memory pipeline'),
      }),
    ]);
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      totalRecords: 1,
      stagedEventCount: 0,
      dirtyTargetCount: 0,
      pendingJobCount: 0,
    });
  });

  it('ignores streaming assistant deltas and only records the finalized assistant text', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'Need the final answer only' }));
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 110, { text: 'partial', streaming: true }));
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 120, { text: 'final answer', streaming: false }));

    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 2,
      dirtyTargetCount: 1,
    });

    await ingestion.handleTimelineEvent(makeEvent('session.state', 130, { state: 'idle' }));

    const [summary] = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, limit: 10 });
    expect(summary?.summary).toContain('**User:** Need the final answer only');
    expect(summary?.summary).toContain('**Assistant:** final answer');
    expect(summary?.summary).not.toContain('partial');
  });


  it('buffers and retries timeline events when context-store worker is temporarily unavailable', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });
    const originalIngest = ingestion.coordinator.ingestEvent.bind(ingestion.coordinator);
    vi.spyOn(ingestion.coordinator, 'ingestEvent')
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'worker down'))
      .mockImplementation(originalIngest);

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'queued while worker down' }));
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 0,
      dirtyTargetCount: 0,
    });

    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 110, { text: 'flushes queued event', streaming: false }));
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 2,
      dirtyTargetCount: 1,
    });
  });


  it('does not let a blocked retry-buffer head be overtaken by a new same-session event', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });
    const originalIngest = ingestion.coordinator.ingestEvent.bind(ingestion.coordinator);
    const ingestSpy = vi.spyOn(ingestion.coordinator, 'ingestEvent')
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'worker down'))
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.timeout, 'still blocked'))
      .mockImplementation(originalIngest);

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'first queued' }));
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 110, { text: 'second must wait', streaming: false }));
    expect(ingestSpy).toHaveBeenCalledTimes(2);
    expect(ingestSpy.mock.calls.map(([input]) => input.content)).toEqual([
      'first queued',
      'first queued',
    ]);
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 0,
      dirtyTargetCount: 0,
    });

    await ingestion.flushAllRetryBuffers({ forceDue: true });
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 2,
      dirtyTargetCount: 1,
    });
    expect(listContextEvents({ namespace, kind: 'session', sessionName: session.name }).map((event) => event.content)).toEqual([
      'first queued',
      'second must wait',
    ]);
  });

  it('prepares a current event blocked by pre-flush so replay keeps the original target', async () => {
    const originalNamespace = namespace;
    const laterNamespace: ContextNamespace = { scope: 'personal', projectId: 'github.com/acme/later' };
    let activeNamespace = originalNamespace;
    const mutableSession = { ...session };
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => mutableSession,
      resolveBootstrap: async () => ({ namespace: activeNamespace, diagnostics: ['test'] }),
    });
    const originalIngest = ingestion.coordinator.ingestEvent.bind(ingestion.coordinator);
    vi.spyOn(ingestion.coordinator, 'ingestEvent')
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'worker down'))
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.timeout, 'still blocked'))
      .mockImplementation(originalIngest);

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'first queued with original target' }));
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 110, { text: 'second prepared behind blocked head', streaming: false }));
    activeNamespace = laterNamespace;
    mutableSession.updatedAt = 2;

    await ingestion.flushAllRetryBuffers({ forceDue: true });

    expect(getProcessedProjectionStats({ scope: 'personal', projectId: originalNamespace.projectId })).toMatchObject({
      stagedEventCount: 2,
      dirtyTargetCount: 1,
    });
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: laterNamespace.projectId })).toMatchObject({
      stagedEventCount: 0,
      dirtyTargetCount: 0,
    });
  });

  it('drains a tail retry-buffer event without waiting for another same-session event', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });
    const originalIngest = ingestion.coordinator.ingestEvent.bind(ingestion.coordinator);
    vi.spyOn(ingestion.coordinator, 'ingestEvent')
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'worker down'))
      .mockImplementation(originalIngest);

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'tail queued event' }));
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({ stagedEventCount: 0 });

    await ingestion.flushAllRetryBuffers({ forceDue: true });
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 1,
      dirtyTargetCount: 1,
    });
  });


  it('respects nextAttemptAt/backoff under high same-session event rate', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });
    const originalIngest = ingestion.coordinator.ingestEvent.bind(ingestion.coordinator);
    const ingestSpy = vi.spyOn(ingestion.coordinator, 'ingestEvent')
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'worker down'))
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'worker still down'))
      .mockImplementation(originalIngest);

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'head queued' }));
    expect(ingestSpy).toHaveBeenCalledTimes(1);
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 110, { text: 'sets backoff after blocked head', streaming: false }));
    expect(ingestSpy).toHaveBeenCalledTimes(2);
    expect(getCounter('mem.ingest.buffer.transient_retry')).toBe(1);

    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 120, { text: 'must not burn retry before due', streaming: false }));
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 130, { text: 'still before due', streaming: false }));
    expect(ingestSpy).toHaveBeenCalledTimes(2);
    expect(getCounter('mem.ingest.buffer.transient_retry')).toBe(1);

    await vi.advanceTimersByTimeAsync(250);
    await ingestion.flushAllRetryBuffers({ forceDue: true });
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 4,
      dirtyTargetCount: 1,
    });
  });

  it('does not call ingest during a default retry drain before nextAttemptAt', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });
    const originalIngest = ingestion.coordinator.ingestEvent.bind(ingestion.coordinator);
    const ingestSpy = vi.spyOn(ingestion.coordinator, 'ingestEvent').mockImplementation(originalIngest);
    const event = makeEvent('user.message', 100, { text: 'not due yet' });
    enqueueRetryableEntryForTest(
      ingestion,
      makeIngestAction(event, namespace, session.name, 'before-due'),
      new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'worker down'),
      { nextAttemptAt: Date.now() + 1_000 },
    );

    await flushRetryBufferForTest(ingestion, session.name);

    expect(ingestSpy).not.toHaveBeenCalled();
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 0,
      dirtyTargetCount: 0,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await ingestion.flushAllRetryBuffers({ forceDue: true });
    expect(ingestSpy).toHaveBeenCalledTimes(1);
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 1,
      dirtyTargetCount: 1,
    });
  });

  it('recovers ready-worker timeout retries as transient instead of poison-dropping', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });
    const originalIngest = ingestion.coordinator.ingestEvent.bind(ingestion.coordinator);
    vi.spyOn(ingestion.coordinator, 'ingestEvent')
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.timeout, 'ready worker timeout 1'))
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.timeout, 'ready worker timeout 2'))
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.timeout, 'ready worker timeout 3'))
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.timeout, 'ready worker timeout 4'))
      .mockImplementation(originalIngest);

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'recover after timeout warmup' }));
    for (const delayMs of [250, 500, 1_000, 2_000]) {
      await vi.advanceTimersByTimeAsync(delayMs);
      await flushRetryBufferForTest(ingestion, session.name);
    }

    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 1,
      dirtyTargetCount: 1,
    });
    expect(listContextEvents({ namespace, kind: 'session', sessionName: session.name }).map((event) => event.content)).toEqual([
      'recover after timeout warmup',
    ]);
    expect(getCounter('mem.ingest.buffer.transient_retry')).toBe(3);
  });

  it('scopes staged event ids by target when timeline eventId collides', async () => {
    const otherSession = { ...session, name: 'deck_repo_worker', role: 'worker' as const };
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: (sessionName) => sessionName === otherSession.name ? otherSession : session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });
    const sharedEventId = 'transport-tool:shared-call';

    await ingestion.handleTimelineEvent({
      ...makeEvent('user.message', 100, { text: 'main prompt' }, session.name),
      eventId: sharedEventId,
    });
    await ingestion.handleTimelineEvent({
      ...makeEvent('user.message', 100, { text: 'worker prompt' }, otherSession.name),
      eventId: sharedEventId,
    });

    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 2,
      dirtyTargetCount: 2,
    });
  });

  it('retries a partially successful ingest without duplicating the staged event', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });
    const originalIngest = ingestion.coordinator.ingestEvent.bind(ingestion.coordinator);
    vi.spyOn(ingestion.coordinator, 'ingestEvent').mockImplementationOnce(async (input) => {
      await originalIngest(input);
      throw new ContextStoreError(CONTEXT_STORE_RPC_ERROR.timeout, 'enqueue timed out after ingest');
    }).mockImplementation(originalIngest);

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'only staged once' }));
    await ingestion.flushAllRetryBuffers();
    await ingestion.flushAllRetryBuffers();

    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 1,
      dirtyTargetCount: 1,
    });
    expect(listContextEvents({ namespace, kind: 'session', sessionName: session.name }).map((event) => event.content)).toEqual([
      'only staged once',
    ]);
  });

  it('preserves tool-result skill-review evidence while a retry-buffer head is blocked', async () => {
    const enqueued: MaterializationSkillReviewJob[] = [];
    const ingestion = new LiveContextIngestion({
      compressor: successfulCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000, minIntervalMs: 0 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
      skillReviewScheduler: {
        featureEnabled: true,
        getState: () => ({
          pendingKeys: new Set(),
          lastRunByScope: new Map(),
          dailyCountByScope: new Map(),
        }),
        policy: { toolIterationThreshold: 1, minIntervalMs: 0 },
        enqueue: (job) => { enqueued.push(job); },
      },
    });
    const originalIngest = ingestion.coordinator.ingestEvent.bind(ingestion.coordinator);
    vi.spyOn(ingestion.coordinator, 'ingestEvent')
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'worker down'))
      .mockImplementation(originalIngest);

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'blocked head' }));
    await ingestion.handleTimelineEvent(makeEvent('tool.result', 110, { output: 'visible tool result' }));
    await ingestion.flushAllRetryBuffers();
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 120, { text: 'answer after tool', streaming: false }));
    await ingestion.handleTimelineEvent(makeEvent('session.state', 130, { state: 'idle' }));

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.trigger).toBe('tool_iteration_count');
  });

  it('retries bootstrap preparation failures instead of dropping the event', async () => {
    let resolveAttempts = 0;
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => {
        resolveAttempts += 1;
        if (resolveAttempts === 1) {
          throw new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'bootstrap warming');
        }
        return { namespace, diagnostics: ['test'] };
      },
    });

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'queued before bootstrap ready' }));
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 0,
      dirtyTargetCount: 0,
    });

    await ingestion.flushAllRetryBuffers();
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 1,
      dirtyTargetCount: 1,
    });
  });


  it('drops ttl-expired retry entries with onError and metrics', async () => {
    vi.useFakeTimers({ now: 100_000 });
    const onError = vi.fn();
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
      onError,
    });
    const ingestSpy = vi.spyOn(ingestion.coordinator, 'ingestEvent');
    const event = makeEvent('user.message', 100, { text: 'expired retry' });
    const action = makeIngestAction(event, namespace, session.name, 'ttl-expired');
    enqueueRetryableEntryForTest(
      ingestion,
      action,
      new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'worker down too long'),
      { firstEnqueuedAt: Date.now() - INGEST_RETRY_WALL_CLOCK_TTL_MS - 1, nextAttemptAt: Date.now() },
    );

    await ingestion.flushAllRetryBuffers();

    expect(ingestSpy).not.toHaveBeenCalled();
    expect(getCounter('mem.ingest.buffer.ttl_expired_drop')).toBe(1);
    expect(onError).toHaveBeenCalledWith(expect.any(ContextStoreError), event);
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({ stagedEventCount: 0 });
  });

  it('keeps an event buffered across a full self-heal outage instead of TTL-dropping it (audit H-A)', async () => {
    // INVARIANT: the retry TTL must outlast a worker self-heal cycle, otherwise an
    // event buffered at the start of an outage is dropped just as the worker
    // recovers (systematic ingest loss). Was a bare 60_000 === respawnCooldownMs.
    expect(INGEST_RETRY_WALL_CLOCK_TTL_MS).toBeGreaterThan(CONTEXT_STORE_RPC_SELF_HEAL.respawnCooldownMs);
    vi.useFakeTimers({ now: 1_000_000 });
    const onError = vi.fn();
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
      onError,
    });
    const event = makeEvent('user.message', 100, { text: 'survives self-heal cooldown' });
    const action = makeIngestAction(event, namespace, session.name, 'self-heal-survivor');
    // Buffered 90s ago: PAST the old bare-60_000 TTL (would have been dropped) but
    // WITHIN the self-heal-derived TTL, so a full respawn-cooldown outage keeps it.
    enqueueRetryableEntryForTest(
      ingestion,
      action,
      new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'worker down across self-heal'),
      { firstEnqueuedAt: Date.now() - 90_000, nextAttemptAt: Date.now() },
    );

    await ingestion.flushAllRetryBuffers();

    expect(getCounter('mem.ingest.buffer.ttl_expired_drop')).toBe(0);
    expect(onError).not.toHaveBeenCalled();
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({ stagedEventCount: 1 });
  });

  it('bounds cross-session flush concurrency and treats overloaded as transient', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: (sessionName) => ({ ...session, name: sessionName }),
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });
    let active = 0;
    let maxActive = 0;
    vi.spyOn(ingestion.coordinator, 'ingestEvent').mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      throw new ContextStoreError(CONTEXT_STORE_RPC_ERROR.overloaded, 'worker saturated');
    });

    for (let index = 0; index < 10; index += 1) {
      const sessionName = `${session.name}_${index}`;
      const event = makeEvent('user.message', 1_000 + index, { text: `buffered ${index}` }, sessionName);
      enqueuePreparedRetryableEventForTest(
        ingestion,
        makePreparedIngest(event, namespace, sessionName, `concurrency:${index}`),
        new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'initial outage'),
        0,
      );
    }

    await ingestion.flushAllRetryBuffers();

    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(8);
    expect(getCounter('mem.ingest.buffer.transient_retry')).toBe(10);
    ingestion.dispose();
  });

  it('does not stage a duplicate when backfill replays the same logical live event', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });
    const event = makeEvent('user.message', 100, { text: 'same event from live and backfill' });

    await ingestion.handleTimelineEvent(event);
    await ingestion.backfillSessionFromEvents(session.name, [event]);

    expect(listContextEvents({ namespace, kind: 'session', sessionName: session.name })).toHaveLength(1);
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 1,
      dirtyTargetCount: 1,
    });
  });

  it('dedupes same-eventId backfill versions before staging the latest logical event', async () => {
    closeLiveContextMaterializationAdmission('test-reset');
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });
    const older = { ...makeEvent('user.message', 100, { text: 'old duplicate' }), eventId: 'same-logical-id' };
    const newer = { ...makeEvent('user.message', 110, { text: 'new duplicate' }), eventId: 'same-logical-id' };

    await ingestion.backfillSessionFromEvents(session.name, [older, newer]);

    const staged = listContextEvents({ namespace, kind: 'session', sessionName: session.name });
    expect(staged).toHaveLength(1);
    expect(staged[0]?.content).toBe('new duplicate');
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 1,
      dirtyTargetCount: 1,
    });
    reopenLiveContextMaterializationAdmission();
  });

  it('prefers the full final assistant text over a newer streaming version when backfill dedupes the same eventId', async () => {
    closeLiveContextMaterializationAdmission('test-reset');
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });
    // Same logical assistant.text eventId twice: the streaming version has NEWER
    // ts/seq, the non-streaming final has OLDER ts/seq. The shared preference
    // comparator must pick the full/non-streaming final (which maps to a staged
    // assistant turn). A weaker ts/seq-only comparator would pick the newer
    // streaming version, which mapTimelineEvent drops → 0 staged events.
    const final = {
      ...makeEvent('assistant.text', 100, { text: 'full final answer', streaming: false }),
      seq: 100,
      eventId: 'assistant-shared-id',
    };
    const streaming = {
      ...makeEvent('assistant.text', 110, { text: 'partial streaming preview', streaming: true }),
      seq: 110,
      eventId: 'assistant-shared-id',
    };

    await ingestion.backfillSessionFromEvents(session.name, [final, streaming]);

    const staged = listContextEvents({ namespace, kind: 'session', sessionName: session.name });
    expect(staged).toHaveLength(1);
    expect(staged[0]?.content).toBe('full final answer');
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 1,
      dirtyTargetCount: 1,
    });
    reopenLiveContextMaterializationAdmission();
  });

  it('backfills a second session in the same namespace after another session already has processed memory', async () => {
    const secondSession = { ...session, name: 'deck_repo_worker', role: 'worker' as const };
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 1, scheduleMs: 1, minIntervalMs: 0 },
      sessionLookup: (sessionName) => sessionName === secondSession.name ? secondSession : session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'first session memory' }, session.name));
    await ingestion.handleTimelineEvent(makeEvent('session.state', 101, { state: 'idle' }, session.name));
    expect(queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, limit: 10 })
      .some((entry) => entry.summary.includes('first session memory'))).toBe(true);

    await ingestion.backfillSessionFromEvents(secondSession.name, [
      makeEvent('user.message', 200, { text: 'second session backfill' }, secondSession.name),
      makeEvent('assistant.text', 201, { text: 'second session answer' }, secondSession.name),
    ]);

    expect(queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, limit: 10 })
      .some((entry) => entry.summary.includes('second session answer'))).toBe(true);
  });

  it('retries a blocked idle event with dirty=false as a no-op', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });
    const originalListDirtyTargets = ingestion.coordinator.listDirtyTargets.bind(ingestion.coordinator);
    vi.spyOn(ingestion.coordinator, 'listDirtyTargets')
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'dirty read unavailable'))
      .mockImplementation(originalListDirtyTargets);

    await ingestion.handleTimelineEvent(makeEvent('session.state', 100, { state: 'idle' }));
    await ingestion.flushAllRetryBuffers();

    expect(queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, limit: 10 })).toEqual([]);
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 0,
      dirtyTargetCount: 0,
    });
  });

  it('retries a blocked idle event with dirty=true and materializes via the delayed idle action', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000, minIntervalMs: 0 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });
    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'dirty before idle retry' }));
    const originalListDirtyTargets = ingestion.coordinator.listDirtyTargets.bind(ingestion.coordinator);
    vi.spyOn(ingestion.coordinator, 'listDirtyTargets')
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'dirty read unavailable'))
      .mockImplementation(originalListDirtyTargets);

    await ingestion.handleTimelineEvent(makeEvent('session.state', 110, { state: 'idle' }));
    expect(queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, limit: 10 })).toEqual([]);

    await ingestion.flushAllRetryBuffers();

    expect(queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, limit: 10 })).toEqual([
      expect.objectContaining({ summary: expect.stringContaining('dirty before idle retry') }),
    ]);
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 0,
      dirtyTargetCount: 0,
    });
  });

  it('freezes prepared target and stable event id after ingest failure before retry flush', async () => {
    const originalNamespace = namespace;
    const laterNamespace: ContextNamespace = { scope: 'personal', projectId: 'github.com/acme/changed-before-retry' };
    let activeNamespace = originalNamespace;
    const mutableSession = { ...session };
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => mutableSession,
      resolveBootstrap: async () => ({ namespace: activeNamespace, diagnostics: ['test'] }),
    });
    const originalIngest = ingestion.coordinator.ingestEvent.bind(ingestion.coordinator);
    vi.spyOn(ingestion.coordinator, 'ingestEvent')
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'ingest failed after prepare'))
      .mockImplementation(originalIngest);
    const event = makeEvent('user.message', 100, { text: 'prepared once' });

    await ingestion.handleTimelineEvent(event);
    activeNamespace = laterNamespace;
    mutableSession.updatedAt = 2;
    await ingestion.flushAllRetryBuffers();

    expect(listContextEvents({ namespace: originalNamespace, kind: 'session', sessionName: session.name })).toHaveLength(1);
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: originalNamespace.projectId })).toMatchObject({
      stagedEventCount: 1,
      dirtyTargetCount: 1,
    });
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: laterNamespace.projectId })).toMatchObject({
      stagedEventCount: 0,
      dirtyTargetCount: 0,
    });
  });

  it('keeps trigger metadata idempotent when enqueue fails after a staged event is recorded', async () => {
    closeLiveContextMaterializationAdmission('test-reset');
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 1, idleMs: 60_000, scheduleMs: 60_000, minIntervalMs: 0 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });
    const originalIngest = ingestion.coordinator.ingestEvent.bind(ingestion.coordinator);
    vi.spyOn(ingestion.coordinator, 'ingestEvent').mockImplementationOnce(async (input) => {
      const result = await originalIngest(input);
      expect(result.trigger).toBe('threshold');
      throw new ContextStoreError(CONTEXT_STORE_RPC_ERROR.timeout, 'enqueue timed out after staged event');
    }).mockImplementation(originalIngest);

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'queued job exactly once' }));
    const beforeRetry = listDirtyTargets(namespace)[0];
    expect(beforeRetry?.pendingJobId).toEqual(expect.any(String));
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 1,
      dirtyTargetCount: 1,
      pendingJobCount: 1,
    });

    await ingestion.flushAllRetryBuffers();

    const afterRetry = listDirtyTargets(namespace)[0];
    expect(listContextEvents({ namespace, kind: 'session', sessionName: session.name })).toHaveLength(1);
    expect(afterRetry?.pendingJobId).toBe(beforeRetry?.pendingJobId);
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 1,
      dirtyTargetCount: 1,
      pendingJobCount: 1,
    });
    reopenLiveContextMaterializationAdmission();
  });

  it('keeps raw events staged but skips materialization while admission is closed', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 1, idleMs: 1, scheduleMs: 1 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });

    closeLiveContextMaterializationAdmission('shutdown');
    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'preserve raw user event' }));
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 110, { text: 'preserve raw assistant event' }));
    await ingestion.handleTimelineEvent(makeEvent('session.state', 120, { state: 'idle' }));
    await ingestion.flushDueTargets(130);

    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      totalRecords: 0,
      stagedEventCount: 2,
      dirtyTargetCount: 1,
    });
  });


  it('ignores API connection error assistant turns even when they are not explicitly memoryExcluded', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'Continue the run' }));
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 110, {
      text: '[API Error: Connection error. (cause: fetch failed)]',
      streaming: false,
    }));

    await ingestion.handleTimelineEvent(makeEvent('session.state', 120, { state: 'idle' }));

    const [summary] = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, limit: 10 });
    expect(summary?.summary).toContain('**User:** Continue the run');
    expect(summary?.summary).not.toContain('API Error');
    expect(summary?.summary).not.toContain('fetch failed');
  });

  it('ignores memory-excluded assistant warnings so runtime errors do not enter processed memory', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'Continue the run' }));
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 110, {
      text: '⚠️ Error: Terminal stream unavailable after max retries',
      streaming: false,
      memoryExcluded: true,
    }));

    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 1,
      dirtyTargetCount: 1,
    });

    await ingestion.handleTimelineEvent(makeEvent('session.state', 120, { state: 'idle' }));

    const [summary] = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, limit: 10 });
    expect(summary?.summary).toContain('**User:** Continue the run');
    expect(summary?.summary).not.toContain('Terminal stream unavailable');
  });

  it('ignores tool calls and tool results when building memory', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'Find the final fix' }));
    await ingestion.handleTimelineEvent(makeEvent('tool.call', 110, {
      tool: 'grep',
      input: { pattern: 'bug' },
    }));
    await ingestion.handleTimelineEvent(makeEvent('tool.result', 120, {
      output: 'intermediate output',
    }));
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 130, { text: 'Use the final patch', streaming: false }));

    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 2,
      dirtyTargetCount: 1,
    });

    await ingestion.handleTimelineEvent(makeEvent('session.state', 140, { state: 'idle' }));

    const [summary] = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, limit: 10 });
    expect(summary?.summary).toContain('**User:** Find the final fix');
    expect(summary?.summary).toContain('**Assistant:** Use the final patch');
    expect(summary?.summary).not.toContain('grep');
    expect(summary?.summary).not.toContain('intermediate output');
  });

  it('uses completed tool results as threshold evidence for post-response skill auto-creation without storing tool output', async () => {
    const enqueued: MaterializationSkillReviewJob[] = [];
    const ingestion = new LiveContextIngestion({
      compressor: successfulCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000, minIntervalMs: 0 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
      skillReviewScheduler: {
        featureEnabled: true,
        getState: () => ({
          pendingKeys: new Set(),
          lastRunByScope: new Map(),
          dailyCountByScope: new Map(),
        }),
        policy: { toolIterationThreshold: 2, minIntervalMs: 0 },
        enqueue: (job) => { enqueued.push(job); },
      },
    });

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'Use tools once' }));
    await ingestion.handleTimelineEvent(makeEvent('tool.result', 110, { output: 'do not store this output' }));
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 120, { text: 'First answer', streaming: false }));
    await ingestion.handleTimelineEvent(makeEvent('session.state', 130, { state: 'idle' }));
    expect(enqueued).toEqual([]);

    await ingestion.handleTimelineEvent(makeEvent('user.message', 200, { text: 'Use tools again' }));
    await ingestion.handleTimelineEvent(makeEvent('tool.result', 210, { output: 'also not stored' }));
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 220, { text: 'Second answer', streaming: false }));
    await ingestion.handleTimelineEvent(makeEvent('session.state', 230, { state: 'idle' }));
    expect(enqueued).toEqual([]);

    await ingestion.handleTimelineEvent(makeEvent('user.message', 300, { text: 'Use enough tools in one turn' }));
    await ingestion.handleTimelineEvent(makeEvent('tool.result', 310, { output: 'third hidden output' }));
    await ingestion.handleTimelineEvent(makeEvent('tool.result', 320, { output: 'fourth hidden output' }));
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 330, { text: 'Third answer', streaming: false }));
    await ingestion.handleTimelineEvent(makeEvent('session.state', 340, { state: 'idle' }));

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.trigger).toBe('tool_iteration_count');
    const summaries = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, limit: 10 });
    expect(summaries.map((entry) => entry.summary).join('\n')).not.toContain('do not store this output');
    expect(summaries.map((entry) => entry.summary).join('\n')).not.toContain('also not stored');
  });

  it('filters hidden and failed tool results from skill-review tool-iteration evidence', async () => {
    const enqueued: MaterializationSkillReviewJob[] = [];
    const ingestion = new LiveContextIngestion({
      compressor: successfulCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000, minIntervalMs: 0 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
      skillReviewScheduler: {
        featureEnabled: true,
        getState: () => ({
          pendingKeys: new Set(),
          lastRunByScope: new Map(),
          dailyCountByScope: new Map(),
        }),
        policy: { toolIterationThreshold: 1, minIntervalMs: 0 },
        enqueue: (job) => { enqueued.push(job); },
      },
    });

    await ingestion.handleTimelineEvent(makeEvent('user.message', 300, { text: 'Hidden tools should not learn' }));
    await ingestion.handleTimelineEvent({ ...makeEvent('tool.result', 310, { output: 'hidden raw edit' }), hidden: true });
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 320, { text: 'First answer', streaming: false }));
    await ingestion.handleTimelineEvent(makeEvent('session.state', 330, { state: 'idle' }));
    expect(enqueued).toEqual([]);

    await ingestion.handleTimelineEvent(makeEvent('user.message', 400, { text: 'Failed tools should not learn' }));
    await ingestion.handleTimelineEvent(makeEvent('tool.result', 410, { error: 'tool failed' }));
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 420, { text: 'Second answer', streaming: false }));
    await ingestion.handleTimelineEvent(makeEvent('session.state', 430, { state: 'idle' }));
    expect(enqueued).toEqual([]);

    await ingestion.handleTimelineEvent(makeEvent('user.message', 500, { text: 'Visible completed tool can learn' }));
    await ingestion.handleTimelineEvent(makeEvent('tool.result', 510, { output: 'ok' }));
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 520, { text: 'Third answer', streaming: false }));
    await ingestion.handleTimelineEvent(makeEvent('session.state', 530, { state: 'idle' }));
    expect(enqueued).toHaveLength(1);
  });

  it('lets callers suppress team participant timeline events before they enter memory staging', async () => {
    const enqueued: MaterializationSkillReviewJob[] = [];
    const workerSession = { ...session, name: 'deck_repo_w1', role: 'w1' as const };
    const ingestion = new LiveContextIngestion({
      compressor: echoCompressor,
      thresholds: { eventCount: 99, idleMs: 1, scheduleMs: 1, minIntervalMs: 0 },
      sessionLookup: (sessionName) => sessionName === workerSession.name ? workerSession : session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
      shouldIngestTimelineEvent: (event) => event.sessionId !== workerSession.name,
      skillReviewScheduler: {
        featureEnabled: true,
        getState: () => ({
          pendingKeys: new Set(),
          lastRunByScope: new Map(),
          dailyCountByScope: new Map(),
        }),
        policy: { toolIterationThreshold: 1, minIntervalMs: 0 },
        enqueue: (job) => { enqueued.push(job); },
      },
    });

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'P2P worker kickoff prompt' }, workerSession.name));
    await ingestion.handleTimelineEvent(makeEvent('tool.result', 110, { output: 'worker tool evidence' }, workerSession.name));
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 120, { text: 'P2P worker analysis', streaming: false }, workerSession.name));
    await ingestion.handleTimelineEvent(makeEvent('session.state', 130, { state: 'idle' }, workerSession.name));

    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      totalRecords: 0,
      stagedEventCount: 0,
      dirtyTargetCount: 0,
    });
    expect(enqueued).toEqual([]);

    await ingestion.handleTimelineEvent(makeEvent('user.message', 200, {
      text: 'Main internal summary prompt',
      memoryExcluded: true,
    }));
    await ingestion.handleTimelineEvent(makeEvent('assistant.text', 210, { text: 'Main session summary', streaming: false }));
    await ingestion.handleTimelineEvent(makeEvent('session.state', 220, { state: 'idle' }));

    const [summary] = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, limit: 10 });
    expect(summary?.summary).toContain('Main session summary');
    expect(summary?.summary).not.toContain('Main internal summary prompt');
    expect(summary?.summary).not.toContain('P2P worker');
    expect(summary?.summary).not.toContain('worker tool evidence');
  });

  it('backfills recent timeline history for sessions that have no existing context activity', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });

    await ingestion.backfillSessionFromEvents(session.name, [
      makeEvent('user.message', 99, { text: '/model gpt-5.4' }),
      makeEvent('user.message', 100, { text: 'Summarize the deployment plan' }),
      makeEvent('assistant.text', 101, { text: 'Deployment plan captured' }),
    ]);

    expect(queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, limit: 10 })).toEqual([
      expect.objectContaining({
        class: 'recent_summary',
        summary: expect.stringContaining('**Assistant:** Deployment plan captured'),
      }),
    ]);
    expect(queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, limit: 10 })[0]?.summary)
      .not.toContain('/model gpt-5.4');
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      totalRecords: 1,
      stagedEventCount: 0,
      dirtyTargetCount: 0,
    });
    expect(scheduleMarkdownMemoryIngestMock).not.toHaveBeenCalled();
  });

  it('backfill activity-check retry queues prepared events without materializing or retargeting', async () => {
    const originalNamespace = namespace;
    const laterNamespace: ContextNamespace = { scope: 'personal', projectId: 'github.com/acme/later-backfill' };
    let activeNamespace = originalNamespace;
    const mutableSession = { ...session };
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      sessionLookup: () => mutableSession,
      resolveBootstrap: async () => ({ namespace: activeNamespace, diagnostics: ['test'] }),
    });
    const originalListDirtyTargets = ingestion.coordinator.listDirtyTargets.bind(ingestion.coordinator);
    vi.spyOn(ingestion.coordinator, 'listDirtyTargets')
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'worker down during activity check'))
      .mockImplementation(originalListDirtyTargets);

    await ingestion.backfillSessionFromEvents(session.name, [
      makeEvent('user.message', 100, { text: 'Backfill A waits for retry' }),
      makeEvent('assistant.text', 101, { text: 'Backfill B must keep the original target' }),
    ]);

    expect(queryProcessedProjections({ scope: 'personal', projectId: originalNamespace.projectId, limit: 10 })).toEqual([]);
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: originalNamespace.projectId })).toMatchObject({
      totalRecords: 0,
      stagedEventCount: 0,
      dirtyTargetCount: 0,
    });

    activeNamespace = laterNamespace;
    mutableSession.updatedAt = 2;
    await ingestion.flushAllRetryBuffers();

    expect(getProcessedProjectionStats({ scope: 'personal', projectId: originalNamespace.projectId })).toMatchObject({
      stagedEventCount: 2,
      dirtyTargetCount: 1,
    });
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: laterNamespace.projectId })).toMatchObject({
      stagedEventCount: 0,
      dirtyTargetCount: 0,
    });
    expect(queryProcessedProjections({ scope: 'personal', projectId: originalNamespace.projectId, limit: 10 })).toEqual([]);
  });

  it('backfill retry preserves order so B is not staged while A remains blocked', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });
    const originalIngest = ingestion.coordinator.ingestEvent.bind(ingestion.coordinator);
    vi.spyOn(ingestion.coordinator, 'ingestEvent')
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'backfill A failed'))
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.timeout, 'backfill A still blocked'))
      .mockImplementation(originalIngest);

    await ingestion.backfillSessionFromEvents(session.name, [
      makeEvent('user.message', 100, { text: 'Backfill A' }),
      makeEvent('assistant.text', 101, { text: 'Backfill B' }),
    ]);
    await ingestion.flushAllRetryBuffers({ forceDue: true });

    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 0,
      dirtyTargetCount: 0,
    });

    await ingestion.flushAllRetryBuffers({ forceDue: true });
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 2,
      dirtyTargetCount: 1,
    });
  });

  it('reports non-empty retry buffers on dispose via onError and metrics', async () => {
    const onError = vi.fn();
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
      onError,
    });
    vi.spyOn(ingestion.coordinator, 'ingestEvent')
      .mockRejectedValueOnce(new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'worker down'));
    const event = makeEvent('user.message', 100, { text: 'queued until dispose' });

    await ingestion.handleTimelineEvent(event);
    ingestion.dispose();

    expect(onError).toHaveBeenCalledWith(expect.any(ContextStoreError), event);
    expect(getCounter('mem.ingest.buffer.disposed_drop')).toBe(1);
  });

  it('makes retry-buffer drop-oldest overflow observable via onError and metrics', () => {
    const onError = vi.fn();
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 60_000, scheduleMs: 60_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
      onError,
    });
    const retryError = new ContextStoreError(CONTEXT_STORE_RPC_ERROR.unavailable, 'worker down');
    const enqueue = (ingestion as unknown as {
      enqueuePreparedRetryableEvent: (prepared: {
        event: TimelineEvent;
        target: { namespace: typeof namespace; kind: 'session'; sessionName: string };
        mapped: { eventType: 'user.turn'; content: string; metadata: { timelineType: 'user.message' } };
        createdAt: number;
        stableEventId: string;
      }, error: unknown, attempts: number) => boolean;
    }).enqueuePreparedRetryableEvent.bind(ingestion);
    const prepared = (event: TimelineEvent, index: number) => ({
      event,
      target: { namespace, kind: 'session' as const, sessionName: session.name },
      mapped: { eventType: 'user.turn' as const, content: String(event.payload.text), metadata: { timelineType: 'user.message' as const } },
      createdAt: event.ts,
      stableEventId: `overflow:${index}`,
    });

    for (let index = 0; index < 256; index += 1) {
      const event = makeEvent('user.message', 1_000 + index, { text: `buffered ${index}` });
      expect(enqueue(prepared(event, index), retryError, 0)).toBe(true);
    }
    const newest = makeEvent('user.message', 2_000, { text: 'kept newest' });
    expect(enqueue(prepared(newest, 999), retryError, 0)).toBe(true);

    expect(onError).toHaveBeenCalledWith(retryError, expect.objectContaining({ payload: { text: 'buffered 0' } }));
    expect(getCounter('mem.ingest.buffer.overflow_drop', { policy: 'drop_oldest' })).toBe(1);
    ingestion.dispose();
  });

  it('schedules markdown memory ingestion for live events only', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'Live event should refresh md memory' }));

    expect(scheduleMarkdownMemoryIngestMock).toHaveBeenCalledTimes(1);
    expect(scheduleMarkdownMemoryIngestMock).toHaveBeenCalledWith({
      projectDir: session.projectDir,
      namespace,
    });
  });

  it('rate-limits processed summaries to at most one per target every 10 seconds by default', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 1, idleMs: 60_000, scheduleMs: 60_000, minIntervalMs: 10_000 },
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });

    await ingestion.handleTimelineEvent(makeEvent('user.message', 100, { text: 'First prompt' }));
    await ingestion.handleTimelineEvent(makeEvent('session.state', 101, { state: 'idle' }));
    expect(queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, limit: 10 })).toHaveLength(1);

    await ingestion.handleTimelineEvent(makeEvent('user.message', 105, { text: 'Second prompt too soon' }));
    await ingestion.handleTimelineEvent(makeEvent('session.state', 106, { state: 'idle' }));
    expect(queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, limit: 10 })).toHaveLength(1);
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      stagedEventCount: 1,
      dirtyTargetCount: 1,
    });

    await ingestion.flushDueTargets(10_200);
    const summaries = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, limit: 10 });
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.summary).toContain('Second prompt too soon');
  });
});


type TestPreparedIngest = {
  event: TimelineEvent;
  target: { namespace: ContextNamespace; kind: 'session'; sessionName: string };
  mapped: { eventType: 'user.turn'; content: string; metadata: { timelineType: 'user.message' } };
  createdAt: number;
  stableEventId: string;
};

type TestRetryableAction = { kind: 'ingest'; prepared: TestPreparedIngest };

function makePreparedIngest(
  event: TimelineEvent,
  targetNamespace: ContextNamespace,
  sessionName: string,
  stableEventId: string,
): TestPreparedIngest {
  return {
    event,
    target: { namespace: targetNamespace, kind: 'session', sessionName },
    mapped: {
      eventType: 'user.turn',
      content: String(event.payload.text),
      metadata: { timelineType: 'user.message' },
    },
    createdAt: event.ts,
    stableEventId,
  };
}

function makeIngestAction(
  event: TimelineEvent,
  targetNamespace: ContextNamespace,
  sessionName: string,
  stableEventId: string,
): TestRetryableAction {
  return { kind: 'ingest', prepared: makePreparedIngest(event, targetNamespace, sessionName, stableEventId) };
}

function enqueuePreparedRetryableEventForTest(
  ingestion: LiveContextIngestion,
  prepared: TestPreparedIngest,
  error: unknown,
  attempts: number,
): boolean {
  return (ingestion as unknown as {
    enqueuePreparedRetryableEvent: (prepared: TestPreparedIngest, error: unknown, attempts: number) => boolean;
  }).enqueuePreparedRetryableEvent(prepared, error, attempts);
}

function enqueueRetryableEntryForTest(
  ingestion: LiveContextIngestion,
  action: TestRetryableAction,
  error: unknown,
  options?: { firstEnqueuedAt?: number; nextAttemptAt?: number; backoffMs?: number },
): boolean {
  return (ingestion as unknown as {
    enqueueRetryableEntry: (
      action: TestRetryableAction,
      error: unknown,
      options?: { firstEnqueuedAt?: number; nextAttemptAt?: number; backoffMs?: number },
    ) => boolean;
  }).enqueueRetryableEntry(action, error, options);
}

async function flushRetryBufferForTest(
  ingestion: LiveContextIngestion,
  sessionName: string,
): Promise<void> {
  await (ingestion as unknown as {
    flushRetryBuffer: (sessionName: string) => Promise<{ status: 'drained' } | { status: 'blocked'; error: unknown }>;
  }).flushRetryBuffer(sessionName);
}

function makeEvent(
  type: TimelineEvent['type'],
  ts: number,
  payload: Record<string, unknown>,
  sessionId = 'deck_repo_brain',
): TimelineEvent {
  return {
    eventId: `${type}-${ts}`,
    sessionId,
    ts,
    seq: ts,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type,
    payload,
  };
}
