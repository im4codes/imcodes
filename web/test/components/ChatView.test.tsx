/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { render, waitFor, cleanup, fireEvent } from '@testing-library/preact';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from '../../src/components/ChatView.js';

const chatMarkdownRenderSpy = vi.hoisted(() => vi.fn());

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
  ChatMarkdown: ({ text }: { text: string }) => {
    chatMarkdownRenderSpy(text);
    return <div>{text}</div>;
  },
}));

vi.mock('../../src/components/FileBrowser.js', () => ({
  FileBrowser: () => null,
}));

vi.mock('../../src/components/FloatingPanel.js', () => ({
  FloatingPanel: ({ children }: { children?: preact.ComponentChildren }) => <div>{children}</div>,
}));

describe('ChatView', () => {
  const originalVisualViewport = window.visualViewport;
  const clipboardWriteText = vi.fn().mockResolvedValue(undefined);

  (window as Window & { visualViewport?: typeof visualViewportMock }).visualViewport = visualViewportMock as any;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWriteText },
  });

  afterEach(() => {
    cleanup();
    chatMarkdownRenderSpy.mockClear();
    clipboardWriteText.mockClear();
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

  it('shows a small refreshing spinner while history gap-fill is in progress', () => {
    const { container } = render(
      <ChatView
        events={[] as any}
        loading={false}
        refreshing
        sessionId="deck_sub_preview"
      />,
    );

    expect(container.querySelector('.chat-refreshing-spinner')).not.toBeNull();
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


  it('renders memory context as a collapsible timeline card linked to the current message', async () => {
    const { container, getByText } = render(
      <ChatView
        events={[
          {
            eventId: 'evt-user',
            type: 'user.message',
            ts: 1000,
            payload: { text: 'Fix reconnect issues' },
          },
          {
            eventId: 'evt-memory',
            type: 'memory.context',
            ts: 1001,
            payload: {
              relatedToEventId: 'evt-user',
              query: 'Fix reconnect issues',
              injectedText: '[Related past work]\n- [codedeck] Fix websocket reconnect loop',
              items: [
                {
                  id: 'mem-1',
                  projectId: 'codedeck',
                  summary: 'Fix websocket reconnect loop',
                  relevanceScore: 0.812,
                  hitCount: 4,
                  lastUsedAt: 1710000000000,
                },
              ],
            },
          },
        ] as any}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    expect(container.querySelectorAll('.chat-event.chat-user')).toHaveLength(1);
    expect(container.querySelectorAll('.chat-memory-context')).toHaveLength(1);
    expect(container.querySelector('.chat-linked-event-group')).not.toBeNull();
    expect(getByText('chat.memory_context_title')).toBeTruthy();
    expect(container.textContent).not.toContain('Fix websocket reconnect loop');

    fireEvent.click(getByText('chat.memory_context_title'));

    await waitFor(() => {
      expect(container.textContent).toContain('Fix websocket reconnect loop');
      expect(container.textContent).toContain('codedeck');
      expect(container.textContent).toContain('chat.memory_context_score');
      expect(container.textContent).toContain('sharedContext.management.memoryRecalls');
      expect(container.textContent).toContain('sharedContext.management.memoryLastRecalled');
      expect(container.textContent).toContain('chat.memory_context_collapse_bottom');
    });

    fireEvent.click(getByText('chat.memory_context_collapse_bottom'));
    await waitFor(() => {
      expect(container.textContent).not.toContain('Fix websocket reconnect loop');
    });
  });

  it('shows startup injection reason for startup memory.context events', async () => {
    const { container, getByText } = render(
      <ChatView
        events={[
          {
            eventId: 'evt-memory-startup',
            type: 'memory.context',
            ts: 1001,
            payload: {
              reason: 'startup',
              injectedText: '[Related past work]\n- [codedeck] Fix websocket reconnect loop',
              items: [
                {
                  id: 'mem-1',
                  projectId: 'codedeck',
                  summary: 'Fix websocket reconnect loop',
                },
              ],
            },
          },
        ] as any}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    expect(container.querySelector('.chat-linked-event-group')).toBeNull();
    // Startup-reason memory-context cards now use a distinct title so users
    // can tell a pre-loaded history preamble from a per-prompt recall at a
    // glance. The collapsed header therefore shows
    // chat.memory_context_startup_title, not the plain recall title.
    fireEvent.click(getByText('chat.memory_context_startup_title'));

    await waitFor(() => {
      expect(container.textContent).toContain('chat.memory_context_startup_reason');
      expect(container.textContent).toContain('Fix websocket reconnect loop');
    });
  });

  it('renders status-only memory context hints collapsed by default — only the one-line reason is visible', async () => {
    const { container, getByText } = render(
      <ChatView
        events={[
          {
            eventId: 'evt-user',
            type: 'user.message',
            ts: 1000,
            payload: { text: 'Continue' },
          },
          {
            eventId: 'evt-memory-status',
            type: 'memory.context',
            ts: 1001,
            payload: {
              relatedToEventId: 'evt-user',
              query: 'Continue',
              status: 'deduped_recently',
              matchedCount: 2,
              dedupedCount: 2,
              items: [],
            },
          },
        ] as any}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    const statusCard = container.querySelector('.chat-memory-context-status');
    expect(statusCard).not.toBeNull();
    // Headline reason is visible without user interaction.
    expect(container.textContent).toContain('chat.memory_context_status_deduped_recently');
    // Detail is hidden until the user expands the card.
    expect(container.textContent).not.toContain('chat.memory_context_status_deduped_recently_detail');
    // The query line is redundant with the preceding user.message bubble —
    // it must not re-appear in the status card regardless of expand state.
    expect(container.textContent).not.toContain('chat.memory_context_query');

    // Expanding the card reveals the detail line.
    fireEvent.click(getByText('chat.memory_context_status_deduped_recently'));
    await waitFor(() => {
      expect(container.textContent).toContain('chat.memory_context_status_deduped_recently_detail');
    });
    // Query stays hidden even after expanding — it was always redundant.
    expect(container.textContent).not.toContain('chat.memory_context_query');
  });

  it('renders status-only cards with no detail as a flat one-liner (no toggle)', () => {
    // Not every status has a detail translation — for those the card must
    // degrade to a flat row with no caret / no click handler.
    const { container } = render(
      <ChatView
        events={[
          {
            eventId: 'evt-memory-no-detail',
            type: 'memory.context',
            ts: 1001,
            payload: {
              query: 'x',
              status: 'no_matches',
              matchedCount: 0,
              items: [],
            },
          },
        ] as any}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );
    const card = container.querySelector('.chat-memory-context-status');
    expect(card).not.toBeNull();
    expect(container.querySelector('.chat-memory-context-status-toggle')).toBeNull();
    expect(container.querySelector('.chat-memory-context-status-row')).not.toBeNull();
  });

  it('renders Auto progress notes as a separate assistant block instead of merging them into the model reply', async () => {
    const events = [
      {
        eventId: 'evt-assistant',
        type: 'assistant.text',
        ts: 1000,
        payload: { text: 'Implemented the feature.', streaming: false },
      },
      {
        eventId: 'evt-auto',
        type: 'assistant.text',
        ts: 1001,
        payload: {
          text: 'Auto: checking whether the task is complete...',
          streaming: false,
          automation: true,
          automationKind: 'supervision-status',
        },
      },
    ] as any;

    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    expect(chatMarkdownRenderSpy).toHaveBeenCalledTimes(2);
    expect(chatMarkdownRenderSpy.mock.calls[0]?.[0]).toBe('Implemented the feature.');
    expect(chatMarkdownRenderSpy.mock.calls[1]?.[0]).toBe('Auto: checking whether the task is complete...');
    expect(container.querySelectorAll('.chat-assistant')).toHaveLength(2);
    expect(container.querySelectorAll('.chat-assistant-automation')).toHaveLength(1);
  });

  it('keeps only the latest Auto note when supervision reuses the same event id', async () => {
    const events = [
      {
        eventId: 'supervision-note:deck_main_brain',
        type: 'assistant.text',
        ts: 1001,
        payload: {
          text: 'Auto: checking whether the task is complete...',
          streaming: false,
          automation: true,
          automationKind: 'supervision-status',
        },
      },
      {
        eventId: 'supervision-note:deck_main_brain',
        type: 'assistant.text',
        ts: 1002,
        payload: {
          text: 'Auto: task looks complete.',
          streaming: false,
          automation: true,
          automationKind: 'supervision-complete',
        },
      },
    ] as any;

    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    expect(chatMarkdownRenderSpy).toHaveBeenCalledTimes(1);
    expect(chatMarkdownRenderSpy.mock.calls[0]?.[0]).toBe('Auto: task looks complete.');
    expect(container.textContent).toContain('Auto: task looks complete.');
    expect(container.textContent).not.toContain('Auto: checking whether the task is complete...');
    expect(container.querySelectorAll('.chat-assistant-automation')).toHaveLength(1);
  });

  it('renders transport-origin memory.context cards the same as process recall cards', async () => {
    const { container, getByText } = render(
      <ChatView
        events={[
          {
            eventId: 'evt-user-transport',
            type: 'user.message',
            ts: 1000,
            payload: { text: 'Recall the transport fix' },
          },
          {
            eventId: 'evt-memory-transport',
            type: 'memory.context',
            ts: 1001,
            payload: {
              relatedToEventId: 'evt-user-transport',
              reason: 'message',
              runtimeFamily: 'transport',
              injectionSurface: 'normalized-payload',
              authoritySource: 'processed_local',
              sourceKind: 'local_processed',
              query: 'Recall the transport fix',
              injectedText: '[Related past work]\n- [repo-1] Fixed transport recall visibility',
              items: [
                {
                  id: 'mem-transport-1',
                  projectId: 'repo-1',
                  summary: 'Fixed transport recall visibility',
                  relevanceScore: 0.91,
                  hitCount: 2,
                  lastUsedAt: 1710000000000,
                },
              ],
            },
          },
        ] as any}
        loading={false}
        sessionId="deck_transport_brain"
      />,
    );

    expect(container.querySelector('.chat-linked-event-group')).not.toBeNull();
    fireEvent.click(getByText('chat.memory_context_title'));

    await waitFor(() => {
      expect(container.textContent).toContain('Fixed transport recall visibility');
      expect(container.querySelector('.chat-memory-context')?.getAttribute('data-related-to')).toBe('evt-user-transport');
    });
  });

  it('renders transport memory.context events with linked evidence', async () => {
    const { container, getByText } = render(
      <ChatView
        events={[
          {
            eventId: 'evt-user-transport',
            type: 'user.message',
            ts: 1000,
            payload: { text: 'Recall transport memory' },
          },
          {
            eventId: 'evt-memory-transport',
            type: 'memory.context',
            ts: 1001,
            payload: {
              reason: 'message',
              runtimeFamily: 'transport',
              injectionSurface: 'normalized-payload',
              relatedToEventId: 'evt-user-transport',
              query: 'Recall transport memory',
              injectedText: '[Related past work]\n- [codedeck] Transport recall parity reached',
              items: [
                {
                  id: 'mem-transport-1',
                  projectId: 'codedeck',
                  summary: 'Transport recall parity reached',
                  relevanceScore: 0.9,
                  hitCount: 2,
                },
              ],
            },
          },
        ] as any}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    expect(container.querySelector('.chat-memory-context')).not.toBeNull();
    fireEvent.click(getByText('chat.memory_context_title'));

    await waitFor(() => {
      expect(container.textContent).toContain('Transport recall parity reached');
      expect(container.textContent).toContain('codedeck');
      expect(container.textContent).toContain('chat.memory_context_query');
    });
  });

  it('does not rerender an unchanged assistant block when the parent chat rerenders', async () => {
    const { rerender } = render(
      <ChatView
        events={[
          {
            eventId: 'evt-1',
            type: 'assistant.text',
            ts: 1000,
            payload: { text: 'stable block' },
          },
        ] as any}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    expect(chatMarkdownRenderSpy.mock.calls.filter(([text]) => text === 'stable block')).toHaveLength(1);

    rerender(
      <ChatView
        events={[
          {
            eventId: 'evt-1',
            type: 'assistant.text',
            ts: 1000,
            payload: { text: 'stable block' },
          },
          {
            eventId: 'evt-2',
            type: 'user.message',
            ts: 1001,
            payload: { text: 'new user message' },
          },
        ] as any}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    expect(chatMarkdownRenderSpy.mock.calls.filter(([text]) => text === 'stable block')).toHaveLength(1);
  });

  it('does not render running or idle session states as chat rows', () => {
    const { container } = render(
      <ChatView
        events={[
          {
            eventId: 'evt-running',
            type: 'session.state',
            ts: 1000,
            payload: { state: 'running' },
          },
          {
            eventId: 'evt-idle',
            type: 'session.state',
            ts: 1001,
            payload: { state: 'idle' },
          },
          {
            eventId: 'evt-msg',
            type: 'assistant.text',
            ts: 1002,
            payload: { text: 'real message' },
          },
        ] as any}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    expect(container.textContent).not.toContain('Agent working...');
    expect(container.textContent).not.toContain('Agent idle');
    expect(container.textContent).toContain('real message');
  });

  it('still renders non-live session state entries such as stopped', () => {
    const { container } = render(
      <ChatView
        events={[
          {
            eventId: 'evt-stopped',
            type: 'session.state',
            ts: 1000,
            payload: { state: 'stopped' },
          },
        ] as any}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    expect(container.textContent).toContain('Session stopped');
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

  it('shows tool input args from result detail when tool.call has no input (transport SDK)', async () => {
    // Transport SDK: tool.call arrives at content_block_start with NO input,
    // tool.result arrives at content_block_stop with input in detail.input.
    const events = [
      {
        eventId: 'tc-1',
        type: 'tool.call',
        ts: 1000,
        payload: { tool: 'Read' },
      },
      {
        eventId: 'tr-1',
        type: 'tool.result',
        ts: 1001,
        payload: {
          output: 'file contents...',
          detail: {
            kind: 'tool_use_complete',
            summary: 'Read',
            input: { file_path: '/home/user/project/src/index.ts' },
          },
        },
      },
    ] as any;

    const { container } = render(
      <ChatView events={events} loading={false} sessionId="test" />,
    );

    const toolEl = container.querySelector('.chat-tool');
    expect(toolEl).not.toBeNull();
    const text = toolEl!.textContent ?? '';
    // Must contain the file path from result detail, not just "Read ✓"
    expect(text).toContain('/home/user/project/src/index.ts');
    expect(text).toContain('✓');
  });

  it('shows tool input inline when tool.call already has input (tmux agent)', async () => {
    const events = [
      {
        eventId: 'tc-2',
        type: 'tool.call',
        ts: 2000,
        payload: { tool: 'Bash', input: 'npm test' },
      },
      {
        eventId: 'tr-2',
        type: 'tool.result',
        ts: 2001,
        payload: { output: 'all tests passed' },
      },
    ] as any;

    const { container } = render(
      <ChatView events={events} loading={false} sessionId="test" />,
    );

    const toolEl = container.querySelector('.chat-tool');
    const text = toolEl!.textContent ?? '';
    expect(text).toContain('npm test');
    expect(text).toContain('✓');
  });

  it('shows Agent tool prompt from result detail.input', async () => {
    const events = [
      {
        eventId: 'tc-3',
        type: 'tool.call',
        ts: 3000,
        payload: { tool: 'Agent' },
      },
      {
        eventId: 'tr-3',
        type: 'tool.result',
        ts: 3001,
        payload: {
          detail: {
            kind: 'tool_use_complete',
            input: { prompt: 'Find the bug in auth module', description: 'Auth bug search' },
          },
        },
      },
    ] as any;

    const { container } = render(
      <ChatView events={events} loading={false} sessionId="test" />,
    );

    const toolEl = container.querySelector('.chat-tool');
    const text = toolEl!.textContent ?? '';
    // Must show the prompt, not just "Agent ✓"
    expect(text).toContain('Find the bug in auth module');
  });

  it('copies a chat message without the trailing timestamp from the context menu', async () => {
    const hadTouchStart = 'ontouchstart' in window;
    const originalTouchStart = (window as Window & { ontouchstart?: unknown }).ontouchstart;
    if (hadTouchStart) delete (window as Window & { ontouchstart?: unknown }).ontouchstart;
    try {
      const { container, getByText } = render(
        <ChatView
          events={[
            {
              eventId: 'evt-user-copy',
              type: 'user.message',
              ts: new Date('2026-04-17T12:34:00Z').getTime(),
              payload: { text: 'Fix reconnect logic' },
            },
          ] as any}
          loading={false}
          sessionId="deck_main_brain"
        />,
      );

      const chatEvent = container.querySelector('.chat-event.chat-user') as HTMLElement;
      fireEvent.contextMenu(chatEvent, { clientX: 40, clientY: 40 });
      fireEvent.click(getByText('common.copy'));

      await waitFor(() => {
        expect(clipboardWriteText).toHaveBeenCalledWith('Fix reconnect logic');
      });
    } finally {
      if (hadTouchStart) (window as Window & { ontouchstart?: unknown }).ontouchstart = originalTouchStart;
    }
  });

  it('copies the last tool event without the trailing timestamp from the context menu', async () => {
    const hadTouchStart = 'ontouchstart' in window;
    const originalTouchStart = (window as Window & { ontouchstart?: unknown }).ontouchstart;
    if (hadTouchStart) delete (window as Window & { ontouchstart?: unknown }).ontouchstart;
    try {
      const { container, getByText } = render(
        <ChatView
          events={[
            {
              eventId: 'evt-tool-copy-call',
              type: 'tool.call',
              ts: new Date('2026-04-17T12:34:00Z').getTime(),
              payload: { tool: 'Read', input: { file_path: 'README.md' } },
            },
            {
              eventId: 'evt-tool-copy-result',
              type: 'tool.result',
              ts: new Date('2026-04-17T12:35:00Z').getTime(),
              payload: { output: { path: '/tmp/README.md' } },
            },
          ] as any}
          loading={false}
          sessionId="deck_main_brain"
        />,
      );

      const toolEvents = container.querySelectorAll('.chat-event.chat-tool');
      const lastToolEvent = toolEvents[toolEvents.length - 1] as HTMLElement;
      fireEvent.contextMenu(lastToolEvent, { clientX: 40, clientY: 40 });
      fireEvent.click(getByText('common.copy'));

      await waitFor(() => {
        expect(clipboardWriteText).toHaveBeenCalledWith('/tmp/README.md');
      });
    } finally {
      if (hadTouchStart) (window as Window & { ontouchstart?: unknown }).ontouchstart = originalTouchStart;
    }
  });
});
