/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { render, waitFor, cleanup, fireEvent } from '@testing-library/preact';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from '../../src/components/ChatView.js';

type ViewportListener = () => void;
const visualViewportListeners = new Map<string, Set<ViewportListener>>();
const visualViewportMock = {
  height: 800,
  addEventListener: vi.fn((type: string, listener: ViewportListener) => {
    if (!visualViewportListeners.has(type)) visualViewportListeners.set(type, new Set());
    visualViewportListeners.get(type)!.add(listener);
  }),
  removeEventListener: vi.fn((type: string, listener: ViewportListener) => {
    visualViewportListeners.get(type)?.delete(listener);
  }),
};

function emitVisualViewport(type: string) {
  for (const listener of visualViewportListeners.get(type) ?? []) listener();
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../src/components/ChatMarkdown.js', () => ({
  ChatMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock('../../src/components/FileBrowser.js', () => ({
  FileBrowser: () => null,
}));

vi.mock('../../src/components/FloatingPanel.js', () => ({
  FloatingPanel: ({ children }: { children?: preact.ComponentChildren }) => <div>{children}</div>,
}));

describe('ChatView', () => {
  const originalVisualViewport = window.visualViewport;

  (window as Window & { visualViewport?: typeof visualViewportMock }).visualViewport = visualViewportMock as any;

  afterEach(() => {
    cleanup();
    visualViewportMock.height = 800;
    visualViewportListeners.clear();
  });

  afterAll(() => {
    (window as Window & { visualViewport?: typeof visualViewportMock }).visualViewport = originalVisualViewport as any;
  });

  it('keeps preview mode pinned to the bottom during streaming updates with the same timestamp', async () => {
    const initialEvents = [
      {
        eventId: 'evt-1',
        type: 'assistant.text',
        ts: 1000,
        payload: { text: 'hello' },
      },
    ] as any;

    const { container, rerender } = render(
      <ChatView
        events={initialEvents}
        loading={false}
        sessionId="deck_sub_preview"
        preview
      />,
    );

    const scrollEl = container.querySelector('.chat-view') as HTMLDivElement;
    Object.defineProperty(scrollEl, 'scrollTop', { configurable: true, writable: true, value: 0 });
    Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, value: 200 });

    await waitFor(() => {
      expect(scrollEl.scrollTop).toBe(1200);
    });

    scrollEl.scrollTop = 25;
    Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, value: 1600 });

    rerender(
      <ChatView
        events={[
          {
            eventId: 'evt-1',
            type: 'assistant.text',
            ts: 1000,
            payload: { text: 'hello world' },
          },
        ] as any}
        loading={false}
        sessionId="deck_sub_preview"
        preview
      />,
    );

    await waitFor(() => {
      expect(scrollEl.scrollTop).toBe(1600);
    });
  });

  it('forces the main chat view to follow streamed updates with the same timestamp', async () => {
    const initialEvents = [
      {
        eventId: 'evt-1',
        type: 'assistant.text',
        ts: 1000,
        payload: { text: 'hello' },
      },
    ] as any;

    const { container, rerender } = render(
      <ChatView
        events={initialEvents}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    const scrollEl = container.querySelector('.chat-view') as HTMLDivElement;
    Object.defineProperty(scrollEl, 'scrollTop', { configurable: true, writable: true, value: 0 });
    Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, value: 200 });

    await waitFor(() => {
      expect(scrollEl.scrollTop).toBe(1200);
    });

    scrollEl.scrollTop = 50;
    Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, value: 1800 });

    rerender(
      <ChatView
        events={[
          {
            eventId: 'evt-1',
            type: 'assistant.text',
            ts: 1000,
            payload: { text: 'hello world' },
          },
        ] as any}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    await waitFor(() => {
      expect(scrollEl.scrollTop).toBe(1800);
    });
  });

  it('restores mobile keyboard scroll position from bottom offset instead of snapping to top', async () => {
    const initialEvents = [
      {
        eventId: 'evt-1',
        type: 'assistant.text',
        ts: 1000,
        payload: { text: 'hello' },
      },
    ] as any;

    const { container } = render(
      <ChatView
        events={initialEvents}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    const scrollEl = container.querySelector('.chat-view') as HTMLDivElement;
    let scrollTopValue = 0;
    let scrollHeightValue = 1200;
    let clientHeightValue = 200;
    Object.defineProperty(scrollEl, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value) => { scrollTopValue = value; },
    });
    Object.defineProperty(scrollEl, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(scrollEl, 'clientHeight', {
      configurable: true,
      get: () => clientHeightValue,
    });

    await waitFor(() => {
      expect(scrollTopValue).toBe(1200);
    });

    scrollTopValue = 600;
    scrollEl.dispatchEvent(new Event('scroll'));
    document.dispatchEvent(new FocusEvent('focusin'));

    scrollTopValue = 0;
    scrollHeightValue = 1600;
    visualViewportMock.height = 620;
    emitVisualViewport('resize');

    expect(scrollTopValue).toBe(1000);
  });

  it('keeps the chat pinned to bottom when the mobile keyboard closes', async () => {
    const initialEvents = [
      {
        eventId: 'evt-1',
        type: 'assistant.text',
        ts: 1000,
        payload: { text: 'hello' },
      },
    ] as any;

    const { container } = render(
      <ChatView
        events={initialEvents}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    const scrollEl = container.querySelector('.chat-view') as HTMLDivElement;
    let scrollTopValue = 0;
    let scrollHeightValue = 1200;
    let clientHeightValue = 200;
    Object.defineProperty(scrollEl, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value) => { scrollTopValue = value; },
    });
    Object.defineProperty(scrollEl, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(scrollEl, 'clientHeight', {
      configurable: true,
      get: () => clientHeightValue,
    });

    await waitFor(() => {
      expect(scrollTopValue).toBe(1200);
    });

    document.dispatchEvent(new FocusEvent('focusin'));

    scrollTopValue = 0;
    scrollHeightValue = 1600;
    visualViewportMock.height = 900;
    emitVisualViewport('resize');

    await waitFor(() => {
      expect(scrollTopValue).toBe(1600);
    });
  });

  it('ignores transient top jumps while auto-follow is active instead of loading older history', async () => {
    const onLoadOlder = vi.fn();
    const initialEvents = [
      {
        eventId: 'evt-1',
        type: 'assistant.text',
        ts: 1000,
        payload: { text: 'hello' },
      },
    ] as any;

    const { container } = render(
      <ChatView
        events={initialEvents}
        loading={false}
        sessionId="deck_main_brain"
        onLoadOlder={onLoadOlder}
      />,
    );

    const scrollEl = container.querySelector('.chat-view') as HTMLDivElement;
    let scrollTopValue = 0;
    Object.defineProperty(scrollEl, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value) => { scrollTopValue = value; },
    });
    Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, value: 200 });

    await waitFor(() => {
      expect(scrollTopValue).toBe(1200);
    });

    scrollTopValue = 0;
    fireEvent.scroll(scrollEl);

    await waitFor(() => {
      expect(scrollTopValue).toBe(1200);
    });
    expect(onLoadOlder).not.toHaveBeenCalled();
  });
});
