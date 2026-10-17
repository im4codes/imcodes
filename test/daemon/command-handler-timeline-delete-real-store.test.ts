/**
 * Real TimelineStore (JSONL on disk) with MORE than 5000 events: the daemon delete
 * used to look only at the ring buffer and `read(limit: 5000)`, so any older message
 * answered "Message not found" and the web ignored it. Only the SQLite projection
 * mirror is stubbed; the JSONL file, the real emitter and the real handler run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TIMELINE_MESSAGES, TIMELINE_USER_DELETED_PAYLOAD_KEY } from '../../shared/timeline-protocol.js';
import type { TimelineEvent } from '../../src/shared/timeline/types.js';
import { mergeTimelineEvents } from '../../src/shared/timeline/merge.js';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('../../src/daemon/timeline-projection.js', () => ({
  timelineProjection: {
    recordAppendedEvent: vi.fn(async () => undefined), queryHistory: vi.fn(async () => null), queryByTypes: vi.fn(async () => null),
    queryCompletedTextTail: vi.fn(async () => null), getLatest: vi.fn(async () => null), rebuildSession: vi.fn(async () => true),
    pruneSessionToAuthoritative: vi.fn(), deleteSession: vi.fn(), checkpointIfNeeded: vi.fn(), drain: vi.fn(async () => undefined),
  },
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


const originalHome = process.env.HOME;
const originalProfile = process.env.USERPROFILE;
let home = '';
let handleWebCommand: typeof import('../../src/daemon/command-handler.js').handleWebCommand;
let timelineStore: typeof import('../../src/daemon/timeline-store.js').timelineStore;
const SESSION = 'deck_proj_brain';
const serverLink = { send: vi.fn(), sendBinary: vi.fn(), sendTimelineEvent: vi.fn(), daemonVersion: '0.1.0' };

function stored(seq: number): TimelineEvent {
  return {
    eventId: `evt-${seq}`, sessionId: SESSION, ts: 1_700_000_000_000 + seq, seq, epoch: 1, source: 'daemon', confidence: 'high',
    type: seq % 2 ? 'user.message' : 'assistant.text', payload: { text: `message ${seq}`, streaming: false },
  } as TimelineEvent;
}

describe('timeline.delete against a real >5000-event timeline', () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'imcodes-timeline-delete-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.resetModules();
    getSessionMock.mockReturnValue({ name: SESSION, projectName: 'proj', role: 'brain', agentType: 'claude-code', runtimeType: 'process', state: 'idle' });
    ({ timelineStore } = await import('../../src/daemon/timeline-store.js'));
    ({ handleWebCommand } = await import('../../src/daemon/command-handler.js'));
    for (let seq = 1; seq <= 6000; seq += 1) timelineStore.append(stored(seq));
    await timelineStore.flushSession(SESSION);
  }, 120_000);

  afterAll(() => {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalProfile;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('deletes an event that is older than the newest 5000 (not in the ring buffer, not in the tail read)', async () => {
    // Precondition proving the old handler could not have found it.
    expect(timelineStore.read(SESSION, { limit: 5000 }).some((e) => e.eventId === 'evt-10')).toBe(false);

    handleWebCommand({ type: TIMELINE_MESSAGES.DELETE, sessionName: SESSION, eventId: 'evt-10', eventTypes: { 'evt-10': 'assistant.text' }, commandId: 'cmd-old' }, serverLink as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await timelineStore.flushSession(SESSION);

    const acks = serverLink.send.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((m) => m.type === 'command.ack' && m.commandId === 'cmd-old');
    expect(acks).toEqual([expect.objectContaining({ status: 'accepted' })]);

    // Durable: the tombstone is on disk, at the tail, and wins over the original on replay.
    const lines = readFileSync(timelineStore.filePath(SESSION), 'utf-8').trimEnd().split('\n').map((l) => JSON.parse(l) as TimelineEvent);
    const tombstones = lines.filter((e) => e.eventId === 'evt-10' && e.hidden === true);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]!.payload[TIMELINE_USER_DELETED_PAYLOAD_KEY]).toBe(true);
    const replay = timelineStore.read(SESSION, { limit: 5000 });
    expect(replay.find((e) => e.eventId === 'evt-10')?.hidden).toBe(true);
  }, 60_000);

  it('a message inside the tail survives a "restart": the JSONL replay (original row + tombstone row) merges to hidden', async () => {
    handleWebCommand({ type: TIMELINE_MESSAGES.DELETE, sessionName: SESSION, eventId: 'evt-5990', eventTypes: { 'evt-5990': 'user.message' }, commandId: 'cmd-tail' }, serverLink as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await timelineStore.flushSession(SESSION);

    // A restarted daemon serves history/replay straight from the JSONL: both rows are there...
    const rows = timelineStore.read(SESSION, { limit: 5000 }).filter((e) => e.eventId === 'evt-5990');
    expect(rows.map((e) => e.hidden === true)).toEqual([false, true]);
    // ...and the merge every consumer applies (web store, IndexedDB, daemon ring buffer) resolves it to hidden,
    // in either order, even when the original was "hydrated" (fuller) in some client cache.
    expect(mergeTimelineEvents([], rows)[0]?.hidden).toBe(true);
    expect(mergeTimelineEvents([], [...rows].reverse())[0]?.hidden).toBe(true);
  }, 60_000);
});

