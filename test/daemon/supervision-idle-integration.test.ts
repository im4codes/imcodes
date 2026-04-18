/**
 * Integration test covering the FULL supervision-on-idle path with the real
 * `timelineEmitter` and real `supervisionAutomation` wired together — previous
 * tests mocked one or the other, so the actual production seam was never
 * exercised.
 *
 * Regression scope: user reports "idle 后依旧不触发任何动作和效果" — after the
 * assistant goes idle, supervision appears to never fire (no "Auto: checking..."
 * note, no broker decision, nothing). Unit tests for `supervisionAutomation`
 * only exercise it via direct `registerTaskIntent` + manual timeline emits, and
 * `command-handler-transport-queue` mocks `supervisionAutomation` entirely, so
 * no test verified the handshake between `handleWebCommand('session.send')` →
 * `registerTaskIntent` → `timelineEmitter.emit('session.state', 'idle')` →
 * `handleTimelineEvent` → `supervisionBroker.decide`.
 *
 * This test runs the real emitter + real automation and mocks only the broker
 * + transport runtime + store, asserting that enabling supervision then sending
 * a message and transitioning to idle does call `supervisionBroker.decide`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SUPERVISION_MODE,
  normalizeSessionSupervisionSnapshot,
} from '../../shared/supervision-config.js';

const {
  getSessionMock,
  upsertSessionMock,
  getTransportRuntimeMock,
  supervisionDecideMock,
  startP2pRunMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  upsertSessionMock: vi.fn(),
  getTransportRuntimeMock: vi.fn(),
  supervisionDecideMock: vi.fn(async () => ({ decision: 'complete', reason: 'looks done', confidence: 0.95 })),
  startP2pRunMock: vi.fn(async () => ({ id: 'p2p-run-stub' })),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => []),
  getSession: getSessionMock,
  upsertSession: upsertSessionMock,
  removeSession: vi.fn(),
  updateSessionState: vi.fn(),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  startProject: vi.fn(),
  stopProject: vi.fn(),
  teardownProject: vi.fn(),
  getTransportRuntime: getTransportRuntimeMock,
  launchTransportSession: vi.fn(),
  isProviderSessionBound: vi.fn(() => false),
  persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: vi.fn(),
  stopTransportRuntimeSession: vi.fn(),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  sendKeys: vi.fn(),
  sendKeysDelayedEnter: vi.fn(),
  sendRawInput: vi.fn(),
  resizeSession: vi.fn(),
  sendKey: vi.fn(),
  getPaneStartCommand: vi.fn(),
}));

vi.mock('../../src/router/message-router.js', () => ({
  routeMessage: vi.fn(),
}));

vi.mock('../../src/daemon/terminal-streamer.js', () => ({
  terminalStreamer: {
    subscribe: vi.fn(() => vi.fn()),
    unsubscribe: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    requestSnapshot: vi.fn(),
    invalidateSize: vi.fn(),
  },
}));

vi.mock('../../src/daemon/subsession-manager.js', () => ({
  startSubSession: vi.fn(),
  stopSubSession: vi.fn(),
  rebuildSubSessions: vi.fn(),
  detectShells: vi.fn().mockResolvedValue([]),
  readSubSessionResponse: vi.fn(),
  subSessionName: (id: string) => `deck_sub_${id}`,
}));

vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({
  startP2pRun: startP2pRunMock,
  cancelP2pRun: vi.fn(),
  getP2pRun: vi.fn(() => ({ id: 'p2p-run-stub', status: 'completed', resultSummary: 'ok\n<!-- P2P_VERDICT: PASS -->' })),
  listP2pRuns: vi.fn(() => []),
  serializeP2pRun: vi.fn(),
}));

vi.mock('../../src/daemon/repo-handler.js', () => ({ handleRepoCommand: vi.fn() }));
vi.mock('../../src/daemon/file-transfer-handler.js', () => ({
  handleFileUpload: vi.fn(),
  handleFileDownload: vi.fn(),
  createProjectFileHandle: vi.fn(),
  lookupAttachment: vi.fn(() => undefined),
}));
vi.mock('../../src/daemon/preview-relay.js', () => ({ handlePreviewCommand: vi.fn() }));
vi.mock('../../src/daemon/provider-sessions.js', () => ({ listProviderSessions: vi.fn(() => []) }));

vi.mock('../../src/daemon/supervision-broker.js', () => ({
  supervisionBroker: { decide: supervisionDecideMock },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/util/imc-dir.js', () => ({
  ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'),
  imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`),
}));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: { append: vi.fn(), read: vi.fn(() => []), clear: vi.fn() },
}));

// Import AFTER mocks — real timelineEmitter, real supervisionAutomation.
const { handleWebCommand } = await import('../../src/daemon/command-handler.js');
const { timelineEmitter } = await import('../../src/daemon/timeline-emitter.js');
const { supervisionAutomation } = await import('../../src/daemon/supervision-automation.js');

const SESSION = 'deck_supervision_idle_brain';
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

function seedSupervisedSession(mode: 'supervised' | 'supervised_audit' = 'supervised') {
  const snapshot = normalizeSessionSupervisionSnapshot({
    mode: mode === 'supervised' ? SUPERVISION_MODE.SUPERVISED : SUPERVISION_MODE.SUPERVISED_AUDIT,
    backend: 'codex-sdk',
    model: 'gpt-5.3-codex-spark',
    timeoutMs: 2_000,
    promptVersion: 'supervision_decision_v1',
    maxParseRetries: 1,
    auditMode: 'audit',
    maxAuditLoops: 2,
    taskRunPromptVersion: 'supervision_continue_v1',
  });
  getSessionMock.mockReturnValue({
    name: SESSION,
    projectName: 'supervision_idle',
    role: 'brain',
    agentType: 'codex-sdk',
    runtimeType: 'transport',
    providerId: 'codex-sdk',
    providerSessionId: SESSION,
    projectDir: '/tmp/supervision-idle',
    state: 'idle',
    transportConfig: { supervision: snapshot },
  });
  return snapshot;
}

describe('supervision → idle → broker integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supervisionAutomation.cancelSession(SESSION);
    supervisionAutomation.init();
    supervisionDecideMock.mockResolvedValue({ decision: 'complete', reason: 'looks done', confidence: 0.95 });
  });

  it('calls supervisionBroker.decide when a supervised session goes idle after a user task', async () => {
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: SESSION,
      send: transportSend,
      pendingCount: 0,
      pendingMessages: [],
      pendingEntries: [],
    });
    seedSupervisedSession('supervised');

    const serverLink = { send: vi.fn(), sendBinary: vi.fn(), sendTimelineEvent: vi.fn(), daemonVersion: '0.1.0' };
    handleWebCommand({
      type: 'session.send',
      session: SESSION,
      text: 'implement the feature',
      commandId: 'cmd-int-1',
    }, serverLink as any);
    await flushAsync();

    // handleSend must have dispatched the message and registered the task intent.
    expect(transportSend).toHaveBeenCalledWith('implement the feature', 'cmd-int-1');
    expect(supervisionAutomation.getActiveRun(SESSION)).toBeTruthy();

    // Now simulate the transport runtime's status flow: streaming → idle.
    timelineEmitter.emit(SESSION, 'assistant.text', {
      text: 'Done — here is what I did.',
      streaming: false,
    });
    timelineEmitter.emit(SESSION, 'session.state', { state: 'running' });
    timelineEmitter.emit(SESSION, 'session.state', { state: 'idle' });

    await waitFor(() => supervisionDecideMock.mock.calls.length > 0, 1_000);

    expect(supervisionDecideMock).toHaveBeenCalledWith(expect.objectContaining({
      taskRequest: 'implement the feature',
      assistantResponse: 'Done — here is what I did.',
    }));
  });

  it('picks up supervision at the next idle even when Auto was enabled mid-turn (no active run yet)', async () => {
    // Simulate: user sent a message BEFORE enabling supervised. There's no active
    // run, but recentTaskCandidates was populated from the user.message and an
    // assistant response has already landed. Enabling supervision then going
    // idle must still trigger the broker through the implicit path.
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: SESSION,
      send: transportSend,
      pendingCount: 0,
      pendingMessages: [],
      pendingEntries: [],
    });
    seedSupervisedSession('supervised');

    // Simulate the user.message + assistant.text that already flowed through
    // the session before supervision was enabled.
    timelineEmitter.emit(SESSION, 'user.message', {
      text: 'fix the failing tests',
      clientMessageId: 'cmd-midturn',
    });
    timelineEmitter.emit(SESSION, 'assistant.text', {
      text: 'Fixed the tests.',
      streaming: false,
    });
    timelineEmitter.emit(SESSION, 'session.state', { state: 'running' });

    // No active run — supervision is enabled on the session record only.
    expect(supervisionAutomation.getActiveRun(SESSION)).toBeUndefined();

    // Now idle fires.
    timelineEmitter.emit(SESSION, 'session.state', { state: 'idle' });

    await waitFor(() => supervisionDecideMock.mock.calls.length > 0, 1_000);
    expect(supervisionDecideMock).toHaveBeenCalledWith(expect.objectContaining({
      taskRequest: 'fix the failing tests',
      assistantResponse: 'Fixed the tests.',
    }));
  });

  it('evaluates immediately when supervision is enabled while the session is already idle with a prior turn', async () => {
    // This is THE regression the user reported: "idle 后依旧不触发任何动作和效果".
    // Sequence:
    //   1. user sends a task (supervision is OFF)
    //   2. assistant replies
    //   3. session transitions to idle
    //   4. user turns ON supervision via the Auto dropdown
    //   5. *** nothing ever happens *** — no idle boundary fires again unless the
    //      user sends another message, so the broker is never consulted.
    // The broker MUST evaluate the most recent turn immediately on enablement
    // (same semantics as the implicit-idle path but triggered by the snapshot
    // transition OFF → supervised instead of the idle transition).
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: SESSION,
      send: vi.fn(() => 'sent'),
      pendingCount: 0,
      pendingMessages: [],
      pendingEntries: [],
    });
    // Start with supervision OFF.
    getSessionMock.mockReturnValue({
      name: SESSION,
      projectName: 'supervision_idle',
      role: 'brain',
      agentType: 'codex-sdk',
      runtimeType: 'transport',
      providerId: 'codex-sdk',
      providerSessionId: SESSION,
      projectDir: '/tmp/supervision-idle',
      state: 'idle',
      transportConfig: { supervision: { mode: SUPERVISION_MODE.OFF } },
    });

    // Simulate a past turn: user message → assistant reply → idle.
    timelineEmitter.emit(SESSION, 'user.message', {
      text: 'refactor the parser',
      clientMessageId: 'cmd-before-enable',
    });
    timelineEmitter.emit(SESSION, 'assistant.text', {
      text: 'Refactored the parser.',
      streaming: false,
    });
    timelineEmitter.emit(SESSION, 'session.state', { state: 'running' });
    timelineEmitter.emit(SESSION, 'session.state', { state: 'idle' });
    await flushAsync();

    expect(supervisionDecideMock).not.toHaveBeenCalled();

    // Now the user flips Auto ON.
    const snapshot = seedSupervisedSession('supervised');
    supervisionAutomation.applySnapshotUpdate(SESSION, snapshot);

    await waitFor(() => supervisionDecideMock.mock.calls.length > 0, 1_000);
    expect(supervisionDecideMock).toHaveBeenCalledWith(expect.objectContaining({
      taskRequest: 'refactor the parser',
      assistantResponse: 'Refactored the parser.',
    }));
  });

  it('emits the visible "Auto: checking..." note and a supervision status before evaluating', async () => {
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: SESSION,
      send: transportSend,
      pendingCount: 0,
      pendingMessages: [],
      pendingEntries: [],
    });
    seedSupervisedSession('supervised');

    // Capture everything the real emitter broadcasts.
    const seen: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = timelineEmitter.on((event) => {
      seen.push({ type: event.type, payload: event.payload });
    });

    const serverLink = { send: vi.fn(), sendBinary: vi.fn(), sendTimelineEvent: vi.fn(), daemonVersion: '0.1.0' };
    handleWebCommand({
      type: 'session.send',
      session: SESSION,
      text: 'ship the fix',
      commandId: 'cmd-note',
    }, serverLink as any);
    await flushAsync();

    timelineEmitter.emit(SESSION, 'assistant.text', { text: 'Shipped.', streaming: false });
    timelineEmitter.emit(SESSION, 'session.state', { state: 'running' });
    timelineEmitter.emit(SESSION, 'session.state', { state: 'idle' });

    await waitFor(() => supervisionDecideMock.mock.calls.length > 0, 1_000);
    unsubscribe();

    // The user must see the status + the "Auto: checking..." note before the
    // decision. Silence on idle is the bug we are guarding against.
    const status = seen.find((e) => e.type === 'agent.status' && e.payload.status === 'supervision_waiting');
    const note = seen.find((e) => e.type === 'assistant.text'
      && typeof e.payload.text === 'string'
      && (e.payload.text as string).includes('Auto: checking'));
    expect(status).toBeTruthy();
    expect(note).toBeTruthy();
  });

  it('still evaluates when idle arrives before the final assistant text for an active supervised run', async () => {
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: SESSION,
      send: transportSend,
      pendingCount: 0,
      pendingMessages: [],
      pendingEntries: [],
    });
    seedSupervisedSession('supervised');

    const serverLink = { send: vi.fn(), sendBinary: vi.fn(), sendTimelineEvent: vi.fn(), daemonVersion: '0.1.0' };
    handleWebCommand({
      type: 'session.send',
      session: SESSION,
      text: 'finish the refactor',
      commandId: 'cmd-race-active',
    }, serverLink as any);
    await flushAsync();

    timelineEmitter.emit(SESSION, 'session.state', { state: 'running' });
    timelineEmitter.emit(SESSION, 'session.state', { state: 'idle' });
    expect(supervisionDecideMock).not.toHaveBeenCalled();

    timelineEmitter.emit(SESSION, 'assistant.text', {
      text: 'Refactor finished.',
      streaming: false,
    });

    await waitFor(() => supervisionDecideMock.mock.calls.length > 0, 1_000);
    expect(supervisionDecideMock).toHaveBeenCalledWith(expect.objectContaining({
      taskRequest: 'finish the refactor',
      assistantResponse: 'Refactor finished.',
    }));
  });

  it('still evaluates when idle arrives before the final assistant text for an implicit supervised run', async () => {
    seedSupervisedSession('supervised');

    timelineEmitter.emit(SESSION, 'user.message', {
      text: 'fix the queue bug',
      clientMessageId: 'cmd-race-implicit',
    });
    timelineEmitter.emit(SESSION, 'session.state', { state: 'running' });
    timelineEmitter.emit(SESSION, 'session.state', { state: 'idle' });
    expect(supervisionDecideMock).not.toHaveBeenCalled();

    timelineEmitter.emit(SESSION, 'assistant.text', {
      text: 'Queue bug fixed.',
      streaming: false,
    });

    await waitFor(() => supervisionDecideMock.mock.calls.length > 0, 1_000);
    expect(supervisionDecideMock).toHaveBeenCalledWith(expect.objectContaining({
      taskRequest: 'fix the queue bug',
      assistantResponse: 'Queue bug fixed.',
    }));
  });
});
