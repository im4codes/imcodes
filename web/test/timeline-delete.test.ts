import { afterEach, describe, expect, it, vi } from 'vitest';
import { MSG_COMMAND_ACK, MSG_COMMAND_FAILED } from '../../shared/ack-protocol.js';
import { TIMELINE_DELETE_ERROR_CODES } from '../../shared/timeline-protocol.js';
import {
  TimelineDeleteError,
  normalizeTimelineDeleteError,
  requestTimelineMessageDelete,
  resolveTimelineDeleteTargets,
  timelineDeleteErrorKey,
} from '../src/timeline-delete.js';

function harness(connected = true) {
  const handlers = new Set<(msg: unknown) => void>();
  const ws = {
    connected,
    deleteTimelineMessage: vi.fn((_s: string, _id: string, _o?: unknown) => 'x'),
    onMessage: vi.fn((h: (msg: unknown) => void) => { handlers.add(h); return () => handlers.delete(h); }),
  };
  const commandId = () => (ws.deleteTimelineMessage.mock.calls[0]![2] as { commandId: string }).commandId;
  const deliver = (msg: Record<string, unknown>) => handlers.forEach((h) => h(msg));
  return { ws, commandId, deliver, listeners: () => handlers.size };
}
const targets = { primaryEventId: 'a', eventIds: ['a', 'b'], eventTypes: { a: 'assistant.text', b: 'assistant.text' } };

describe('requestTimelineMessageDelete', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves on an accepted ack for ITS command id and detaches the listener', async () => {
    const h = harness();
    const promise = requestTimelineMessageDelete(h.ws as never, 'sess', targets);
    expect(h.ws.deleteTimelineMessage).toHaveBeenCalledWith('sess', 'a', expect.objectContaining({ eventIds: ['a', 'b'], eventTypes: targets.eventTypes }));
    h.deliver({ type: MSG_COMMAND_ACK, commandId: 'someone-else', status: 'error', error: 'x' }); // ignored
    h.deliver({ type: MSG_COMMAND_ACK, commandId: h.commandId(), session: 'sess', status: 'accepted' });
    await expect(promise).resolves.toBeUndefined();
    expect(h.listeners()).toBe(0);
  });

  it('rejects with the daemon error code', async () => {
    const h = harness();
    const promise = requestTimelineMessageDelete(h.ws as never, 'sess', targets);
    h.deliver({ type: MSG_COMMAND_ACK, commandId: h.commandId(), status: 'error', error: TIMELINE_DELETE_ERROR_CODES.SESSION_NOT_FOUND });
    await expect(promise).rejects.toMatchObject({ code: TIMELINE_DELETE_ERROR_CODES.SESSION_NOT_FOUND });
  });

  it('maps an older daemon\'s free-text error and a command.failed to the generic failure', async () => {
    const old = harness();
    const p1 = requestTimelineMessageDelete(old.ws as never, 'sess', targets);
    old.deliver({ type: MSG_COMMAND_ACK, commandId: old.commandId(), status: 'error', error: 'Message not found' });
    await expect(p1).rejects.toMatchObject({ code: TIMELINE_DELETE_ERROR_CODES.FAILED });

    const failed = harness();
    const p2 = requestTimelineMessageDelete(failed.ws as never, 'sess', targets);
    failed.deliver({ type: MSG_COMMAND_FAILED, commandId: failed.commandId(), session: 'sess', reason: 'daemon_offline', retryable: true });
    await expect(p2).rejects.toMatchObject({ code: TIMELINE_DELETE_ERROR_CODES.FAILED });
  });

  it('times out with a coded error instead of waiting forever', async () => {
    vi.useFakeTimers();
    const h = harness();
    const promise = requestTimelineMessageDelete(h.ws as never, 'sess', targets, 5_000);
    const assertion = expect(promise).rejects.toMatchObject({ code: TIMELINE_DELETE_ERROR_CODES.TIMEOUT });
    await vi.advanceTimersByTimeAsync(5_001);
    await assertion;
    expect(h.listeners()).toBe(0);
  });

  it('fails immediately, without sending, when the socket is not connected', async () => {
    const h = harness(false);
    await expect(requestTimelineMessageDelete(h.ws as never, 'sess', targets)).rejects.toBeInstanceOf(TimelineDeleteError);
    expect(h.ws.deleteTimelineMessage).not.toHaveBeenCalled();
  });

  it('maps codes to locale keys', () => {
    expect(timelineDeleteErrorKey(TIMELINE_DELETE_ERROR_CODES.TIMEOUT)).toBe('chat.delete_message_error_timeout');
    expect(timelineDeleteErrorKey(TIMELINE_DELETE_ERROR_CODES.SESSION_NOT_FOUND)).toBe('chat.delete_message_error_session');
    expect(timelineDeleteErrorKey(TIMELINE_DELETE_ERROR_CODES.FAILED)).toBe('chat.delete_message_error');
    expect(normalizeTimelineDeleteError(undefined)).toBe(TIMELINE_DELETE_ERROR_CODES.FAILED);
  });
});

describe('resolveTimelineDeleteTargets', () => {
  const events = [
    { eventId: 'u1', type: 'user.message' }, { eventId: 'm1', type: 'memory.context' },
    { eventId: 'a1', type: 'assistant.text' }, { eventId: 'a2', type: 'assistant.text' },
  ];
  it('a merged assistant block resolves to every stored event, keyed by the first', () => {
    const items = [{ key: 'a1', eventIds: ['a1', 'a2'] }];
    expect(resolveTimelineDeleteTargets(items, events, 'a1')).toEqual({
      primaryEventId: 'a1', eventIds: ['a1', 'a2'], eventTypes: { a1: 'assistant.text', a2: 'assistant.text' },
    });
  });
  it('a user message also takes its attached memory.context rows', () => {
    const items = [{ key: 'u1', event: { eventId: 'u1' }, linkedEvents: [{ eventId: 'm1' }] }];
    expect(resolveTimelineDeleteTargets(items, events, 'u1').eventIds.sort()).toEqual(['m1', 'u1']);
  });
  it('an id the view no longer holds still resolves to itself (cache-only / paginated id)', () => {
    expect(resolveTimelineDeleteTargets([], [], 'cache-only')).toEqual({ primaryEventId: 'cache-only', eventIds: ['cache-only'], eventTypes: {} });
  });
});
