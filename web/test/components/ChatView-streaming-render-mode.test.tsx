/**
 * @vitest-environment jsdom
 *
 * Owner's recording: while a reply streamed, the SAME bubble alternated between
 * its Markdown rendering (bold heading, compact paragraphs) and the raw text
 * ("**深夜的便利店**", "---" literal) every few hundred ms, and the changing
 * height moved the whole viewport. The real ChatMarkdown (not mocked) is used
 * here: whatever a viewer can see after any chunk, the streaming row is the
 * same DOM node and it is rendered as Markdown.
 */
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
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
import type { TimelineEvent } from '../../src/ws-client.js';

class FakeResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
class FakeIntersectionObserver {
  observe(): void {} unobserve(): void {} disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

const SESSION = 'deck_stream_mode_brain';
const REPLY = [
  '好的，这次换一篇不同题材的。', '', '---', '', '**深夜的便利店**', '',
  '凌晨一点四十分，便利店的自动门"叮咚"响了一声。', '', '- 一盒**饭团**', '- 一瓶 `无糖` 茶',
].join('\n');

const userMessage: TimelineEvent = {
  eventId: 'evt-user', type: 'user.message', ts: 1000, epoch: 1, seq: 1, sessionId: SESSION,
  source: 'daemon', confidence: 'high', payload: { text: '随机写一段', streaming: false },
} as unknown as TimelineEvent;
const streaming = (text: string, live = true): TimelineEvent => ({
  eventId: 'transport:stream-1', type: 'assistant.text', ts: 2000, epoch: 1, seq: 2, sessionId: SESSION,
  source: 'daemon', confidence: 'high', payload: { text, streaming: live },
}) as unknown as TimelineEvent;

const streamingRow = (container: Element) => container.querySelector('[data-event-id="transport:stream-1"]');
/** Raw = the bubble is one bare <span> of text (Markdown renders block elements). */
const isRaw = (row: Element | null) => {
  const rich = row?.querySelector('.chat-rich-text');
  return Boolean(rich && rich.children.length === 1 && rich.firstElementChild?.tagName === 'SPAN');
};

describe('ChatView — streaming row keeps one identity and one render mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', FakeResizeObserver as unknown as typeof ResizeObserver);
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver as unknown as typeof IntersectionObserver);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('bursty chunks: the same DOM node, Markdown after every chunk, never the raw text', async () => {
    const view = render(<ChatView events={[userMessage, streaming('好的，')] as never} loading={false} hasOlderHistory={false} sessionId={SESSION} />);
    const first = streamingRow(view.container);
    expect(first).not.toBeNull();
    const seen: Array<{ raw: boolean; sameNode: boolean; text: string }> = [];
    let end = 6;
    while (end <= REPLY.length) {
      // a burst of 3 chunks 15 ms apart, then a pause longer than the Markdown refresh interval
      for (let i = 0; i < 3 && end <= REPLY.length; i += 1, end += 3) {
        await act(async () => { view.rerender(<ChatView events={[userMessage, streaming(REPLY.slice(0, end))] as never} loading={false} hasOlderHistory={false} sessionId={SESSION} />); });
        seen.push({ raw: isRaw(streamingRow(view.container)), sameNode: streamingRow(view.container) === first, text: streamingRow(view.container)?.textContent ?? '' });
        await act(async () => { await vi.advanceTimersByTimeAsync(15); });
        seen.push({ raw: isRaw(streamingRow(view.container)), sameNode: streamingRow(view.container) === first, text: streamingRow(view.container)?.textContent ?? '' });
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      seen.push({ raw: isRaw(streamingRow(view.container)), sameNode: streamingRow(view.container) === first, text: streamingRow(view.container)?.textContent ?? '' });
    }
    expect(seen.length).toBeGreaterThan(20);
    expect(seen.filter((state) => state.raw)).toHaveLength(0);
    expect(seen.filter((state) => !state.sameNode)).toHaveLength(0);
    // no literal Markdown markers at any point (partial bold is closed, not shown as "**")
    expect(seen.filter((state) => /\*\*|`/.test(state.text))).toHaveLength(0);
    // the row settles on the final text
    await act(async () => { view.rerender(<ChatView events={[userMessage, streaming(REPLY, false)] as never} loading={false} hasOlderHistory={false} sessionId={SESSION} />); });
    expect(streamingRow(view.container)).toBe(first);
    expect(view.container.querySelector('.chat-rich-text strong')?.textContent).toBe('深夜的便利店');
    expect(view.container.querySelector('hr')).not.toBeNull();
  });
});
