import { afterEach, describe, it, expect, vi } from 'vitest';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import {
  BACKGROUND_SUBAGENT_WAKE_MODES,
  type TransportProvider,
} from '../../src/agent/transport-provider.js';
import type { AgentMessage, ToolCallEvent } from '../../shared/agent-message.js';
import {
  buildSdkSubagentSafeDetail,
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_SCHEMA_VERSION,
  SDK_SUBAGENT_STATUS,
  SDK_SUBAGENT_WAKE_PROMPT_HEADER,
} from '../../shared/sdk-subagent-status.js';

// This suite verifies the transport wake state machine, not memory retrieval.
// Without this boundary the test-only (non-production-owner) recall fallback
// can open the local context store / embedding path and spend several seconds
// before provider.send(), making a 25 ms wake test depend on machine load. The
// daemon path never takes that fallback once the context-store owner is
// started. Keep recall deterministic here so a failure means the wake contract
// itself regressed.
vi.mock('../../src/context/memory-recall-client.js', () => ({
  searchLocalMemorySemanticFrontOfTurn: vi.fn(async () => ({
    items: [],
    stats: {
      totalRecords: 0,
      matchedRecords: 0,
      recentSummaryCount: 0,
      durableCandidateCount: 0,
      projectCount: 0,
      stagedEventCount: 0,
      dirtyTargetCount: 0,
      pendingJobCount: 0,
    },
  })),
}));

afterEach(() => vi.unstubAllEnvs());

/**
 * Shared-layer guard for `ProviderActiveWorkSnapshot.backgroundWorkCount`.
 *
 * The runtime gates every send on hasActiveTurnWork() === blockingWorkCount > 0,
 * so a provider reporting a still-running Claude subagent as active work made the
 * runtime queue every new message behind it — the "cannot send while a subagent
 * runs" bug. Turn work is now `activeWorkCount - backgroundWorkCount`.
 *
 * The second test is the one that matters for Codex: a provider that does NOT
 * report backgroundWorkCount (Codex, Qwen, Kimi …) must keep blocking exactly as
 * before, so its just-stabilised idle detection cannot move.
 */
function runtimeWithSnapshot(snapshot: Record<string, unknown> | null) {
  const provider = {
    id: 'test-provider',
    connectionMode: 'local-sdk',
    sessionOwnership: 'shared',
    capabilities: { streaming: true, toolCalling: true },
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    onDelta: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
    getActiveWorkSnapshot: () => snapshot,
  } as any;
  const rt = new TransportSessionRuntime(provider, 'deck_bg');
  (rt as any)._providerSessionId = 'sess-1';
  return rt;
}

const baseSnapshot = {
  status: 'current',
  activeToolCount: 0,
  busyReasons: ['background_monitor'],
  updatedAt: Date.now(),
};

