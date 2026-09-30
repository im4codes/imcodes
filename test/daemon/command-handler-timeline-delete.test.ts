/**
 * Owner report: "右键删除消息删不掉". The daemon side of the delete:
 *  - looked the event up in the ring buffer, then tail-scanned 5000 JSONL events
 *    SYNCHRONOUSLY on the main thread, and answered "Message not found" for anything
 *    older (or that the web only held in its cache / a history page);
 *  - only ever hid the FIRST event of a merged assistant block;
 *  - dropped a delete issued within 5s of sending (the user.message dedup);
 *  - never logged, and silently returned on a malformed request.
 * These tests run the REAL TimelineEmitter (ring buffer + merge) with an in-memory
 * stand-in for the JSONL append so persistence/restart can be asserted too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TIMELINE_DELETE_ERROR_CODES,
  TIMELINE_DELETE_MAX_EVENT_IDS,
  TIMELINE_MESSAGES,
  TIMELINE_USER_DELETED_PAYLOAD_KEY,
} from '../../shared/timeline-protocol.js';
import type { TimelineEvent } from '../../src/shared/timeline/types.js';

const { getSessionMock, persisted, readMock, loggerMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  persisted: [] as unknown[],
  readMock: vi.fn(() => []),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => []),
  getSession: getSessionMock,
  upsertSession: vi.fn(),
  removeSession: vi.fn(),
  updateSessionState: vi.fn(),
}));
vi.mock('../../src/agent/session-manager.js', () => ({
  startProject: vi.fn(), stopProject: vi.fn(), teardownProject: vi.fn(), getTransportRuntime: vi.fn(() => undefined),
  launchTransportSession: vi.fn(), isProviderSessionBound: vi.fn(() => false), persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: vi.fn(), stopTransportRuntimeSession: vi.fn(),
}));
vi.mock('../../src/agent/tmux.js', () => ({ sendKeys: vi.fn(), sendKeysDelayedEnter: vi.fn(), sendRawInput: vi.fn(), resizeSession: vi.fn(), sendKey: vi.fn(), getPaneStartCommand: vi.fn() }));
vi.mock('../../src/router/message-router.js', () => ({ routeMessage: vi.fn() }));
vi.mock('../../src/daemon/terminal-streamer.js', () => ({ terminalStreamer: { subscribe: vi.fn(), unsubscribe: vi.fn(), start: vi.fn(), stop: vi.fn() } }));
vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: {
    append: vi.fn((event: unknown) => { persisted.push(event); return Promise.resolve(); }),
    read: readMock,
    getLatest: vi.fn(() => null),
    clear: vi.fn(),
    truncate: vi.fn(),
    cleanup: vi.fn(),
  },
}));
vi.mock('../../src/daemon/subsession-manager.js', () => ({ startSubSession: vi.fn(), stopSubSession: vi.fn(), rebuildSubSessions: vi.fn(), detectShells: vi.fn().mockResolvedValue([]), readSubSessionResponse: vi.fn(), subSessionName: (id: string) => `deck_sub_${id}` }));
vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({ startP2pRun: vi.fn(), cancelP2pRun: vi.fn(), getP2pRun: vi.fn(() => undefined), listP2pRuns: vi.fn(() => []), serializeP2pRun: vi.fn() }));
vi.mock('../../src/daemon/session-list.js', () => ({ buildSessionList: vi.fn(async () => []) }));
vi.mock('../../src/daemon/repo-handler.js', () => ({ handleRepoCommand: vi.fn() }));
vi.mock('../../src/daemon/file-transfer-handler.js', () => ({ handleFileUpload: vi.fn(), handleFileUploadFetch: vi.fn(), handleFileDownload: vi.fn(), createProjectFileHandle: vi.fn(), createProjectFileHandleFromValidatedPath: vi.fn(), tryCreateProjectFileHandle: vi.fn(), lookupAttachment: vi.fn(() => undefined) }));
vi.mock('../../src/daemon/preview-relay.js', () => ({ handlePreviewCommand: vi.fn() }));
vi.mock('../../src/daemon/provider-sessions.js', () => ({ listProviderSessions: vi.fn(() => []) }));
vi.mock('../../src/util/logger.js', () => ({ default: loggerMock }));
vi.mock('../../src/util/imc-dir.js', () => ({ ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'), imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`) }));
vi.mock('../../src/daemon/supervision-broker.js', () => ({ supervisionBroker: { decide: vi.fn() } }));
vi.mock('../../src/daemon/supervision-automation.js', () => ({ supervisionAutomation: { init: vi.fn(), setServerLink: vi.fn(), cancelSession: vi.fn(), queueTaskIntent: vi.fn(), updateQueuedTaskIntent: vi.fn(), removeQueuedTaskIntent: vi.fn(), registerTaskIntent: vi.fn(), applySnapshotUpdate: vi.fn() } }));

import { handleWebCommand } from '../../src/daemon/command-handler.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { mergeTimelineEvents } from '../../src/shared/timeline/merge.js';

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const SESSION = 'deck_proj_brain';
const serverLink = { send: vi.fn(), sendBinary: vi.fn(), sendTimelineEvent: vi.fn(), daemonVersion: '0.1.0' };

function del(extra: Record<string, unknown>, commandId = `cmd-${Math.random().toString(16).slice(2)}`) {
  handleWebCommand({ type: TIMELINE_MESSAGES.DELETE, sessionName: SESSION, commandId, ...extra }, serverLink as never);
  return commandId;
}
function acksFor(commandId: string): Array<Record<string, unknown>> {
  return serverLink.send.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((msg) => msg.type === 'command.ack' && msg.commandId === commandId);
}
const buffered = (sessionName = SESSION): TimelineEvent[] => timelineEmitter.getBufferedEvents(sessionName);
const byId = (id: string, sessionName = SESSION): TimelineEvent | undefined => buffered(sessionName).find((e) => e.eventId === id);

describe('timeline.delete (daemon)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persisted.length = 0;
    getSessionMock.mockReset();
    getSessionMock.mockReturnValue({ name: SESSION, projectName: 'proj', role: 'brain', agentType: 'claude-code', runtimeType: 'process', state: 'idle' });
  });

  it('hides a recent message with a durable, sticky tombstone and acks accepted', async () => {
    const original = timelineEmitter.emit(SESSION, 'user.message', { text: 'recent secret' }, { eventId: 'evt-recent', allowDuplicate: true } as never)!;
    persisted.length = 0;
    const id = del({ eventId: original.eventId });
    await flushAsync();

    const tomb = byId('evt-recent')!;
    expect(tomb.hidden).toBe(true);
    expect(tomb.payload[TIMELINE_USER_DELETED_PAYLOAD_KEY]).toBe(true);
    expect(tomb.payload.streaming).toBe(false);
    expect(persisted.filter((e) => (e as TimelineEvent).eventId === 'evt-recent' && (e as TimelineEvent).hidden === true)).toHaveLength(1);
    expect(acksFor(id)).toEqual([expect.objectContaining({ status: 'accepted' })]);
  });

  it('deletes a message older than the ring buffer / 5000-event JSONL window without reading the store', async () => {
    // The daemon holds nothing for this id (it is only in the web cache / an older history page).
    expect(byId('evt-ancient')).toBeUndefined();
    const id = del({ eventId: 'evt-ancient', eventTypes: { 'evt-ancient': 'user.message' } });
    await flushAsync();

    expect(readMock).not.toHaveBeenCalled(); // no synchronous 5000-row tail scan on the main thread
    const tomb = byId('evt-ancient')!;
    expect(tomb).toBeDefined();
    expect(tomb.type).toBe('user.message');
    expect(tomb.hidden).toBe(true);
    expect(tomb.payload[TIMELINE_USER_DELETED_PAYLOAD_KEY]).toBe(true);
    expect(persisted).toContainEqual(expect.objectContaining({ eventId: 'evt-ancient', hidden: true }));
    expect(acksFor(id)).toEqual([expect.objectContaining({ status: 'accepted' })]);
  });

  it('hides EVERY stored event of a merged assistant block, not just the first', async () => {
    for (const [eid, text] of [['evt-a1', 'first segment'], ['evt-a2', 'second segment'], ['evt-a3', 'third segment']] as const) {
      timelineEmitter.emit(SESSION, 'assistant.text', { text, streaming: false }, { eventId: eid });
    }
    const id = del({ eventId: 'evt-a1', eventIds: ['evt-a1', 'evt-a2', 'evt-a3'] });
    await flushAsync();

    for (const eid of ['evt-a1', 'evt-a2', 'evt-a3']) expect(byId(eid)?.hidden).toBe(true);
    expect(acksFor(id)).toEqual([expect.objectContaining({ status: 'accepted' })]);
  });

  it('a message deleted while it is still streaming stays deleted when the terminal update arrives', async () => {
    timelineEmitter.emit(SESSION, 'assistant.text', { text: 'partial', streaming: true }, { eventId: 'evt-live' });
    persisted.length = 0;
    del({ eventId: 'evt-live' });
    await flushAsync();
    // Streaming deltas are not persisted; the tombstone (streaming forced false) must be.
    expect(persisted).toContainEqual(expect.objectContaining({ eventId: 'evt-live', hidden: true }));

    // The agent finishes the turn: a higher-seq, terminal, non-hidden revision of the same id.
    const terminal = timelineEmitter.emit(SESSION, 'assistant.text', { text: 'partial and complete', streaming: false }, { eventId: 'evt-live' })!;
    expect(byId('evt-live')?.hidden).toBe(true); // daemon ring buffer keeps the tombstone
    // ...and a web client merging the tombstone with the later terminal event keeps it hidden too.
    const tomb = persisted.find((e) => (e as TimelineEvent).eventId === 'evt-live' && (e as TimelineEvent).hidden) as TimelineEvent;
    const merged = mergeTimelineEvents([tomb], [terminal]);
    expect(merged.find((e) => e.eventId === 'evt-live')?.hidden).toBe(true);
  });

  it('survives a daemon restart: replaying the persisted rows with the original resolves to hidden', async () => {
    const original = timelineEmitter.emit(SESSION, 'assistant.text', { text: 'will be deleted', streaming: false }, { eventId: 'evt-restart' })!;
    del({ eventId: 'evt-restart' });
    await flushAsync();
    const tomb = persisted.find((e) => (e as TimelineEvent).eventId === 'evt-restart' && (e as TimelineEvent).hidden) as TimelineEvent;
    // JSONL order after restart: original first, tombstone after; a hydrated (fuller) original must not win.
    const hydratedOriginal = { ...original, payload: { ...original.payload, completeness: 'hydrated' }, seq: tomb.seq + 5 } as TimelineEvent;
    expect(mergeTimelineEvents([original], [tomb]).find((e) => e.eventId === 'evt-restart')?.hidden).toBe(true);
    expect(mergeTimelineEvents([hydratedOriginal], [tomb]).find((e) => e.eventId === 'evt-restart')?.hidden).toBe(true);
    expect(mergeTimelineEvents([tomb], [hydratedOriginal]).find((e) => e.eventId === 'evt-restart')?.hidden).toBe(true);
  });

  it('deleting a message right after sending it is not swallowed by the 5s duplicate-send guard', async () => {
    const sent = timelineEmitter.emit(SESSION, 'user.message', { text: 'oops wrong chat' }, { eventId: 'evt-just-sent' })!;
    persisted.length = 0;
    const id = del({ eventId: sent.eventId });
    await flushAsync();
    expect(byId('evt-just-sent')?.hidden).toBe(true);
    expect(persisted).toContainEqual(expect.objectContaining({ eventId: 'evt-just-sent', hidden: true }));
    expect(acksFor(id)).toEqual([expect.objectContaining({ status: 'accepted' })]);
  });

  it('is idempotent: deleting twice accepts twice but writes the tombstone once', async () => {
    timelineEmitter.emit(SESSION, 'assistant.text', { text: 'x', streaming: false }, { eventId: 'evt-twice' });
    del({ eventId: 'evt-twice' });
    await flushAsync();
    const rowsFor = () => persisted.filter((e) => (e as TimelineEvent).eventId === 'evt-twice').length;
    const writesAfterFirst = rowsFor();
    const id2 = del({ eventId: 'evt-twice' });
    await flushAsync();
    expect(rowsFor()).toBe(writesAfterFirst);
    expect(acksFor(id2)).toEqual([expect.objectContaining({ status: 'accepted' })]);
  });

  it('works for a sub-session the daemon owns', async () => {
    getSessionMock.mockReturnValue({ name: 'deck_sub_abc', projectName: 'proj', role: 'w1', agentType: 'codex-sdk', runtimeType: 'transport', state: 'idle', parentSession: SESSION });
    timelineEmitter.emit('deck_sub_abc', 'assistant.text', { text: 'sub reply', streaming: false }, { eventId: 'evt-sub' });
    handleWebCommand({ type: TIMELINE_MESSAGES.DELETE, sessionName: 'deck_sub_abc', eventId: 'evt-sub', commandId: 'cmd-sub' }, serverLink as never);
    await flushAsync();
    expect(byId('evt-sub', 'deck_sub_abc')?.hidden).toBe(true);
    expect(acksFor('cmd-sub')).toEqual([expect.objectContaining({ status: 'accepted' })]);
  });

  it('answers EVERY failure with a coded ack (never a silent return)', async () => {
    const malformed = del({}); // no ids
    await flushAsync();
    expect(acksFor(malformed)).toEqual([expect.objectContaining({ status: 'error', error: TIMELINE_DELETE_ERROR_CODES.INVALID_REQUEST })]);

    const tooMany = del({ eventId: 'a', eventIds: Array.from({ length: TIMELINE_DELETE_MAX_EVENT_IDS + 1 }, (_, i) => `id-${i}`) });
    await flushAsync();
    expect(acksFor(tooMany)).toEqual([expect.objectContaining({ status: 'error', error: TIMELINE_DELETE_ERROR_CODES.TOO_MANY_TARGETS })]);

    getSessionMock.mockReturnValue(undefined);
    const foreign = del({ eventId: 'evt-x' });
    await flushAsync();
    expect(acksFor(foreign)).toEqual([expect.objectContaining({ status: 'error', error: TIMELINE_DELETE_ERROR_CODES.SESSION_NOT_FOUND })]);
    expect(byId('evt-x')).toBeUndefined(); // a session this daemon does not own is never touched
  });

  it('logs every outcome with counts and a duration (no message content)', async () => {
    timelineEmitter.emit(SESSION, 'assistant.text', { text: 'CONTENT-MUST-NOT-BE-LOGGED', streaming: false }, { eventId: 'evt-log' });
    del({ eventId: 'evt-log', eventIds: ['evt-log', 'evt-log-missing'] });
    await flushAsync();
    const call = loggerMock.info.mock.calls.find((c) => c[1] === 'timeline delete handled');
    expect(call).toBeDefined();
    expect(call![0]).toEqual(expect.objectContaining({ sessionName: SESSION, requested: 2, fromBuffer: 1, tombstonedWithoutOriginal: 1, durationMs: expect.any(Number) }));
    expect(JSON.stringify(loggerMock.info.mock.calls)).not.toContain('CONTENT-MUST-NOT-BE-LOGGED');
  });
  describe('a delete is bookkeeping, never new activity for local subscribers', () => {
    it('deleting a streaming message (re-emitted non-streaming) and an unknown hinted id reach NO default subscriber, but the forwarder still gets both', async () => {
      const defaultSeen: TimelineEvent[] = [];
      const forwarderSeen: TimelineEvent[] = [];
      const offDefault = timelineEmitter.on((e) => defaultSeen.push(e));
      const offForwarder = timelineEmitter.on((e) => forwarderSeen.push(e), { includeUserDeleted: true });
      try {
        timelineEmitter.emit(SESSION, 'assistant.text', { text: 'partial', streaming: true }, { eventId: 'evt-act-live' });
        defaultSeen.length = 0; forwarderSeen.length = 0;

        const id1 = del({ eventId: 'evt-act-live' });
        const id2 = del({ eventId: 'evt-act-unknown-user', eventTypes: { 'evt-act-unknown-user': 'user.message' } });
        const id3 = del({ eventId: 'evt-act-unknown-tool', eventTypes: { 'evt-act-unknown-tool': 'tool.call' } });
        await flushAsync();

        const activity = (list: TimelineEvent[]) => list.filter((e) => e.type === 'assistant.text' || e.type === 'user.message' || e.type === 'tool.call');
        expect(activity(defaultSeen)).toEqual([]); // memory ingestion / supervision / cron / peer-audit / session-activity see nothing
        expect(activity(forwarderSeen).map((e) => e.eventId).sort()).toEqual(['evt-act-live', 'evt-act-unknown-tool', 'evt-act-unknown-user']);
        expect(activity(forwarderSeen).every((e) => e.hidden === true && e.payload[TIMELINE_USER_DELETED_PAYLOAD_KEY] === true)).toBe(true);
        for (const id of [id1, id2, id3]) expect(acksFor(id)).toEqual([expect.objectContaining({ status: 'accepted' })]);
        // Still persisted + buffered exactly as before.
        expect(persisted).toContainEqual(expect.objectContaining({ eventId: 'evt-act-unknown-user', hidden: true }));
        expect(byId('evt-act-live')?.hidden).toBe(true);
      } finally { offDefault(); offForwarder(); }
    });

    it('a normal (non-tombstone) event still reaches default subscribers', () => {
      const seen: TimelineEvent[] = [];
      const off = timelineEmitter.on((e) => seen.push(e));
      try {
        timelineEmitter.emit(SESSION, 'assistant.text', { text: 'normal', streaming: false }, { eventId: 'evt-act-normal' });
        expect(seen.map((e) => e.eventId)).toEqual(['evt-act-normal']);
      } finally { off(); }
    });

    it('a delete does not reset the same-state idle dedup (it is not visible activity)', () => {
      timelineEmitter.emit(SESSION, 'session.state', { state: 'idle' });
      del({ eventId: 'evt-act-idle', eventTypes: { 'evt-act-idle': 'assistant.text' } });
      const seen: TimelineEvent[] = [];
      const off = timelineEmitter.on((e) => seen.push(e));
      try {
        timelineEmitter.emit(SESSION, 'session.state', { state: 'idle' });
        expect(seen.filter((e) => e.type === 'session.state')).toEqual([]);
      } finally { off(); }
    });
  });
});
