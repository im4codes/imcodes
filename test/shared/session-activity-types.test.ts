import { describe, expect, it } from 'vitest';
import {
  buildCodexLifecycleIdempotencyKey,
  buildCodexLifecycleTerminalMetadata,
  evaluateProviderSnapshot,
  hasProviderActiveWork,
  isCodexLifecycleTerminalMetadata,
  isAuthoritativeCleanIdlePayload,
  reduceTimelineActivity,
  toPrivacySafeLifecycleMetadata,
} from '../../shared/session-activity-types.js';
import {
  CODEX_APP_SERVER_SCHEMA_BASELINE_NOTE,
  codexAppServerLifecycleReplay,
  codexLifecycleProjectionEvents,
} from '../fixtures/codex-app-server-lifecycle.js';

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

  it('keeps legacy idle weak over keyed open tools and closes on authoritative idle', () => {
    expect(reduceTimelineActivity([
      { type: 'tool.call', payload: { toolCallId: 'A', tool: 'Bash' } },
      { type: 'session.state', payload: { state: 'idle' } },
    ])).toMatchObject({ active: true, degraded: true, openToolCount: 1 });

    expect(reduceTimelineActivity([
      { type: 'tool.call', payload: { toolCallId: 'A', tool: 'Bash' } },
      {
        type: 'session.state',
        payload: authoritativeIdlePayload,
      },
    ])).toMatchObject({ active: false, openToolCount: 0 });
  });

  it('does not keep anonymous legacy tool calls active across idle', () => {
    expect(reduceTimelineActivity([
      { type: 'tool.call', payload: { tool: 'Bash' } },
      { type: 'session.state', payload: { state: 'idle' } },
    ])).toMatchObject({
      active: false,
      degraded: true,
      openToolCount: 0,
      degradedReasons: ['weak_idle'],
    });
  });

  it('does not count SDK sub-agent timeline rows as parent active work', () => {
    const sdkDetail = {
      kind: 'sdkSubagent',
      meta: {
        isSdkSubagent: true,
        schemaVersion: 1,
        provider: 'codex-sdk',
        providerKind: 'codexRuntimeAgent',
        canonicalKey: 'codex:deck_test:runtime:agent-1',
        normalizedStatus: 'running',
        active: true,
        terminal: false,
        backgrounded: true,
      },
    };

    expect(reduceTimelineActivity([
      { type: 'session.state', payload: authoritativeIdlePayload },
      { type: 'tool.call', payload: { toolCallId: 'agent-1', tool: 'Codex Sub-agent', detail: sdkDetail } },
    ])).toMatchObject({ active: false, degraded: false, openToolCount: 0 });

    expect(reduceTimelineActivity([
      { type: 'session.state', payload: authoritativeIdlePayload },
      { type: 'tool.call', payload: { toolCallId: 'agent-1', tool: 'Codex Sub-agent', detail: sdkDetail } },
      { type: 'tool.result', payload: { toolCallId: 'agent-1', detail: { ...sdkDetail, meta: { ...sdkDetail.meta, normalizedStatus: 'complete', active: false, terminal: true } } } },
    ])).toMatchObject({ active: false, degraded: false, openToolCount: 0 });
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

  it('validates Codex lifecycle terminal metadata and stable idempotency keys', () => {
    const metadata = buildCodexLifecycleTerminalMetadata({
      sessionId: 'deck_test',
      terminalStatus: 'cancelled',
      terminalReason: 'user_cancelled',
      synthetic: true,
      source: 'daemon_synthetic',
      decisionReason: 'local_stop',
      activityGeneration: { scope: 'session', sessionName: 'deck_test', generation: 4 },
      itemId: 'item-1',
      toolCallId: 'tool-1',
      turnId: 'turn-1',
      itemKind: 'web_search',
    });
    expect(isCodexLifecycleTerminalMetadata(metadata)).toBe(true);
    expect(metadata.idempotencyKey).toBe(buildCodexLifecycleIdempotencyKey({
      sessionId: 'deck_test',
      terminalStatus: 'cancelled',
      terminalReason: 'user_cancelled',
      activityGeneration: { scope: 'session', sessionName: 'deck_test', generation: 4 },
      itemId: 'item-1',
      toolCallId: 'tool-1',
      turnId: 'turn-1',
    }));

    expect(isCodexLifecycleTerminalMetadata({
      ...metadata,
      terminalReason: 'not-a-reason',
    })).toBe(false);
    expect(isCodexLifecycleTerminalMetadata({
      ...metadata,
      source: 'rollout_jsonl_diagnostic',
      terminalReason: 'thread_idle_settle',
      itemKind: 'context_compaction',
    })).toBe(true);
  });

  it('keeps lifecycle diagnostic metadata privacy-bounded', () => {
    const safe = toPrivacySafeLifecycleMetadata({
      sessionId: 'deck_test',
      terminalStatus: 'stale',
      terminalReason: 'daemon_restart_orphan',
      source: 'daemon_synthetic',
      decisionReason: 'restore_reconnect_orphan_reconcile',
      idempotencyKey: 'stable-key',
      activityGeneration: { scope: 'session', sessionName: 'deck_test', generation: 2 },
      activeWorkCount: 0,
      activeToolCount: 0,
      rawUserMessage: 'SECRET_USER_BODY',
      prompt: 'SECRET_PROMPT',
      toolInput: 'SECRET_TOOL_INPUT',
      commandOutput: 'SECRET_COMMAND_OUTPUT',
      providerPayload: { token: 'SECRET_PROVIDER_PAYLOAD' },
      env: { SECRET_ENV: 'SECRET_ENV_VALUE' },
      childTranscript: 'SECRET_CHILD_TRANSCRIPT',
    });
    expect(safe).toMatchObject({
      sessionId: 'deck_test',
      terminalStatus: 'stale',
      terminalReason: 'daemon_restart_orphan',
      source: 'daemon_synthetic',
      decisionReason: 'restore_reconnect_orphan_reconcile',
      idempotencyKey: 'stable-key',
      activeWorkCount: 0,
      activeToolCount: 0,
    });
    expect(JSON.stringify(safe)).not.toContain('SECRET_');
  });

  it('uses the maintained Codex app-server fixture baseline for projection parity', () => {
    expect(CODEX_APP_SERVER_SCHEMA_BASELINE_NOTE).toContain('schema is not available');
    expect(codexAppServerLifecycleReplay.map((event) => event.method)).toEqual([
      'thread/resume',
      'turn/start',
      'item/started',
      'item/started',
      'item/completed',
      'turn/completed',
    ]);
    expect(reduceTimelineActivity(codexLifecycleProjectionEvents)).toMatchObject({
      active: false,
      degraded: false,
      openToolCount: 0,
      lastTerminalStatus: 'succeeded',
      lastTerminalReason: 'app_server_completed',
    });
  });
});
