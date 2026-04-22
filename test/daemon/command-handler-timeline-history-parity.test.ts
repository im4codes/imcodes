import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  readMock,
  readPreferredMock,
} = vi.hoisted(() => ({
  readMock: vi.fn(),
  readPreferredMock: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => []),
  getSession: vi.fn(() => null),
  upsertSession: vi.fn(),
  removeSession: vi.fn(),
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
}));

vi.mock('../../src/agent/tmux.js', () => ({
  sendKeys: vi.fn(),
  sendKeysDelayedEnter: vi.fn(),
  sendRawInput: vi.fn(),
  resizeSession: vi.fn(),
  sendKey: vi.fn(),
  getPaneStartCommand: vi.fn(),
}));

vi.mock('../../src/router/message-router.js', () => ({ routeMessage: vi.fn() }));
vi.mock('../../src/daemon/terminal-streamer.js', () => ({ terminalStreamer: { subscribe: vi.fn(), unsubscribe: vi.fn(), start: vi.fn(), stop: vi.fn() } }));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: vi.fn(), on: vi.fn(() => () => {}), off: vi.fn(), epoch: 5, replay: vi.fn(() => ({ events: [], truncated: false })) } }));
vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: {
    append: vi.fn(),
    read: readMock,
    readPreferred: readPreferredMock,
    clear: vi.fn(),
  },
}));
vi.mock('../../src/daemon/subsession-manager.js', () => ({ startSubSession: vi.fn(), stopSubSession: vi.fn(), rebuildSubSessions: vi.fn(), detectShells: vi.fn().mockResolvedValue([]), readSubSessionResponse: vi.fn(), subSessionName: (id: string) => `deck_sub_${id}` }));
vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({ startP2pRun: vi.fn(), cancelP2pRun: vi.fn(), getP2pRun: vi.fn(() => undefined), listP2pRuns: vi.fn(() => []), serializeP2pRun: vi.fn() }));
vi.mock('../../src/daemon/session-list.js', () => ({ buildSessionList: vi.fn(async () => []) }));
vi.mock('../../src/daemon/repo-handler.js', () => ({ handleRepoCommand: vi.fn() }));
vi.mock('../../src/daemon/file-transfer-handler.js', () => ({ handleFileUpload: vi.fn(), handleFileDownload: vi.fn(), createProjectFileHandle: vi.fn(), lookupAttachment: vi.fn(() => undefined) }));
vi.mock('../../src/daemon/preview-relay.js', () => ({ handlePreviewCommand: vi.fn() }));
vi.mock('../../src/daemon/provider-sessions.js', () => ({ listProviderSessions: vi.fn(() => []) }));
vi.mock('../../src/util/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/util/imc-dir.js', () => ({ ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'), imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`) }));
vi.mock('../../src/daemon/supervision-broker.js', () => ({ supervisionBroker: { decide: vi.fn() } }));
vi.mock('../../src/daemon/supervision-automation.js', () => ({ supervisionAutomation: { init: vi.fn(), setServerLink: vi.fn(), cancelSession: vi.fn(), queueTaskIntent: vi.fn(), updateQueuedTaskIntent: vi.fn(), removeQueuedTaskIntent: vi.fn(), registerTaskIntent: vi.fn(), applySnapshotUpdate: vi.fn() } }));

import { handleWebCommand } from '../../src/daemon/command-handler.js';

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('command-handler timeline.history_request SQLite parity expectations', () => {
  const serverLink = {
    send: vi.fn(),
    sendBinary: vi.fn(),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    readMock.mockReturnValue([]);
    readPreferredMock.mockResolvedValue([
      {
        eventId: 'user-1',
        sessionId: 'deck_proj_brain',
        ts: 100,
        seq: 1,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'user.message',
        payload: { text: 'Question' },
      },
      {
        eventId: 'state-1',
        sessionId: 'deck_proj_brain',
        ts: 101,
        seq: 2,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'session.state',
        payload: { state: 'running' },
      },
      {
        eventId: 'assistant-1',
        sessionId: 'deck_proj_brain',
        ts: 102,
        seq: 3,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'assistant.text',
        payload: { text: 'Answer', streaming: false },
      },
    ]);
  });

  it.skip('should switch timeline.history_request to readPreferred while preserving state interleaving semantics', async () => {
    handleWebCommand({
      type: 'timeline.history_request',
      sessionName: 'deck_proj_brain',
      requestId: 'req-history',
      limit: 2,
    }, serverLink as never);
    await flushAsync();

    expect(readPreferredMock).toHaveBeenCalledWith('deck_proj_brain', { limit: 12, afterTs: undefined, beforeTs: undefined });
    expect(readMock).not.toHaveBeenCalled();
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'timeline.history',
      sessionName: 'deck_proj_brain',
      requestId: 'req-history',
      events: expect.arrayContaining([
        expect.objectContaining({ eventId: 'user-1' }),
        expect.objectContaining({ eventId: 'state-1' }),
        expect.objectContaining({ eventId: 'assistant-1' }),
      ]),
    }));
  });
});
