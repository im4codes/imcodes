import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  updateSessionState: vi.fn(),
  upsertSession: vi.fn(),
  readOpenCodeSessionMessagesSince: vi.fn(),
  buildTimelineEventsFromOpenCodeExport: vi.fn(),
  discoverLatestOpenCodeSessionId: vi.fn(),
  emit: vi.fn(),
  timelineRead: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: mocks.getSession,
  updateSessionState: mocks.updateSessionState,
  upsertSession: mocks.upsertSession,
}));

vi.mock('../../src/daemon/opencode-history.js', () => ({
  readOpenCodeSessionMessagesSince: mocks.readOpenCodeSessionMessagesSince,
  buildTimelineEventsFromOpenCodeExport: mocks.buildTimelineEventsFromOpenCodeExport,
  discoverLatestOpenCodeSessionId: mocks.discoverLatestOpenCodeSessionId,
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { epoch: 1, emit: mocks.emit },
}));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: { read: mocks.timelineRead },
}));

import { startWatching, stopWatching, isWatching, __testOnly } from '../../src/daemon/opencode-watcher.js';

describe('opencode-watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.getSession.mockReturnValue({ name: 'deck_sub_oc', projectDir: '/proj', opencodeSessionId: 'sid-1' });
    mocks.readOpenCodeSessionMessagesSince.mockResolvedValue([]);
    mocks.buildTimelineEventsFromOpenCodeExport.mockReturnValue([]);
    mocks.discoverLatestOpenCodeSessionId.mockResolvedValue(undefined);
    mocks.timelineRead.mockReturnValue([]);
  });

  afterEach(() => {
    stopWatching('deck_sub_oc');
    vi.useRealTimers();
  });

  it('starts polling without replaying full history, then emits only new delta events', async () => {
    mocks.timelineRead.mockReturnValue([{ type: 'assistant.text' }]);
    await startWatching('deck_sub_oc', '/proj', 'sid-1');
    expect(isWatching('deck_sub_oc')).toBe(true);

    await vi.runOnlyPendingTimersAsync();
    expect(mocks.emit).not.toHaveBeenCalled();

    mocks.readOpenCodeSessionMessagesSince.mockResolvedValueOnce([
      { info: { id: 'm2', role: 'assistant', time: { created: 200 } }, parts: [{ id: 'p1', type: 'text', text: 'hi' }, { id: 'p2', type: 'step-finish' }] },
    ]);
    mocks.buildTimelineEventsFromOpenCodeExport.mockReturnValueOnce([
      { type: 'assistant.text', payload: { text: 'hi', streaming: false }, source: 'daemon', confidence: 'high', eventId: 'evt-1', ts: 200 },
    ]);

    await vi.advanceTimersByTimeAsync(1600);
    expect(mocks.readOpenCodeSessionMessagesSince).toHaveBeenLastCalledWith('/proj', 'sid-1', {
      timeCreated: 0,
      messageId: '',
    });
    expect(mocks.emit).toHaveBeenCalledWith('deck_sub_oc', 'assistant.text', { text: 'hi', streaming: false }, expect.objectContaining({ eventId: 'evt-1', ts: 200 }));
    expect(mocks.updateSessionState).toHaveBeenCalledWith('deck_sub_oc', 'idle');

    stopWatching('deck_sub_oc');
    expect(isWatching('deck_sub_oc')).toBe(false);
  });

  it('bootstraps missing assistant history from session creation time and skips duplicate user message', async () => {
    mocks.getSession.mockReturnValue({ name: 'deck_sub_oc', projectDir: '/proj', opencodeSessionId: 'sid-1', createdAt: 500 });
    mocks.readOpenCodeSessionMessagesSince.mockResolvedValueOnce([
      { info: { id: 'm2', role: 'assistant', time: { created: 700 } }, parts: [{ id: 'p1', type: 'text', text: '你好！' }, { id: 'p2', type: 'step-finish' }] },
    ]);
    mocks.buildTimelineEventsFromOpenCodeExport.mockReturnValueOnce([
      { type: 'user.message', payload: { text: '你好' }, source: 'daemon', confidence: 'high', eventId: 'evt-u', ts: 600 },
      { type: 'assistant.text', payload: { text: '你好！', streaming: false }, source: 'daemon', confidence: 'high', eventId: 'evt-a', ts: 700 },
    ]);

    await startWatching('deck_sub_oc', '/proj', 'sid-1');
    await vi.runOnlyPendingTimersAsync();

    expect(mocks.readOpenCodeSessionMessagesSince).toHaveBeenCalledWith('/proj', 'sid-1', {
      timeCreated: 499,
      messageId: '',
    });
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledWith('deck_sub_oc', 'assistant.text', { text: '你好！', streaming: false }, expect.objectContaining({ eventId: 'evt-a', ts: 700 }));
  });


  it('bootstraps from earliest timeline user message when store createdAt is too new', async () => {
    mocks.getSession.mockReturnValue({ name: 'deck_sub_oc', projectDir: '/proj', opencodeSessionId: 'sid-1', createdAt: 900 });
    mocks.timelineRead.mockReturnValue([
      { type: 'user.message', ts: 600 },
      { type: 'command.ack', ts: 601 },
      { type: 'session.state', ts: 950 },
    ]);
    mocks.readOpenCodeSessionMessagesSince.mockResolvedValueOnce([
      { info: { id: 'm2', role: 'assistant', time: { created: 700 } }, parts: [{ id: 'p1', type: 'text', text: '你好！' }, { id: 'p2', type: 'step-finish' }] },
    ]);
    mocks.buildTimelineEventsFromOpenCodeExport.mockReturnValueOnce([
      { type: 'user.message', payload: { text: '你好' }, source: 'daemon', confidence: 'high', eventId: 'evt-u', ts: 600 },
      { type: 'assistant.text', payload: { text: '你好！', streaming: false }, source: 'daemon', confidence: 'high', eventId: 'evt-a', ts: 700 },
    ]);

    await startWatching('deck_sub_oc', '/proj', 'sid-1');
    await vi.runOnlyPendingTimersAsync();

    expect(mocks.readOpenCodeSessionMessagesSince).toHaveBeenCalledWith('/proj', 'sid-1', {
      timeCreated: 599,
      messageId: '',
    });
    expect(mocks.emit).toHaveBeenCalledWith('deck_sub_oc', 'assistant.text', { text: '你好！', streaming: false }, expect.objectContaining({ eventId: 'evt-a', ts: 700 }));
  });



  it('rebinds fresh session to latest sqlite session when store is still pinned to an older opencode session', async () => {
    mocks.getSession.mockReturnValue({ name: 'deck_sub_oc', projectDir: '/proj', opencodeSessionId: 'sid-old', createdAt: 900 });
    mocks.timelineRead.mockReturnValue([
      { type: 'user.message', ts: 1000 },
      { type: 'command.ack', ts: 1001 },
    ]);
    mocks.discoverLatestOpenCodeSessionId.mockResolvedValueOnce('sid-new');
    mocks.readOpenCodeSessionMessagesSince.mockResolvedValueOnce([
      { info: { id: 'm2', role: 'assistant', time: { created: 1100 } }, parts: [{ id: 'p1', type: 'text', text: 'hi' }, { id: 'p2', type: 'step-finish' }] },
    ]);
    mocks.buildTimelineEventsFromOpenCodeExport.mockReturnValueOnce([
      { type: 'user.message', payload: { text: 'hello' }, source: 'daemon', confidence: 'high', eventId: 'evt-u', ts: 1000 },
      { type: 'assistant.text', payload: { text: 'hi', streaming: false }, source: 'daemon', confidence: 'high', eventId: 'evt-a', ts: 1100 },
    ]);

    await startWatching('deck_sub_oc', '/proj', 'sid-old');
    await vi.runOnlyPendingTimersAsync();

    expect(mocks.discoverLatestOpenCodeSessionId).toHaveBeenCalledWith('/proj', {
      updatedAfter: 0,
      exactDirectory: '/proj',
      maxCount: 50,
    });
    expect(mocks.upsertSession).toHaveBeenCalledWith(expect.objectContaining({ opencodeSessionId: 'sid-new' }));
    expect(mocks.readOpenCodeSessionMessagesSince).toHaveBeenCalledWith('/proj', 'sid-new', {
      timeCreated: 999,
      messageId: '',
    });
    expect(mocks.emit).toHaveBeenCalledWith('deck_sub_oc', 'assistant.text', { text: 'hi', streaming: false }, expect.objectContaining({ eventId: 'evt-a', ts: 1100 }));
  });



  it('uses latest structured timeline timestamp to fetch missing assistant delta after restart', async () => {
    mocks.timelineRead.mockReturnValue([
      { type: 'assistant.text', ts: 700 },
      { type: 'user.message', ts: 1000 },
      { type: 'command.ack', ts: 1001 },
    ]);
    mocks.readOpenCodeSessionMessagesSince.mockResolvedValueOnce([
      { info: { id: 'm3', role: 'user', time: { created: 1010 } }, parts: [] },
      { info: { id: 'm4', role: 'assistant', time: { created: 1020 } }, parts: [{ id: 'p1', type: 'text', text: 'reply' }, { id: 'p2', type: 'step-finish' }] },
    ]);
    mocks.buildTimelineEventsFromOpenCodeExport.mockReturnValueOnce([
      { type: 'user.message', payload: { text: 'hi' }, source: 'daemon', confidence: 'high', eventId: 'evt-u', ts: 1010 },
      { type: 'assistant.text', payload: { text: 'reply', streaming: false }, source: 'daemon', confidence: 'high', eventId: 'evt-a', ts: 1020 },
    ]);

    await startWatching('deck_sub_oc', '/proj', 'sid-1');
    await vi.runOnlyPendingTimersAsync();

    expect(mocks.readOpenCodeSessionMessagesSince).toHaveBeenCalledWith('/proj', 'sid-1', {
      timeCreated: 1000,
      messageId: '',
    });
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledWith('deck_sub_oc', 'assistant.text', { text: 'reply', streaming: false }, expect.objectContaining({ eventId: 'evt-a', ts: 1020 }));
  });

  it('does not advance cursor past assistant rows that exist before their parts are committed', async () => {
    mocks.timelineRead.mockReturnValue([{ type: 'assistant.text', ts: 700 }]);
    mocks.readOpenCodeSessionMessagesSince
      .mockResolvedValueOnce([
        { info: { id: 'm-user', role: 'user', time: { created: 1000 } }, parts: [] },
        { info: { id: 'm-assistant', role: 'assistant', time: { created: 1010 } }, parts: [] },
      ])
      .mockResolvedValueOnce([
        { info: { id: 'm-user', role: 'user', time: { created: 1000 } }, parts: [] },
        { info: { id: 'm-assistant', role: 'assistant', time: { created: 1010 } }, parts: [{ id: 'p1', type: 'text', text: 'reply' }] },
      ]);
    mocks.buildTimelineEventsFromOpenCodeExport
      .mockReturnValueOnce([
        { type: 'user.message', payload: { text: 'hi' }, source: 'daemon', confidence: 'high', eventId: 'evt-u', ts: 1000 },
      ])
      .mockReturnValueOnce([
      { type: 'user.message', payload: { text: 'hi' }, source: 'daemon', confidence: 'high', eventId: 'evt-u', ts: 1000 },
      { type: 'assistant.text', payload: { text: 'reply', streaming: false }, source: 'daemon', confidence: 'high', eventId: 'evt-a', ts: 1010 },
      ]);

    await startWatching('deck_sub_oc', '/proj', 'sid-1');
    await Promise.resolve();

    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.updateSessionState).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1600);

    expect(mocks.readOpenCodeSessionMessagesSince).toHaveBeenNthCalledWith(2, '/proj', 'sid-1', {
      timeCreated: 1000,
      messageId: 'm-user',
    });
    expect(mocks.emit).toHaveBeenCalledWith('deck_sub_oc', 'assistant.text', { text: 'reply', streaming: false }, expect.objectContaining({ eventId: 'evt-a', ts: 1010 }));
    expect(mocks.updateSessionState).toHaveBeenCalledWith('deck_sub_oc', 'idle');
  });

  it('only commits trailing assistant rows once they have materialized parts', () => {
    const { committed, pendingTail } = __testOnly.splitCommittedMessages([
      { info: { id: 'u1', role: 'user' }, parts: [] },
      { info: { id: 'a1', role: 'assistant' }, parts: [{ type: 'reasoning', text: 'thinking' }, { type: 'step-finish' }] },
      { info: { id: 'a2', role: 'assistant' }, parts: [] },
      { info: { id: 'a3', role: 'assistant' }, parts: [{ type: 'reasoning', text: 'thinking more' }] },
    ]);

    expect(committed.map((m) => String(m.info?.id))).toEqual(['u1', 'a1']);
    expect(pendingTail.map((m) => String(m.info?.id))).toEqual(['a2', 'a3']);
  });

});
