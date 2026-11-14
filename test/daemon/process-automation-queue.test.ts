import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SESSION_STATE_DECISION_REASON_SERVER_LINK_RESYNC,
} from '../../shared/session-activity-types.js';
import { MEMORY_MCP_SEND_DELIVERY_MODES } from '../../shared/memory-mcp-contracts.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const { sendKeysMock, getSessionMock, listSessionsMock } = vi.hoisted(() => ({
  sendKeysMock: vi.fn(async () => {}),
  getSessionMock: vi.fn<() => SessionRecord | null>(),
  listSessionsMock: vi.fn<() => SessionRecord[]>(() => []),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: listSessionsMock,
  getSession: getSessionMock,
  upsertSession: vi.fn(),
  removeSession: vi.fn(),
  updateSessionState: vi.fn(),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  startProject: vi.fn(),
  stopProject: vi.fn(),
  teardownProject: vi.fn(),
  getTransportRuntime: vi.fn(() => undefined),
  launchTransportSession: vi.fn(),
  isProviderSessionBound: vi.fn(() => false),
  persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: vi.fn(),
  stopTransportRuntimeSession: vi.fn(),
  drainTransportResendQueueForDispatch: vi.fn(),
  ensureTransportRuntimeForPendingResend: vi.fn(),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  BACKEND: 'tmux',
  sendKeys: sendKeysMock,
  sendKeysDelayedEnter: sendKeysMock,
  sendRawInput: vi.fn(),
  resizeSession: vi.fn(),
  sendKey: vi.fn(),
  getPaneStartCommand: vi.fn(),
  preparePrivateInputWriter: vi.fn(),
}));

