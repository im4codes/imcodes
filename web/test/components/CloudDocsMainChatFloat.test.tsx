/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
      hideTaskPairPanel?: boolean;
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
    hideWorkflowControls?: boolean;
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
    expect(lastProps.hideTaskPairPanel).toBe(true);
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

  it('renders sci-fi marquee ring & breathing aura, triggers entrance scale-bounce on mount and visible transitions, and ignores child animationend', () => {
    const { ws } = createSharedMockWs();
    const mainChat = makeMainChatContext(ws);

    const view = render(<CloudDocsMainChatFloat mainChat={mainChat} />);
    const fab = screen.getByTestId('cloud-docs-main-chat-fab');
    const aura = fab.querySelector('.cloud-docs-fab-aura');
    const ring = fab.querySelector('.cloud-docs-fab-ring');
    expect(aura?.getAttribute('aria-hidden')).toBe('true');
    expect(ring?.getAttribute('aria-hidden')).toBe('true');
    expect(fab.classList.contains('is-entering')).toBe(true);

    // Child animationend (bubbling from aura/ring) must NOT clear is-entering
    fireEvent.animationEnd(aura!);
    expect(fab.classList.contains('is-entering')).toBe(true);

    // Non-entrance animationName on button itself must NOT clear is-entering
    const unrelatedEv = new Event('animationend', { bubbles: false });
    Object.defineProperty(unrelatedEv, 'animationName', { value: 'someOtherAnim' });
    fireEvent(fab, unrelatedEv);
    expect(fab.classList.contains('is-entering')).toBe(true);

    // Entrance animationend clears is-entering cleanly
    const entranceEv = new Event('animationend', { bubbles: false });
    Object.defineProperty(entranceEv, 'animationName', { value: 'cloudDocsFabEntrance' });
    fireEvent(fab, entranceEv);
    expect(fab.classList.contains('is-entering')).toBe(false);

    // Hidden -> visible transition replays entrance animation
    view.rerender(<CloudDocsMainChatFloat mainChat={mainChat} visible={false} />);
    expect(fab.classList.contains('is-entering')).toBe(false);

    view.rerender(<CloudDocsMainChatFloat mainChat={mainChat} visible={true} />);
    expect(fab.classList.contains('is-entering')).toBe(true);
    const replayEndEv = new Event('animationend', { bubbles: false });
    Object.defineProperty(replayEndEv, 'animationName', { value: 'cloudDocsFabEntrance' });
    fireEvent(fab, replayEndEv);
    expect(fab.classList.contains('is-entering')).toBe(false);
    view.unmount();

    // Mounting initially hidden does NOT set is-entering until visible becomes true
    const hiddenView = render(<CloudDocsMainChatFloat mainChat={mainChat} visible={false} />);
    const hiddenFab = screen.getByTestId('cloud-docs-main-chat-fab');
    expect(hiddenFab.classList.contains('is-entering')).toBe(false);
    hiddenView.rerender(<CloudDocsMainChatFloat mainChat={mainChat} visible={true} />);
    expect(hiddenFab.classList.contains('is-entering')).toBe(true);
    hiddenView.unmount();
  });

  it('defines sci-fi FAB CSS keyframes, unclipped busy dot rules, reduced-motion fallback, and avoids backdrop-filter', () => {
    const stylesPath = process.cwd().endsWith('/web')
      ? resolve(process.cwd(), 'src/styles.css')
      : resolve(process.cwd(), 'web/src/styles.css');
    const css = readFileSync(stylesPath, 'utf8');
    const fabSection = css.slice(css.indexOf('.cloud-docs-fab {'), css.indexOf('.cloud-docs-mini-chat {'));

    expect(fabSection).toContain('overflow: visible;');
    expect(fabSection).toContain('.cloud-docs-fab-ring');
    expect(fabSection).toContain('overflow: hidden;');
    expect(fabSection).toContain('desktop-cloud-docs-marquee-spin');
    expect(fabSection).toContain('@keyframes cloudDocsFabAura');
    expect(fabSection).toContain('@keyframes cloudDocsFabEntrance');
    expect(fabSection).toContain('scale(1.42)');
    expect(fabSection).toContain('scale(0.93)');
    expect(fabSection).toContain('@media (prefers-reduced-motion: reduce)');
    expect(fabSection).not.toContain('backdrop-filter');
  });

  it('supports header drag positioning with container boundary clamping, close-button exclusion, interaction shield, and layout persistence', async () => {
    const storageKey = 'test_mini_chat_drag_pos';
    const { ws } = createSharedMockWs();
    const mainChat = makeMainChatContext(ws);

    const view = render(
      <div data-testid="drag-host" style={{ position: 'relative', width: '900px', height: '700px' }}>
        <CloudDocsMainChatFloat
          mainChat={mainChat}
          heightStorageKey={storageKey}
          overlayClassName={REMOTE_DESKTOP_OVERLAY_CLASS}
        />
      </div>,
    );

    const host = screen.getByTestId('drag-host');
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 900 });
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 700 });
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 900, height: 700, right: 900, bottom: 700, x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    const miniChat = await screen.findByTestId('cloud-docs-mini-chat');
    vi.spyOn(miniChat, 'getBoundingClientRect').mockReturnValue({
      left: 506, top: 218, width: 380, height: 420, right: 886, bottom: 638, x: 506, y: 218, toJSON: () => ({}),
    });

    const closeBtn = screen.getByTestId('cloud-docs-mini-chat-close');
    const header = screen.getByTestId('cloud-docs-mini-chat-header');

    // Pointerdown on close button must NOT enter drag mode
    fireEvent(closeBtn, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 870, clientY: 230, pointerId: 10,
    }));
    expect(miniChat.classList.contains('is-dragging')).toBe(false);
    expect(document.documentElement.classList.contains('imcodes-window-dragging')).toBe(false);

    // Drag header by (-200, -100) -> moves from (506, 218) to (306, 118)
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    fireEvent(header, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 600, clientY: 230, pointerId: 11,
    }));
    expect(miniChat.classList.contains('is-dragging')).toBe(true);
    expect(document.documentElement.classList.contains('imcodes-window-dragging')).toBe(true);
    const shield = screen.getByTestId('cloud-docs-mini-chat-interaction-shield');
    expect(shield.classList.contains(REMOTE_DESKTOP_OVERLAY_CLASS)).toBe(true);

    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 400, clientY: 130, pointerId: 11,
    }));
    expect(miniChat.classList.contains('is-positioned')).toBe(true);
    expect(miniChat.style.right).toBe('214px');
    expect(miniChat.style.bottom).toBe('162px');
    expect(miniChat.style.left).toBe('');
    expect(miniChat.style.top).toBe('');
    // No synchronous localStorage churn during pointermove
    expect(setItemSpy).not.toHaveBeenCalled();

    // Clamp against top-left edge (8px margin -> max right=512, max bottom=272)
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: -400, clientY: -400, pointerId: 11,
    }));
    expect(miniChat.style.right).toBe('512px');
    expect(miniChat.style.bottom).toBe('272px');

    // Clamp against bottom-right edge (8px margin -> min right=8, min bottom=8)
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 1600, clientY: 1400, pointerId: 11,
    }));
    expect(miniChat.style.right).toBe('8px');
    expect(miniChat.style.bottom).toBe('8px');

    // Commit at (240, 120) -> delta (-360, -110) => (right: 14 + 360 = 374, bottom: 62 + 110 = 172)
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 240, clientY: 120, pointerId: 11,
    }));
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 240, clientY: 120, pointerId: 11,
    }));

    expect(miniChat.classList.contains('is-dragging')).toBe(false);
    expect(document.documentElement.classList.contains('imcodes-window-dragging')).toBe(false);
    expect(screen.queryByTestId('cloud-docs-mini-chat-interaction-shield')).toBeNull();
    expect(JSON.parse(localStorage.getItem(`${storageKey}:layout`) || '{}')).toEqual({
      right: 374,
      bottom: 172,
    });

    // Unmount & remount in a smaller container (300x260) clamps restored position & size safely inside container
    view.unmount();
    render(
      <div data-testid="tiny-host" style={{ position: 'relative', width: '300px', height: '260px' }}>
        <CloudDocsMainChatFloat mainChat={mainChat} heightStorageKey={storageKey} />
      </div>,
    );
    const tinyHost = screen.getByTestId('tiny-host');
    Object.defineProperty(tinyHost, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(tinyHost, 'clientHeight', { configurable: true, value: 260 });
    vi.spyOn(tinyHost, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 300, height: 260, right: 300, bottom: 260, x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    const tinyMiniChat = await screen.findByTestId('cloud-docs-mini-chat');
    const restoredRight = Number.parseInt(tinyMiniChat.style.right, 10);
    const restoredBottom = Number.parseInt(tinyMiniChat.style.bottom, 10);
    expect(restoredRight).toBeGreaterThanOrEqual(0);
    expect(restoredBottom).toBeGreaterThanOrEqual(0);
    expect(restoredRight).toBeLessThan(300);
    expect(restoredBottom).toBeLessThan(260);
  });

  it('supports 8-direction width+height resizing, backward-compat height storage, corrupt layout recovery, blur/cancel guard release, and iframe pointer blocking CSS', async () => {
    const storageKey = 'test_mini_chat_multi_resize';
    const { ws } = createSharedMockWs();
    const mainChat = makeMainChatContext(ws);

    // Corrupt layout JSON + legacy plain-numeric height should not crash and should keep legacy height
    localStorage.setItem(storageKey, '460');
    localStorage.setItem(`${storageKey}:layout`, '{corrupt-json');

    render(
      <div data-testid="resize-host" style={{ position: 'relative', width: '900px', height: '700px' }}>
        <CloudDocsMainChatFloat
          mainChat={mainChat}
          heightStorageKey={storageKey}
          defaultWidth={380}
          minWidth={280}
          maxWidth={600}
          defaultHeight={420}
          minHeight={220}
          maxHeight={560}
        />
      </div>,
    );
    const host = screen.getByTestId('resize-host');
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 900 });
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 700 });
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 900, height: 700, right: 900, bottom: 700, x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    const miniChat = await screen.findByTestId('cloud-docs-mini-chat');
    expect(miniChat.style.height).toBe('460px');
    expect(miniChat.style.width).toBe('');
    expect(miniChat.style.right).toBe('');
    expect(miniChat.style.left).toBe('');

    vi.spyOn(miniChat, 'getBoundingClientRect').mockReturnValue({
      left: 506, top: 178, width: 380, height: 460, right: 886, bottom: 638, x: 506, y: 178, toJSON: () => ({}),
    });

    // Resize west handle left by 80px -> width 380 -> 460 while staying docked at right/bottom
    const westHandle = screen.getByTestId('mini-chat-resize-handle-w');
    fireEvent(westHandle, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 506, clientY: 300, pointerId: 21,
    }));
    expect(document.documentElement.classList.contains('imcodes-window-dragging')).toBe(true);
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 426, clientY: 300, pointerId: 21,
    }));
    expect(miniChat.style.width).toBe('460px');
    expect(miniChat.style.right).toBe('');
    expect(miniChat.style.left).toBe('');
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 426, clientY: 300, pointerId: 21,
    }));
    expect(document.documentElement.classList.contains('imcodes-window-dragging')).toBe(false);
    expect(JSON.parse(localStorage.getItem(`${storageKey}:layout`) || '{}')).toMatchObject({ width: 460 });

    // Move off docked corner so right=64, bottom=92 (left=376, top=148)
    vi.spyOn(miniChat, 'getBoundingClientRect').mockReturnValue({
      left: 426, top: 178, width: 460, height: 460, right: 886, bottom: 638, x: 426, y: 178, toJSON: () => ({}),
    });
    const header = screen.getByTestId('cloud-docs-mini-chat-header');
    fireEvent(header, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 500, clientY: 190, pointerId: 22,
    }));
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 450, clientY: 160, pointerId: 22,
    }));
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 450, clientY: 160, pointerId: 22,
    }));
    expect(miniChat.style.right).toBe('64px');
    expect(miniChat.style.bottom).toBe('92px');
    expect(miniChat.style.left).toBe('');
    expect(miniChat.style.top).toBe('');

    // Resize south-east handle: updates width, height, right, bottom while pinning top-left edge
    vi.spyOn(miniChat, 'getBoundingClientRect').mockReturnValue({
      left: 376, top: 148, width: 460, height: 460, right: 836, bottom: 608, x: 376, y: 148, toJSON: () => ({}),
    });
    const seHandle = screen.getByTestId('mini-chat-resize-handle-se');
    fireEvent(seHandle, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 836, clientY: 608, pointerId: 23,
    }));
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 876, clientY: 648, pointerId: 23,
    }));
    expect(miniChat.style.width).toBe('500px');
    expect(miniChat.style.height).toBe('500px');
    expect(miniChat.style.right).toBe('24px');
    expect(miniChat.style.bottom).toBe('52px');

    // Window blur mid-resize cleanly releases dragging guard and active state
    fireEvent(window, new Event('blur'));
    expect(document.documentElement.classList.contains('imcodes-window-dragging')).toBe(false);
    expect(miniChat.classList.contains('is-resizing')).toBe(false);
    expect(screen.queryByTestId('cloud-docs-mini-chat-interaction-shield')).toBeNull();

    // North-west corner resize updates width & height while pinning bottom-right
    vi.spyOn(miniChat, 'getBoundingClientRect').mockReturnValue({
      left: 376, top: 148, width: 500, height: 500, right: 876, bottom: 648, x: 376, y: 148, toJSON: () => ({}),
    });
    const nwHandle = screen.getByTestId('mini-chat-resize-handle-nw');
    fireEvent(nwHandle, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 376, clientY: 148, pointerId: 24,
    }));
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 336, clientY: 108, pointerId: 24,
    }));
    expect(miniChat.style.width).toBe('540px');
    expect(miniChat.style.height).toBe('540px');
    expect(miniChat.style.right).toBe('24px');
    expect(miniChat.style.bottom).toBe('52px');
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 336, clientY: 108, pointerId: 24,
    }));
    expect(localStorage.getItem(storageKey)).toBe('540');
    expect(JSON.parse(localStorage.getItem(`${storageKey}:layout`) || '{}')).toEqual({
      width: 540,
      right: 24,
      bottom: 52,
    });

    // Verify iframe pointer-events block rule and bottom-right positioning CSS in styles.css
    const stylesPath = process.cwd().endsWith('/web')
      ? resolve(process.cwd(), 'src/styles.css')
      : resolve(process.cwd(), 'web/src/styles.css');
    const css = readFileSync(stylesPath, 'utf8');
    expect(css).toMatch(/html\.imcodes-window-dragging\s+iframe\s*\{\s*pointer-events:\s*none\s*!important;\s*\}/);
    expect(css).toContain('.cloud-docs-mini-chat-interaction-shield');
    expect(css).toMatch(/\.cloud-docs-mini-chat\.is-positioned\s*\{\s*left:\s*auto;\s*top:\s*auto;/);
  });

  it('passes hideWorkflowControls to SessionControls so Quick Audit, Supervision, and OpenSpec stay hidden in mini chat', async () => {
    const { ws } = createSharedMockWs();
    const mainChat = makeMainChatContext(ws);

    render(<CloudDocsMainChatFloat mainChat={mainChat} />);
    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    await screen.findByTestId('cloud-docs-mini-chat');

    expect(controlsPropsSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      compact: true,
      hideWorkflowControls: true,
    });
  });

  it('auto-attaches remote_desktop activePreviewQuote, supports dismiss + reattach, switches cleanly across hosts, and forwards onRemoteDesktopClick', async () => {
    const { ws } = createSharedMockWs();
    const mainChat = makeMainChatContext(ws);
    const onRemoteDesktopClick = vi.fn();

    const { rerender } = render(
      <CloudDocsMainChatFloat
        mainChat={mainChat}
        activePreviewQuote={{
          kind: 'remote_desktop',
          id: '6000000099',
          serverId: 'srv-cn-99',
          nodeId: '6000000099',
          name: 'Studio [Mac]\n| 01',
        }}
        onRemoteDesktopClick={onRemoteDesktopClick}
      />,
    );

    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    await waitFor(() => expect(screen.getByTestId('mini-quote-pill-0')).toBeTruthy());
    expect(screen.getByTestId('mini-quote-pill-0').textContent).toContain('[RemoteDesktop: Studio Mac 01 | id=6000000099]');

    fireEvent.click(screen.getByTestId('mini-quote-remove-0'));
    await waitFor(() => expect(screen.queryByTestId('mini-quote-pill-0')).toBeNull());
    const reattachBtn = screen.getByTestId('cloud-docs-mini-chat-reattach');
    expect(reattachBtn.textContent).toContain('Studio Mac 01');

    fireEvent.click(reattachBtn);
    await waitFor(() => expect(screen.getByTestId('mini-quote-pill-0')).toBeTruthy());

    fireEvent.click(screen.getByTestId('mock-mini-send'));
    await waitFor(() => expect(screen.queryByTestId('mini-quote-pill-0')).toBeNull());
    await waitFor(() => {
      const lastEvents = (chatViewPropsSpy.mock.calls.at(-1)?.[0] as { events?: Array<{ payload?: { text?: string } }> })?.events ?? [];
      expect(lastEvents.some((ev) => String(ev.payload?.text ?? '').includes('[RemoteDesktop: Studio Mac 01 | id=6000000099]'))).toBe(true);
    });

    // Switching to another remote desktop re-attaches without carrying over dismissal
    rerender(
      <CloudDocsMainChatFloat
        mainChat={mainChat}
        activePreviewQuote={{
          kind: 'remote_desktop',
          id: 'srv-win-02',
          serverId: 'srv-win-02',
          name: 'Win Server 02',
        }}
        onRemoteDesktopClick={onRemoteDesktopClick}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('mini-quote-pill-0').textContent).toContain('[RemoteDesktop: Win Server 02 | id=srv-win-02]'));
    expect(chatViewPropsSpy.mock.calls.at(-1)?.[0]?.onRemoteDesktopClick).toBe(onRemoteDesktopClick);
  });

  it('hides only the robot FAB when hideFab is true while keeping an expanded mini chat open and interactive, and restores FAB when hideFab becomes false', async () => {
    const { ws } = createSharedMockWs();
    const mainChat = makeMainChatContext(ws);

    const view = render(<CloudDocsMainChatFloat mainChat={mainChat} hideFab={false} />);
    const fab = screen.getByTestId('cloud-docs-main-chat-fab');
    expect(fab.classList.contains('is-entering')).toBe(true);
    const entranceEv = new Event('animationend', { bubbles: false });
    Object.defineProperty(entranceEv, 'animationName', { value: 'cloudDocsFabEntrance' });
    fireEvent(fab, entranceEv);
    expect(fab.classList.contains('is-entering')).toBe(false);

    // Expand mini chat before keyboard opens
    fireEvent.click(fab);
    const miniChat = await screen.findByTestId('cloud-docs-mini-chat');
    expect(miniChat).toBeTruthy();

    // Opening keyboard hides only the robot button; mini chat remains visible & usable for typing
    view.rerender(<CloudDocsMainChatFloat mainChat={mainChat} hideFab={true} />);
    expect(screen.queryByTestId('cloud-docs-main-chat-fab')).toBeNull();
    expect(screen.getByTestId('cloud-docs-mini-chat')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mock-mini-send'));

    // Closing keyboard shows the robot button again without replaying the entrance animation
    view.rerender(<CloudDocsMainChatFloat mainChat={mainChat} hideFab={false} />);
    const restoredFab = screen.getByTestId('cloud-docs-main-chat-fab');
    expect(restoredFab).toBeTruthy();
    expect(restoredFab.classList.contains('is-entering')).toBe(false);
    expect(screen.getByTestId('cloud-docs-mini-chat')).toBeTruthy();

    // Closing mini chat works while hideFab is false
    fireEvent.click(screen.getByTestId('cloud-docs-mini-chat-close'));
    expect(screen.queryByTestId('cloud-docs-mini-chat')).toBeNull();
  });

  it('keeps mini-chat anchored to bottom-right across UI scales (60%-150%), migrates legacy {x,y} storage cleanly, and scales drag/resize under both Chromium and iOS WebKit rect modes', async () => {
    const storageKey = 'test_rd_mini_chat_ui_scale';
    const { ws } = createSharedMockWs();
    const mainChat = makeMainChatContext(ws);

    // 1. Legacy { width, x, y } storage keeps width and drops stale top-left x/y so window returns to bottom-right
    localStorage.setItem(storageKey, '360');
    localStorage.setItem(`${storageKey}:layout`, JSON.stringify({ width: 340, x: 20, y: 200 }));
    document.documentElement.style.zoom = '0.75';
    document.documentElement.style.setProperty('--imcodes-ui-zoom', '0.75');

    const firstView = render(
      <div data-testid="scale-host" style={{ position: 'relative', width: '524px', height: '1136px' }}>
        <CloudDocsMainChatFloat
          mainChat={mainChat}
          heightStorageKey={storageKey}
          defaultWidth={380}
          minWidth={280}
          defaultHeight={420}
          minHeight={220}
        />
      </div>,
    );
    const scaleHost = screen.getByTestId('scale-host');
    Object.defineProperty(scaleHost, 'clientWidth', { configurable: true, value: 524 });
    Object.defineProperty(scaleHost, 'clientHeight', { configurable: true, value: 1136 });
    Object.defineProperty(scaleHost, 'offsetWidth', { configurable: true, value: 524 });
    Object.defineProperty(scaleHost, 'offsetHeight', { configurable: true, value: 1136 });
    vi.spyOn(scaleHost, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 393, height: 852, right: 393, bottom: 852, x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    const migratedMiniChat = await screen.findByTestId('cloud-docs-mini-chat');
    expect(migratedMiniChat.classList.contains('is-positioned')).toBe(false);
    expect(migratedMiniChat.style.left).toBe('');
    expect(migratedMiniChat.style.top).toBe('');
    expect(migratedMiniChat.style.right).toBe('');
    expect(migratedMiniChat.style.bottom).toBe('');
    expect(migratedMiniChat.style.width).toBe('340px');
    expect(migratedMiniChat.style.height).toBe('360px');
    firstView.unmount();
    localStorage.clear();

    // 2. Chromium mode at zoom=0.75 (getBoundingClientRect scaled by 0.75): drag & 8-dir resize scale by 1/0.75 without jumping
    document.documentElement.style.zoom = '0.75';
    document.documentElement.style.setProperty('--imcodes-ui-zoom', '0.75');
    render(
      <div data-testid="chromium-zoom-host" style={{ position: 'relative', width: '1000px', height: '800px' }}>
        <CloudDocsMainChatFloat
          mainChat={mainChat}
          heightStorageKey={storageKey}
          defaultWidth={380}
          minWidth={280}
          maxWidth={700}
          defaultHeight={420}
          minHeight={220}
          maxHeight={650}
        />
      </div>,
    );
    const chromeHost = screen.getByTestId('chromium-zoom-host');
    Object.defineProperty(chromeHost, 'clientWidth', { configurable: true, value: 1000 });
    Object.defineProperty(chromeHost, 'clientHeight', { configurable: true, value: 800 });
    Object.defineProperty(chromeHost, 'offsetWidth', { configurable: true, value: 1000 });
    Object.defineProperty(chromeHost, 'offsetHeight', { configurable: true, value: 800 });
    vi.spyOn(chromeHost, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 750, height: 600, right: 750, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    const chromeMini = await screen.findByTestId('cloud-docs-mini-chat');
    Object.defineProperty(chromeMini, 'offsetWidth', { configurable: true, value: 380 });
    Object.defineProperty(chromeMini, 'offsetHeight', { configurable: true, value: 420 });
    // Docked CSS rect in 1000x800 layout at right=14, bottom=62 (width=380, height=420) -> scaled by 0.75 in Chromium:
    // left=(1000-14-380)*0.75=454.5, top=(800-62-420)*0.75=238.5, right=986*0.75=739.5, bottom=738*0.75=553.5, width=285, height=315
    vi.spyOn(chromeMini, 'getBoundingClientRect').mockReturnValue({
      left: 454.5, top: 238.5, width: 285, height: 315, right: 739.5, bottom: 553.5, x: 454.5, y: 238.5, toJSON: () => ({}),
    });

    // Pointer move (-75, -75) visual px under zoom=0.75 => (-100, -100) layout px -> right=14+100=114, bottom=62+100=162
    const chromeHeader = screen.getByTestId('cloud-docs-mini-chat-header');
    fireEvent(chromeHeader, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 500, clientY: 250, pointerId: 31,
    }));
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 425, clientY: 175, pointerId: 31,
    }));
    expect(chromeMini.style.right).toBe('114px');
    expect(chromeMini.style.bottom).toBe('162px');
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 425, clientY: 175, pointerId: 31,
    }));

    // Update mocked visual rect to reflect positioned (right=114, bottom=162, width=380, height=420):
    // left=506*0.75=379.5, top=218*0.75=163.5, right=886*0.75=664.5, bottom=638*0.75=478.5
    vi.spyOn(chromeMini, 'getBoundingClientRect').mockReturnValue({
      left: 379.5, top: 163.5, width: 285, height: 315, right: 664.5, bottom: 478.5, x: 379.5, y: 163.5, toJSON: () => ({}),
    });

    // Resize south-west handle by (-30, +45) visual px -> (-40, +60) layout px => width=420, height=480, right=114, bottom=162-60=102
    const swHandle = screen.getByTestId('mini-chat-resize-handle-sw');
    fireEvent(swHandle, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 379.5, clientY: 478.5, pointerId: 32,
    }));
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 349.5, clientY: 523.5, pointerId: 32,
    }));
    expect(chromeMini.style.width).toBe('420px');
    expect(chromeMini.style.height).toBe('480px');
    expect(chromeMini.style.right).toBe('114px');
    expect(chromeMini.style.bottom).toBe('102px');
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 349.5, clientY: 523.5, pointerId: 32,
    }));

    // Resize north-east handle by (+30, -30) visual px -> (+40, -40) layout px
    Object.defineProperty(chromeMini, 'offsetWidth', { configurable: true, value: 420 });
    Object.defineProperty(chromeMini, 'offsetHeight', { configurable: true, value: 480 });
    vi.spyOn(chromeMini, 'getBoundingClientRect').mockReturnValue({
      left: 349.5, top: 163.5, width: 315, height: 360, right: 664.5, bottom: 523.5, x: 349.5, y: 163.5, toJSON: () => ({}),
    });
    const neHandle = screen.getByTestId('mini-chat-resize-handle-ne');
    fireEvent(neHandle, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 664.5, clientY: 163.5, pointerId: 33,
    }));
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 694.5, clientY: 133.5, pointerId: 33,
    }));
    expect(chromeMini.style.width).toBe('460px');
    expect(chromeMini.style.height).toBe('520px');
    expect(chromeMini.style.right).toBe('74px');
    expect(chromeMini.style.bottom).toBe('102px');
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 694.5, clientY: 133.5, pointerId: 33,
    }));

    // Changing UI scale (60% -> 100% -> 125% -> 150%) keeps right/bottom anchored near corner and fires UI_SCALE_EVENT cleanly
    for (const [pct, zoomStr, newW, newH] of [
      ['60%', '0.6', 655, 1420],
      ['100%', '1', 393, 852],
      ['125%', '1.25', 314, 682],
      ['150%', '1.5', 262, 568],
    ] as const) {
      document.documentElement.style.zoom = zoomStr === '1' ? '' : zoomStr;
      if (zoomStr === '1') {
        document.documentElement.style.removeProperty('--imcodes-ui-zoom');
      } else {
        document.documentElement.style.setProperty('--imcodes-ui-zoom', zoomStr);
      }
      Object.defineProperty(chromeHost, 'clientWidth', { configurable: true, value: newW });
      Object.defineProperty(chromeHost, 'clientHeight', { configurable: true, value: newH });
      Object.defineProperty(chromeHost, 'offsetWidth', { configurable: true, value: newW });
      Object.defineProperty(chromeHost, 'offsetHeight', { configurable: true, value: newH });
      act(() => {
        window.dispatchEvent(new CustomEvent('imcodes:uiScaleChanged', { detail: { scale: Number(zoomStr) * 100 } }));
      });
      const r = Number.parseInt(chromeMini.style.right, 10);
      const b = Number.parseInt(chromeMini.style.bottom, 10);
      const w = Number.parseInt(chromeMini.style.width, 10);
      const h = Number.parseInt(chromeMini.style.height, 10);
      expect(r, pct).toBeGreaterThanOrEqual(0);
      expect(b, pct).toBeGreaterThanOrEqual(0);
      expect(r + w, pct).toBeLessThanOrEqual(newW);
      expect(b + h, pct).toBeLessThanOrEqual(newH);
    }

    cleanup();
    localStorage.clear();

    // 3. iOS WebKit unscaled-rect mode (getDomRectToLayoutScale() === 1 at zoom=0.75; pointer deltas still in visual px)
    document.documentElement.style.zoom = '0.75';
    document.documentElement.style.setProperty('--imcodes-ui-zoom', '0.75');
    render(
      <div data-testid="webkit-zoom-host" style={{ position: 'relative', width: '524px', height: '1136px' }}>
        <CloudDocsMainChatFloat
          mainChat={mainChat}
          heightStorageKey={storageKey}
          defaultWidth={380}
          minWidth={280}
          defaultHeight={420}
          minHeight={220}
        />
      </div>,
    );
    const wkHost = screen.getByTestId('webkit-zoom-host');
    Object.defineProperty(wkHost, 'clientWidth', { configurable: true, value: 524 });
    Object.defineProperty(wkHost, 'clientHeight', { configurable: true, value: 1136 });
    Object.defineProperty(wkHost, 'offsetWidth', { configurable: true, value: 524 });
    Object.defineProperty(wkHost, 'offsetHeight', { configurable: true, value: 1136 });
    // iOS WebKit reports unscaled CSS layout rects (ratio === 1)
    vi.spyOn(wkHost, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 524, height: 1136, right: 524, bottom: 1136, x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    const wkMini = await screen.findByTestId('cloud-docs-mini-chat');
    Object.defineProperty(wkMini, 'offsetWidth', { configurable: true, value: 380 });
    Object.defineProperty(wkMini, 'offsetHeight', { configurable: true, value: 420 });
    vi.spyOn(wkMini, 'getBoundingClientRect').mockReturnValue({
      left: 130, top: 654, width: 380, height: 420, right: 510, bottom: 1074, x: 130, y: 654, toJSON: () => ({}),
    });

    // Drag up/left by (-30, -60) visual px -> (-40, -80) CSS layout px => right = 14+40 = 54, bottom = 62+80 = 142
    const wkHeader = screen.getByTestId('cloud-docs-mini-chat-header');
    fireEvent(wkHeader, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 250, clientY: 670, pointerId: 41,
    }));
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 220, clientY: 610, pointerId: 41,
    }));
    expect(wkMini.style.right).toBe('54px');
    expect(wkMini.style.bottom).toBe('142px');
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 220, clientY: 610, pointerId: 41,
    }));

    // Verify zero-container viewport fallback scales window.innerWidth/innerHeight by 1/zoom
    cleanup();
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 393 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 852 });
    render(
      <div data-testid="fallback-host">
        <CloudDocsMainChatFloat
          mainChat={mainChat}
          heightStorageKey={storageKey}
          defaultWidth={380}
          minWidth={280}
          defaultHeight={420}
          minHeight={220}
        />
      </div>,
    );
    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    const fbMini = await screen.findByTestId('cloud-docs-mini-chat');
    const fbWest = screen.getByTestId('mini-chat-resize-handle-w');
    // Unscaled viewport is 393/0.75 = 524px wide -> dragging W handle left can reach maxWidth 524 - 28 = 496px (NOT capped at 393 - 28 = 365px!)
    fireEvent(fbWest, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 300, clientY: 400, pointerId: 51,
    }));
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 150, clientY: 400, pointerId: 51,
    }));
    expect(Number.parseInt(fbMini.style.width, 10)).toBeGreaterThan(400);
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 150, clientY: 400, pointerId: 51,
    }));

    document.documentElement.style.zoom = '';
    document.documentElement.style.removeProperty('--imcodes-ui-zoom');
  });

  it('preserves docked-constrained dimensions when undocking via drag or single-axis resize (393x852 @ 150%), keeps orthogonal axis fixed, and recovers saved size when space expands', async () => {
    const storageKey = 'test_rd_mini_chat_undock_150';
    const { ws } = createSharedMockWs();
    const mainChat = makeMainChatContext(ws);

    // 393x852 Chromium viewport at 150% UI scale -> 262x568 CSS layout container.
    // Saved width=340, height=640 are clamped in docked mode to 234x492 (351x738 visual px).
    localStorage.setItem(storageKey, '640');
    localStorage.setItem(`${storageKey}:layout`, JSON.stringify({ width: 340 }));
    document.documentElement.style.zoom = '1.5';
    document.documentElement.style.setProperty('--imcodes-ui-zoom', '1.5');
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 393 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 852 });

    const { unmount } = render(
      <div data-testid="dock-150-host" style={{ position: 'relative', width: '262px', height: '568px' }}>
        <CloudDocsMainChatFloat
          mainChat={mainChat}
          heightStorageKey={storageKey}
          defaultWidth={380}
          minWidth={280}
          defaultHeight={420}
          minHeight={220}
        />
      </div>,
    );
    const host = screen.getByTestId('dock-150-host');
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 262 });
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 568 });
    Object.defineProperty(host, 'offsetWidth', { configurable: true, value: 262 });
    Object.defineProperty(host, 'offsetHeight', { configurable: true, value: 568 });
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 393, height: 852, right: 393, bottom: 852, x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    const miniChat = await screen.findByTestId('cloud-docs-mini-chat');
    // Docked clamped size in layout px (desktop inset right=14, bottom=62, margin=8): width=240 (262-22), height=498 (568-70)
    expect(miniChat.style.width).toBe('240px');
    expect(miniChat.style.height).toBe('498px');

    Object.defineProperty(miniChat, 'offsetWidth', { configurable: true, value: 240 });
    Object.defineProperty(miniChat, 'offsetHeight', { configurable: true, value: 498 });
    // Visual rect in 393x852 (at docked right=14, bottom=62 layout -> 21, 93 visual): width=360, height=747
    vi.spyOn(miniChat, 'getBoundingClientRect').mockReturnValue({
      left: 12, top: 12, width: 360, height: 747, right: 372, bottom: 759, x: 12, y: 12, toJSON: () => ({}),
    });

    // Drag header down by 3 visual px (= 2 layout px): box MUST stay 240x498 (NOT jump to 246x552), and bottom moves 62 -> 60
    const header = screen.getByTestId('cloud-docs-mini-chat-header');
    fireEvent(header, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 180, clientY: 40, pointerId: 61,
    }));
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 180, clientY: 43, pointerId: 61,
    }));
    expect(miniChat.classList.contains('is-positioned')).toBe(true);
    expect(miniChat.style.width).toBe('240px');
    expect(miniChat.style.height).toBe('498px');
    expect(miniChat.style.right).toBe('14px');
    expect(miniChat.style.bottom).toBe('60px');
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 180, clientY: 43, pointerId: 61,
    }));

    // Pure drag preserved saved desired width=340 and height=640 in localStorage
    expect(localStorage.getItem(storageKey)).toBe('640');
    expect(JSON.parse(localStorage.getItem(`${storageKey}:layout`) || '{}')).toEqual({
      width: 340,
      right: 14,
      bottom: 60,
    });

    // When UI scale returns to 100% (393x852 layout), saved desired width=340 and height=640 recover cleanly
    document.documentElement.style.zoom = '';
    document.documentElement.style.removeProperty('--imcodes-ui-zoom');
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 393 });
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 852 });
    Object.defineProperty(host, 'offsetWidth', { configurable: true, value: 393 });
    Object.defineProperty(host, 'offsetHeight', { configurable: true, value: 852 });
    act(() => {
      window.dispatchEvent(new CustomEvent('imcodes:uiScaleChanged', { detail: { scale: 100 } }));
    });
    expect(miniChat.style.width).toBe('340px');
    expect(miniChat.style.height).toBe('640px');
    expect(miniChat.style.right).toBe('14px');
    expect(miniChat.style.bottom).toBe('60px');

    unmount();

    // Single-axis edge resize ('e') from docked constrained state keeps the orthogonal axis fixed at its docked size
    localStorage.setItem(storageKey, '640');
    localStorage.setItem(`${storageKey}:layout`, JSON.stringify({ width: 340 }));
    document.documentElement.style.zoom = '1.5';
    document.documentElement.style.setProperty('--imcodes-ui-zoom', '1.5');
    render(
      <div data-testid="dock-edge-host" style={{ position: 'relative', width: '262px', height: '568px' }}>
        <CloudDocsMainChatFloat
          mainChat={mainChat}
          heightStorageKey={storageKey}
          defaultWidth={380}
          minWidth={200}
          defaultHeight={420}
          minHeight={220}
        />
      </div>,
    );
    const edgeHost = screen.getByTestId('dock-edge-host');
    Object.defineProperty(edgeHost, 'clientWidth', { configurable: true, value: 262 });
    Object.defineProperty(edgeHost, 'clientHeight', { configurable: true, value: 568 });
    Object.defineProperty(edgeHost, 'offsetWidth', { configurable: true, value: 262 });
    Object.defineProperty(edgeHost, 'offsetHeight', { configurable: true, value: 568 });
    vi.spyOn(edgeHost, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 393, height: 852, right: 393, bottom: 852, x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    const edgeMini = await screen.findByTestId('cloud-docs-mini-chat');
    Object.defineProperty(edgeMini, 'offsetWidth', { configurable: true, value: 240 });
    Object.defineProperty(edgeMini, 'offsetHeight', { configurable: true, value: 498 });
    vi.spyOn(edgeMini, 'getBoundingClientRect').mockReturnValue({
      left: 12, top: 12, width: 360, height: 747, right: 372, bottom: 759, x: 12, y: 12, toJSON: () => ({}),
    });

    // Single-axis 'e' resize inward by -30 visual px (-20 layout px): width shrinks 240 -> 220, orthogonal height stays 498!
    const eastHandle = screen.getByTestId('mini-chat-resize-handle-e');
    fireEvent(eastHandle, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 372, clientY: 300, pointerId: 62,
    }));
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 342, clientY: 300, pointerId: 62,
    }));
    expect(edgeMini.style.width).toBe('220px');
    expect(edgeMini.style.height).toBe('498px');
    expect(edgeMini.style.right).toBe('34px');
    expect(edgeMini.style.bottom).toBe('62px');
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 342, clientY: 300, pointerId: 62,
    }));

    // Saved desired height=640 was NOT degraded by the pure horizontal resize!
    expect(localStorage.getItem(storageKey)).toBe('640');

    document.documentElement.style.zoom = '';
    document.documentElement.style.removeProperty('--imcodes-ui-zoom');
  });

  it('preserves default CSS size below minWidth when undocking via vertical drag or vertical-only edge resize (393x852 @ 150%, empty storage)', async () => {
    const storageKey = 'test_rd_mini_chat_default_undock_150';
    const { ws } = createSharedMockWs();
    const mainChat = makeMainChatContext(ws);

    // Empty storage, 393x852 Chromium @ 150% -> 262x568 CSS layout container.
    // Docked mobile CSS puts mini-chat at right=10, bottom=58 with width=242 (< minWidth=280), height=380 -> visual 363x570 at right=15px.
    localStorage.clear();
    document.documentElement.style.zoom = '1.5';
    document.documentElement.style.setProperty('--imcodes-ui-zoom', '1.5');
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 393 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 852 });

    const { unmount } = render(
      <div data-testid="default-150-host" style={{ position: 'relative', width: '262px', height: '568px' }}>
        <CloudDocsMainChatFloat
          mainChat={mainChat}
          heightStorageKey={storageKey}
          defaultWidth={380}
          minWidth={280}
          defaultHeight={420}
          minHeight={220}
        />
      </div>,
    );
    const host = screen.getByTestId('default-150-host');
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 262 });
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 568 });
    Object.defineProperty(host, 'offsetWidth', { configurable: true, value: 262 });
    Object.defineProperty(host, 'offsetHeight', { configurable: true, value: 568 });
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 393, height: 852, right: 393, bottom: 852, x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    const miniChat = await screen.findByTestId('cloud-docs-mini-chat');
    Object.defineProperty(miniChat, 'offsetWidth', { configurable: true, value: 242 });
    Object.defineProperty(miniChat, 'offsetHeight', { configurable: true, value: 380 });
    vi.spyOn(miniChat, 'getBoundingClientRect').mockReturnValue({
      left: 15, top: 195, width: 363, height: 570, right: 378, bottom: 765, x: 15, y: 195, toJSON: () => ({}),
    });

    // Pure vertical drag up by 3 visual px (= 2 layout px): width stays 242 (NOT raised to 246), right stays 10 (NOT jumped to 8), bottom 58 -> 60
    const header = screen.getByTestId('cloud-docs-mini-chat-header');
    fireEvent(header, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 180, clientY: 210, pointerId: 71,
    }));
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 180, clientY: 207, pointerId: 71,
    }));
    expect(miniChat.classList.contains('is-positioned')).toBe(true);
    expect(miniChat.style.width).toBe('242px');
    expect(miniChat.style.height).toBe('380px');
    expect(miniChat.style.right).toBe('10px');
    expect(miniChat.style.bottom).toBe('60px');
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 180, clientY: 207, pointerId: 71,
    }));
    // Temporary capped width was NOT written into localStorage
    expect(JSON.parse(localStorage.getItem(`${storageKey}:layout`) || '{}')).toEqual({
      right: 10,
      bottom: 60,
    });
    expect(localStorage.getItem(storageKey)).toBeNull();

    // Now pull east handle INWARD by -18 visual px (-12 layout px): box is already below minWidth=280 (242 < 246),
    // so inward resize must stop at 242 and keep BOTH right=10 and west edge fixed (NO reverse jump to 246/right=8)!
    vi.spyOn(miniChat, 'getBoundingClientRect').mockReturnValue({
      left: 15, top: 192, width: 363, height: 570, right: 378, bottom: 762, x: 15, y: 192, toJSON: () => ({}),
    });
    const eastHandle = screen.getByTestId('mini-chat-resize-handle-e');
    fireEvent(eastHandle, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 378, clientY: 300, pointerId: 73,
    }));
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 360, clientY: 300, pointerId: 73,
    }));
    expect(miniChat.style.width).toBe('242px');
    expect(miniChat.style.height).toBe('380px');
    expect(miniChat.style.right).toBe('10px');
    expect(miniChat.style.bottom).toBe('60px');
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 360, clientY: 300, pointerId: 73,
    }));
    expect(JSON.parse(localStorage.getItem(`${storageKey}:layout`) || '{}')).toEqual({
      right: 10,
      bottom: 60,
    });

    // Now pull east handle OUTWARD by +3 visual px (+2 layout px): right moves 10 -> 8, width grows 242 -> 244 (west edge stays 262-8-244=10!)
    fireEvent(eastHandle, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 378, clientY: 300, pointerId: 74,
    }));
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 381, clientY: 300, pointerId: 74,
    }));
    expect(miniChat.style.width).toBe('244px');
    expect(miniChat.style.height).toBe('380px');
    expect(miniChat.style.right).toBe('8px');
    expect(miniChat.style.bottom).toBe('60px');
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 381, clientY: 300, pointerId: 74,
    }));
    unmount();

    // Direct outward pull on docked West handle ('w') at 393x852 @ 150%, empty storage (docked right=10, width=242, left=10 -> visual x=15, right=378):
    // Pulling West edge left by 3 visual px (-2 layout px) must NOT reverse-shrink width to 234 or shift x right to 27!
    localStorage.clear();
    const { unmount: unmountWest } = render(
      <div data-testid="dock-west-150-host" style={{ position: 'relative', width: '262px', height: '568px' }}>
        <CloudDocsMainChatFloat
          mainChat={mainChat}
          heightStorageKey={storageKey}
          defaultWidth={380}
          minWidth={280}
          defaultHeight={420}
          minHeight={220}
        />
      </div>,
    );
    const westHost = screen.getByTestId('dock-west-150-host');
    Object.defineProperty(westHost, 'clientWidth', { configurable: true, value: 262 });
    Object.defineProperty(westHost, 'clientHeight', { configurable: true, value: 568 });
    Object.defineProperty(westHost, 'offsetWidth', { configurable: true, value: 262 });
    Object.defineProperty(westHost, 'offsetHeight', { configurable: true, value: 568 });
    vi.spyOn(westHost, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 393, height: 852, right: 393, bottom: 852, x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    const westMini = await screen.findByTestId('cloud-docs-mini-chat');
    Object.defineProperty(westMini, 'offsetWidth', { configurable: true, value: 242 });
    Object.defineProperty(westMini, 'offsetHeight', { configurable: true, value: 380 });
    vi.spyOn(westMini, 'getBoundingClientRect').mockReturnValue({
      left: 15, top: 195, width: 363, height: 570, right: 378, bottom: 765, x: 15, y: 195, toJSON: () => ({}),
    });

    const westHandle = screen.getByTestId('mini-chat-resize-handle-w');
    fireEvent(westHandle, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 15, clientY: 300, pointerId: 75,
    }));
    // Pull outward left 3 visual px (-2 layout px): width expands 242 -> 244 (not shrinking to 234!), left = 262-10-244 = 8 <= 10, right stays docked
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 12, clientY: 300, pointerId: 75,
    }));
    const wAfterOutward = Number.parseInt(westMini.style.width, 10);
    expect(wAfterOutward).toBe(244);
    expect(262 - 10 - wAfterOutward).toBeLessThanOrEqual(10);
    expect(westMini.classList.contains('is-positioned')).toBe(false);
    // Inward back past initial edge stops cleanly at startW=242 (zero jump)
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 30, clientY: 300, pointerId: 75,
    }));
    expect(westMini.style.width).toBe('242px');
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 30, clientY: 300, pointerId: 75,
    }));
    unmountWest();

    // Vertical mirror on docked North handle ('n') with constrained height (262x250 @ 150%, docked bottom=58, height=182 < minHeight=220):
    localStorage.clear();
    const { unmount: unmountNorth } = render(
      <div data-testid="dock-north-150-host" style={{ position: 'relative', width: '262px', height: '250px' }}>
        <CloudDocsMainChatFloat
          mainChat={mainChat}
          heightStorageKey={storageKey}
          defaultWidth={380}
          minWidth={280}
          defaultHeight={420}
          minHeight={220}
        />
      </div>,
    );
    const northHost = screen.getByTestId('dock-north-150-host');
    Object.defineProperty(northHost, 'clientWidth', { configurable: true, value: 262 });
    Object.defineProperty(northHost, 'clientHeight', { configurable: true, value: 250 });
    Object.defineProperty(northHost, 'offsetWidth', { configurable: true, value: 262 });
    Object.defineProperty(northHost, 'offsetHeight', { configurable: true, value: 250 });
    vi.spyOn(northHost, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 393, height: 375, right: 393, bottom: 375, x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    const northMini = await screen.findByTestId('cloud-docs-mini-chat');
    Object.defineProperty(northMini, 'offsetWidth', { configurable: true, value: 242 });
    Object.defineProperty(northMini, 'offsetHeight', { configurable: true, value: 182 });
    vi.spyOn(northMini, 'getBoundingClientRect').mockReturnValue({
      left: 15, top: 15, width: 363, height: 273, right: 378, bottom: 288, x: 15, y: 15, toJSON: () => ({}),
    });

    const northHandle = screen.getByTestId('mini-chat-resize-handle');
    fireEvent(northHandle, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 180, clientY: 15, pointerId: 76,
    }));
    // Pull outward up 3 visual px (-2 layout px): height expands 182 -> 184 (top 10 -> 8, bottom stays docked at 58)
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 180, clientY: 12, pointerId: 76,
    }));
    const hAfterOutward = Number.parseInt(northMini.style.height, 10);
    expect(hAfterOutward).toBe(184);
    expect(250 - 58 - hAfterOutward).toBeLessThanOrEqual(10);
    expect(northMini.classList.contains('is-positioned')).toBe(false);
    // Inward pull down stops cleanly at startH=182
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 180, clientY: 30, pointerId: 76,
    }));
    expect(northMini.style.height).toBe('182px');
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 180, clientY: 30, pointerId: 76,
    }));
    unmountNorth();

    // Fresh docked state at 150%: vertical-only south edge resize keeps width=242 and right=10 untouched
    localStorage.clear();
    render(
      <div data-testid="default-edge-150-host" style={{ position: 'relative', width: '262px', height: '568px' }}>
        <CloudDocsMainChatFloat
          mainChat={mainChat}
          heightStorageKey={storageKey}
          defaultWidth={380}
          minWidth={280}
          defaultHeight={420}
          minHeight={220}
        />
      </div>,
    );
    const edgeHost = screen.getByTestId('default-edge-150-host');
    Object.defineProperty(edgeHost, 'clientWidth', { configurable: true, value: 262 });
    Object.defineProperty(edgeHost, 'clientHeight', { configurable: true, value: 568 });
    Object.defineProperty(edgeHost, 'offsetWidth', { configurable: true, value: 262 });
    Object.defineProperty(edgeHost, 'offsetHeight', { configurable: true, value: 568 });
    vi.spyOn(edgeHost, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 393, height: 852, right: 393, bottom: 852, x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
    const edgeMini = await screen.findByTestId('cloud-docs-mini-chat');
    Object.defineProperty(edgeMini, 'offsetWidth', { configurable: true, value: 242 });
    Object.defineProperty(edgeMini, 'offsetHeight', { configurable: true, value: 380 });
    vi.spyOn(edgeMini, 'getBoundingClientRect').mockReturnValue({
      left: 15, top: 195, width: 363, height: 570, right: 378, bottom: 765, x: 15, y: 195, toJSON: () => ({}),
    });

    // Resize south edge down by +30 visual px (+20 layout px): height 380 -> 400, bottom 58 -> 38, width stays 242, right stays 10!
    const southHandle = screen.getByTestId('mini-chat-resize-handle-s');
    fireEvent(southHandle, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      button: 0, clientX: 180, clientY: 765, pointerId: 72,
    }));
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 180, clientY: 795, pointerId: 72,
    }));
    expect(edgeMini.style.width).toBe('242px');
    expect(edgeMini.style.height).toBe('400px');
    expect(edgeMini.style.right).toBe('10px');
    expect(edgeMini.style.bottom).toBe('38px');
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 180, clientY: 795, pointerId: 72,
    }));
    expect(JSON.parse(localStorage.getItem(`${storageKey}:layout`) || '{}')).toEqual({
      right: 10,
      bottom: 38,
    });
    expect(localStorage.getItem(storageKey)).toBe('400');

    document.documentElement.style.zoom = '';
    document.documentElement.style.removeProperty('--imcodes-ui-zoom');
  });

  it('clamps docked resized width and height inside container when zooming 100% -> 150% and restores preferred sizes at 100%', async () => {
    const storageKey = 'test_mini_chat_docked_zoom_shrink_clamp';
    const { ws } = createSharedMockWs();
    const mainChat = makeMainChatContext(ws);
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('max-width: 600px'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    try {
      // 100% UI scale on 393x852 mobile viewport -> docked insets right=10, bottom=58, layout=393x852
      localStorage.clear();
      document.documentElement.style.zoom = '';
      document.documentElement.style.removeProperty('--imcodes-ui-zoom');
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 393 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 852 });

      const { unmount } = render(
        <div data-testid="zoom-shrink-w-host" style={{ position: 'relative', width: '393px', height: '852px' }}>
          <CloudDocsMainChatFloat
            mainChat={mainChat}
            heightStorageKey={storageKey}
            defaultWidth={380}
            minWidth={280}
            defaultHeight={420}
            minHeight={220}
          />
        </div>,
      );
      const hostW = screen.getByTestId('zoom-shrink-w-host');
      const syncHostW = (w: number, h: number) => {
        Object.defineProperty(hostW, 'clientWidth', { configurable: true, value: w });
        Object.defineProperty(hostW, 'clientHeight', { configurable: true, value: h });
        Object.defineProperty(hostW, 'offsetWidth', { configurable: true, value: w });
        Object.defineProperty(hostW, 'offsetHeight', { configurable: true, value: h });
        vi.spyOn(hostW, 'getBoundingClientRect').mockReturnValue({
          left: 0, top: 0, width: 393, height: 852, right: 393, bottom: 852, x: 0, y: 0, toJSON: () => ({}),
        });
      };
      syncHostW(393, 852);

      fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
      const miniW = await screen.findByTestId('cloud-docs-mini-chat');
      Object.defineProperty(miniW, 'offsetWidth', { configurable: true, value: 373 });
      Object.defineProperty(miniW, 'offsetHeight', { configurable: true, value: 420 });
      vi.spyOn(miniW, 'getBoundingClientRect').mockReturnValue({
        left: 10, top: 374, width: 373, height: 420, right: 383, bottom: 794, x: 10, y: 374, toJSON: () => ({}),
      });

      // Pull west edge left by 2px (373 -> 375), release pointer
      const westHandle = screen.getByTestId('mini-chat-resize-handle-w');
      fireEvent(westHandle, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
        button: 0, clientX: 10, clientY: 500, pointerId: 81,
      }));
      fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
        clientX: 8, clientY: 500, pointerId: 81,
      }));
      expect(miniW.style.width).toBe('375px');
      fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
        clientX: 8, clientY: 500, pointerId: 81,
      }));
      expect(JSON.parse(localStorage.getItem(`${storageKey}:layout`) || '{}')).toEqual({ width: 375 });

      // Switch 100% -> 150%: layout container shrinks to 262x568; inline width/maxWidth MUST fit <= 262 - 10 = 252
      document.documentElement.style.zoom = '1.5';
      document.documentElement.style.setProperty('--imcodes-ui-zoom', '1.5');
      syncHostW(262, 568);
      act(() => {
        window.dispatchEvent(new CustomEvent('imcodes:uiScaleChanged', { detail: { scale: 150 } }));
      });
      const renderedWidthAt150 = Number.parseInt(miniW.style.width, 10);
      const renderedMaxWidthAt150 = Number.parseInt(miniW.style.maxWidth, 10);
      expect(renderedWidthAt150 + 10).toBeLessThanOrEqual(262);
      expect(renderedMaxWidthAt150 + 10).toBeLessThanOrEqual(262);
      expect(renderedWidthAt150).toBe(244);
      // Preferred width=375 remains preserved in storage
      expect(JSON.parse(localStorage.getItem(`${storageKey}:layout`) || '{}')).toEqual({ width: 375 });

      // Return to 100%: preferred width=375 recovers
      document.documentElement.style.zoom = '';
      document.documentElement.style.removeProperty('--imcodes-ui-zoom');
      syncHostW(393, 852);
      act(() => {
        window.dispatchEvent(new CustomEvent('imcodes:uiScaleChanged', { detail: { scale: 100 } }));
      });
      expect(miniW.style.width).toBe('375px');
      expect(miniW.style.maxWidth).toBe('375px');
      unmount();

      // Symmetric vertical axis: 100% docked north edge pull (784 -> 786), then 100% -> 150% -> 100%
      localStorage.clear();
      render(
        <div data-testid="zoom-shrink-h-host" style={{ position: 'relative', width: '393px', height: '852px' }}>
          <CloudDocsMainChatFloat
            mainChat={mainChat}
            heightStorageKey={storageKey}
            defaultWidth={380}
            minWidth={280}
            defaultHeight={420}
            minHeight={220}
          />
        </div>,
      );
      const hostH = screen.getByTestId('zoom-shrink-h-host');
      const syncHostH = (w: number, h: number) => {
        Object.defineProperty(hostH, 'clientWidth', { configurable: true, value: w });
        Object.defineProperty(hostH, 'clientHeight', { configurable: true, value: h });
        Object.defineProperty(hostH, 'offsetWidth', { configurable: true, value: w });
        Object.defineProperty(hostH, 'offsetHeight', { configurable: true, value: h });
        vi.spyOn(hostH, 'getBoundingClientRect').mockReturnValue({
          left: 0, top: 0, width: 393, height: 852, right: 393, bottom: 852, x: 0, y: 0, toJSON: () => ({}),
        });
      };
      syncHostH(393, 852);

      fireEvent.click(screen.getByTestId('cloud-docs-main-chat-fab'));
      const miniH = await screen.findByTestId('cloud-docs-mini-chat');
      Object.defineProperty(miniH, 'offsetWidth', { configurable: true, value: 373 });
      Object.defineProperty(miniH, 'offsetHeight', { configurable: true, value: 784 });
      vi.spyOn(miniH, 'getBoundingClientRect').mockReturnValue({
        left: 10, top: 10, width: 373, height: 784, right: 383, bottom: 794, x: 10, y: 10, toJSON: () => ({}),
      });

      const northHandle = screen.getByTestId('mini-chat-resize-handle');
      fireEvent(northHandle, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
        button: 0, clientX: 180, clientY: 10, pointerId: 82,
      }));
      fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
        clientX: 180, clientY: 8, pointerId: 82,
      }));
      expect(miniH.style.height).toBe('786px');
      fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
        clientX: 180, clientY: 8, pointerId: 82,
      }));
      expect(localStorage.getItem(storageKey)).toBe('786');

      document.documentElement.style.zoom = '1.5';
      document.documentElement.style.setProperty('--imcodes-ui-zoom', '1.5');
      syncHostH(262, 568);
      act(() => {
        window.dispatchEvent(new CustomEvent('imcodes:uiScaleChanged', { detail: { scale: 150 } }));
      });
      const renderedHeightAt150 = Number.parseInt(miniH.style.height, 10);
      const renderedMaxHeightAt150 = Number.parseInt(miniH.style.maxHeight, 10);
      expect(renderedHeightAt150 + 58).toBeLessThanOrEqual(568);
      expect(renderedMaxHeightAt150 + 58).toBeLessThanOrEqual(568);
      expect(renderedHeightAt150).toBe(502);
      expect(localStorage.getItem(storageKey)).toBe('786');

      document.documentElement.style.zoom = '';
      document.documentElement.style.removeProperty('--imcodes-ui-zoom');
      syncHostH(393, 852);
      act(() => {
        window.dispatchEvent(new CustomEvent('imcodes:uiScaleChanged', { detail: { scale: 100 } }));
      });
      expect(miniH.style.height).toBe('786px');
      expect(miniH.style.maxHeight).toBe('786px');
    } finally {
      document.documentElement.style.zoom = '';
      document.documentElement.style.removeProperty('--imcodes-ui-zoom');
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: originalMatchMedia,
      });
    }
  });
});
