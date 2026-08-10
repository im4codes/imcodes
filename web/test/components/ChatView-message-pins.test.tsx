/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import type { TimelineEvent } from '../../src/ws-client.js';
import { requestMessagePinNavigation } from '../../src/message-pin-navigation.js';

const pinMessageMock = vi.hoisted(() => vi.fn());
const unpinMessageMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/hooks/useMessagePins.js', () => ({
  useMessagePins: () => ({
    pins: [],
    loading: false,
    mutating: false,
    error: null,
    pinMessage: pinMessageMock,
    unpinMessage: unpinMessageMock,
    clearError: vi.fn(),
  }),
}));

vi.mock('../../src/session-repo-context-store.js', () => ({
  useSessionRepoContext: () => ({ currentBranch: 'dev' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string) => key,
  }),
}));

vi.mock('../../src/components/ChatMarkdown.js', () => ({
  ChatMarkdown: ({ text }: { text: string }) => <span>{text}</span>,
}));

import { ChatView } from '../../src/components/ChatView.js';

function userEvent(): TimelineEvent {
  return {
    eventId: 'event-to-pin',
    sessionId: 'deck_pin_main',
    ts: 1234,
    seq: 1,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type: 'user.message',
    payload: { text: 'Keep this exact message' },
  };
}

describe('ChatView message pin action', () => {
  beforeEach(() => {
    pinMessageMock.mockReset().mockResolvedValue(null);
    unpinMessageMock.mockReset();
    Reflect.deleteProperty(window, 'ontouchstart');
  });
  afterEach(cleanup);

  it('places the compact pin counter after the font and branch controls', () => {
    const { container } = render(
      <ChatView
        events={[]}
        loading={false}
        sessionId="deck_pin_main"
        serverId="srv-1"
        workdir="/repo"
        onViewRepo={vi.fn()}
        messagePinsEnabled
      />,
    );
    const titlebar = container.querySelector('.chat-titlebar');
    const trigger = screen.getByTestId('message-pins-trigger');
    expect(titlebar).not.toBeNull();
    expect(titlebar!.children).toHaveLength(3);
    expect(titlebar!.children[0]?.querySelector('[aria-label="Aa"]')).toBeTruthy();
    expect(titlebar!.children[1]?.querySelector('.session-repo-branch-summary')).toBeTruthy();
    expect(titlebar!.children[2]).toBe(trigger.closest('.message-pins-bar'));
    expect(trigger.textContent).toBe('📌0/0');
  });

  it('wires the message action menu to a session-scoped pin payload', async () => {
    const { container } = render(
      <ChatView
        events={[userEvent()]}
        loading={false}
        sessionId="deck_pin_main"
        serverId="srv-1"
        messagePinsEnabled
      />,
    );
    const bubble = container.querySelector<HTMLElement>('[data-event-id="event-to-pin"]');
    expect(bubble).not.toBeNull();
    fireEvent.contextMenu(bubble!, { clientX: 40, clientY: 40 });
    await waitFor(() => expect(screen.getByText('messagePins.pin')).toBeTruthy());
    fireEvent.click(screen.getByText('messagePins.pin'));
    expect(pinMessageMock).toHaveBeenCalledWith({
      eventId: 'event-to-pin',
      eventTs: 1234,
      eventType: 'user.message',
      text: 'Keep this exact message',
    });
  });

  it('locates a merged pinned event by scrolling only the chat viewport', async () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    const first: TimelineEvent = {
      ...userEvent(),
      eventId: 'assistant-first',
      type: 'assistant.text',
      payload: { text: 'first part' },
    };
    const second: TimelineEvent = {
      ...first,
      eventId: 'assistant-pinned',
      ts: 1235,
      seq: 2,
      payload: { text: 'second part' },
    };
    try {
      render(
        <ChatView
          events={[first, second]}
          loading={false}
          sessionId="deck_pin_main"
          serverId="srv-1"
          messagePinsEnabled
        />,
      );
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const viewport = document.querySelector('.chat-view') as HTMLElement;
      const target = document.querySelector('[data-event-id="assistant-first"]') as HTMLElement;
      const scrollTo = vi.fn();
      viewport.scrollTo = scrollTo;
      Object.defineProperties(viewport, {
        clientHeight: { configurable: true, value: 400 },
        scrollHeight: { configurable: true, value: 1_200 },
        scrollTop: { configurable: true, writable: true, value: 100 },
      });
      viewport.getBoundingClientRect = () => ({ top: 50, bottom: 450, height: 400, left: 0, right: 600, width: 600, x: 0, y: 50, toJSON: () => ({}) });
      target.getBoundingClientRect = () => ({ top: 550, bottom: 590, height: 40, left: 0, right: 600, width: 600, x: 0, y: 550, toJSON: () => ({}) });
      requestMessagePinNavigation({
        id: 'pin-assistant',
        serverId: 'srv-1',
        sessionName: 'deck_pin_main',
        eventId: 'assistant-pinned',
        eventTs: 1235,
        eventType: 'assistant.text',
        text: 'second part',
        createdAt: 1,
        updatedAt: 1,
      });
      await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));
      const scrollOptions = scrollTo.mock.calls[0]?.[0] as ScrollToOptions;
      expect(scrollOptions.behavior).toBe('smooth');
      expect(scrollOptions.top).toBeGreaterThanOrEqual(0);
      expect(scrollOptions.top).toBeLessThanOrEqual(800);
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(target).not.toBeNull();
      expect(document.querySelector('[data-event-id="assistant-pinned"]')).toBeNull();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
