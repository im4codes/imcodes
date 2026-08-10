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

  it('locates a pinned assistant event even when history merges it under an earlier block id', async () => {
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
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      expect(document.querySelector('[data-event-id="assistant-first"]')).not.toBeNull();
      expect(document.querySelector('[data-event-id="assistant-pinned"]')).toBeNull();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
