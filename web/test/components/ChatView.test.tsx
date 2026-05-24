/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, render, waitFor, cleanup, fireEvent, screen } from '@testing-library/preact';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from '../../src/components/ChatView.js';
import {
  SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL,
  SESSION_CONTROL_TIMELINE_STATE_STOPPING,
} from '../../../shared/session-control-commands.js';
import {
  __resetSessionRepoContextStoreForTests,
  ingestSessionRepoContext,
} from '../../src/session-repo-context-store.js';
import {
  CHAT_INITIAL_RENDER_ITEM_LIMIT,
  PREVIEW_EVENT_TAIL_LIMIT,
  PREVIEW_RENDER_ITEM_LIMIT,
} from '../../src/chat-render-limits.js';

const chatMarkdownRenderSpy = vi.hoisted(() => vi.fn());
const showToolCallsPref = vi.hoisted(() => ({
  value: true as boolean | null,
}));

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

function findTextNode(root: Node, needle: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.textContent?.includes(needle)) return node as Text;
    node = walker.nextNode();
  }
  throw new Error(`Text node not found: ${needle}`);
}

function selectText(node: Text, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../src/components/ChatMarkdown.js', () => ({
  ChatMarkdown: ({ text, onUrlClick }: { text: string; onUrlClick?: (url: string) => void }) => {
    chatMarkdownRenderSpy(text);
    const url = text.match(/https?:\/\/\S+/)?.[0];
    if (url) {
      return (
        <a
          class="chat-external-link"
          href={url}
          onClick={(e) => {
            e.preventDefault();
            onUrlClick?.(url);
          }}
        >
          {url}
        </a>
      );
    }
    return <div>{text}</div>;
  },
}));

vi.mock('../../src/components/FileBrowser.js', () => ({
  FileBrowser: () => null,
}));

vi.mock('../../src/components/FloatingPanel.js', () => ({
  FloatingPanel: ({ children }: { children?: preact.ComponentChildren }) => <div>{children}</div>,
}));

