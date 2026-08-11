/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import type { TimelineEvent } from '../../src/ws-client.js';
import type { MessagePin } from '../../../shared/message-pins.js';
import {
  __resetMessagePinNavigationForTests,
  getPendingMessagePin,
  requestMessagePinNavigation,
} from '../../src/message-pin-navigation.js';

const pinMessageMock = vi.hoisted(() => vi.fn());
const unpinMessageMock = vi.hoisted(() => vi.fn());
const messagePinsState = vi.hoisted(() => ({ pins: [] as MessagePin[] }));
const previewModePref = vi.hoisted(() => ({
  value: null as 'rendered' | 'text' | null,
  save: vi.fn(),
  requestedKeys: [] as Array<string | null>,
}));

vi.mock('../../src/hooks/useMessagePins.js', () => ({
  useMessagePins: () => ({
    pins: messagePinsState.pins,
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

vi.mock('../../src/hooks/usePref.js', () => ({
  parseBooleanish: (raw: unknown) => (raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null),
  usePref: (key: string | null) => {
    previewModePref.requestedKeys.push(key);
    if (key === 'message_pin_preview_mode') {
      return {
        value: previewModePref.value,
        rawValue: previewModePref.value,
        loaded: true,
        loading: false,
        stale: false,
        error: null,
        save: previewModePref.save,
        set: vi.fn(),
        reload: vi.fn(),
      };
    }
    return {
      value: true,
      rawValue: true,
      loaded: true,
      loading: false,
      stale: false,
      error: null,
      save: vi.fn(),
      set: vi.fn(),
      reload: vi.fn(),
    };
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string) => key,
  }),
}));

vi.mock('../../src/components/ChatMarkdown.js', () => ({
  ChatMarkdown: ({ text }: { text: string }) => text.includes('127.0.0.1:8787')
    ? (
      <span data-testid="chat-markdown" data-source-text={text}>
        <strong>Local access</strong>: http://127.0.0.1:8787/
        <span class="chat-loopback-actions">
          <button>Open through IM.codes proxy</button>
          <button>Open directly on LAN</button>
        </span>
      </span>
    )
    : <span data-testid="chat-markdown">{text}</span>,
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
    messagePinsState.pins = [];
    previewModePref.value = null;
    previewModePref.save.mockReset().mockResolvedValue(undefined);
    previewModePref.requestedKeys.length = 0;
    __resetMessagePinNavigationForTests();
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

  it('pins source Markdown instead of rendered loopback action labels', async () => {
    const sourceText = '**Local access**: http://127.0.0.1:8787/';
    const event: TimelineEvent = {
      ...userEvent(),
      type: 'assistant.text',
      payload: { text: sourceText },
    };
    const { container } = render(
      <ChatView
        events={[event]}
        loading={false}
        sessionId="deck_pin_main"
        serverId="srv-1"
        messagePinsEnabled
      />,
    );
    const bubble = container.querySelector<HTMLElement>('[data-event-id="event-to-pin"]');
    expect(bubble?.textContent).toContain('Open through IM.codes proxy');
    fireEvent.contextMenu(bubble!, { clientX: 40, clientY: 40 });
    await waitFor(() => expect(screen.getByText('messagePins.pin')).toBeTruthy());
    fireEvent.click(screen.getByText('messagePins.pin'));

    expect(pinMessageMock).toHaveBeenCalledWith({
      eventId: 'event-to-pin',
      eventTs: 1234,
      eventType: 'assistant.text',
      text: sourceText,
    });
  });

  it('pins the complete source text of a merged assistant bubble', async () => {
    const first: TimelineEvent = {
      ...userEvent(),
      type: 'assistant.text',
      payload: { text: '**First part**' },
    };
    const second: TimelineEvent = {
      ...first,
      eventId: 'event-to-pin-part-2',
      ts: 1235,
      seq: 2,
      payload: { text: 'Second part' },
    };
    const { container } = render(
      <ChatView
        events={[first, second]}
        loading={false}
        sessionId="deck_pin_main"
        serverId="srv-1"
        messagePinsEnabled
      />,
    );
    const bubble = container.querySelector<HTMLElement>('[data-event-id="event-to-pin"]');
    fireEvent.contextMenu(bubble!, { clientX: 40, clientY: 40 });
    await waitFor(() => expect(screen.getByText('messagePins.pin')).toBeTruthy());
    fireEvent.click(screen.getByText('messagePins.pin'));

    expect(pinMessageMock).toHaveBeenCalledWith({
      eventId: 'event-to-pin',
      eventTs: 1234,
      eventType: 'assistant.text',
      text: '**First part**\nSecond part',
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

  it('carries the source session and automatically locates a pin in another mounted chat', async () => {
    const targetEvent: TimelineEvent = {
      ...userEvent(),
      eventId: 'event-in-target',
      sessionId: 'deck_pin_target',
      payload: { text: 'Pinned target message' },
    };
    messagePinsState.pins = [{
      id: 'pin-in-target',
      serverId: 'srv-1',
      sessionName: 'deck_pin_target',
      eventId: targetEvent.eventId,
      eventTs: targetEvent.ts,
      eventType: 'user.message',
      text: 'Pinned target message',
      createdAt: 1,
      updatedAt: 1,
    }];

    const { subscribeMessagePinNavigation } = await import('../../src/message-pin-navigation.js');
    const observedSources: Array<string | null> = [];
    const unsubscribe = subscribeMessagePinNavigation((_pin, sourceSessionName) => {
      observedSources.push(sourceSessionName);
    });

    try {
      render(
        <div>
          <div data-testid="source-chat">
            <ChatView
              events={[]}
              loading={false}
              sessionId="deck_pin_source"
              serverId="srv-1"
              messagePinsEnabled
            />
          </div>
          <div data-testid="target-chat">
            <ChatView
              events={[targetEvent]}
              loading={false}
              sessionId="deck_pin_target"
              serverId="srv-1"
              messagePinsEnabled
            />
          </div>
        </div>,
      );
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const targetChat = screen.getByTestId('target-chat');
      const viewport = targetChat.querySelector('.chat-view') as HTMLElement;
      const target = targetChat.querySelector('[data-event-id="event-in-target"]') as HTMLElement;
      const scrollTo = vi.fn();
      viewport.scrollTo = scrollTo;
      Object.defineProperties(viewport, {
        clientHeight: { configurable: true, value: 400 },
        scrollHeight: { configurable: true, value: 1_200 },
        scrollTop: { configurable: true, writable: true, value: 100 },
      });
      viewport.getBoundingClientRect = () => ({ top: 50, bottom: 450, height: 400, left: 0, right: 600, width: 600, x: 0, y: 50, toJSON: () => ({}) });
      target.getBoundingClientRect = () => ({ top: 550, bottom: 590, height: 40, left: 0, right: 600, width: 600, x: 0, y: 550, toJSON: () => ({}) });

      const sourceChat = within(screen.getByTestId('source-chat'));
      fireEvent.click(sourceChat.getByTestId('message-pins-trigger'));
      fireEvent.click(sourceChat.getByText('messagePins.allTab'));
      fireEvent.click(sourceChat.getByText('Pinned target message'));
      expect(scrollTo).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText('messagePins.jump'));

      await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));
      expect(observedSources).toContain('deck_pin_source');
      expect(getPendingMessagePin('deck_pin_target')).toBeNull();
    } finally {
      unsubscribe();
    }
  });

  it('quotes a previewed cross-session pin into the current chat without navigating', () => {
    const onQuote = vi.fn();
    messagePinsState.pins = [{
      id: 'pin-for-current-quote',
      serverId: 'srv-1',
      sessionName: 'deck_pin_other',
      eventId: 'event-in-other',
      eventTs: 1234,
      eventType: 'assistant.text',
      text: 'Quote this into the current composer',
      createdAt: 1,
      updatedAt: 1,
    }];

    render(
      <ChatView
        events={[]}
        loading={false}
        sessionId="deck_pin_current"
        serverId="srv-1"
        onQuote={onQuote}
        messagePinsEnabled
      />,
    );

    fireEvent.click(screen.getByTestId('message-pins-trigger'));
    fireEvent.click(screen.getByText('messagePins.allTab'));
    fireEvent.click(screen.getByText('Quote this into the current composer'));
    fireEvent.click(screen.getByText('common.quote'));

    expect(onQuote).toHaveBeenCalledWith('Quote this into the current composer');
    expect(getPendingMessagePin('deck_pin_other')).toBeNull();
    expect(screen.queryByText('messagePins.previewTitle')).toBeNull();
  });

  it('reuses ChatMarkdown by default and saves preview mode as an account preference', () => {
    messagePinsState.pins = [{
      id: 'pin-markdown-preview',
      serverId: 'srv-1',
      sessionName: 'deck_pin_main',
      eventId: 'event-markdown-preview',
      eventTs: 1234,
      eventType: 'assistant.text',
      text: '**Rendered by chat markdown**',
      createdAt: 1,
      updatedAt: 1,
    }];

    render(
      <ChatView
        events={[]}
        loading={false}
        sessionId="deck_pin_main"
        serverId="srv-1"
        messagePinsEnabled
      />,
    );

    fireEvent.click(screen.getByTestId('message-pins-trigger'));
    fireEvent.click(screen.getByText('**Rendered by chat markdown**'));

    expect(screen.getByTestId('chat-markdown').textContent).toBe('**Rendered by chat markdown**');
    expect(previewModePref.requestedKeys).toContain('message_pin_preview_mode');
    fireEvent.click(screen.getByRole('button', { name: 'messagePins.textMode' }));
    expect(previewModePref.save).toHaveBeenCalledWith('text');
  });

  it('recovers an existing polluted pin from its loaded source event in every preview mode', () => {
    const sourceText = '**Local access**: http://127.0.0.1:8787/';
    const pollutedText = 'Local access: http://127.0.0.1:8787/Open through IM.codes proxyOpen directly on LAN';
    const onQuote = vi.fn();
    messagePinsState.pins = [{
      id: 'pin-polluted-loopback',
      serverId: 'srv-1',
      sessionName: 'deck_pin_main',
      eventId: 'event-to-pin',
      eventTs: 1234,
      eventType: 'user.message',
      text: pollutedText,
      createdAt: 1,
      updatedAt: 1,
    }];

    const props = {
      events: [{ ...userEvent(), payload: { text: sourceText } }],
      loading: false,
      sessionId: 'deck_pin_main',
      serverId: 'srv-1',
      onQuote,
      messagePinsEnabled: true,
    };
    const view = render(
      <ChatView
        {...props}
      />,
    );

    fireEvent.click(screen.getByTestId('message-pins-trigger'));
    expect(document.querySelector('.message-pin-text')?.textContent).toBe(sourceText);
    fireEvent.click(document.querySelector('.message-pin-open')!);
    expect(screen.getByTestId('chat-markdown').getAttribute('data-source-text')).toBe(sourceText);

    previewModePref.value = 'text';
    view.rerender(<ChatView {...props} events={[...props.events]} />);
    expect(document.querySelector('pre.zoom-text-content')?.textContent).toBe(sourceText);
    fireEvent.click(screen.getByText('common.quote'));
    expect(onQuote).toHaveBeenCalledWith(sourceText);
  });
});
