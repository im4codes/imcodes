/**
 * @vitest-environment jsdom
 *
 * Causal regression tests for keyboard/tab/server switching + post-switch hydration bottom pinning:
 * 1. Retained `ChatView` `visible: false -> true` with pending parent `onScrollBottomFn()` +
 *    subsequent layout/height growth must not clobber `lastScrollHeightRef` or drop follow mode.
 * 2. Passive `scrollHeight` expansion — including single-step AND two-step geometry growth where
 *    `scrollTop` simultaneously moves > 2px (`1200/200/1000 -> 1900/200/1020`,
 *    `1200/200/1000 -> 1240/200/1010 -> 1900/200/1035`) — must re-pin without calling
 *    `disengageFollow()`, while unchanged-geometry coordinate jumps still disengage.
 * 3. Server/tab rapid A -> B -> C -> A switching across >24-row virtualized & non-virtualized
 *    sessions with cached render -> delayed new messages + live virtual row `ResizeObserver`
 *    measurement + async `<img>` decode stays 100% pinned without `[↓ N]`.
 * 4. Modified keyboard shortcuts (`Alt+ArrowUp`, `Ctrl+PageUp`, `Meta+Home`, `defaultPrevented`)
 *    do not arm `userPointerOrKeyScrollUntilRef`.
 * 5. Active upward user scroll wins over switching bottom-pin:
 *    - A single unmodified `ArrowUp` moving 40px (< `disengageThreshold`) immediately disengages
 *      and stays unfollowed after the hold window expires.
 *    - A real `wheel` upward scroll between initial engage and frame-2 passive settle (`{ passive: true }`)
 *      wins over delayed settle, never snaps back, and shows `[↓ 1]` on arriving messages.
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
import { __resetMessagePinNavigationForTests, requestMessagePinNavigation } from '../../src/message-pin-navigation.js';

const resizeCallbacks: ResizeObserverCallback[] = [];
class FakeResizeObserver {
  constructor(cb: ResizeObserverCallback) { resizeCallbacks.push(cb); }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function fireResize(targets: Element[] = []): void {
  const entries = targets.map((target) => ({ target })) as unknown as ResizeObserverEntry[];
  for (const cb of resizeCallbacks) cb(entries, {} as ResizeObserver);
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

type ScrollBottomDelegate = (opts?: { passive?: boolean }) => boolean | void;

async function mountSwitchHarness(initialProps: {
  serverId: string;
  sessionId: string;
  visible: boolean;
  events: TimelineEvent[];
  initialScrollHeight?: number;
  initialClientHeight?: number;
  messagePinsEnabled?: boolean;
  onLoadMessageContext?: (eventId: string, ts?: number) => Promise<boolean>;
}) {
  let currentProps = { ...initialProps };
  let scrollBottomFn: ScrollBottomDelegate | null = null;
  const rendered = render(
    <ChatView
      events={currentProps.events as never}
      loading={false}
      hasOlderHistory={false}
      serverId={currentProps.serverId}
      sessionId={currentProps.sessionId}
      visible={currentProps.visible}
      messagePinsEnabled={currentProps.messagePinsEnabled}
      onLoadMessageContext={currentProps.onLoadMessageContext}
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
    invokeScrollBottom: (opts?: { passive?: boolean }) => { scrollBottomFn?.(opts); },
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
          messagePinsEnabled={currentProps.messagePinsEnabled}
          onLoadMessageContext={currentProps.onLoadMessageContext}
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
    __resetMessagePinNavigationForTests();
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

    act(() => { chat.invokeScrollBottom(); });
    await chat.updateProps({ visible: true });
    expect(chat.scrollTop).toBe(1000);

    await new Promise((resolve) => setTimeout(resolve, 250));
    chat.setGeometry({ scrollHeight: 1650 });
    fireEvent.scroll(chat.scrollEl);

    await chat.drainFrames();
    expect(chat.scrollTop).toBe(1450);

    chat.setGeometry({ scrollHeight: 1950 });
    await chat.updateProps({
      events: [...initialEvents, assistantEvent('a-2', 'fresh reply', 3000)],
    });
    expect(chat.scrollTop).toBe(1750);
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();
  });

  it('re-pins passive single-step and two-step growth even when scrollTop shifts > 2px, while keeping unchanged-geometry jump disengage', async () => {
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

    // Expire both 200ms programmatic guard and 1500ms mount settle so handleScroll owns classification.
    await new Promise((resolve) => setTimeout(resolve, 1600));

    // Single-step passive layout growth with simultaneous >2px scrollTop shift (1200/200/1000 -> 1900/200/1020).
    chat.setGeometry({ scrollHeight: 1900, scrollTop: 1020 });
    fireEvent.scroll(chat.scrollEl);
    await waitFor(() => expect(chat.scrollTop).toBe(1700));
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();

    // Expire 200ms guard before testing two-step growth with >2px scrollTop shift in both steps.
    await new Promise((resolve) => setTimeout(resolve, 250));
    chat.setGeometry({ scrollHeight: 1940, scrollTop: 1710 });
    fireEvent.scroll(chat.scrollEl);
    chat.setGeometry({ scrollHeight: 2600, scrollTop: 1735 });
    fireEvent.scroll(chat.scrollEl);

    await waitFor(() => expect(chat.scrollTop).toBe(2400));
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();

    // Negative scrollTop displacement during passive layout shift (e.g., shorter intermediate layout
    // clamped scrollTop down, then backfilled to a taller scrollHeight without user scroll intent).
    await new Promise((resolve) => setTimeout(resolve, 250));
    chat.setGeometry({ scrollHeight: 1600, scrollTop: 1400 });
    fireEvent.scroll(chat.scrollEl);
    await chat.drainFrames();
    chat.setGeometry({ scrollHeight: 2600, scrollTop: 1100 });
    fireEvent.scroll(chat.scrollEl);
    await waitFor(() => expect(chat.scrollTop).toBe(2400));
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();

    // Arriving message after multi-step + negative-clamped expansion must still auto-follow with zero `[↓ 1]`.
    chat.setGeometry({ scrollHeight: 2900 });
    await chat.updateProps({
      events: [...baseEvents, assistantEvent('m-3', 'new message', 3000)],
    });
    expect(chat.scrollTop).toBe(2700);
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();

    // Unchanged geometry explicit coordinate jump (`2900/200/2700 -> 2900/200/2100`) still disengages.
    await new Promise((resolve) => setTimeout(resolve, 250));
    chat.setGeometry({ scrollTop: 2100 });
    fireEvent.scroll(chat.scrollEl);
    expect(chat.container.querySelector('.chat-scroll-btn')).not.toBeNull();
  });

  it('does not let queued passive settle or subsequent virtual measurement override an in-pane pin locate', async () => {
    const items: TimelineEvent[] = Array.from({ length: 120 }, (_, i) => (
      i % 2 === 0
        ? userEvent(`p-${i}`, `prompt ${i}`, 1000 + i * 10)
        : assistantEvent(`p-${i}`, `answer ${i}`, 1000 + i * 10)
    ));
    const chat = await mountSwitchHarness({
      serverId: 'srv-1',
      sessionId: 'deck_pin_race',
      visible: true,
      events: items,
      initialScrollHeight: 2200,
      initialClientHeight: 200,
      messagePinsEnabled: true,
      onLoadMessageContext: () => new Promise(() => {}),
    });
    expect(chat.scrollTop).toBe(2000);

    // Expire mount settle window, then simulate:
    // 1) a passive layout repin / settle is queued (`scrollToBottom(false)` + passive delegate)
    // 2) BEFORE that rAF executes, user clicks an in-pane pin to locate an off-screen message near 460px.
    await new Promise((resolve) => setTimeout(resolve, 250));
    chat.setGeometry({ scrollHeight: 2350 });
    fireEvent.scroll(chat.scrollEl);
    act(() => {
      chat.setGeometry({ scrollTop: 460 });
      requestMessagePinNavigation({
        id: 'pin-race-1',
        serverId: 'srv-1',
        sessionName: 'deck_pin_race',
        eventId: 'older-pinned-target',
        eventTs: 500,
        eventType: 'user.message',
        text: 'older pinned prompt',
        createdAt: 1,
        updatedAt: 1,
      });
    });

    // Queued settle frame + passive invoke MUST yield to pendingPinnedLocateIdRef (`460`, never `2150`).
    act(() => { chat.invokeScrollBottom({ passive: true }); });
    await chat.drainFrames();
    expect(chat.scrollTop).toBe(460);

    // Subsequent virtualizer row measurement + new content while pin anchor is still active
    // must also preserve 460 and not snap to bottom.
    const row = chat.container.querySelector('[data-virtual-key]') as HTMLElement | null;
    expect(row).toBeTruthy();
    chat.setGeometry({ scrollHeight: 2600 });
    act(() => { fireResize([row!]); });
    await chat.drainFrames();
    expect(chat.scrollTop).toBe(460);
  });

  it('keeps explicit locate on an already-mounted target during delayed smooth scroll over queued pin/measurements and resumes bottom follow on End', async () => {
    const items: TimelineEvent[] = Array.from({ length: 120 }, (_, i) => (
      i % 2 === 0
        ? userEvent(`m-${i}`, `prompt ${i}`, 1000 + i * 10)
        : assistantEvent(`m-${i}`, `answer ${i}`, 1000 + i * 10)
    ));
    const chat = await mountSwitchHarness({
      serverId: 'srv-1',
      sessionId: 'deck_pin_mounted',
      visible: true,
      events: items,
      initialScrollHeight: 2200,
      initialClientHeight: 200,
      messagePinsEnabled: true,
    });
    expect(chat.scrollTop).toBe(2000);

    // Confirm target row m-116 is ALREADY mounted in the DOM (no context load needed),
    // so pendingPinnedLocateIdRef clears synchronously once smooth scroll starts.
    const mountedTarget = chat.container.querySelector('[data-event-id="m-116"]') as HTMLElement | null;
    expect(mountedTarget).not.toBeNull();
    const rootRectSpy = vi.spyOn(chat.scrollEl, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 200, width: 320, height: 200, toJSON: () => ({}),
    } as DOMRect);
    const targetRectSpy = vi.spyOn(mountedTarget!, 'getBoundingClientRect').mockImplementation(() => ({
      // At scrollTop=2000, placing DOM rect at top = 580 - scrollTop gives contentTop = 580 -> desired center top = 500
      x: 0, y: 580 - chat.scrollTop, top: 580 - chat.scrollTop, left: 0, right: 320, bottom: 620 - chat.scrollTop, width: 320, height: 40, toJSON: () => ({}),
    } as DOMRect));
    const smoothCalls: Array<{ top?: number; behavior?: ScrollBehavior }> = [];
    const scrollToSpy = vi.fn((opts?: ScrollToOptions) => {
      smoothCalls.push({ top: opts?.top, behavior: opts?.behavior });
      if (typeof opts?.top === 'number') {
        const dest = opts.top;
        // Simulate asynchronous native smooth scroll completing ~80ms later.
        window.setTimeout(() => {
          chat.setGeometry({ scrollTop: dest });
          fireEvent.scroll(chat.scrollEl);
        }, 80);
      }
    });
    Object.defineProperty(chat.scrollEl, 'scrollTo', { configurable: true, writable: true, value: scrollToSpy });

    try {
      // 1) Queue passive bottom pin BEFORE locating.
      await new Promise((resolve) => setTimeout(resolve, 250));
      chat.setGeometry({ scrollHeight: 2350 });
      fireEvent.scroll(chat.scrollEl);
      act(() => { chat.invokeScrollBottom({ passive: true }); });

      // 2) Immediately locate already-mounted target `m-116`: `revealEvent` starts smooth scroll
      //    async toward 500 and clears `pendingPinnedLocateIdRef` right away while scrollTop is still 2000.
      act(() => {
        requestMessagePinNavigation({
          id: 'pin-mounted-1',
          serverId: 'srv-1',
          sessionName: 'deck_pin_mounted',
          eventId: 'm-116',
          eventTs: 1000 + 116 * 10,
          eventType: 'user.message',
          text: 'prompt 116',
          createdAt: 1,
          updatedAt: 1,
        });
      });

      await waitFor(() => expect(smoothCalls.length).toBeGreaterThanOrEqual(1));
      const destTop = smoothCalls[0].top!;
      expect(smoothCalls[0].behavior).toBe('smooth');
      expect(destTop).toBeLessThan(1500);

      // 3) Before smooth finishes (80ms) AND after it settles, queued frames + new row ResizeObserver
      //    measurement enter: old queued bottom pin or new measurement MUST NOT overwrite `destTop`.
      const row = chat.container.querySelector('[data-virtual-key]') as HTMLElement | null;
      expect(row).toBeTruthy();
      chat.setGeometry({ scrollHeight: 2500 });
      act(() => { fireResize([row!]); });
      await waitFor(() => expect(chat.scrollTop).toBe(destTop));
      await chat.drainFrames();
      expect(chat.scrollTop).toBe(destTop);
      expect(chat.container.querySelector('.chat-scroll-btn')).not.toBeNull();

      // 4) Explicit `End` resumes follow mode and pins cleanly to the latest bottom (2300).
      fireEvent.keyDown(chat.scrollEl, { key: 'End' });
      await chat.drainFrames();
      expect(chat.scrollTop).toBe(2300);
      expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();
    } finally {
      rootRectSpy.mockRestore();
      targetRectSpy.mockRestore();
    }
  });

  it('does not cancel native smooth locate via restoreReaderAnchor when an image above target grows +30px mid-scroll, reconciles target position, and resumes on End', async () => {
    const events = [
      assistantEvent('u-above', 'above image:\n\n![above](https://example.test/above.png)', 1000),
      userEvent('u-target', 'located target prompt', 2000),
      assistantEvent('a-tail', 'latest reply at bottom', 3000),
    ];
    const chat = await mountSwitchHarness({
      serverId: 'srv-1',
      sessionId: 'deck_locate_img_race',
      visible: true,
      events,
      initialScrollHeight: 1200,
      initialClientHeight: 200,
      messagePinsEnabled: true,
    });
    expect(chat.scrollTop).toBe(1000);

    const targetEl = chat.container.querySelector('[data-event-id="u-target"]') as HTMLElement | null;
    const imgEl = chat.container.querySelector('img[alt="above"]') as HTMLImageElement | null;
    expect(targetEl).not.toBeNull();
    expect(imgEl).not.toBeNull();

    let aboveGrowth = 0;
    let currentTop = 1000;
    let currentHeight = 1200;
    let fromSmoothStep = false;
    let smoothCancelledByDirectWrite = false;
    let expectedMidTop = -1;
    let activeSmooth: { dest: number; timer: number | null } | null = null;
    let resolveMidReached: (() => void) | null = null;
    const midReached = new Promise<void>((resolve) => {
      resolveMidReached = resolve;
    });
    const clamp = (v: number) => Math.max(0, Math.min(v, Math.max(0, currentHeight - 200)));

    Object.defineProperty(chat.scrollEl, 'scrollHeight', { configurable: true, get: () => currentHeight });
    Object.defineProperty(chat.scrollEl, 'clientHeight', { configurable: true, get: () => 200 });
    Object.defineProperty(chat.scrollEl, 'scrollTop', {
      configurable: true,
      get: () => currentTop,
      set: (v: number) => {
        if (activeSmooth && !fromSmoothStep) {
          smoothCancelledByDirectWrite = true;
          if (activeSmooth.timer !== null) window.clearTimeout(activeSmooth.timer);
          activeSmooth = null;
        }
        currentTop = clamp(v);
      },
    });
    const completeSmooth = () => {
      if (!activeSmooth) return;
      const { dest, timer } = activeSmooth;
      if (timer !== null) window.clearTimeout(timer);
      activeSmooth = null;
      fromSmoothStep = true;
      currentTop = clamp(dest);
      fromSmoothStep = false;
      fireEvent.scroll(chat.scrollEl);
      chat.scrollEl.dispatchEvent(new Event('scrollend'));
    };
    const scrollToImpl = vi.fn((opts?: ScrollToOptions) => {
      const dest = typeof opts?.top === 'number' ? opts.top : 0;
      if (opts?.behavior !== 'smooth') {
        if (activeSmooth) {
          if (activeSmooth.timer !== null) window.clearTimeout(activeSmooth.timer);
          activeSmooth = null;
        }
        fromSmoothStep = true;
        currentTop = clamp(dest);
        fromSmoothStep = false;
        fireEvent.scroll(chat.scrollEl);
        return;
      }
      if (activeSmooth?.timer != null) window.clearTimeout(activeSmooth.timer);
      const start = currentTop;
      const midTop = clamp(Math.round((start + dest) / 2));
      const midTimer = window.setTimeout(() => {
        if (!activeSmooth) return;
        activeSmooth.timer = null;
        expectedMidTop = midTop;
        fromSmoothStep = true;
        currentTop = midTop;
        fromSmoothStep = false;
        fireEvent.scroll(chat.scrollEl);
        resolveMidReached?.();
        resolveMidReached = null;
      }, 10);
      activeSmooth = { dest, timer: midTimer };
    });
    Object.defineProperty(chat.scrollEl, 'scrollTo', { configurable: true, writable: true, value: scrollToImpl });

    const rootRectSpy = vi.spyOn(chat.scrollEl, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 200, width: 320, height: 200, toJSON: () => ({}),
    } as DOMRect);
    const targetRectSpy = vi.spyOn(targetEl!, 'getBoundingClientRect').mockImplementation(() => {
      const contentTop = 580 + aboveGrowth;
      const top = contentTop - currentTop;
      return {
        x: 0, y: top, top, left: 0, right: 320, bottom: top + 40, width: 320, height: 40, toJSON: () => ({}),
      } as DOMRect;
    });

    try {
      // Queue passive bottom pin, then locate `u-target` (desired top = 580 - 80 = 500).
      await new Promise((resolve) => setTimeout(resolve, 250));
      currentHeight = 1200;
      fireEvent.scroll(chat.scrollEl);
      act(() => { chat.invokeScrollBottom({ passive: true }); });
      act(() => {
        requestMessagePinNavigation({
          id: 'pin-img-race-1',
          serverId: 'srv-1',
          sessionName: 'deck_locate_img_race',
          eventId: 'u-target',
          eventTs: 2000,
          eventType: 'user.message',
          text: 'located target prompt',
          createdAt: 1,
          updatedAt: 1,
        });
      });

      // Wait for mid-smooth tick (strictly intermediate between start and 500), then grow +30px above `u-target` and fire `<img>` load (`onMediaLayout`) before completing smooth scroll.
      await midReached;
      expect(expectedMidTop).not.toBe(-1);
      expect(expectedMidTop).not.toBe(500);
      expect(currentTop).toBe(expectedMidTop);
      aboveGrowth = 30;
      currentHeight = 1230;
      fireEvent(imgEl!, new Event('load', { bubbles: false }));
      completeSmooth();

      // Wait for post-smooth target reconciliation (`500 -> 530`).
      await waitFor(() => expect(currentTop).toBe(530));
      await chat.drainFrames();
      expect(smoothCancelledByDirectWrite).toBe(false);
      expect(currentTop).toBe(530);
      expect(chat.container.querySelector('.chat-scroll-btn')).not.toBeNull();

      // Explicit `End` releases locate ownership and pins back to bottom (`1030`).
      fireEvent.keyDown(chat.scrollEl, { key: 'End' });
      await chat.drainFrames();
      expect(currentTop).toBe(1030);
      expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();
    } finally {
      if (activeSmooth?.timer != null) window.clearTimeout(activeSmooth.timer);
      rootRectSpy.mockRestore();
      targetRectSpy.mockRestore();
    }
  });

  it('reconciles downward smooth locate when an image below an intermediate viewport row grows +300px mid-scroll and preserves cancel on End', async () => {
    const events = [
      userEvent('r-top', 'top history prompt', 1000),
      assistantEvent('r-img', 'mid image:\n\n![mid](https://example.test/mid.png)', 2000),
      userEvent('r-target', 'located lower prompt', 3000),
      assistantEvent('r-tail', 'latest reply', 4000),
    ];
    const chat = await mountSwitchHarness({
      serverId: 'srv-1',
      sessionId: 'deck_locate_downward_mid_img',
      visible: true,
      events,
      initialScrollHeight: 2000,
      initialClientHeight: 200,
      messagePinsEnabled: true,
    });
    expect(chat.scrollTop).toBe(1800);

    const topEl = chat.container.querySelector('[data-event-id="r-top"]') as HTMLElement | null;
    const imgEl = chat.container.querySelector('img[alt="mid"]') as HTMLImageElement | null;
    const targetEl = chat.container.querySelector('[data-event-id="r-target"]') as HTMLElement | null;
    expect(topEl).not.toBeNull();
    expect(imgEl).not.toBeNull();
    expect(targetEl).not.toBeNull();

    let midImgGrowth = 0;
    let currentTop = 1800;
    let currentHeight = 2000;
    let fromSmoothStep = false;
    let smoothCancelledByDirectWrite = false;
    let activeSmooth: { dest: number; timer: number | null } | null = null;
    let resolveMidReached: (() => void) | null = null;
    const midReached = new Promise<void>((resolve) => {
      resolveMidReached = resolve;
    });
    const clamp = (v: number) => Math.max(0, Math.min(v, Math.max(0, currentHeight - 200)));

    Object.defineProperty(chat.scrollEl, 'scrollHeight', { configurable: true, get: () => currentHeight });
    Object.defineProperty(chat.scrollEl, 'clientHeight', { configurable: true, get: () => 200 });
    Object.defineProperty(chat.scrollEl, 'scrollTop', {
      configurable: true,
      get: () => currentTop,
      set: (v: number) => {
        if (activeSmooth && !fromSmoothStep) {
          smoothCancelledByDirectWrite = true;
          if (activeSmooth.timer !== null) window.clearTimeout(activeSmooth.timer);
          activeSmooth = null;
        }
        currentTop = clamp(v);
      },
    });
    const completeSmooth = () => {
      if (!activeSmooth) return;
      const { dest, timer } = activeSmooth;
      if (timer !== null) window.clearTimeout(timer);
      activeSmooth = null;
      fromSmoothStep = true;
      currentTop = clamp(dest);
      fromSmoothStep = false;
      fireEvent.scroll(chat.scrollEl);
      chat.scrollEl.dispatchEvent(new Event('scrollend'));
    };
    const scrollToImpl = vi.fn((opts?: ScrollToOptions) => {
      const dest = typeof opts?.top === 'number' ? opts.top : 0;
      if (opts?.behavior !== 'smooth') {
        if (activeSmooth) {
          if (activeSmooth.timer !== null) window.clearTimeout(activeSmooth.timer);
          activeSmooth = null;
        }
        fromSmoothStep = true;
        currentTop = clamp(dest);
        fromSmoothStep = false;
        fireEvent.scroll(chat.scrollEl);
        return;
      }
      if (activeSmooth?.timer != null) window.clearTimeout(activeSmooth.timer);
      const midTimer = window.setTimeout(() => {
        if (!activeSmooth) return;
        activeSmooth.timer = null;
        fromSmoothStep = true;
        // Step through an intermediate scrollTop inside `r-top` (`0..260`) while `r-img` sits below `r-top`.
        currentTop = clamp(200);
        fromSmoothStep = false;
        fireEvent.scroll(chat.scrollEl);
        resolveMidReached?.();
        resolveMidReached = null;
      }, 10);
      activeSmooth = { dest, timer: midTimer };
    });
    Object.defineProperty(chat.scrollEl, 'scrollTo', { configurable: true, writable: true, value: scrollToImpl });

    const rootRectSpy = vi.spyOn(chat.scrollEl, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 200, width: 320, height: 200, toJSON: () => ({}),
    } as DOMRect);
    const topRectSpy = vi.spyOn(topEl!, 'getBoundingClientRect').mockImplementation(() => {
      const top = 0 - currentTop;
      return {
        x: 0, y: top, top, left: 0, right: 320, bottom: top + 260, width: 320, height: 260, toJSON: () => ({}),
      } as DOMRect;
    });
    const targetRectSpy = vi.spyOn(targetEl!, 'getBoundingClientRect').mockImplementation(() => {
      const contentTop = 1130 + midImgGrowth;
      const top = contentTop - currentTop;
      return {
        x: 0, y: top, top, left: 0, right: 320, bottom: top + 40, width: 320, height: 40, toJSON: () => ({}),
      } as DOMRect;
    });

    try {
      // Scroll up to old history (`scrollTop = 0`) and disengage follow cleanly.
      await new Promise((resolve) => setTimeout(resolve, 250));
      fireEvent.wheel(chat.scrollEl, { deltaY: -120 });
      currentTop = 0;
      fireEvent.scroll(chat.scrollEl);
      expect(chat.container.querySelector('.chat-scroll-btn')).not.toBeNull();

      // Locate `r-target` downward (initial desired top = 1130 - 80 = 1050).
      act(() => {
        requestMessagePinNavigation({
          id: 'pin-downward-mid-img',
          serverId: 'srv-1',
          sessionName: 'deck_locate_downward_mid_img',
          eventId: 'r-target',
          eventTs: 3000,
          eventType: 'user.message',
          text: 'located lower prompt',
          createdAt: 1,
          updatedAt: 1,
        });
      });

      // Mid-smooth (`scrollTop = 200`, inside `r-top` whose delta stays 0): grow `r-img` below `r-top` and above `r-target` by +300px.
      await midReached;
      expect(currentTop).toBe(200);
      midImgGrowth = 300;
      currentHeight = 2300;
      fireEvent(imgEl!, new Event('load', { bubbles: false }));
      completeSmooth();

      // Natural smooth finish reconciles to `1350` (not stranded at `1050` where target y=380 would be off-screen).
      await waitFor(() => expect(currentTop).toBe(1350));
      await chat.drainFrames();
      expect(smoothCancelledByDirectWrite).toBe(false);
      expect(currentTop).toBe(1350);
      const visibleTargetRect = targetEl!.getBoundingClientRect();
      expect(visibleTargetRect.top).toBe(80);
      expect(visibleTargetRect.bottom).toBe(120);
      expect(chat.container.querySelector('.chat-scroll-btn')).not.toBeNull();

      // Explicit `End` releases locate ownership and jumps to bottom (`2100`).
      fireEvent.keyDown(chat.scrollEl, { key: 'End' });
      await chat.drainFrames();
      expect(currentTop).toBe(2100);
      expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();
    } finally {
      if (activeSmooth?.timer != null) window.clearTimeout(activeSmooth.timer);
      rootRectSpy.mockRestore();
      topRectSpy.mockRestore();
      targetRectSpy.mockRestore();
    }
  });

  it('keeps virtualized >24-row chats pinned through A -> B -> C -> A switches, ResizeObserver row measurement, delayed catch-up, and img load', async () => {
    const eventsA = [userEvent('a-1', 'server A', 500)];
    const eventsB = [userEvent('b-1', 'server B', 600)];
    const cachedVirtualC: TimelineEvent[] = Array.from({ length: 120 }, (_, i) => (
      i % 2 === 0
        ? userEvent(`c-${i}`, `cached user ${i}`, 1000 + i * 10)
        : assistantEvent(`c-${i}`, `cached reply ${i}`, 1000 + i * 10)
    ));
    const chat = await mountSwitchHarness({
      serverId: 'srv-1',
      sessionId: 'deck_srv1_main',
      visible: true,
      events: eventsA,
      initialScrollHeight: 1200,
      initialClientHeight: 250,
    });

    // Rapid A -> B -> C switch ending on virtualized srv-3 cached history.
    await chat.updateProps({ serverId: 'srv-2', sessionId: 'deck_srv2_main', events: eventsB }, false);
    chat.setGeometry({ scrollHeight: 2200 });
    await chat.updateProps({ serverId: 'srv-3', sessionId: 'deck_srv3_main', events: cachedVirtualC });
    expect(chat.scrollTop).toBe(1950);
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();

    // Delayed catch-up arrives 250ms later with a user turn + assistant message containing an <img>.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const withImage = [
      ...cachedVirtualC,
      userEvent('u-new-img', 'show screenshot', 4900),
      assistantEvent('c-new-img', 'screenshot attached:\n\n![result](https://example.test/out.png)', 5000),
    ];
    chat.setGeometry({ scrollHeight: 2320 });
    fireEvent.scroll(chat.scrollEl);
    await chat.updateProps({ events: withImage });
    expect(chat.scrollTop).toBe(2070);

    // Fire real ResizeObserver callback on the newly mounted virtual row `[data-virtual-key]`.
    const tailEvent = chat.container.querySelector('[data-event-id="c-new-img"]') as HTMLElement | null;
    expect(tailEvent).not.toBeNull();
    const tailVirtualRow = tailEvent?.closest('[data-virtual-key]') as HTMLElement | null;
    expect(tailVirtualRow).toBeTruthy();
    const rectSpy = vi.spyOn(tailVirtualRow!, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 260, width: 320, height: 260, toJSON: () => ({}),
    } as DOMRect);
    try {
      chat.setGeometry({ scrollHeight: 2640, scrollTop: 2090 });
      fireEvent.scroll(chat.scrollEl);
      act(() => { fireResize([tailVirtualRow!]); });
      await waitFor(() => expect(chat.scrollTop).toBe(2390));
      expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();
    } finally {
      rectSpy.mockRestore();
    }

    // Async <img> decode expands scrollHeight further.
    const img = chat.container.querySelector('img[alt="result"]') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    chat.setGeometry({ scrollHeight: 2880 });
    fireEvent.scroll(chat.scrollEl);
    fireEvent(img!, new Event('load', { bubbles: false }));
    await waitFor(() => expect(chat.scrollTop).toBe(2630));
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();

    // Return A: switching back from C -> A re-pins cleanly to A's bottom.
    chat.setGeometry({ scrollHeight: 1450 });
    await chat.updateProps({
      serverId: 'srv-1',
      sessionId: 'deck_srv1_main',
      events: [...eventsA, assistantEvent('a-2', 'back on A', 6000)],
    });
    expect(chat.scrollTop).toBe(1200);
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

  it('lets a single 40px ArrowUp and between-frame wheel upward scroll win over switch settle and surface unread badge', async () => {
    const events = [
      userEvent('u-neg', 'msg', 1000),
      assistantEvent('a-neg', 'reply', 2000),
    ];
    const chat = await mountSwitchHarness({
      serverId: 'srv-1',
      sessionId: 'deck_neg',
      visible: true,
      events,
      initialScrollHeight: 1200,
      initialClientHeight: 200,
    });
    expect(chat.scrollTop).toBe(1000);

    // 1) A single 40px unmodified ArrowUp (`1000 -> 960`, < 180 disengageThreshold) MUST disengage immediately.
    await new Promise((resolve) => setTimeout(resolve, 250));
    fireEvent.keyDown(chat.scrollEl, { key: 'ArrowUp' });
    chat.setGeometry({ scrollTop: 960 });
    fireEvent.scroll(chat.scrollEl);
    expect(chat.container.querySelector('.chat-scroll-btn')).not.toBeNull();

    // Even after the 400ms keyboard hold expires, arriving content stays at 960 and surfaces `[↓ 1]`.
    await new Promise((resolve) => setTimeout(resolve, 450));
    chat.setGeometry({ scrollHeight: 1500 });
    await chat.updateProps({
      events: [...events, assistantEvent('a-neg-arrow', 'unread after ArrowUp', 2500)],
    });
    expect(chat.scrollTop).toBe(960);
    expect(chat.container.querySelector('.chat-scroll-btn')?.textContent).toContain('↓ 1');

    // Re-engage via bottom button.
    fireEvent.click(chat.container.querySelector('.chat-scroll-btn') as HTMLButtonElement);
    await chat.drainFrames();
    expect(chat.scrollTop).toBe(1300);
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();

    // 2) Simulate parent switch engage (`invokeScrollBottom()`) followed immediately by wheel-up
    //    BEFORE frame-2 passive settle (`invokeScrollBottom({ passive: true })`) executes.
    act(() => { chat.invokeScrollBottom(); });
    fireEvent.wheel(chat.scrollEl, { deltaY: -120 });
    chat.setGeometry({ scrollTop: 650 });
    fireEvent.scroll(chat.scrollEl);
    act(() => { chat.invokeScrollBottom({ passive: true }); });
    await chat.drainFrames();

    expect(chat.scrollTop).toBe(650);
    expect(chat.container.querySelector('.chat-scroll-btn')).not.toBeNull();

    chat.setGeometry({ scrollHeight: 1850 });
    await chat.updateProps({
      events: [
        ...events,
        assistantEvent('a-neg-arrow', 'unread after ArrowUp', 2500),
        assistantEvent('a-neg-wheel', 'unread after wheel between frames', 3500),
      ],
    });
    expect(chat.scrollTop).toBe(650);
    expect(chat.container.querySelector('.chat-scroll-btn')?.textContent).toContain('↓ 1');
  });
});