describe('transport runtime — background work does not gate dispatch', () => {
  it('treats work reported as background as NOT turn work (runtime dispatches instead of queueing)', () => {
    // Claude subagent-only window: 1 unit of work, all of it background.
    const rt = runtimeWithSnapshot({ ...baseSnapshot, activeWorkCount: 1, backgroundWorkCount: 1 });

    const snapshot = (rt as any).getActivitySnapshot();

    expect(snapshot.blockingWorkCount).toBe(0); // hasActiveTurnWork() === false → send dispatches
    expect(snapshot.backgroundWorkCount).toBe(1);
    expect(rt.backgroundWorkCount).toBe(1);
    expect(rt.getDiagnosticSnapshot().backgroundWorkCount).toBe(1);
    // The subagent is still surfaced so the UI can show it running.
    expect(snapshot.busyReasons).toContain('background_monitor');
  });

  it('keeps blocking for providers that do not report backgroundWorkCount (Codex/Qwen/Kimi unchanged)', () => {
    // Exactly the shape every other provider emits today — no backgroundWorkCount.
    const rt = runtimeWithSnapshot({ ...baseSnapshot, activeWorkCount: 1 });

    expect((rt as any).getActivitySnapshot().blockingWorkCount).toBeGreaterThan(0);
  });

  it('still blocks on the turn-work remainder when only part of the work is background', () => {
    // e.g. a live tool call (turn work) alongside a backgrounded subagent.
    const rt = runtimeWithSnapshot({ ...baseSnapshot, activeWorkCount: 3, backgroundWorkCount: 1 });

    expect((rt as any).getActivitySnapshot().blockingWorkCount).toBeGreaterThan(0);
  });

  it('keeps runtime tool_running when backgroundSessionStatus is running while allowing immediate dispatch, and preserves idle when omitted', async () => {
    let currentSnapshot: Record<string, unknown> = {
      ...baseSnapshot,
      activeWorkCount: 1,
      backgroundWorkCount: 1,
      backgroundSessionStatus: 'running',
    };
    const statusCallbacks: Array<(sessionId: string, status: { status: string | null }) => void> = [];
    const completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
    const provider = {
      id: 'test-provider',
      connectionMode: 'local-sdk',
      sessionOwnership: 'shared',
      capabilities: { streaming: true, toolCalling: true },
      connect: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn(),
      onDelta: vi.fn(),
      onComplete: (cb: (sessionId: string, message: AgentMessage) => void) => {
        completeCallbacks.push(cb);
        return () => {};
      },
      onError: vi.fn(),
      onStatus: (cb: (sessionId: string, status: { status: string | null }) => void) => {
        statusCallbacks.push(cb);
        return () => {};
      },
      getActiveWorkSnapshot: () => currentSnapshot,
    } as any;
    const rt = new TransportSessionRuntime(provider, 'deck_bg_running');
    rt.setProviderSessionId('sess-1');

    // Simulate background task notification: waiting is promoted to tool_running while blockingWorkCount stays 0.
    statusCallbacks.forEach((cb) => cb('sess-1', { status: 'waiting' }));
    expect(rt.getActivitySnapshot().blockingWorkCount).toBe(0);
    expect(rt.getActivitySnapshot().backgroundKeepsSessionRunning).toBe(true);
    expect(rt.getStatus()).toBe('tool_running');
    expect(rt.send('plain append while bg runs', 'bg-msg-1')).toBe('sent');
    await vi.waitFor(() => expect(provider.send).toHaveBeenCalledTimes(1));

    // When the foreground APPEND turn completes while backgroundSessionStatus === 'running',
    // runtime must stay tool_running (not flash idle).
    completeCallbacks.forEach((cb) => cb('sess-1', {
      id: 'bg-msg-1-done',
      sessionId: 'sess-1',
      kind: 'text',
      role: 'assistant',
      content: 'ack',
      timestamp: Date.now(),
      status: 'complete',
    }));
    expect(rt.getStatus()).toBe('tool_running');

    // Explicit setStatus('idle') / onStatus(null) must not drop below tool_running while backgroundSessionStatus === 'running'.
    (rt as any).setStatus('idle');
    expect(rt.getStatus()).toBe('tool_running');
    statusCallbacks.forEach((cb) => cb('sess-1', { status: null }));
    expect(rt.getStatus()).toBe('tool_running');

    // Once background work finishes, null status cleanly clears back to idle.
    currentSnapshot = {
      ...baseSnapshot,
      activeWorkCount: 0,
      backgroundWorkCount: 0,
      busyReasons: [],
    };
    statusCallbacks.forEach((cb) => cb('sess-1', { status: null }));
    expect(rt.getActivitySnapshot().backgroundKeepsSessionRunning).toBe(false);
    expect(rt.getStatus()).toBe('idle');

    // Regression guard: omitting backgroundSessionStatus keeps Claude Code subagent idle behavior.
    const claudeRt = runtimeWithSnapshot({
      ...baseSnapshot,
      activeWorkCount: 1,
      backgroundWorkCount: 1,
    });
    (claudeRt as any).setStatus('idle');
    expect(claudeRt.getActivitySnapshot().backgroundKeepsSessionRunning).toBe(false);
    expect(claudeRt.getStatus()).toBe('idle');
  });
});

function backgroundSubagentTool(
  status: 'running' | 'complete',
  key = 'codex:route:runtime:child-1',
  includeBackgroundFlag = true,
): ToolCallEvent {
  const terminal = status === 'complete';
  return {
    id: key,
    name: 'Codex Sub-agent',
    status,
    detail: buildSdkSubagentSafeDetail({
      kind: SDK_SUBAGENT_DETAIL_KIND,
      summary: terminal ? 'untrusted terminal summary' : 'untrusted running summary',
      meta: {
        isSdkSubagent: true,
        schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
        provider: SDK_SUBAGENT_PROVIDERS.CODEX_SDK,
        providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_AGENT,
        canonicalKey: key,
        normalizedStatus: terminal ? SDK_SUBAGENT_STATUS.COMPLETE : SDK_SUBAGENT_STATUS.RUNNING,
        active: !terminal,
        terminal,
        ...(includeBackgroundFlag ? { backgrounded: true } : {}),
      },
    }),
  };
}

