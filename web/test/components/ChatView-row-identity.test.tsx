/**
 * @vitest-environment jsdom
 *
 * A row that is streaming is one DOM node for its whole life: it must survive
 * events appending to it, the retained-event cap dropping the oldest events of
 * its merged run, a tool call starting and ending inside the turn, and the
 * turn finalizing. (Before, the merged block was keyed by the first event still
 * in the list, so every dropped oldest event gave the row a new key and Preact
 * re-created it - about once per message in a long run.)
 */
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock('../../src/components/ChatMarkdown.js', () => ({
  ChatMarkdown: ({ text }: { text: string }) => <div class="md">{text}</div>,
}));
vi.mock('../../src/components/FileBrowser.js', () => ({ FileBrowser: () => null }));
vi.mock('../../src/components/FloatingPanel.js', () => ({
  FloatingPanel: ({ children }: { children?: preact.ComponentChildren }) => <div>{children}</div>,
}));
vi.mock('../../src/hooks/usePref.js', () => ({
  parseBooleanish: (raw: unknown) => (raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null),
  usePref: () => ({
    value: true, rawValue: true, loaded: true, loading: false, stale: false,
    error: null, save: async () => undefined, set: () => undefined, reload: async () => true,
  }),
}));

import { ChatView } from '../../src/components/ChatView.js';
import { __resetRunKeysForTests } from '../../src/components/chat-run-keys.js';
import type { TimelineEvent } from '../../src/ws-client.js';

class FakeResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
class FakeIntersectionObserver {
  observe(): void {} unobserve(): void {} disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

const SESSION = 'deck_row_identity_brain';
const ev = (i: number, type: string, payload: Record<string, unknown>): TimelineEvent => ({
  eventId: `e${i}`, type, ts: 1000 + i, epoch: 1, seq: i, sessionId: SESSION, source: 'daemon', confidence: 'high', payload,
}) as unknown as TimelineEvent;
const text = (i: number, extra: Record<string, unknown> = {}) => ev(i, 'assistant.text', { text: `message ${i}`, streaming: false, ...extra });
const call = (i: number, id: string) => ev(i, 'tool.call', { tool: 'shell', input: { command: 'ls' }, toolCallId: id, status: 'running' });
const result = (i: number, id: string) => ev(i, 'tool.result', { tool: 'shell', output: 'ok', toolCallId: id, status: 'complete' });

const mount = (events: TimelineEvent[]) => render(<ChatView events={events as never} loading={false} hasOlderHistory={false} sessionId={SESSION} />);
const update = async (view: ReturnType<typeof mount>, events: TimelineEvent[]) => {
  await act(async () => { view.rerender(<ChatView events={events as never} loading={false} hasOlderHistory={false} sessionId={SESSION} />); });
};
/** The row that holds the given message text (the merged block that the stream lives in). */
const rowWith = (container: Element, needle: string) => [...container.querySelectorAll('.chat-assistant')].find((node) => node.textContent?.includes(needle)) ?? null;

describe('ChatView - a streaming row keeps its DOM node', () => {
  beforeEach(() => {
    __resetRunKeysForTests();
    vi.stubGlobal('ResizeObserver', FakeResizeObserver as unknown as typeof ResizeObserver);
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver as unknown as typeof IntersectionObserver);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('across appended chunks, the oldest events of its run being dropped, a tool call inside the turn, and finalization', async () => {
    // 30 consecutive assistant messages form ONE merged block; the last one is streaming.
    const history = Array.from({ length: 29 }, (_, i) => text(i));
    const streaming = (chunk: number, live = true) => text(29, { text: `message 29 chunk ${chunk}`, streaming: live });
    const view = mount([...history, streaming(0)]);
    const block = rowWith(view.container, 'message 29');
    expect(block).not.toBeNull();

    // 1. chunks append; meanwhile the retained-event cap drops the oldest event each time
    let events = [...history, streaming(0)];
    for (let chunk = 1; chunk <= 12; chunk += 1) {
      events = [...events.slice(1, -1), streaming(chunk)];
      await update(view, events);
      expect(rowWith(view.container, `chunk ${chunk}`), `chunk ${chunk}: the row is the same node`).toBe(block);
    }

    // 2. a tool call starts and ends inside the turn (the block before it is untouched)
    events = [...events, call(100, 't1')];
    await update(view, events);
    expect(rowWith(view.container, 'chunk 12')).toBe(block);
    events = [...events, result(101, 't1')];
    await update(view, events);
    expect(rowWith(view.container, 'chunk 12')).toBe(block);

    // 3. the turn finalizes
    events = events.map((e) => (e.eventId === 'e29' ? streaming(12, false) : e));
    await update(view, events);
    expect(rowWith(view.container, 'chunk 12')).toBe(block);

    // 4. the next message is a NEW row (not a remount of the old one)
    events = [...events, text(102, { text: 'next message' })];
    await update(view, events);
    expect(rowWith(view.container, 'chunk 12')).toBe(block);
    expect(rowWith(view.container, 'next message')).not.toBe(block);
  });
});