vi.mock('../../src/router/message-router.js', () => ({ routeMessage: vi.fn() }));
vi.mock('../../src/daemon/terminal-streamer.js', () => ({
  terminalStreamer: { subscribe: vi.fn(), unsubscribe: vi.fn(), start: vi.fn(), stop: vi.fn() },
}));
vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: { append: vi.fn(), read: vi.fn(() => []), clear: vi.fn(), readPreferred: vi.fn(async () => []) },
  TimelinePreferredReadError: class extends Error {},
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
  startP2pRun: vi.fn(),
  cancelP2pRun: vi.fn(),
  getP2pRun: vi.fn(() => undefined),
  listP2pRuns: vi.fn(() => []),
  serializeP2pRun: vi.fn(),
}));
vi.mock('../../src/daemon/session-list.js', () => ({ buildSessionList: vi.fn(async () => []) }));
vi.mock('../../src/daemon/repo-handler.js', () => ({ handleRepoCommand: vi.fn() }));
vi.mock('../../src/daemon/file-transfer-handler.js', () => ({
  handleFileUpload: vi.fn(),
  handleFileUploadFetch: vi.fn(),
  handleFileDownload: vi.fn(),
  createProjectFileHandle: vi.fn(),
  createProjectFileHandleFromValidatedPath: vi.fn(),
  tryCreateProjectFileHandle: vi.fn(),
  lookupAttachment: vi.fn(() => undefined),
}));
vi.mock('../../src/daemon/preview-relay.js', () => ({ handlePreviewCommand: vi.fn() }));
vi.mock('../../src/daemon/provider-sessions.js', () => ({ listProviderSessions: vi.fn(() => []) }));
vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/util/imc-dir.js', () => ({
  ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'),
  imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`),
}));
vi.mock('../../src/daemon/supervision-broker.js', () => ({ supervisionBroker: { decide: vi.fn() } }));
vi.mock('../../src/daemon/supervision-automation.js', () => ({
  supervisionAutomation: {
    init: vi.fn(),
    setServerLink: vi.fn(),
    cancelSession: vi.fn(),
    queueTaskIntent: vi.fn(),
    updateQueuedTaskIntent: vi.fn(),
    removeQueuedTaskIntent: vi.fn(),
    registerTaskIntent: vi.fn(),
    applySnapshotUpdate: vi.fn(),
  },
}));
vi.mock('../../src/daemon/git-remote-clone.js', () => ({
  maybeCloneGitRemoteToDirectory: vi.fn(),
}));

import {
  clearProcessAutomationQueuesForTest,
  getProcessAutomationQueueDepth,
  sendProcessSessionMessageForAutomation,
} from '../../src/daemon/command-handler.js';
import { dispatchSessionMessage } from '../../src/daemon/session-dispatch.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { drainQueue } from '../../src/daemon/hook-server.js';

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

function makeProcessSession(state: SessionRecord['state']): SessionRecord {
  return {
    name: 'deck_proj_proc',
    projectName: 'proj',
    role: 'brain',
    agentType: 'shell',
    runtimeType: 'process',
    projectDir: '/tmp/proj',
    state,
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('sendProcessSessionMessageForAutomation queue-when-busy', () => {
  let sessionState: SessionRecord['state'];

  beforeEach(() => {
    vi.clearAllMocks();
    clearProcessAutomationQueuesForTest();
    sessionState = 'running';
    getSessionMock.mockImplementation(() => makeProcessSession(sessionState));
    listSessionsMock.mockImplementation(() => [makeProcessSession(sessionState)]);
  });

  it('queues messages for running process sessions under deliveryMode=queue and drains one per idle transition FIFO', async () => {
    const onTyped1 = vi.fn();
    const onTyped2 = vi.fn();

    const r1 = await sendProcessSessionMessageForAutomation('deck_proj_proc', 'first queued msg', {
      deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.QUEUE,
      verbatim: true,
      onTyped: onTyped1,
    });
    const r2 = await dispatchSessionMessage(makeProcessSession('running'), 'second queued msg', {
      dispatchId: 'd_q2' as never,
      messageId: 'm_q2' as never,
      deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.QUEUE,
      command: true,
    });

    expect(r1).toBe('queued');
    expect(r2).toBe('queued');
    expect(getProcessAutomationQueueDepth('deck_proj_proc')).toBe(2);
    expect(sendKeysMock).not.toHaveBeenCalled();

    // Server-link resync idle snapshot must NOT drain queued messages prematurely.
    timelineEmitter.emit('deck_proj_proc', 'session.state', {
      state: 'idle',
      decisionReason: SESSION_STATE_DECISION_REASON_SERVER_LINK_RESYNC,
    });
    await flushAsync();
    expect(sendKeysMock).not.toHaveBeenCalled();
    expect(getProcessAutomationQueueDepth('deck_proj_proc')).toBe(2);

    // First real idle edge (even with concurrent drainQueue call) drains ONLY first queued item.
    sessionState = 'idle';
    timelineEmitter.emit('deck_proj_proc', 'session.state', { state: 'idle' });
    void drainQueue('deck_proj_proc');
    await flushAsync();

    expect(sendKeysMock).toHaveBeenCalledTimes(1);
    expect(sendKeysMock.mock.calls[0]).toEqual(
      expect.arrayContaining(['deck_proj_proc', 'first queued msg']),
    );
    expect(onTyped1).toHaveBeenCalledTimes(1);
    expect(onTyped2).not.toHaveBeenCalled();
    expect(getProcessAutomationQueueDepth('deck_proj_proc')).toBe(1);

    // Second real idle edge drains second queued item.
    timelineEmitter.emit('deck_proj_proc', 'session.state', { state: 'idle' });
    await flushAsync();

    expect(sendKeysMock).toHaveBeenCalledTimes(2);
    expect(sendKeysMock.mock.calls[1]).toEqual(
      expect.arrayContaining(['deck_proj_proc', 'second queued msg']),
    );
    expect(getProcessAutomationQueueDepth('deck_proj_proc')).toBe(0);
  });

  it('delivers immediately when process session is idle even with deliveryMode=queue, and skips cancelled beforeTyping items cleanly', async () => {
    sessionState = 'idle';
    const immediate = await sendProcessSessionMessageForAutomation('deck_proj_proc', 'idle immediate', {
      deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.QUEUE,
      verbatim: true,
    });
    expect(immediate).toBe('sent');
    expect(sendKeysMock).toHaveBeenCalledTimes(1);
    expect(getProcessAutomationQueueDepth('deck_proj_proc')).toBe(0);

    // Now enqueue a cancelled gate item followed by a valid item while running.
    sessionState = 'running';
    let allowFirst = true;
    await sendProcessSessionMessageForAutomation('deck_proj_proc', 'stale skipped', {
      deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.QUEUE,
      verbatim: true,
      beforeTyping: () => allowFirst,
    });
    await sendProcessSessionMessageForAutomation('deck_proj_proc', 'valid follower', {
      deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.QUEUE,
      verbatim: true,
    });
    allowFirst = false;

    sessionState = 'idle';
    timelineEmitter.emit('deck_proj_proc', 'session.state', { state: 'idle' });
    await flushAsync();

    expect(sendKeysMock).toHaveBeenCalledTimes(2);
    expect(sendKeysMock.mock.calls[1]).toEqual(
      expect.arrayContaining(['deck_proj_proc', 'valid follower']),
    );
    expect(getProcessAutomationQueueDepth('deck_proj_proc')).toBe(0);
  });
});
