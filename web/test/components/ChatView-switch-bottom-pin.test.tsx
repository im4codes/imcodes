/**
 * @vitest-environment jsdom
 *
 * Causal regression tests for keyboard/tab/server switching + post-switch hydration bottom pinning:
 * 1. Retained `ChatView` `visible: false -> true` with pending parent `onScrollBottomFn()` +
 *    subsequent layout/height growth must not clobber `lastScrollHeightRef` or drop follow mode.
 * 2. Multi-step `scrollHeight` expansion during `handleScroll` (without upward scroll intent)
 *    must re-pin via `pendingGrowthRepinRef` rather than calling `disengageFollow()`.
 * 3. Server/tab switch with cached history -> delayed new messages + virtualized row measurement +
 *    async `<img>` decode must stay 100% pinned at bottom without `[↓ N]` badge.
 * 4. Modified keyboard shortcuts (`Alt+ArrowUp`, `Ctrl+PageUp`, `Meta+Home`, `defaultPrevented`)
 *    must not arm `userPointerOrKeyScrollUntilRef`.
 * 5. Genuine user upward scroll (wheel, touch drag, scrollbar pointer drag, unmodified `PageUp`,
 *    or explicit scroll-away) must still disengage cleanly and show `[↓ 1]` on arriving messages.
 */
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, act, fireEvent, waitFor } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock('../../src/components/FileBrowser.js', () => ({ FileBrowser: () => null }));
vi.mock('../../src/components/FloatingPanel.js', () => ({
  FloatingPanel: ({ children }: { children?: preact.ComponentChildren }) => <div>{children}</div>,
}));
vi.mock('../../src/hooks/usePref.js', () => ({
  parseBooleanish: (raw: unknown) => (raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null),
  usePref: () => ({
    value: true, rawValue: true, loaded: true, loading: false, stale: false,
    error: null, save: async () => undefined, set: () => undefined, reload: async () => true,
  }),
}));

import { ChatView } from '../../src/components/ChatView.js';
import type { TimelineEvent } from '../../src/ws-client.js';

const resizeCallbacks: ResizeObserverCallback[] = [];
class FakeResizeObserver {
  constructor(cb: ResizeObserverCallback) { resizeCallbacks.push(cb); }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class FakeIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

function userEvent(eventId: string, text: string, ts: number): TimelineEvent {
  return {
    eventId,
    type: 'user.message',
    ts,
    epoch: 1,
    seq: ts,
    sessionId: 'deck_switch_bottom',
    source: 'daemon',
    confidence: 'high',
    payload: { text },
  } as unknown as TimelineEvent;
}

function assistantEvent(eventId: string, text: string, ts: number): TimelineEvent {
  return {
    eventId,
    type: 'assistant.text',
    ts,
    epoch: 1,
    seq: ts,
    sessionId: 'deck_switch_bottom',
    source: 'daemon',
    confidence: 'high',
    payload: { text, streaming: false },
  } as unknown as TimelineEvent;
}

async function mountSwitchHarness(initialProps: {
  serverId: string;
  sessionId: string;
  visible: boolean;
  events: TimelineEvent[];
  initialScrollHeight?: number;
  initialClientHeight?: number;
}) {
  let currentProps = { ...initialProps };
  let scrollBottomFn: (() => void) | null = null;
  const rendered = render(
    <ChatView
      events={currentProps.events as never}
      loading={false}
      hasOlderHistory={false}
      serverId={currentProps.serverId}
      sessionId={currentProps.sessionId}
      visible={currentProps.visible}
      onScrollBottomFn={(fn) => { scrollBottomFn = fn; }}
    />,
  );
  const scrollEl = rendered.container.querySelector('.chat-view') as HTMLDivElement;
  let scrollTopValue = 0;
  let clientHeightValue = initialProps.initialClientHeight ?? 200;
  let scrollHeightValue = initialProps.initialScrollHeight ?? 1200;
  const clampTop = (v: number) => Math.max(0, Math.min(v, Math.max(0, scrollHeightValue - clientHeightValue)));

  Object.defineProperty(scrollEl, 'scrollTop', {
    configurable: true,
    get: () => scrollTopValue,
    set: (v: number) => { scrollTopValue = clampTop(v); },
  });
  Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, get: () => scrollHeightValue });
  Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, get: () => clientHeightValue });

  const drainFrames = async () => {
    await act(async () => {
      for (let i = 0; i < 4; i++) {
        await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, 30); });
    });
  };

  await drainFrames();

  return {
    container: rendered.container,
    scrollEl,
    get scrollTop() { return scrollTopValue; },
    get maxTop() { return Math.max(0, scrollHeightValue - clientHeightValue); },
    invokeScrollBottom: () => { scrollBottomFn?.(); },
    drainFrames,
    setGeometry: (next: { scrollHeight?: number; clientHeight?: number; scrollTop?: number }) => {
      if (next.scrollHeight !== undefined) scrollHeightValue = next.scrollHeight;
      if (next.clientHeight !== undefined) clientHeightValue = next.clientHeight;
      if (next.scrollTop !== undefined) scrollTopValue = clampTop(next.scrollTop);
      else scrollTopValue = clampTop(scrollTopValue);
    },
    updateProps: async (patch: Partial<typeof initialProps>, drain = true) => {
      currentProps = { ...currentProps, ...patch };
      rendered.rerender(
        <ChatView
          events={currentProps.events as never}
          loading={false}
          hasOlderHistory={false}
          serverId={currentProps.serverId}
          sessionId={currentProps.sessionId}
          visible={currentProps.visible}
          onScrollBottomFn={(fn) => { scrollBottomFn = fn; }}
        />,
      );
      if (drain) await drainFrames();
    },
  };
}

