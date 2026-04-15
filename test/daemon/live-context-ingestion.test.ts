import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';
import type { TimelineEvent } from '../../src/daemon/timeline-event.js';
import { LiveContextIngestion } from '../../src/context/live-context-ingestion.js';
import { localOnlyCompressor } from '../../src/context/summary-compressor.js';
import { getProcessedProjectionStats, queryProcessedProjections } from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

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
    tempDir = await createIsolatedSharedContextDb('live-context-ingestion');
  });

  afterEach(async () => {
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
        summary: expect.stringContaining('User problem: Investigate memory pipeline'),
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
    expect(summary?.summary).toContain('User problem: Need the final answer only');
    expect(summary?.summary).toContain('Resolution: final answer');
    expect(summary?.summary).not.toContain('partial');
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
    expect(summary?.summary).toContain('User problem: Find the final fix');
    expect(summary?.summary).toContain('Resolution: Use the final patch');
    expect(summary?.summary).not.toContain('grep');
    expect(summary?.summary).not.toContain('intermediate output');
  });

  it('backfills recent timeline history for sessions that have no existing context activity', async () => {
    const ingestion = new LiveContextIngestion({ compressor: localOnlyCompressor,
      sessionLookup: () => session,
      resolveBootstrap: async () => ({ namespace, diagnostics: ['test'] }),
    });

    await ingestion.backfillSessionFromEvents(session.name, [
      makeEvent('user.message', 100, { text: 'Summarize the deployment plan' }),
      makeEvent('assistant.text', 101, { text: 'Deployment plan captured' }),
    ]);

    expect(queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, limit: 10 })).toEqual([
      expect.objectContaining({
        class: 'recent_summary',
        summary: expect.stringContaining('Resolution: Deployment plan captured'),
      }),
    ]);
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: namespace.projectId })).toMatchObject({
      totalRecords: 1,
      stagedEventCount: 0,
      dirtyTargetCount: 0,
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

function makeEvent(type: TimelineEvent['type'], ts: number, payload: Record<string, unknown>): TimelineEvent {
  return {
    eventId: `${type}-${ts}`,
    sessionId: 'deck_repo_brain',
    ts,
    seq: ts,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type,
    payload,
  };
}
