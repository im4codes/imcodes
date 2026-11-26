/** @vitest-environment jsdom */
/**
 * Right-click delete ("右键删除消息删不掉"), web side:
 *  - it deleted only the FIRST stored event of a merged assistant block (the id in the DOM),
 *    so the rest of the reply stayed on screen;
 *  - it was fire-and-forget: an error ack / timeout / dead socket left no trace in the UI.
 * Now: every stored event of the block is named, the message hides at once (optimistic),
 * and a failure restores it and shows a localized, dismissible error.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import type { TimelineEvent } from '../../src/ws-client.js';
import { MSG_COMMAND_ACK } from '../../../shared/ack-protocol.js';
import { TIMELINE_DELETE_ERROR_CODES } from '../../../shared/timeline-protocol.js';

const unpinMessageMock = vi.hoisted(() => vi.fn());
const messagePinsState = vi.hoisted(() => ({ pins: [] as unknown[] }));

vi.mock('../../src/hooks/useMessagePins.js', () => ({
  useMessagePins: () => ({ pins: messagePinsState.pins, loading: false, mutating: false, error: null, pinMessage: vi.fn(), unpinMessage: unpinMessageMock, clearError: vi.fn() }),
}));
vi.mock('../../src/session-repo-context-store.js', () => ({ useSessionRepoContext: () => ({ currentBranch: 'dev' }) }));
vi.mock('../../src/hooks/usePref.js', () => ({
  parseBooleanish: (raw: unknown) => (raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null),
  usePref: () => ({ value: true, rawValue: true, loaded: true, loading: false, stale: false, error: null, save: vi.fn(), set: vi.fn(), reload: vi.fn() }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string) => key }) }));
vi.mock('../../src/components/ChatMarkdown.js', () => ({ ChatMarkdown: ({ text }: { text: string }) => <span data-testid="chat-markdown">{text}</span> }));

import { ChatView } from '../../src/components/ChatView.js';

const SESSION = 'deck_del_main';

function ev(eventId: string, type: TimelineEvent['type'], text: string, seq: number): TimelineEvent {
  return { eventId, sessionId: SESSION, ts: 1000 + seq, seq, epoch: 1, source: 'daemon', confidence: 'high', type, payload: { text, streaming: false } } as TimelineEvent;
}

/** A fake WsClient: records the delete request and lets a test answer it. */
function fakeWs() {
  const handlers = new Set<(msg: unknown) => void>();
  const ws = {
    connected: true,
    deleteTimelineMessage: vi.fn((_session: string, _id: string, _opts?: unknown) => 'cmd'),
    onMessage: vi.fn((handler: (msg: unknown) => void) => { handlers.add(handler); return () => handlers.delete(handler); }),
    onSessionMessage: vi.fn(() => () => undefined),
    send: vi.fn(),
    sendSessionMessage: vi.fn(),
    subscribeTimeline: vi.fn(),
    unsubscribeTimeline: vi.fn(),
    getTimelineCache: vi.fn(),
  };
  const lastCommandId = (): string => (ws.deleteTimelineMessage.mock.calls.at(-1)![2] as { commandId: string }).commandId;
  const answer = (message: Record<string, unknown>) => act(() => { for (const handler of [...handlers]) handler(message); });
  return { ws, lastCommandId, answer };
}

const MERGED_BLOCK = [
  ev('u1', 'user.message', 'question', 1),
  ev('a1', 'assistant.text', 'first segment', 2),
  ev('a2', 'assistant.text', 'second segment', 3),
  ev('a3', 'assistant.text', 'third segment', 4),
];

async function openDelete(container: HTMLElement, eventId: string): Promise<void> {
  const bubble = container.querySelector<HTMLElement>(`[data-event-id="${eventId}"]`);
  expect(bubble).not.toBeNull();
  fireEvent.contextMenu(bubble!, { clientX: 40, clientY: 40 });
  await waitFor(() => expect(screen.getByText('chat.delete_message')).toBeTruthy());
  fireEvent.click(screen.getByText('chat.delete_message'));
}

