/**
 * tsk_f2a967730b: the daemon's terminal subscriber has two outbound channels -
 * raw PTY bytes (batched for up to RAW_BATCH_FLUSH_MS, binary frames) and
 * snapshots / control messages (immediate, JSON). Bytes forwarded BEFORE a
 * snapshot were still waiting in the batch when the snapshot left, so they
 * reached the browser after it: applied on top of a screen that already
 * reflected them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { subscribeMock, scheduleResizeSnapshotMock, invalidateSizeMock, resizeSessionMock, getSessionMock } = vi.hoisted(() => ({
  subscribeMock: vi.fn(),
  scheduleResizeSnapshotMock: vi.fn(),
  invalidateSizeMock: vi.fn(),
  resizeSessionMock: vi.fn().mockResolvedValue(undefined),
  getSessionMock: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => []),
  getSession: getSessionMock,
  upsertSession: vi.fn(),
  removeSession: vi.fn(),
  updateSessionState: vi.fn(),
}));
vi.mock('../../src/agent/session-manager.js', () => ({
  startProject: vi.fn(), stopProject: vi.fn(), teardownProject: vi.fn(),
  getTransportRuntime: vi.fn(() => undefined), launchTransportSession: vi.fn(), isProviderSessionBound: vi.fn(() => false),
  persistSessionRecord: vi.fn(), relaunchSessionWithSettings: vi.fn(), stopTransportRuntimeSession: vi.fn(),
}));
vi.mock('../../src/agent/tmux.js', () => ({
  sendKeys: vi.fn(), sendKeysDelayedEnter: vi.fn(), sendRawInput: vi.fn(), resizeSession: resizeSessionMock,
  sendKey: vi.fn(), getPaneStartCommand: vi.fn(),
}));
vi.mock('../../src/router/message-router.js', () => ({ routeMessage: vi.fn() }));
vi.mock('../../src/daemon/terminal-streamer.js', () => ({
  terminalStreamer: {
    subscribe: subscribeMock, unsubscribe: vi.fn(), start: vi.fn(), stop: vi.fn(),
    invalidateSize: invalidateSizeMock, scheduleResizeSnapshot: scheduleResizeSnapshotMock, requestSnapshot: vi.fn(),
  },
}));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: vi.fn(), on: vi.fn(() => () => {}), off: vi.fn(), epoch: 0, replay: vi.fn(() => ({ events: [], truncated: false })) } }));
vi.mock('../../src/daemon/timeline-store.js', () => ({ timelineStore: { append: vi.fn(), read: vi.fn(() => []), clear: vi.fn() } }));
vi.mock('../../src/daemon/subsession-manager.js', () => ({ startSubSession: vi.fn(), stopSubSession: vi.fn(), rebuildSubSessions: vi.fn(), detectShells: vi.fn().mockResolvedValue([]), readSubSessionResponse: vi.fn(), subSessionName: (id: string) => `deck_sub_${id}` }));
vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({ startP2pRun: vi.fn(), cancelP2pRun: vi.fn(), getP2pRun: vi.fn(() => undefined), listP2pRuns: vi.fn(() => []), serializeP2pRun: vi.fn() }));
vi.mock('../../src/daemon/session-list.js', () => ({ buildSessionList: vi.fn(async () => []) }));
vi.mock('../../src/daemon/repo-handler.js', () => ({ handleRepoCommand: vi.fn() }));
vi.mock('../../src/daemon/file-transfer-handler.js', () => ({ handleFileUpload: vi.fn(), handleFileUploadFetch: vi.fn(), handleFileDownload: vi.fn(), createProjectFileHandle: vi.fn(), createProjectFileHandleFromValidatedPath: vi.fn(), tryCreateProjectFileHandle: vi.fn(), lookupAttachment: vi.fn(() => undefined) }));
vi.mock('../../src/daemon/preview-relay.js', () => ({ handlePreviewCommand: vi.fn() }));
vi.mock('../../src/daemon/provider-sessions.js', () => ({ listProviderSessions: vi.fn(() => []) }));
vi.mock('../../src/util/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/util/imc-dir.js', () => ({ ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'), imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`) }));
vi.mock('../../src/daemon/supervision-broker.js', () => ({ supervisionBroker: { decide: vi.fn() } }));
vi.mock('../../src/daemon/supervision-automation.js', () => ({ supervisionAutomation: { init: vi.fn(), setServerLink: vi.fn(), cancelSession: vi.fn(), queueTaskIntent: vi.fn(), updateQueuedTaskIntent: vi.fn(), removeQueuedTaskIntent: vi.fn(), registerTaskIntent: vi.fn(), applySnapshotUpdate: vi.fn() } }));

import { handleWebCommand } from '../../src/daemon/command-handler.js';
import type { StreamSubscriber } from '../../src/daemon/terminal-streamer.js';
import { TERMINAL_CONTROL } from '../../shared/terminal-protocol.js';

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const SESSION = 'deck_e2eorder_w1';

describe('daemon terminal subscriber keeps its two channels in order', () => {
  const sent: Array<{ channel: 'binary' | 'json'; value: unknown }> = [];
  const serverLink = {
    send: vi.fn((value: unknown) => { sent.push({ channel: 'json', value }); }),
    sendBinary: vi.fn((value: unknown) => { sent.push({ channel: 'binary', value }); }),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
  };
  let subscriber: StreamSubscriber;

  beforeEach(() => {
    vi.useRealTimers();
    sent.length = 0;
    vi.clearAllMocks();
    getSessionMock.mockReturnValue({ name: SESSION, agentType: 'shell', runtimeType: 'process' });
    subscribeMock.mockImplementation((sub: StreamSubscriber) => { subscriber = sub; return () => {}; });
    handleWebCommand({ type: 'terminal.subscribe', session: SESSION, raw: true }, serverLink as never);
    expect(subscriber).toBeDefined();
  });

  const frame = (marker: string) => ({ sessionName: SESSION, timestamp: 1, lines: [[0, marker]], cols: 80, rows: 1, fullFrame: true, snapshotRequested: true });

  it('delivers raw bytes forwarded before a snapshot BEFORE that snapshot', () => {
    subscriber.sendRaw!(Buffer.from('older-bytes'));
    subscriber.send(frame('snapshot'));
    const order = sent.map((entry) => (entry.channel === 'binary' ? 'raw' : (entry.value as { type: string }).type));
    expect(order).toEqual(['raw', 'terminal_update']);
    expect(Buffer.from(sent[0]!.value as Buffer).toString()).toContain('older-bytes');
  });

  it('does the same for a control message (a reset must not be overtaken)', () => {
    subscriber.sendRaw!(Buffer.from('older-bytes'));
    subscriber.sendControl!({ type: TERMINAL_CONTROL.STREAM_RESET, session: SESSION, reason: 'rebind' });
    expect(sent.map((entry) => entry.channel)).toEqual(['binary', 'json']);
  });

  it('bytes forwarded after the snapshot still follow it, and nothing is flushed twice', async () => {
    subscriber.sendRaw!(Buffer.from('A'));
    subscriber.send(frame('snapshot'));
    subscriber.sendRaw!(Buffer.from('B'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const order = sent.map((entry) => (entry.channel === 'binary' ? Buffer.from(entry.value as Buffer).toString().slice(-1) : 'snapshot'));
    expect(order).toEqual(['A', 'snapshot', 'B']);
  });

  it('a resize re-syncs the pane once the new geometry has settled', async () => {
    handleWebCommand({ type: 'session.resize', sessionName: SESSION, cols: 120, rows: 40 }, serverLink as never);
    await flushAsync();
    await flushAsync();
    expect(resizeSessionMock).toHaveBeenCalledWith(SESSION, 119, 40);
    expect(invalidateSizeMock).toHaveBeenCalledWith(SESSION);
    expect(scheduleResizeSnapshotMock).toHaveBeenCalledWith(SESSION);
  });
});