// Force the show-tool-calls preference to "developer view" for ChatView's
// timeline tests. Production default for an undecided pref is also developer
// view, with a chooser prompt still visible; these tests assert tool-row
// markup without the extra prompt unless they explicitly change this value.
// Other usePref features (parse, save, etc.) aren't exercised here, so a
// minimal stub is enough.
vi.mock('../../src/hooks/usePref.js', () => ({
  parseBooleanish: (raw: unknown) => (raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null),
  usePref: () => ({
    value: showToolCallsPref.value,
    rawValue: showToolCallsPref.value,
    loaded: true,
    loading: false,
    stale: false,
    error: null,
    save: async () => undefined,
    set: () => undefined,
    reload: async () => true,
  }),
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
    showToolCallsPref.value = true;
    clipboardWriteText.mockClear();
    visualViewportMock.height = 800;
    visualViewportListeners.clear();
    __resetSessionRepoContextStoreForTests();
  });

  afterAll(() => {
    (window as Window & { visualViewport?: typeof visualViewportMock }).visualViewport = originalVisualViewport as any;
  });

  it('renders only the recent tail of very large cached timelines on first mount', () => {
    const events = Array.from({ length: CHAT_INITIAL_RENDER_ITEM_LIMIT + 10 }, (_, index) => ({
      eventId: `user-${index}`,
      type: 'user.message',
      ts: 1_700_000_000_000 + index,
      payload: { text: `message-${index}` },
    }));

    render(
      <ChatView
        events={events as any}
        loading={false}
        hasOlderHistory={false}
        sessionId="deck_large_brain"
      />,
    );

    expect(screen.queryByText('message-0')).toBeNull();
    expect(screen.getByText('message-10')).toBeTruthy();
    expect(screen.getByText(`message-${CHAT_INITIAL_RENDER_ITEM_LIMIT + 9}`)).toBeTruthy();

    fireEvent.click(screen.getByText('chat.load_older'));

    expect(screen.getByText('message-0')).toBeTruthy();
  });

  it('suppresses the "no events" placeholder while bootstrap history is still loading (SubSessionWindow flash fix)', () => {
    // Regression test for "本地历史还是没有瞬间加载" / 暂无消息 flash:
    // SubSessionWindow forces `loading={false}` so its ChatView doesn't
    // flicker on minimize/restore. Combined with an empty cache, this
    // used to surface the "no events" placeholder while the
    // 历史 → 本地缓存 → daemon overlay was still spinning. The placeholder
    // must defer to the overlay during the bootstrap phase.
    const { container, rerender } = render(
      <ChatView
        events={[] as any}
        loading={false}
        sessionId="deck_sub_bootstrap"
        historyStatus={{
          phase: 'bootstrap',
          steps: {
            cache: 'running',
            textTail: 'skipped',
            daemon: 'pending',
            http: 'pending',
            older: 'skipped',
          },
        }}
      />,
    );

    // Overlay must be visible, placeholder must be hidden.
    expect(container.querySelector('.chat-history-overlay')).not.toBeNull();
    expect(screen.queryByText('chat.no_events')).toBeNull();

    // Once bootstrap finishes AND events are still empty, the placeholder
    // returns (so users on a truly-empty session don't sit looking at a
    // blank pane after the overlay disappears).
    rerender(
      <ChatView
        events={[] as any}
        loading={false}
        sessionId="deck_sub_bootstrap"
        historyStatus={{
          phase: 'idle',
          steps: {
            cache: 'done',
            textTail: 'skipped',
            daemon: 'done',
            http: 'done',
            older: 'skipped',
          },
        }}
      />,
    );

    expect(screen.getByText('chat.no_events')).toBeTruthy();
  });

  it('preview mode caps rendered items to PREVIEW_RENDER_ITEM_LIMIT (sub-session thumbnails)', () => {
    // Regression test for "本地消息都没有立即显示. 空白半天 + sub-session 按钮无反应"
    // (slow refresh + unresponsive buttons on mobile). Without the cap, every
    // SubSessionCard would rebuild viewItems over PREVIEW_EVENT_TAIL_LIMIT + N
    // events on mount, freezing the main thread when many sub-sessions exist.
    const totalEvents = PREVIEW_EVENT_TAIL_LIMIT + 100; // well above both caps
    const events = Array.from({ length: totalEvents }, (_, index) => ({
      eventId: `user-${index}`,
      type: 'user.message',
      ts: 1_700_000_000_000 + index,
      payload: { text: `preview-msg-${index}` },
    }));

    render(
      <ChatView
        events={events as any}
        loading={false}
        hasOlderHistory={false}
        sessionId="deck_preview_brain"
        preview
      />,
    );

    // Last message must be visible — preview cards are tail-anchored.
    expect(screen.getByText(`preview-msg-${totalEvents - 1}`)).toBeTruthy();
    // Earliest tail entry within the preview render limit must be visible.
    expect(
      screen.getByText(`preview-msg-${totalEvents - PREVIEW_RENDER_ITEM_LIMIT}`),
    ).toBeTruthy();
    // Anything older than the render limit must NOT be rendered — that's the
    // savings that keeps the main thread free.
    expect(
      screen.queryByText(`preview-msg-${totalEvents - PREVIEW_RENDER_ITEM_LIMIT - 1}`),
    ).toBeNull();
    expect(screen.queryByText('preview-msg-0')).toBeNull();
    // Preview mode never shows the "Load older" affordance.
    expect(screen.queryByText('chat.load_older')).toBeNull();
  });

  it('renders plain-text HTML path action only outside preview mode', () => {
    const onPreviewFile = vi.fn();
    const events = [{
      eventId: 'user-html-path',
      type: 'user.message',
      ts: Date.now(),
      payload: { text: 'Open ./dist/index.HTML' },
    }];

    const { container, rerender } = render(
      <ChatView
        events={events as any}
        loading={false}
        sessionId="deck_main_brain"
        ws={{} as any}
        workdir="/repo"
        onPreviewFile={onPreviewFile}
      />,
    );

    const htmlButton = container.querySelector('.chat-html-preview-btn') as HTMLButtonElement | null;
    expect(htmlButton).not.toBeNull();
    fireEvent.click(htmlButton!);
    expect(onPreviewFile).toHaveBeenCalledWith(expect.objectContaining({
      path: '/repo/./dist/index.HTML',
      preferDiff: false,
      previewViewMode: 'html-render',
      preview: { status: 'loading', path: '/repo/./dist/index.HTML' },
      rootPath: '/repo',
      sourcePreviewLive: false,
    }));

    rerender(
      <ChatView
        events={events as any}
        loading={false}
        sessionId="deck_preview_brain"
        preview
        ws={{} as any}
        workdir="/repo"
        onPreviewFile={onPreviewFile}
      />,
    );
    expect(container.querySelector('.chat-html-preview-btn')).toBeNull();
  });

  it('always hides thinking events from the timeline regardless of preference', () => {
    // Thinking events (both live and finished) are unconditionally hidden —
    // the agent's running state and memory-context card already give enough
    // signal that work is happening, and the "Thought for Xs" summary was
    // pure noise. See ChatView's `assistant.thinking` case (returns null).
    for (const prefValue of [null, true, false] as const) {
      showToolCallsPref.value = prefValue;

      const { container, unmount } = render(
        <ChatView
          events={[
            {
              eventId: 'thinking-1',
              type: 'assistant.thinking',
              ts: Date.now() - 1000,
              payload: { text: 'checking files' },
            },
          ] as any}
          loading={false}
          sessionId="test"
        />,
      );

      expect(container.querySelector('.chat-thinking')).toBeNull();
      expect(container.textContent ?? '').not.toContain('checking files');
      expect(container.textContent ?? '').not.toContain('chat.thinking_running');
      expect(container.textContent ?? '').not.toContain('chat.thinking_done');
      unmount();
    }
  });

  it('renders the repo branch summary beside the font settings control', () => {
    const onViewRepo = vi.fn();
    ingestSessionRepoContext({
      sessionId: 'deck_test_brain',
      projectDir: '/repo/project',
      context: {
        status: 'ok',
        info: { currentBranch: 'feature/a' },
        repoGeneration: 1,
      },
    });

    const { container } = render(
      <ChatView
        events={[] as any}
        loading={false}
        sessionId="deck_test_brain"
        workdir="/repo/project"
        onViewRepo={onViewRepo}
      />,
    );

    const titlebar = container.querySelector('.chat-titlebar') as HTMLDivElement | null;
    const fontButton = screen.getByRole('button', { name: 'Aa' });
    const branchHost = container.querySelector('.session-repo-branch-summary-chat-titlebar') as HTMLSpanElement | null;
    const branchButton = screen.getByText('feature/a').closest('button') as HTMLButtonElement | null;
    const titlebarChildren = Array.from(titlebar?.children ?? []);

    expect(titlebar).toBeTruthy();
    expect(branchHost?.textContent).toContain('feature/a');
    expect(titlebar?.contains(branchHost as Element)).toBe(true);
    expect(titlebarChildren.indexOf(fontButton.parentElement as Element)).toBeLessThan(titlebarChildren.indexOf(branchHost as Element));

    fireEvent.click(branchButton!);
    expect(onViewRepo).toHaveBeenCalledTimes(1);
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
    expect(container.querySelector('.chat-history-overlay')).not.toBeNull();
  });

  it('renders history fetch progress as a bottom overlay instead of footer layout content', () => {
    const { container } = render(
      <ChatView
        events={[] as any}
        loading={false}
        historyStatus={{
          phase: 'bootstrap',
          steps: {
            cache: 'done',
            textTail: 'running',
            daemon: 'pending',
            http: 'pending',
            older: 'skipped',
          },
        }}
        sessionId="deck_sub_preview"
      />,
    );

    expect(container.querySelector('.chat-history-overlay')).not.toBeNull();
    expect(container.querySelector('.chat-history-step.running')).not.toBeNull();
    expect(container.querySelector('.chat-history-step.pending')).not.toBeNull();
    expect(container.querySelector('.session-history-progress')).toBeNull();
  });

  it('does not move the main chat viewport on same-timestamp streamed updates after the user scrolls away from bottom', async () => {
    // Regression test for the user-reported bug: "为了自动更新不得不牺牲滚屏体验"
    //
    // Before the sticky-bottom fix, ChatView's `useLayoutEffect` on `viewItems`
    // unconditionally called `scrollToBottom()` on every event-shape change,
    // forcibly snapping the viewport to bottom even when the user had scrolled
    // up to read earlier history. This test pins the corrected contract: when
    // the user has actively scrolled away (scroll event dispatched, distance
    // beyond `disengageThreshold`), in-place streaming updates with the same
    // timestamp must NOT move `scrollTop`.
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

    // Simulate user scrolling away from bottom: move scrollTop AND dispatch
    // a real scroll event so handleScroll fires and disengages auto-follow.
    // (The programmatic-scroll guard's 200ms watchdog has already expired
    // by the time waitFor resolves above, so this dispatch is honoured as
    // a real user scroll.)
    // Wait past both the 200ms programmatic-scroll watchdog AND the 1200ms
    // suppressLoadOlder window (which the transientTopJump handler keys on).
    await new Promise((resolve) => setTimeout(resolve, 1300));
    // Use scrollTop=1300 — beyond the disengage threshold (distance=300 > 180)
    // and well past the transientTopJump threshold (scrollTop=1300 > 100), so
    // handleScroll cleanly disengages auto-follow without triggering the
    // mobile-keyboard recovery branch.
    scrollEl.scrollTop = 1300;
    Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, value: 1800 });
    fireEvent.scroll(scrollEl);

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

    // Give the layout effect a tick to (potentially) fire and confirm it
    // does NOT yank the viewport to bottom.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scrollEl.scrollTop).toBe(1300);
  });

  it('continues following streamed updates in main chat when the user remains near the bottom', async () => {
    // Negative companion to the test above: prevent the gating fix from
    // over-correcting and breaking the legitimate sticky-bottom case.
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

    // Remain near bottom — distance from bottom = 30px, well within
    // reengageThreshold = max(60, 0.10 * 200) = 60.
    Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, value: 1800 });
    // No scroll event dispatched — user has not moved.
    rerender(
      <ChatView
        events={[
          {
            eventId: 'evt-1',
            type: 'assistant.text',
            ts: 1000,
            payload: { text: 'hello world streamed' },
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

  it('does not force bottom scroll for non-rendered status updates', async () => {
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

    Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, value: 1800 });
    rerender(
      <ChatView
        events={[
          ...initialEvents,
          {
            eventId: 'usage-1',
            type: 'usage.update',
            ts: 2000,
            payload: { inputTokens: 10, outputTokens: 20 },
          },
        ] as any}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scrollEl.scrollTop).toBe(1200);
  });

  it('does not move the main chat viewport when a newer-timestamp message arrives while follow is paused', async () => {
    // Pins the fallback `lastVisibleTs` effect path. If only the layout
    // effect were gated, the timestamp-driven effect could still snap.
    const initialEvents = [
      {
        eventId: 'evt-1',
        type: 'assistant.text',
        ts: 1000,
        payload: { text: 'first' },
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

    // Wait past the 200ms watchdog and 1200ms suppressLoadOlder window.
    await new Promise((resolve) => setTimeout(resolve, 1300));
    // Grow scrollHeight FIRST, then move scrollTop and dispatch — so
    // handleScroll computes distance against the new layout.
    Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, value: 1800 });
    scrollEl.scrollTop = 1300;
    fireEvent.scroll(scrollEl);

    rerender(
      <ChatView
        events={[
          { eventId: 'evt-1', type: 'assistant.text', ts: 1000, payload: { text: 'first' } },
          { eventId: 'evt-2', type: 'assistant.text', ts: 2000, payload: { text: 'second (newer ts)' } },
        ] as any}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    // Wait for the rAF inside the lastVisibleTs effect to fire.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scrollEl.scrollTop).toBe(1300);
  });

  it('does not auto-resume after idle time while the user remains scrolled away', async () => {
    // Pins the removal of the 60-s SCROLL_IDLE_RESUME_MS interval.
    // Pre-fix, after 60 s of inactivity ChatView would snap to bottom.
    // Post-fix the user controls the scroll position.
    vi.useFakeTimers();
    try {
      const initialEvents = [
        { eventId: 'evt-1', type: 'assistant.text', ts: 1000, payload: { text: 'hi' } },
      ] as any;

      const { container } = render(
        <ChatView events={initialEvents} loading={false} sessionId="deck_main_brain" />,
      );

      const scrollEl = container.querySelector('.chat-view') as HTMLDivElement;
      Object.defineProperty(scrollEl, 'scrollTop', { configurable: true, writable: true, value: 0 });
      Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, value: 1200 });
      Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, value: 200 });

      // Pause follow. Advance past both the 200 ms programmatic-scroll
      // watchdog and the 1200 ms suppressLoadOlder window before simulating
      // a real user scroll-up.
      vi.advanceTimersByTime(1300);
      Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, value: 1800 });
      // Use scrollTop=1300 — beyond the disengage threshold and well above
      // the transientTopJump 100 px floor.
      scrollEl.scrollTop = 1300;
      fireEvent.scroll(scrollEl);

      // Advance past the old 60 s threshold + the old 10 s polling interval.
      vi.advanceTimersByTime(75_000);

      expect(scrollEl.scrollTop).toBe(1300);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a new-message count on the floating jump button while follow is paused', async () => {
    const initialEvents = [
      { eventId: 'evt-1', type: 'assistant.text', ts: 1000, payload: { text: 'one' } },
    ] as any;

    const { container, rerender } = render(
      <ChatView events={initialEvents} loading={false} sessionId="deck_main_brain" />,
    );

    const scrollEl = container.querySelector('.chat-view') as HTMLDivElement;
    Object.defineProperty(scrollEl, 'scrollTop', { configurable: true, writable: true, value: 0 });
    Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, value: 200 });

    await waitFor(() => {
      expect(scrollEl.scrollTop).toBe(1200);
    });

    await new Promise((resolve) => setTimeout(resolve, 1300));
    // Grow scrollHeight first, then disengage with a real scroll event.
    Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, value: 1800 });
    scrollEl.scrollTop = 1300;
    fireEvent.scroll(scrollEl);

    rerender(
      <ChatView
        events={[
          { eventId: 'evt-1', type: 'assistant.text', ts: 1000, payload: { text: 'one' } },
          { eventId: 'evt-2', type: 'assistant.text', ts: 2000, payload: { text: 'two' } },
          { eventId: 'evt-3', type: 'assistant.text', ts: 3000, payload: { text: 'three' } },
        ] as any}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    await waitFor(() => {
      const btn = container.querySelector('.chat-scroll-btn') as HTMLButtonElement;
      expect(btn).toBeTruthy();
      expect(btn.textContent ?? '').toBe('↓ 2');
      expect(btn.getAttribute('aria-label')).toBe('Jump to bottom (2 new)');
    });
  });

  it('counts one new message for many streamed updates of the same event while follow is paused', async () => {
    const initialEvents = [
      { eventId: 'evt-1', type: 'assistant.text', ts: 1000, payload: { text: 'one' } },
    ] as any;

    const { container, rerender } = render(
      <ChatView events={initialEvents} loading={false} sessionId="deck_main_brain" />,
    );

    const scrollEl = container.querySelector('.chat-view') as HTMLDivElement;
    Object.defineProperty(scrollEl, 'scrollTop', { configurable: true, writable: true, value: 0 });
    Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, value: 200 });

    await waitFor(() => {
      expect(scrollEl.scrollTop).toBe(1200);
    });

    await new Promise((resolve) => setTimeout(resolve, 1300));
    Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, value: 1800 });
    scrollEl.scrollTop = 1300;
    fireEvent.scroll(scrollEl);

    await waitFor(() => {
      expect(container.querySelector('.chat-scroll-btn')?.textContent ?? '').toBe('↓');
    });

    rerender(
      <ChatView
        events={[
          { eventId: 'evt-1', type: 'assistant.text', ts: 1000, payload: { text: 'one' } },
          { eventId: 'evt-2', type: 'assistant.text', ts: 2000, payload: { text: 'two', streaming: true } },
        ] as any}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector('.chat-scroll-btn')?.textContent ?? '').toBe('↓');

    rerender(
      <ChatView
        events={[
          { eventId: 'evt-1', type: 'assistant.text', ts: 1000, payload: { text: 'one' } },
          { eventId: 'evt-2', type: 'assistant.text', ts: 2000, payload: { text: 'two chunks', streaming: true } },
        ] as any}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector('.chat-scroll-btn')?.textContent ?? '').toBe('↓');

    rerender(
      <ChatView
        events={[
          { eventId: 'evt-1', type: 'assistant.text', ts: 1000, payload: { text: 'one' } },
          { eventId: 'evt-2', type: 'assistant.text', ts: 2000, payload: { text: 'two final' } },
        ] as any}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    await waitFor(() => {
      const btn = container.querySelector('.chat-scroll-btn') as HTMLButtonElement;
      expect(btn.textContent ?? '').toBe('↓ 1');
      expect(btn.getAttribute('aria-label')).toBe('Jump to bottom (1 new)');
    });
  });

  it('does not render queued session.state events in the chat timeline', async () => {
    const { queryByText } = render(
      <ChatView
        events={[
          {
            eventId: 'queued-state',
            type: 'session.state',
            sessionId: 'deck_q',
            ts: 1000,
            epoch: 1,
            seq: 1,
            source: 'daemon',
            confidence: 'high',
            payload: {
              state: 'queued',
              pendingMessageEntries: [{ clientMessageId: 'cmd-q', text: 'queued text' }],
            },
          },
          {
            eventId: 'assistant-after',
            type: 'assistant.text',
            sessionId: 'deck_q',
            ts: 1001,
            epoch: 1,
            seq: 2,
            source: 'daemon',
            confidence: 'high',
            payload: { text: 'visible assistant text' },
          },
        ] as any}
        loading={false}
        sessionId="deck_q"
      />,
    );

    await waitFor(() => {
      expect(queryByText('visible assistant text')).toBeDefined();
    });
    expect(queryByText('queued')).toBeNull();
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
              preferenceItems: [
                { id: 'pref-1', text: 'Use pnpm for project commands' },
              ],
              items: [
                {
                  id: 'mem-1',
                  projectId: 'codedeck',
                  summary: 'Fix websocket reconnect loop',
                  projectionClass: 'durable_memory_candidate',
                },
                {
                  id: 'mem-2',
                  projectId: 'codedeck',
                  summary: 'Recent MCP startup injection work',
                  projectionClass: 'recent_summary',
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
      expect(container.textContent).toContain('chat.memory_context_section_preferences');
      expect(container.textContent).toContain('Use pnpm for project commands');
      expect(container.textContent).toContain('chat.memory_context_section_durable');
      expect(container.textContent).toContain('Fix websocket reconnect loop');
      expect(container.textContent).toContain('chat.memory_context_section_recent');
      expect(container.textContent).toContain('Recent MCP startup injection work');
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

  it('renders transport Stop cancel feedback as a visible system row', () => {
    const { container } = render(
      <ChatView
        events={[
          {
            eventId: 'evt-stop-requested',
            type: 'session.state',
            ts: 1000,
            payload: {
              state: SESSION_CONTROL_TIMELINE_STATE_STOPPING,
              reason: SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL,
            },
          },
        ] as any}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    expect(container.textContent).toContain('session.state_stop_requested');
  });

  it('opens external URLs in the themed confirmation dialog', () => {
    const { container } = render(
      <ChatView
        events={[
          {
            eventId: 'evt-user-link',
            type: 'assistant.text',
            ts: 1000,
            payload: { text: 'https://example.com/release-notes' },
          },
        ] as any}
        loading={false}
        sessionId="deck_main_brain"
      />,
    );

    const link = container.querySelector('.chat-external-link') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    fireEvent.click(link!);

    const dialog = container.querySelector('.external-link-dialog') as HTMLElement | null;
    expect(dialog).not.toBeNull();
    expect(container.querySelector('.dialog-box')).toBeNull();
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(container.querySelector('.external-link-url')?.textContent).toBe('https://example.com/release-notes');
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

  it('shows the selected-text Copy and Quote popup in narrow desktop windows', async () => {
    const originalMatchMedia = window.matchMedia;
    const matchMedia = vi.fn((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: matchMedia,
    });

    const onQuote = vi.fn();
    try {
      const { container } = render(
        <ChatView
          events={[
            {
              eventId: 'evt-selectable-desktop',
              type: 'assistant.text',
              ts: new Date('2026-04-17T12:34:00Z').getTime(),
              payload: { text: 'Alpha beta gamma' },
            },
          ] as any}
          loading={false}
          sessionId="deck_main_brain"
          onQuote={onQuote}
        />,
      );

      const chatEvent = container.querySelector('.chat-event.chat-assistant') as HTMLElement;
      const textNode = findTextNode(chatEvent, 'Alpha beta gamma');
      await act(async () => {
        await Promise.resolve();
      });
      act(() => {
        selectText(textNode, 6, 10);
      });

      await waitFor(() => {
        expect(screen.getByText('common.copy')).toBeTruthy();
        expect(screen.getByText('common.quote')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('common.quote'));
      expect(onQuote).toHaveBeenCalledWith('beta');
      expect(matchMedia).toHaveBeenCalledWith('(pointer: coarse)');
      expect(matchMedia.mock.calls.some(([query]) => String(query).includes('max-width'))).toBe(false);
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
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