describe('ChatView delete message', () => {
  beforeEach(() => {
    unpinMessageMock.mockReset();
    messagePinsState.pins = [];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    Reflect.deleteProperty(window, 'ontouchstart');
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('names EVERY stored event of a merged assistant block, with their types', async () => {
    const { ws } = fakeWs();
    const { container } = render(<ChatView events={MERGED_BLOCK} loading={false} sessionId={SESSION} ws={ws as never} />);
    // The three assistant events render as ONE bubble keyed by the first id.
    expect(container.querySelectorAll('.chat-assistant')).toHaveLength(1);
    await openDelete(container, 'a1');

    expect(ws.deleteTimelineMessage).toHaveBeenCalledTimes(1);
    const [session, primary, opts] = ws.deleteTimelineMessage.mock.calls[0]! as [string, string, { eventIds: string[]; eventTypes: Record<string, string> }];
    expect(session).toBe(SESSION);
    expect(primary).toBe('a1');
    expect([...opts.eventIds].sort()).toEqual(['a1', 'a2', 'a3']);
    expect(opts.eventTypes).toEqual({ a1: 'assistant.text', a2: 'assistant.text', a3: 'assistant.text' });
  });

  it('hides the message immediately, before the daemon answers, and keeps it hidden on accepted', async () => {
    const { ws, lastCommandId, answer } = fakeWs();
    const { container } = render(<ChatView events={MERGED_BLOCK} loading={false} sessionId={SESSION} ws={ws as never} />);
    await openDelete(container, 'a1');

    await waitFor(() => expect(container.querySelector('.chat-assistant')).toBeNull()); // optimistic
    expect(container.textContent).not.toContain('first segment');
    expect(container.textContent).not.toContain('third segment'); // the WHOLE block is gone, not just its first event
    expect(container.querySelector('[data-event-id="u1"]')).not.toBeNull(); // neighbours untouched

    await answer({ type: MSG_COMMAND_ACK, commandId: lastCommandId(), session: SESSION, status: 'accepted' });
    expect(container.querySelector('.chat-assistant')).toBeNull();
    expect(container.querySelector('[data-chat-delete-error]')).toBeNull();
  });

  it('restores the message and shows a localized error when the daemon answers with an error', async () => {
    const { ws, lastCommandId, answer } = fakeWs();
    const { container } = render(<ChatView events={MERGED_BLOCK} loading={false} sessionId={SESSION} ws={ws as never} />);
    await openDelete(container, 'a1');
    await waitFor(() => expect(container.querySelector('.chat-assistant')).toBeNull());

    await answer({ type: MSG_COMMAND_ACK, commandId: lastCommandId(), session: SESSION, status: 'error', error: TIMELINE_DELETE_ERROR_CODES.FAILED });

    await waitFor(() => expect(container.querySelector('.chat-assistant')).not.toBeNull()); // restored
    expect(container.querySelector('.chat-assistant')?.textContent).toContain('third segment');
    const alert = container.querySelector('[data-chat-delete-error]');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('chat.delete_message_error');
    fireEvent.click(alert!.querySelector('button')!); // dismissible
    expect(container.querySelector('[data-chat-delete-error]')).toBeNull();
  });

  it('an older daemon answering with free text ("Message not found") is still surfaced, not swallowed', async () => {
    const { ws, lastCommandId, answer } = fakeWs();
    const { container } = render(<ChatView events={MERGED_BLOCK} loading={false} sessionId={SESSION} ws={ws as never} />);
    await openDelete(container, 'u1');
    await answer({ type: MSG_COMMAND_ACK, commandId: lastCommandId(), session: SESSION, status: 'error', error: 'Message not found' });
    await waitFor(() => expect(container.querySelector('[data-chat-delete-error]')).not.toBeNull());
    expect(container.querySelector('[data-event-id="u1"]')).not.toBeNull();
  });

  it('restores the message and says so when no ack arrives in time', async () => {
    vi.useFakeTimers();
    const { ws } = fakeWs();
    const { container } = render(<ChatView events={MERGED_BLOCK} loading={false} sessionId={SESSION} ws={ws as never} />);
    const bubble = container.querySelector<HTMLElement>('[data-event-id="u1"]')!;
    fireEvent.contextMenu(bubble, { clientX: 40, clientY: 40 });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByText('chat.delete_message'));
    expect(container.querySelector('[data-event-id="u1"]')).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(10_500); });
    expect(container.querySelector('[data-event-id="u1"]')).not.toBeNull();
    expect(container.querySelector('[data-chat-delete-error]')?.textContent).toContain('chat.delete_message_error_timeout');
  });

  it('fails fast (no 10s wait) when the socket is down, because send() would drop the command silently', async () => {
    const { ws } = fakeWs();
    ws.connected = false;
    const { container } = render(<ChatView events={MERGED_BLOCK} loading={false} sessionId={SESSION} ws={ws as never} />);
    await openDelete(container, 'u1');
    await waitFor(() => expect(container.querySelector('[data-chat-delete-error]')).not.toBeNull());
    expect(ws.deleteTimelineMessage).not.toHaveBeenCalled();
    expect(container.querySelector('[data-event-id="u1"]')).not.toBeNull();
  });

  it('unpins a pinned message once it is deleted for everyone', async () => {
    const pin = { id: 'pin-1', sessionName: SESSION, eventId: 'u1', eventTs: 1001, eventType: 'user.message', text: 'question' };
    messagePinsState.pins = [pin];
    const { ws, lastCommandId, answer } = fakeWs();
    const { container } = render(<ChatView events={MERGED_BLOCK} loading={false} sessionId={SESSION} serverId="srv-1" messagePinsEnabled ws={ws as never} />);
    await openDelete(container, 'u1');
    await answer({ type: MSG_COMMAND_ACK, commandId: lastCommandId(), session: SESSION, status: 'accepted' });
    await waitFor(() => expect(unpinMessageMock).toHaveBeenCalledWith(pin));
  });

  it('does not unpin when the delete failed', async () => {
    const pin = { id: 'pin-1', sessionName: SESSION, eventId: 'u1', eventTs: 1001, eventType: 'user.message', text: 'question' };
    messagePinsState.pins = [pin];
    const { ws, lastCommandId, answer } = fakeWs();
    const { container } = render(<ChatView events={MERGED_BLOCK} loading={false} sessionId={SESSION} serverId="srv-1" messagePinsEnabled ws={ws as never} />);
    await openDelete(container, 'u1');
    await answer({ type: MSG_COMMAND_ACK, commandId: lastCommandId(), session: SESSION, status: 'error', error: TIMELINE_DELETE_ERROR_CODES.FAILED });
    await waitFor(() => expect(container.querySelector('[data-chat-delete-error]')).not.toBeNull());
    expect(unpinMessageMock).not.toHaveBeenCalled();
  });

  it('a cancelled confirmation deletes nothing', async () => {
    (window.confirm as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const { ws } = fakeWs();
    const { container } = render(<ChatView events={MERGED_BLOCK} loading={false} sessionId={SESSION} ws={ws as never} />);
    await openDelete(container, 'a1');
    expect(ws.deleteTimelineMessage).not.toHaveBeenCalled();
    expect(container.querySelector('.chat-assistant')).not.toBeNull();
  });

  it('another device viewing the same session hides the message when the tombstone arrives', async () => {
    const { container, rerender } = render(<ChatView events={MERGED_BLOCK} loading={false} sessionId={SESSION} />);
    expect(container.querySelector('[data-event-id="u1"]')).not.toBeNull();
    // Viewer B never clicked anything: the daemon broadcasts the hidden tombstone for u1.
    const tombstone = { ...MERGED_BLOCK[0]!, seq: 9, hidden: true, payload: { text: 'question', streaming: false, userDeleted: true } } as TimelineEvent;
    rerender(<ChatView events={[tombstone, ...MERGED_BLOCK.slice(1)]} loading={false} sessionId={SESSION} />);
    await waitFor(() => expect(container.querySelector('[data-event-id="u1"]')).toBeNull());
    expect(container.querySelector('.chat-assistant')).not.toBeNull(); // the rest of the conversation stays
  });
});

