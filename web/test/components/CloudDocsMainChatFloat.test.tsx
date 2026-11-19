/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { ServerMessage, TimelineEvent, WsClient } from '../../src/ws-client.js';
import type { SessionInfo } from '../../src/types.js';
import { TIMELINE_MESSAGES } from '@shared/timeline-protocol.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrVars?: string | Record<string, unknown>, vars?: Record<string, unknown>) => {
      if (typeof fallbackOrVars === 'string') {
        if (!vars) return fallbackOrVars;
        return Object.entries(vars).reduce(
          (acc, [k, v]) => acc.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v)),
          fallbackOrVars,
        );
      }
      return fallbackOrVars ? `${key}:${JSON.stringify(fallbackOrVars)}` : key;
    },
  }),
}));

vi.mock('../../src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api.js')>();
  return {
    ...actual,
    fetchTimelineHistoryHttp: vi.fn(async () => ({ events: [] })),
    sendSessionViaHttp: vi.fn(async () => ({ ok: true })),
  };
});

const chatViewPropsSpy = vi.fn();
const chatScrollBottomSpy = vi.fn();
vi.mock('../../src/components/ChatView.js', async () => {
  const { useEffect } = await import('preact/hooks');
  return {
    ChatView: (props: {
      events: TimelineEvent[];
      visible?: boolean;
      preview?: boolean;
      hideFilePanel?: boolean;
      onScrollBottomFn?: (fn: () => void) => void;
    }) => {
      chatViewPropsSpy(props);
      useEffect(() => {
        props.onScrollBottomFn?.(chatScrollBottomSpy);
      }, [props.onScrollBottomFn]);
      return (
        <div data-testid="mock-mini-chat-view" data-visible={String(Boolean(props.visible))}>
          {props.events.map((ev) => (
            <div key={ev.eventId} data-testid={`mini-event-${ev.type}`}>
              {String(ev.payload.text ?? ev.type)}
            </div>
          ))}
        </div>
      );
    },
  };
});