function wakeRuntime(mode: 'native' | 'runtime') {
  vi.stubEnv('IMCODES_TRANSPORT_CONTEXT_BUDGET_MS', '50');
  const deltaCallbacks: Array<(sessionId: string, delta: never) => void> = [];
  const completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  const errorCallbacks: Array<(sessionId: string, error: never) => void> = [];
  const toolCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  const sends: string[] = [];
  const provider = {
    id: 'wake-test-provider',
    connectionMode: 'local-sdk',
    sessionOwnership: 'shared',
    capabilities: {
      streaming: true,
      toolCalling: true,
      approval: false,
      sessionRestore: true,
      multiTurn: true,
      attachments: false,
      contextSupport: 'degraded-message-side-context-mapping',
      backgroundSubagentWake: mode,
    },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    createSession: vi.fn(async () => 'wake-provider-session'),
    endSession: vi.fn(async () => {}),
    send: vi.fn(async (_sessionId: string, payload: string | { userMessage?: string }) => {
      sends.push(typeof payload === 'string' ? payload : String(payload.userMessage ?? ''));
    }),
    onDelta: (cb: (sessionId: string, delta: never) => void) => { deltaCallbacks.push(cb); return () => {}; },
    onComplete: (cb: (sessionId: string, message: AgentMessage) => void) => { completeCallbacks.push(cb); return () => {}; },
    onError: (cb: (sessionId: string, error: never) => void) => { errorCallbacks.push(cb); return () => {}; },
    onToolCall: (cb: (sessionId: string, tool: ToolCallEvent) => void) => { toolCallbacks.push(cb); return () => {}; },
    getActiveWorkSnapshot: () => ({
      status: 'current',
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
    }),
  } as unknown as TransportProvider;
  const runtime = new TransportSessionRuntime(provider, `deck_wake_${mode}`);
  runtime.setProviderSessionId('wake-provider-session');
  return {
    provider,
    runtime,
    sends,
    emitTool: (tool: ToolCallEvent) => toolCallbacks.forEach((cb) => cb('wake-provider-session', tool)),
    emitComplete: (content: string) => completeCallbacks.forEach((cb) => cb('wake-provider-session', {
      id: `complete-${content}`,
      sessionId: 'wake-provider-session',
      kind: 'text',
      role: 'assistant',
      content,
      timestamp: Date.now(),
      status: 'complete',
    })),
  };
}

describe('transport runtime — background subagent parent wake', () => {
  it('wakes an idle parent exactly once after a subagent observed running becomes terminal', async () => {
    const harness = wakeRuntime(BACKGROUND_SUBAGENT_WAKE_MODES.RUNTIME);
    harness.emitTool(backgroundSubagentTool('running'));
    expect((harness.runtime as any)._activeBackgroundSubagents.size).toBe(1);
    // Terminal payloads from some SDK versions omit the background flag. The
    // runtime must correlate them with the previously observed running child.
    harness.emitTool(backgroundSubagentTool('complete', 'codex:route:runtime:child-1', false));
    expect((harness.runtime as any)._pendingBackgroundSubagentWake.size).toBe(1);

    // The runtime deliberately schedules this wake through a delayed idle
    // handoff. Allow extra headroom when the full daemon/server/web workspace
    // is saturating the 211 validation host.
    await vi.waitFor(() => expect(harness.sends).toHaveLength(1), { timeout: 12_000 });
    expect(harness.sends[0]).toContain(SDK_SUBAGENT_WAKE_PROMPT_HEADER);
    expect(harness.sends[0]).toContain('codex:route:runtime:child-1');
    expect(harness.sends[0]).not.toContain('untrusted terminal summary');
    expect(harness.runtime.getHistory()).toEqual([]);

    // Replayed/duplicated terminal snapshots do not create another turn.
    harness.emitTool(backgroundSubagentTool('complete'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(harness.sends).toHaveLength(1);

    harness.emitComplete('Parent resumed and reported the child result.');
    expect(harness.runtime.getHistory().map((message) => message.content)).toEqual([
      'Parent resumed and reported the child result.',
    ]);
    await harness.runtime.kill();
  });

  it('does not wake from a terminal-only replay that was never observed running', async () => {
    const harness = wakeRuntime(BACKGROUND_SUBAGENT_WAKE_MODES.RUNTIME);
    harness.emitTool(backgroundSubagentTool('complete'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(harness.sends).toEqual([]);
    await harness.runtime.kill();
  });

  it('does not inject a duplicate wake while the parent already has an active turn', async () => {
    const harness = wakeRuntime(BACKGROUND_SUBAGENT_WAKE_MODES.RUNTIME);
    harness.emitTool(backgroundSubagentTool('running'));
    expect(harness.runtime.send('user already woke the parent')).toBe('sent');
    await vi.waitFor(() => expect(harness.sends).toHaveLength(1), { timeout: 4_000 });
    harness.emitTool(backgroundSubagentTool('complete'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(harness.sends).toEqual(['user already woke the parent']);
    harness.emitComplete('Handled while already awake.');
    await harness.runtime.kill();
  });

  it('leaves native wake providers to their retained-query protocol', async () => {
    const harness = wakeRuntime(BACKGROUND_SUBAGENT_WAKE_MODES.NATIVE);
    harness.emitTool(backgroundSubagentTool('running'));
    harness.emitTool(backgroundSubagentTool('complete'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(harness.sends).toEqual([]);
    await harness.runtime.kill();
  });
});
