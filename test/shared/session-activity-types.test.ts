import { describe, expect, it } from 'vitest';
import {
  evaluateProviderSnapshot,
  hasProviderActiveWork,
  isAuthoritativeCleanIdlePayload,
  reduceTimelineActivity,
} from '../../shared/session-activity-types.js';

const authoritativeIdlePayload = {
  state: 'idle',
  authoritative: true,
  activityGeneration: { scope: 'session', sessionName: 'deck_test', generation: 1 },
  blockingWorkCount: 0,
  activeWorkCount: 0,
  activeToolCount: 0,
  pendingCount: 0,
  pendingVersion: 1,
  decisionReason: 'activity_reconciler_clear',
  clearInputs: [{ source: 'transport-runtime', reason: 'clear', count: 0 }],
} as const;

describe('session activity shared contract', () => {
  it('requires generation and zero blocking counts for authoritative clean idle', () => {
    expect(isAuthoritativeCleanIdlePayload(authoritativeIdlePayload)).toBe(true);
    expect(isAuthoritativeCleanIdlePayload(authoritativeIdlePayload, { scope: 'session', sessionName: 'deck_test', generation: 1 })).toBe(true);
    expect(isAuthoritativeCleanIdlePayload(authoritativeIdlePayload, { scope: 'session', sessionName: 'deck_test', generation: 2 })).toBe(false);

    expect(isAuthoritativeCleanIdlePayload({
      state: 'idle',
      authoritative: true,
      activeWorkCount: 0,
    })).toBe(false);

    expect(isAuthoritativeCleanIdlePayload({
      state: 'idle',
      authoritative: true,
      activityGeneration: 1,
      blockingWorkCount: 1,
      activeWorkCount: 0,
      activeToolCount: 0,
      pendingCount: 0,
      pendingVersion: 1,
      decisionReason: 'activity_reconciler_clear',
      clearInputs: [],
    })).toBe(false);

    expect(isAuthoritativeCleanIdlePayload({
      ...authoritativeIdlePayload,
      pendingVersion: undefined,
    } as any)).toBe(false);
  });

  it('treats stale and unavailable provider snapshots as blocking', () => {
    expect(hasProviderActiveWork({
      status: 'stale',
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
    })).toBe(true);

    expect(hasProviderActiveWork({
      status: 'unavailable',
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
    })).toBe(true);

    expect(hasProviderActiveWork({
      status: 'current',
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
    })).toBe(false);
  });

  it('requires provider clear snapshots to be attributed to the current runtime generation', () => {
    const currentGeneration = { scope: 'session' as const, sessionName: 'deck_test', generation: 2 };
    expect(evaluateProviderSnapshot({
      status: 'current',
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
      activityGeneration: currentGeneration,
    }, currentGeneration)).toMatchObject({ state: 'clear', blocking: false, clear: true });

    expect(evaluateProviderSnapshot({
      status: 'current',
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
      providerDiagnosticGeneration: 'codex-turn-1',
    }, currentGeneration)).toMatchObject({ state: 'unattributed_clear', blocking: true, clear: false });

    expect(evaluateProviderSnapshot({
      status: 'current',
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
      activityGeneration: { scope: 'session', sessionName: 'deck_test', generation: 1 },
    }, currentGeneration)).toMatchObject({ state: 'stale', blocking: true, clear: false });
  });

  it('keeps legacy idle weak over open tools and closes on authoritative idle', () => {
    expect(reduceTimelineActivity([
      { type: 'tool.call', payload: { tool: 'Bash' } },
      { type: 'session.state', payload: { state: 'idle' } },
    ])).toMatchObject({ active: true, degraded: true, openToolCount: 1 });

    expect(reduceTimelineActivity([
      { type: 'tool.call', payload: { tool: 'Bash' } },
      {
        type: 'session.state',
        payload: authoritativeIdlePayload,
      },
    ])).toMatchObject({ active: false, openToolCount: 0 });
  });

  it('treats stale-generation authoritative idle as weak over open tools', () => {
    expect(reduceTimelineActivity([
      {
        type: 'session.state',
        payload: {
          state: 'running',
          activityGeneration: { scope: 'session', sessionName: 'deck_test', generation: 2 },
        },
      },
      { type: 'tool.call', payload: { toolCallId: 'A', tool: 'Bash' } },
      {
        type: 'session.state',
        payload: {
          ...authoritativeIdlePayload,
          activityGeneration: { scope: 'session', sessionName: 'deck_test', generation: 1 },
        },
      },
    ])).toMatchObject({
      active: true,
      degraded: true,
      openToolCount: 1,
    });
  });

  it('pairs multiple tool calls by id and treats unknown terminals as diagnostic-only', () => {
    expect(reduceTimelineActivity([
      { type: 'tool.call', payload: { toolCallId: 'A', tool: 'Bash' } },
      { type: 'tool.call', payload: { toolCallId: 'B', tool: 'Read' } },
      { type: 'tool.result', payload: { toolCallId: 'A', terminalStatus: 'succeeded' } },
      { type: 'session.state', payload: { state: 'idle' } },
    ])).toMatchObject({ active: true, degraded: true, openToolCount: 1 });

    expect(reduceTimelineActivity([
      { type: 'tool.result', payload: { toolCallId: 'unknown', terminalStatus: 'succeeded' } },
    ])).toMatchObject({ active: false, degraded: true, openToolCount: 0 });
  });

  it('marks non-succeeded terminal tool results as degraded closures', () => {
    expect(reduceTimelineActivity([
      { type: 'tool.call', payload: { tool: 'Bash' } },
      { type: 'tool.result', payload: { terminalStatus: 'stale', terminalReason: 'daemon_restart_orphan' } },
    ])).toMatchObject({
      active: false,
      degraded: true,
      openToolCount: 0,
      lastTerminalStatus: 'stale',
      lastTerminalReason: 'daemon_restart_orphan',
    });
  });
});