describe('ChatView — switch bottom-pin guarantees', () => {
  beforeEach(() => {
    resizeCallbacks.length = 0;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver as unknown as typeof ResizeObserver);
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver as unknown as typeof IntersectionObserver);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not let becameVisible clobber pending parent scroll or lastScrollHeightRef on visible: false -> true', async () => {
    const initialEvents = [
      userEvent('u-1', 'cached 1', 1000),
      assistantEvent('a-1', 'cached reply', 2000),
    ];
    const chat = await mountSwitchHarness({
      serverId: 'srv-1',
      sessionId: 'deck_retained_tab',
      visible: false,
      events: initialEvents,
      initialScrollHeight: 1200,
      initialClientHeight: 200,
    });

    // Parent requests scroll-to-bottom while retained pane is still hidden (tab switch prep).
    act(() => { chat.invokeScrollBottom(); });

    // Transition visible: false -> true. pinScrollToBottomNow records lastScrollHeight=1200,
    // and becameVisible MUST NOT wipe lastScrollHeightRef or pendingEngageFollowRef afterwards.
    await chat.updateProps({ visible: true });
    expect(chat.scrollTop).toBe(1000);

    // Grow past 200ms programmatic ignore window with content expansion + lagging scroll event.
    await new Promise((resolve) => setTimeout(resolve, 250));
    chat.setGeometry({ scrollHeight: 1650 });
    fireEvent.scroll(chat.scrollEl);

    await chat.drainFrames();
    expect(chat.scrollTop).toBe(1450);

    // Subsequent arriving message stays pinned with zero `[↓ N]` badge.
    chat.setGeometry({ scrollHeight: 1950 });
    await chat.updateProps({
      events: [...initialEvents, assistantEvent('a-2', 'fresh reply', 3000)],
    });
    expect(chat.scrollTop).toBe(1750);
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();
  });

  it('handles multi-step passive scrollHeight expansion in handleScroll without false disengage or [↓ 1]', async () => {
    const baseEvents = [
      userEvent('m-1', 'msg 1', 1000),
      assistantEvent('m-2', 'reply 1', 2000),
    ];
    const chat = await mountSwitchHarness({
      serverId: 'srv-1',
      sessionId: 'deck_multistep',
      visible: true,
      events: baseEvents,
      initialScrollHeight: 1200,
      initialClientHeight: 200,
    });
    expect(chat.scrollTop).toBe(1000);

    // Expire both programmatic-scroll guard (200ms) and mount settle (1500ms) to exercise pure handleScroll.
    await new Promise((resolve) => setTimeout(resolve, 1600));

    // Step 1: content grows slightly (`distance = 40`), scrollTop remains stationary at 1000.
    // Step 2 (BEFORE scheduled rAF runs): image / row growth jumps scrollHeight 1240 -> 1900 (`distance = 700 > disengageThreshold`).
    chat.setGeometry({ scrollHeight: 1240 });
    fireEvent.scroll(chat.scrollEl);
    chat.setGeometry({ scrollHeight: 1900 });
    fireEvent.scroll(chat.scrollEl);

    await waitFor(() => expect(chat.scrollTop).toBe(1700));
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();

    // Arriving message after multi-step expansion must still auto-follow with zero `[↓ 1]`.
    chat.setGeometry({ scrollHeight: 2200 });
    await chat.updateProps({
      events: [...baseEvents, assistantEvent('m-3', 'new message', 3000)],
    });
    expect(chat.scrollTop).toBe(2000);
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();
  });

  it('keeps virtualized >24-row and non-virtualized chats pinned when cached switch is followed by delayed new message + img load', async () => {
    const cachedVirtual: TimelineEvent[] = Array.from({ length: 30 }, (_, i) => (
      i % 2 === 0
        ? userEvent(`c-${i}`, `cached user ${i}`, 1000 + i * 10)
        : assistantEvent(`c-${i}`, `cached reply ${i}`, 1000 + i * 10)
    ));
    const chat = await mountSwitchHarness({
      serverId: 'srv-1',
      sessionId: 'deck_srv1_main',
      visible: true,
      events: [userEvent('s1', 'server 1', 500)],
      initialScrollHeight: 1200,
      initialClientHeight: 250,
    });

    // Rapid A -> B -> C server switches ending on virtualized srv-3 cached history.
    await chat.updateProps({ serverId: 'srv-2', sessionId: 'deck_srv2_main', events: [userEvent('s2', 'server 2', 600)] }, false);
    chat.setGeometry({ scrollHeight: 2200 });
    await chat.updateProps({ serverId: 'srv-3', sessionId: 'deck_srv3_main', events: cachedVirtual });
    expect(chat.scrollTop).toBe(1950);
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();

    // Delayed catch-up (250ms later) adds a new message with an image attachment, firing scroll + img load.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const withImage = [
      ...cachedVirtual,
      assistantEvent('c-new-img', 'screenshot attached:\n\n![result](https://example.test/out.png)', 5000),
    ];
    chat.setGeometry({ scrollHeight: 2320 });
    fireEvent.scroll(chat.scrollEl);
    await chat.updateProps({ events: withImage });
    expect(chat.scrollTop).toBe(2070);

    const img = chat.container.querySelector('img[alt="result"]') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    chat.setGeometry({ scrollHeight: 2780 });
    fireEvent.scroll(chat.scrollEl);
    fireEvent(img!, new Event('load', { bubbles: false }));

    await waitFor(() => expect(chat.scrollTop).toBe(2530));
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();
  });

  it('ignores modified keyboard shortcuts (Alt/Ctrl/Meta/defaultPrevented) so switching shortcuts never block pinning', async () => {
    const events = [
      userEvent('k-1', 'first', 1000),
      assistantEvent('k-2', 'second', 2000),
    ];
    const chat = await mountSwitchHarness({
      serverId: 'srv-1',
      sessionId: 'deck_keys',
      visible: true,
      events,
      initialScrollHeight: 1200,
      initialClientHeight: 200,
    });
    expect(chat.scrollTop).toBe(1000);

    fireEvent.keyDown(chat.scrollEl, { key: 'ArrowUp', altKey: true });
    fireEvent.keyDown(chat.scrollEl, { key: 'PageUp', ctrlKey: true });
    fireEvent.keyDown(chat.scrollEl, { key: 'Home', metaKey: true });
    const preventedEv = new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true });
    preventedEv.preventDefault();
    chat.scrollEl.dispatchEvent(preventedEv);

    chat.setGeometry({ scrollHeight: 1700 });
    await chat.updateProps({
      events: [...events, assistantEvent('k-3', 'after modified key', 3000)],
    });

    expect(chat.scrollTop).toBe(1500);
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();
  });

  it('still disengages immediately on genuine wheel up / touch drag / pointer scrollbar drag / unmodified PageUp without snapping back', async () => {
    const events = [
      userEvent('u-neg', 'msg', 1000),
      assistantEvent('a-neg', 'reply', 2000),
    ];
    const chat = await mountSwitchHarness({
      serverId: 'srv-1',
      sessionId: 'deck_neg',
      visible: true,
      events,
      initialScrollHeight: 1600,
      initialClientHeight: 200,
    });
    expect(chat.scrollTop).toBe(1400);

    // 1) Genuine wheel up disengages immediately and counts arriving unread as [↓ 1].
    fireEvent.wheel(chat.scrollEl, { deltaY: -120 });
    chat.setGeometry({ scrollTop: 600 });
    fireEvent.scroll(chat.scrollEl);
    chat.setGeometry({ scrollHeight: 1900 });
    await chat.updateProps({
      events: [...events, assistantEvent('a-neg-2', 'unread while reading', 3000)],
    });
    expect(chat.scrollTop).toBe(600);
    expect(chat.container.querySelector('.chat-scroll-btn')?.textContent).toContain('↓ 1');

    // Re-engage by clicking the bottom button.
    fireEvent.click(chat.container.querySelector('.chat-scroll-btn') as HTMLButtonElement);
    await chat.drainFrames();
    expect(chat.scrollTop).toBe(1700);
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();

    // 2) Unmodified PageUp arms keyboard hold + prevents snap-back when scrolling up.
    fireEvent.keyDown(chat.scrollEl, { key: 'PageUp' });
    chat.setGeometry({ scrollTop: 900 });
    fireEvent.scroll(chat.scrollEl);
    chat.setGeometry({ scrollHeight: 2100 });
    await chat.updateProps({
      events: [
        ...events,
        assistantEvent('a-neg-2', 'unread while reading', 3000),
        assistantEvent('a-neg-3', 'unread after PageUp', 4000),
      ],
    });
    expect(chat.scrollTop).toBe(900);
    expect(chat.container.querySelector('.chat-scroll-btn')?.textContent).toContain('↓ 1');
  });
});
