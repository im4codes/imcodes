/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import type { TimelineEvent } from '../../src/ws-client.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ChatView } from '../../src/components/ChatView.js';

/**
 * The screenshot symptom, at the DOM.
 *
 * `isVisibleChatTimelineEvent` filtered only a hardcoded denylist, so event
 * types the renderer has no case for still became ViewItems: `assistant.thinking`
 * returns null explicitly, and the `transport.queue.*` family falls through to
 * `default: return null`.
 *
 * That produced a pane which is empty AND claims there is more to load, because
 * the "load earlier messages" button is gated on `viewItems.length > 0`. The
 * user sees a button floating above nothing, with no spinner and no "no
 * messages" placeholder — the placeholder is skipped precisely because
 * `viewItems` is not empty.
 *
 * The contract: what survives the filter must be something the chat can
 * actually draw. Otherwise the button lies about content that can never appear.
 */

function ev(eventId: string, type: string, payload: Record<string, unknown> = {}): TimelineEvent {
  return {
    eventId,
    sessionId: 'session-a',
    ts: 1,
    epoch: 1,
    seq: 1,
    source: 'daemon',
    confidence: 'high',
    type,
    payload,
  } as unknown as TimelineEvent;
}

function renderChat(events: TimelineEvent[]) {
  return render(
    <ChatView
      events={events}
      loading={false}
      ws={{} as never}
      workdir="/repo"
      sessionId="session-a"
      onLoadOlder={() => { /* eligible for the button */ }}
    />,
  );
}

describe('a window with nothing renderable in it', () => {
  afterEach(() => cleanup());

  it('does not offer "load earlier messages" above an empty pane', () => {
    const { container } = renderChat([
      ev('t1', 'assistant.thinking', { text: 'thinking' }),
      ev('q1', 'transport.queue.snapshot', { entries: [] }),
    ]);

    const buttons = [...container.querySelectorAll('button')]
      .map((node) => node.textContent ?? '');
    expect(
      buttons.some((label) => label.includes('chat.load_older')),
      'the pane offered to load more history while showing nothing at all',
    ).toBe(false);
  });

  it('shows the empty placeholder instead of a silently blank scroller', () => {
    const { container } = renderChat([
      ev('t1', 'assistant.thinking', { text: 'thinking' }),
      ev('q1', 'transport.queue.reset', {}),
    ]);

    expect(
      container.textContent ?? '',
      'neither messages nor an empty-state was rendered',
    ).toContain('chat.no_events');
  });

  it('still renders real conversation, and still offers older history for it', () => {
    const { container } = renderChat([
      ev('t1', 'assistant.thinking', { text: 'thinking' }),
      ev('m1', 'user.message', { text: 'hello from the user' }),
    ]);

    expect(container.textContent ?? '').toContain('hello from the user');
    expect(container.textContent ?? '').not.toContain('chat.no_events');
    const buttons = [...container.querySelectorAll('button')]
      .map((node) => node.textContent ?? '');
    expect(
      buttons.some((label) => label.includes('chat.load_older')),
      'a pane with real messages must still be able to page back',
    ).toBe(true);
  });
});