const controlsPropsSpy = vi.fn();
vi.mock('../../src/components/StableSessionControls.js', () => ({
  StableSessionControls: (props: {
    compact?: boolean;
    quotes?: string[];
    onRemoveQuote?: (index: number) => void;
    onSend?: (
      sessionName: string,
      text: string,
      meta?: { commandId: string; extra?: Record<string, unknown>; queueAppend?: boolean },
    ) => void;
    activeSession: SessionInfo;
  }) => {
    controlsPropsSpy(props);
    return (
      <div data-testid="mock-mini-controls" data-compact={String(Boolean(props.compact))}>
        {(props.quotes ?? []).map((q, idx) => (
          <span key={`${idx}-${q}`} data-testid={`mini-quote-pill-${idx}`}>
            {q}
            <button
              type="button"
              data-testid={`mini-quote-remove-${idx}`}
              onClick={() => props.onRemoveQuote?.(idx)}
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          data-testid="mock-mini-send"
          onClick={() => {
            const cmdId = `cmd-${Date.now()}`;
            const quotePrefix = (props.quotes ?? []).map((q) => `> ${q}`).join('\n');
            const fullText = quotePrefix ? `${quotePrefix}\n\nsummarize` : 'summarize';
            props.onSend?.(props.activeSession.name, fullText, { commandId: cmdId });
            for (let i = (props.quotes?.length ?? 0) - 1; i >= 0; i--) {
              props.onRemoveQuote?.(i);
            }
          }}
        >
          Send
        </button>
      </div>
    );
  },
}));

import {
  __clearPersistedTimelineSnapshotsForTests,
  __resetTimelineCacheForTests,
  useTimeline,
  type UseTimelineResult,
} from '../../src/hooks/useTimeline.js';
import { CloudDocsMainChatFloat, type CloudDocsMainChatContext } from '../../src/components/CloudDocsMainChatFloat.js';
import { REMOTE_DESKTOP_OVERLAY_CLASS } from '../../src/remote-desktop-pointer-overlay.js';

function createSharedMockWs() {
  const listeners = new Set<(msg: ServerMessage) => void>();
  const ws = {
    connected: true,
    onMessage: (cb: (msg: ServerMessage) => void) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    sendTimelineHistoryRequest: vi.fn(() => 'req-1'),
    sendSessionCommand: vi.fn(() => undefined),
    send: vi.fn(() => undefined),
  } as unknown as WsClient;

  const emit = (msg: ServerMessage) => {
    for (const cb of listeners) cb(msg);
  };

  return { ws, emit };
}

function makeMainSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    name: 'deck_cd_brain',
    project: 'codedeck',
    role: 'brain',
    agentType: 'claude-code',
    runtimeType: 'transport',
    state: 'idle',
    projectDir: '/repo',
    ...overrides,
  };
}

function makeMainChatContext(ws: WsClient, session = makeMainSession()): CloudDocsMainChatContext {
  return {
    session,
    sessions: [session],
    subSessions: [],
    ws,
    connected: true,
    serverId: 'srv-1',
    quickData: {
      loaded: true,
      history: [],
      commands: [],
      phrases: [],
      reload: vi.fn(),
      recordHistory: vi.fn(),
      addCommand: vi.fn(),
      updateCommand: vi.fn(),
      removeCommand: vi.fn(),
      addPhrase: vi.fn(),
      removePhrase: vi.fn(),
    } as unknown as CloudDocsMainChatContext['quickData'],
  };
}

describe('CloudDocsMainChatFloat', () => {
  beforeEach(() => {
    __resetTimelineCacheForTests();
    __clearPersistedTimelineSnapshotsForTests();
    localStorage.clear();
    chatViewPropsSpy.mockClear();
    chatScrollBottomSpy.mockClear();
    controlsPropsSpy.mockClear();
    cleanup();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('stays live-synced with active main session (busy indicator, streaming messages, and optimistic sends)', async () => {
    const { ws, emit } = createSharedMockWs();
    const activeHookRef: { current: UseTimelineResult | null } = { current: null };

    function MainSessionProbe() {
      activeHookRef.current = useTimeline('deck_cd_brain', ws, 'srv-1', {
        isActiveSession: true,
        isVisible: true,
        subscriptionMode: 'full',
      });
      return (
        <div data-testid="active-main-count">
          {activeHookRef.current.events.map((e) => String(e.payload.text ?? e.type)).join('|')}
        </div>
      );
    }

    const mainChat = makeMainChatContext(ws);
    render(
      <div>
        <MainSessionProbe />
        <CloudDocsMainChatFloat mainChat={mainChat} />
      </div>,
    );

    // Collapsed initially; no busy dot while idle
    expect(screen.getByTestId('cloud-docs-main-chat-fab')).toBeTruthy();
    expect(screen.queryByTestId('cloud-docs-mini-chat')).toBeNull();
    expect(screen.queryByTestId('cloud-docs-fab-busy-dot')).toBeNull();

    // Active thinking arrives on WS -> collapsed FAB surfaces busy indicator
    act(() => {
      emit({
        type: TIMELINE_MESSAGES.EVENT,
        event: {
          eventId: 'ev-think-1',
          sessionId: 'deck_cd_brain',
          ts: 1000,
          seq: 1,
          epoch: 1,
          type: 'assistant.thinking',
          payload: { text: 'Analyzing...' },
        },
      } as ServerMessage);
    });

    await waitFor(() => expect(screen.getByTestId('cloud-docs-fab-busy-dot')).toBeTruthy());

    // Expand mini-chat and receive live assistant text
    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    await waitFor(() => expect(screen.getByTestId('cloud-docs-mini-chat')).toBeTruthy());

    act(() => {
      emit({
        type: TIMELINE_MESSAGES.EVENT,
        event: {
          eventId: 'ev-msg-1',
          sessionId: 'deck_cd_brain',
          ts: 2000,
          seq: 2,
          epoch: 1,
          type: 'assistant.text',
          payload: { text: 'Live main response' },
        },
      } as ServerMessage);
    });

    await waitFor(() => expect(screen.getByText('Live main response')).toBeTruthy());

    // Sending from mini-chat updates shared timeline immediately (visible in MainSessionProbe)
    fireEvent.click(screen.getByTestId('mock-mini-send'));
    await waitFor(() => {
      expect(screen.getByTestId('active-main-count').textContent).toContain('summarize');
      expect(screen.getByText('summarize')).toBeTruthy();
    });

    // Collapse cleanly via close button
    fireEvent.click(screen.getByTestId('cloud-docs-mini-chat-close'));
    await waitFor(() => expect(screen.queryByTestId('cloud-docs-mini-chat')).toBeNull());
  });

  it('auto-attaches active preview document quote, supports dismiss + reattach, and switches cleanly across docs', async () => {
    const { ws } = createSharedMockWs();
    const mainChat = makeMainChatContext(ws);

    const { rerender } = render(
      <CloudDocsMainChatFloat
        mainChat={mainChat}
        activePreviewQuote={{ kind: 'cloud_doc', docId: 'doc-1', name: 'Q4_Budget.xlsx' }}
      />,
    );

    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    await waitFor(() => expect(screen.getByTestId('mini-quote-pill-0')).toBeTruthy());
    expect(screen.getByTestId('mini-quote-pill-0').textContent).toContain('[CloudDoc: Q4_Budget.xlsx | id=doc-1]');

    // Dismissing hides the quote pill and offers a 1-click reattach chip
    fireEvent.click(screen.getByTestId('mini-quote-remove-0'));
    await waitFor(() => expect(screen.queryByTestId('mini-quote-pill-0')).toBeNull());
    expect(screen.getByTestId('cloud-docs-mini-chat-reattach')).toBeTruthy();

    // Clicking reattach restores the quote pill
    fireEvent.click(screen.getByTestId('cloud-docs-mini-chat-reattach'));
    await waitFor(() => expect(screen.getByTestId('mini-quote-pill-0')).toBeTruthy());

    // Sending clears the quote badge via SessionControls onRemoveQuote and reveals reattach chip
    fireEvent.click(screen.getByTestId('mock-mini-send'));
    await waitFor(() => expect(screen.queryByTestId('mini-quote-pill-0')).toBeNull());
    expect(screen.getByTestId('cloud-docs-mini-chat-reattach')).toBeTruthy();

    // Switching to another document re-associates cleanly
    rerender(
      <CloudDocsMainChatFloat
        mainChat={mainChat}
        activePreviewQuote={{ kind: 'server_file', path: '/srv/docs/Architecture.md', name: 'Architecture.md', serverId: 'srv-1' }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('mini-quote-pill-0')).toBeTruthy());
    expect(screen.getByTestId('mini-quote-pill-0').textContent).toContain('@/srv/docs/Architecture.md');
  });

  it('mounts ChatView in interactive scrollable mode (no preview, hideFilePanel, wired pagination) and scrolls to bottom on re-expand', async () => {
    const { ws } = createSharedMockWs();
    const mainChat = makeMainChatContext(ws);

    render(<CloudDocsMainChatFloat mainChat={mainChat} />);

    // Expand mini-chat
    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    await waitFor(() => expect(screen.getByTestId('cloud-docs-mini-chat')).toBeTruthy());

    await waitFor(() => expect(chatViewPropsSpy).toHaveBeenCalled());
    const lastProps = chatViewPropsSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastProps.preview).toBeUndefined();
    expect(lastProps.hideFilePanel).toBe(true);
    expect(typeof lastProps.onLoadOlder).toBe('function');
    expect(typeof lastProps.onLoadMessageContext).toBe('function');
    expect(typeof lastProps.hasOlderHistory).toBe('boolean');
    expect(typeof lastProps.loadingOlder).toBe('boolean');
    expect(lastProps).toHaveProperty('historyStatus');
    expect(lastProps).toHaveProperty('historyGap');
    await waitFor(() => expect(chatScrollBottomSpy).toHaveBeenCalled());

    // Collapse and re-expand -> scrolls to bottom again
    chatScrollBottomSpy.mockClear();
    fireEvent.click(screen.getByTestId('cloud-docs-mini-chat-close'));
    await waitFor(() => expect(screen.queryByTestId('cloud-docs-mini-chat')).toBeNull());

    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    await waitFor(() => expect(screen.getByTestId('cloud-docs-mini-chat')).toBeTruthy());
    await waitFor(() => expect(chatScrollBottomSpy).toHaveBeenCalled());
  });

  it('keeps CloudDocs default mode without resize handle, storage writes, or overlay class', async () => {
    const { ws } = createSharedMockWs();
    const mainChat = makeMainChatContext(ws);
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    render(<CloudDocsMainChatFloat mainChat={mainChat} />);
    const fab = screen.getByTestId('cloud-docs-main-chat-fab');
    expect(fab.classList.contains(REMOTE_DESKTOP_OVERLAY_CLASS)).toBe(false);

    fireEvent.click(fab);
    const miniChat = await screen.findByTestId('cloud-docs-mini-chat');
    expect(miniChat.classList.contains(REMOTE_DESKTOP_OVERLAY_CLASS)).toBe(false);
    expect(miniChat.style.height).toBe('');
    expect(screen.queryByTestId('mini-chat-resize-handle')).toBeNull();
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it('supports drag height resizing, boundary clamping, storage persistence, and overlayClassName', async () => {
    const storageKey = 'test_rd_mini_chat_height';
    const { ws } = createSharedMockWs();
    const mainChat = makeMainChatContext(ws);

    const view = render(
      <div style={{ height: '600px' }}>
        <CloudDocsMainChatFloat
          mainChat={mainChat}
          heightStorageKey={storageKey}
          defaultHeight={420}
          minHeight={220}
          maxHeight={500}
          overlayClassName={REMOTE_DESKTOP_OVERLAY_CLASS}
        />
      </div>,
    );

    const fab = screen.getByTestId('cloud-docs-main-chat-fab');
    const anchor = fab.closest('.cloud-docs-main-chat-anchor') as HTMLElement;
    expect(fab.classList.contains(REMOTE_DESKTOP_OVERLAY_CLASS)).toBe(true);
    expect(anchor.classList.contains(REMOTE_DESKTOP_OVERLAY_CLASS)).toBe(false);

    fireEvent.click(fab);
    const miniChat = await screen.findByTestId('cloud-docs-mini-chat');
    expect(miniChat.classList.contains(REMOTE_DESKTOP_OVERLAY_CLASS)).toBe(true);
    // Unset before first drag / stored value
    expect(miniChat.style.height).toBe('');

    const handle = screen.getByTestId('mini-chat-resize-handle');
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal');

    // Non-primary button does not start resize
    fireEvent(handle, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 2, clientY: 300, pointerId: 1,
    }));
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientY: 240, pointerId: 1,
    }));
    expect(localStorage.getItem(storageKey)).toBeNull();

    // Drag upward by 60px: 420 -> 480
    fireEvent(handle, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientY: 300, pointerId: 2,
    }));
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientY: 240, pointerId: 2,
    }));
    expect(miniChat.style.height).toBe('480px');

    // Drag further past maxHeight (500): clamped at 500
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientY: 100, pointerId: 2,
    }));
    expect(miniChat.style.height).toBe('500px');

    // Drag downward past minHeight (220): clamped at 220
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientY: 800, pointerId: 2,
    }));
    expect(miniChat.style.height).toBe('220px');

    // Drag to 350 and release
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientY: 370, pointerId: 2,
    }));
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientY: 370, pointerId: 2,
    }));
    expect(miniChat.style.height).toBe('350px');
    expect(localStorage.getItem(storageKey)).toBe('350');

    // Collapse & re-expand preserves 350px
    fireEvent.click(screen.getByTestId('cloud-docs-mini-chat-close'));
    await waitFor(() => expect(screen.queryByTestId('cloud-docs-mini-chat')).toBeNull());
    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    const reopened = await screen.findByTestId('cloud-docs-mini-chat');
    expect(reopened.style.height).toBe('350px');

    // Unmount & remount restores 350px from localStorage
    view.unmount();
    render(
      <CloudDocsMainChatFloat
        mainChat={mainChat}
        heightStorageKey={storageKey}
        defaultHeight={420}
        minHeight={220}
        maxHeight={500}
        overlayClassName={REMOTE_DESKTOP_OVERLAY_CLASS}
      />,
    );
    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    const remounted = await screen.findByTestId('cloud-docs-mini-chat');
    expect(remounted.style.height).toBe('350px');
  });

  it('handles corrupt/extreme localStorage heights safely and cleans up drag listeners on pointercancel and unmount', async () => {
    const storageKey = 'test_rd_mini_chat_height_bounds';
    const { ws } = createSharedMockWs();
    const mainChat = makeMainChatContext(ws);

    for (const badValue of ['not-a-number', '-120', '0', 'NaN']) {
      localStorage.setItem(storageKey, badValue);
      const { unmount } = render(
        <CloudDocsMainChatFloat
          mainChat={mainChat}
          heightStorageKey={storageKey}
          minHeight={220}
          maxHeight={520}
        />,
      );
      fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
      const miniChat = await screen.findByTestId('cloud-docs-mini-chat');
      expect(miniChat.style.height).toBe('');
      unmount();
    }

    // Oversized stored value clamps to maxHeight
    localStorage.setItem(storageKey, '99999');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(
      <CloudDocsMainChatFloat
        mainChat={mainChat}
        heightStorageKey={storageKey}
        minHeight={220}
        maxHeight={520}
      />,
    );
    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    const miniChat = await screen.findByTestId('cloud-docs-mini-chat');
    expect(miniChat.style.height).toBe('520px');

    const handle = screen.getByTestId('mini-chat-resize-handle');
    fireEvent(handle, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientY: 300, pointerId: 5,
    }));
    fireEvent(window, Object.assign(new Event('pointercancel', { bubbles: true }), { pointerId: 5 }));
    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('pointerup', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('pointercancel', expect.any(Function));

    // Start another drag and unmount without pointerup -> cleans up cleanly
    removeSpy.mockClear();
    fireEvent(handle, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientY: 300, pointerId: 6,
    }));
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('pointerup', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('pointercancel', expect.any(Function));
  });
});
