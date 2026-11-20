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
    expect(miniChat.style.left).toBe('306px');
    expect(miniChat.style.top).toBe('118px');
    // No synchronous localStorage churn during pointermove
    expect(setItemSpy).not.toHaveBeenCalled();

    // Clamp against top-left edge (8px margin)
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: -400, clientY: -400, pointerId: 11,
    }));
    expect(miniChat.style.left).toBe('8px');
    expect(miniChat.style.top).toBe('8px');

    // Clamp against bottom-right edge: (900 - 380 - 8 = 512, 700 - 420 - 8 = 272)
    fireEvent(window, Object.assign(new Event('pointermove', { bubbles: true }), {
      clientX: 1600, clientY: 1400, pointerId: 11,
    }));
    expect(miniChat.style.left).toBe('512px');
    expect(miniChat.style.top).toBe('272px');

    // Commit at (240, 120) -> delta (-360, -110) => (506 - 360 = 146, 218 - 110 = 108)
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
      position: undefined,
      x: 146,
      y: 108,
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
    const restoredLeft = Number.parseInt(tinyMiniChat.style.left, 10);
    const restoredTop = Number.parseInt(tinyMiniChat.style.top, 10);
    expect(restoredLeft).toBeGreaterThanOrEqual(0);
    expect(restoredTop).toBeGreaterThanOrEqual(0);
    expect(restoredLeft).toBeLessThan(300);
    expect(restoredTop).toBeLessThan(260);
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
    expect(miniChat.style.left).toBe('');
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 426, clientY: 300, pointerId: 21,
    }));
    expect(document.documentElement.classList.contains('imcodes-window-dragging')).toBe(false);
    expect(JSON.parse(localStorage.getItem(`${storageKey}:layout`) || '{}')).toMatchObject({ width: 460 });

    // Resize north-west handle after positioning: updates width, height, left, top while pinning right/bottom
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
    // Now positioned at (376, 148)
    expect(miniChat.style.left).toBe('376px');
    expect(miniChat.style.top).toBe('148px');

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
    expect(miniChat.style.left).toBe('376px');
    expect(miniChat.style.top).toBe('148px');

    // Window blur mid-resize cleanly releases dragging guard and active state
    fireEvent(window, new Event('blur'));
    expect(document.documentElement.classList.contains('imcodes-window-dragging')).toBe(false);
    expect(miniChat.classList.contains('is-resizing')).toBe(false);
    expect(screen.queryByTestId('cloud-docs-mini-chat-interaction-shield')).toBeNull();

    // North-west corner resize updates width, height, left, top together while pinning bottom-right
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
    expect(miniChat.style.left).toBe('336px');
    expect(miniChat.style.top).toBe('108px');
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true }), {
      clientX: 336, clientY: 108, pointerId: 24,
    }));
    expect(localStorage.getItem(storageKey)).toBe('540');
    expect(JSON.parse(localStorage.getItem(`${storageKey}:layout`) || '{}')).toEqual({
      width: 540,
      x: 336,
      y: 108,
    });

    // Verify iframe pointer-events block rule in styles.css
    const stylesPath = process.cwd().endsWith('/web')
      ? resolve(process.cwd(), 'src/styles.css')
      : resolve(process.cwd(), 'web/src/styles.css');
    const css = readFileSync(stylesPath, 'utf8');
    expect(css).toMatch(/html\.imcodes-window-dragging\s+iframe\s*\{\s*pointer-events:\s*none\s*!important;\s*\}/);
    expect(css).toContain('.cloud-docs-mini-chat-interaction-shield');
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
});
