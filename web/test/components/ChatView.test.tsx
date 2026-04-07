/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { render, waitFor, cleanup } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from '../../src/components/ChatView.js';

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
  afterEach(() => {
    cleanup();
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
});
