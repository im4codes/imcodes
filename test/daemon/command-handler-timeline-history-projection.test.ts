import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getSessionMock,
  upsertSessionMock,
  readPreferredMock,
  exportOpenCodeSessionMock,
  buildTimelineEventsFromOpenCodeExportMock,
  buildSessionListMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  upsertSessionMock: vi.fn(),
  readPreferredMock: vi.fn(),
  exportOpenCodeSessionMock: vi.fn(),
  buildTimelineEventsFromOpenCodeExportMock: vi.fn(),
  buildSessionListMock: vi.fn(async () => []),
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
vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: vi.fn(), on: vi.fn(() => () => {}), off: vi.fn(), epoch: 99, replay: vi.fn(() => ({ events: [], truncated: false })) } }));
vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: {
    append: vi.fn(),
    read: vi.fn(() => []),
    readPreferred: readPreferredMock,
    readCompletedTextTail: vi.fn(),
    readByTypesPreferred: vi.fn(),
    getLatest: vi.fn(() => null),
    getLatestPreferred: vi.fn(() => null),
    clear: vi.fn(),
  },
}));
vi.mock('../../src/daemon/subsession-manager.js', () => ({ startSubSession: vi.fn(), stopSubSession: vi.fn(), rebuildSubSessions: vi.fn(), detectShells: vi.fn().mockResolvedValue([]), readSubSessionResponse: vi.fn(), subSessionName: (id: string) => `deck_sub_${id}` }));
vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({ startP2pRun: vi.fn(), cancelP2pRun: vi.fn(), getP2pRun: vi.fn(() => undefined), listP2pRuns: vi.fn(() => []), serializeP2pRun: vi.fn() }));
vi.mock('../../src/daemon/session-list.js', () => ({ buildSessionList: buildSessionListMock }));
vi.mock('../../src/daemon/repo-handler.js', () => ({ handleRepoCommand: vi.fn() }));
vi.mock('../../src/daemon/file-transfer-handler.js', () => ({ handleFileUpload: vi.fn(), handleFileDownload: vi.fn(), createProjectFileHandle: vi.fn(), lookupAttachment: vi.fn(() => undefined) }));
vi.mock('../../src/daemon/preview-relay.js', () => ({ handlePreviewCommand: vi.fn() }));
vi.mock('../../src/daemon/provider-sessions.js', () => ({ listProviderSessions: vi.fn(() => []) }));
vi.mock('../../src/util/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/util/imc-dir.js', () => ({ ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'), imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`) }));
vi.mock('../../src/daemon/supervision-broker.js', () => ({ supervisionBroker: { decide: vi.fn() } }));
vi.mock('../../src/daemon/supervision-automation.js', () => ({ supervisionAutomation: { init: vi.fn(), setServerLink: vi.fn(), cancelSession: vi.fn(), queueTaskIntent: vi.fn(), updateQueuedTaskIntent: vi.fn(), removeQueuedTaskIntent: vi.fn(), registerTaskIntent: vi.fn(), applySnapshotUpdate: vi.fn() } }));
vi.mock('../../src/daemon/opencode-history.js', () => ({
  exportOpenCodeSession: exportOpenCodeSessionMock,
  buildTimelineEventsFromOpenCodeExport: buildTimelineEventsFromOpenCodeExportMock,
  discoverLatestOpenCodeSessionId: vi.fn(),
}));

import { handleWebCommand } from '../../src/daemon/command-handler.js';

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('command-handler timeline history with SQLite-preferred reads', () => {
  const serverLink = {
    send: vi.fn(),
    sendBinary: vi.fn(),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockReturnValue(undefined);
    buildTimelineEventsFromOpenCodeExportMock.mockReturnValue([]);
    exportOpenCodeSessionMock.mockResolvedValue({});
  });

  it('uses readPreferred and preserves substantive budgeting plus session.state interleaving', async () => {
    readPreferredMock.mockResolvedValue([
      { eventId: 's0', sessionId: 'deck_hist', ts: 1000, seq: 1, epoch: 1, source: 'daemon', confidence: 'high', type: 'session.state', payload: { state: 'idle' } },
      { eventId: 'u1', sessionId: 'deck_hist', ts: 1010, seq: 2, epoch: 1, source: 'daemon', confidence: 'high', type: 'user.message', payload: { text: 'hello' } },
      { eventId: 's1', sessionId: 'deck_hist', ts: 1020, seq: 3, epoch: 1, source: 'daemon', confidence: 'high', type: 'session.state', payload: { state: 'running' } },
      { eventId: 'a1', sessionId: 'deck_hist', ts: 1030, seq: 4, epoch: 1, source: 'daemon', confidence: 'high', type: 'assistant.text', payload: { text: 'world', streaming: false } },
    ]);

    handleWebCommand({
      type: 'timeline.history_request',
      sessionName: 'deck_hist',
      requestId: 'hist-1',
      limit: 2,
    }, serverLink as any);
    await flushAsync();

    expect(readPreferredMock).toHaveBeenCalledWith('deck_hist', { limit: 12, afterTs: undefined, beforeTs: undefined });
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'timeline.history',
      sessionName: 'deck_hist',
      requestId: 'hist-1',
      epoch: 99,
      events: [
        expect.objectContaining({ eventId: 'u1' }),
        expect.objectContaining({ eventId: 's1' }),
        expect.objectContaining({ eventId: 'a1' }),
      ],
    }));
  });

  it('keeps existing OpenCode synthesis/replacement behavior after SQLite-backed base retrieval', async () => {
    readPreferredMock.mockResolvedValue([
      { eventId: 's0', sessionId: 'deck_oc', ts: 1000, seq: 1, epoch: 1, source: 'daemon', confidence: 'high', type: 'session.state', payload: { state: 'idle' } },
    ]);
    getSessionMock.mockReturnValue({
      name: 'deck_oc',
      agentType: 'opencode',
      projectDir: '/tmp/project',
      opencodeSessionId: 'oc-1',
    });
    buildTimelineEventsFromOpenCodeExportMock.mockReturnValue([
      { eventId: 'u1', sessionId: 'deck_oc', ts: 1010, seq: 1, epoch: 99, source: 'daemon', confidence: 'high', type: 'user.message', payload: { text: 'hi' } },
      { eventId: 'a1', sessionId: 'deck_oc', ts: 1020, seq: 2, epoch: 99, source: 'daemon', confidence: 'high', type: 'assistant.text', payload: { text: 'hello', streaming: false } },
    ]);

    handleWebCommand({
      type: 'timeline.history_request',
      sessionName: 'deck_oc',
      requestId: 'hist-oc',
      limit: 5,
    }, serverLink as any);
    await flushAsync();

    expect(readPreferredMock).toHaveBeenCalledWith('deck_oc', { limit: 30, afterTs: undefined, beforeTs: undefined });
    expect(exportOpenCodeSessionMock).toHaveBeenCalledWith('/tmp/project', 'oc-1');
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'timeline.history',
      sessionName: 'deck_oc',
      requestId: 'hist-oc',
      events: [
        expect.objectContaining({ eventId: 'u1' }),
        expect.objectContaining({ eventId: 'a1' }),
      ],
    }));
  });
});
