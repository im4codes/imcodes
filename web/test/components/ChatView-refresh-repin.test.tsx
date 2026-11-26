/**
 * @vitest-environment jsdom
 *
 * "After refreshing in Safari the chat still sits a little above the bottom,
 * even when I was scrolled all the way down."
 *
 * The chat list sets `overflow-anchor: none`, so the browser never compensates
 * when something shrinks the viewport — only the ResizeObserver re-pin does. But
 * the banner-toggle suppression it consults was stamped by an effect keyed on
 * `[pinnedAboveViewport]`, and such an effect ALSO runs on mount, so the first
 * 300ms after a refresh had re-pinning disabled. That is exactly the window in
 * which `--vvh` is applied from an effect, the composer rehydrates its saved
 * draft, and the sub-session bar runs its 200ms max-height transition. Worse, the
 * observer records the new height BEFORE checking the suppression, so the change
 * was consumed for good: no later resize could recover it.
 *
 * These two tests pin both halves of the contract — a genuine post-mount resize
 * must re-pin, and a real banner toggle must still NOT.
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

/** Controllable ResizeObserver — jsdom has none, and we need to fire it on demand. */
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

/** Minimal IntersectionObserver fake so we can drive the pin banner on/off. */
type IOCallback = (entries: IntersectionObserverEntry[]) => void;
const ioInstances: Array<{ fire: (e: Array<Partial<IntersectionObserverEntry>>) => void }> = [];
class FakeIntersectionObserver {
  private callback: IOCallback;
  private target: Element | null = null;
  constructor(callback: IOCallback) {
    this.callback = callback;
    const self = this;
    ioInstances.push({
      fire: (partial) => {
        self.callback(partial.map((e) => ({
          target: self.target,
          isIntersecting: false,
          intersectionRatio: 0,
          intersectionRect: {} as DOMRectReadOnly,
          boundingClientRect: { bottom: 0, top: 0 } as DOMRectReadOnly,
          rootBounds: { top: 0, bottom: 500 } as DOMRectReadOnly,
          time: 0,
          ...e,
        })) as IntersectionObserverEntry[]);
      },
    });
  }
  observe(target: Element): void { this.target = target; }
  unobserve(): void { this.target = null; }
  disconnect(): void { this.target = null; }
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

function userEvent(eventId: string, text: string, ts: number): TimelineEvent {
  return {
    eventId, type: 'user.message', ts, epoch: 1, seq: ts,
    sessionId: 'deck_repin_brain', source: 'daemon', confidence: 'high',
    payload: { text },
  } as unknown as TimelineEvent;
}
function assistantEvent(eventId: string, text: string, ts: number): TimelineEvent {
  return {
    eventId, type: 'assistant.text', ts, epoch: 1, seq: ts,
    sessionId: 'deck_repin_brain', source: 'daemon', confidence: 'high',
    payload: { text, streaming: false },
  } as unknown as TimelineEvent;
}

const EVENTS = [
  userEvent('u1', 'why is the chat not at the bottom after refresh', 1000),
  assistantEvent('a1', 'investigating the pin path', 2000),
];

/**
 * Renders, waits for the initial bottom pin, then hands back a harness whose
 * `clientHeight` can shrink like a real post-refresh layout settle.
 */
async function renderPinnedChat() {
  const { container } = render(
    <ChatView events={EVENTS as never} loading={false} hasOlderHistory={false} sessionId="deck_repin_brain" />,
  );
  const scrollEl = container.querySelector('.chat-view') as HTMLDivElement;
  let scrollTopValue = 0;
  let clientHeightValue = 200;
  let scrollHeightValue = 1200;
  Object.defineProperty(scrollEl, 'scrollTop', {
    configurable: true,
    get: () => scrollTopValue,
    set: (v: number) => { scrollTopValue = v; },
  });
  Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, get: () => scrollHeightValue });
  Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, get: () => clientHeightValue });

  // Initial pin to the bottom (this is the state the user is in before refresh).
  await waitFor(() => expect(scrollTopValue).toBe(1200));

  // Drain the frames mount already scheduled before handing control back. The
  // session-change effect queues `requestAnimationFrame(() => scrollToBottom(true))`,
  // and under full-suite parallel load that callback can land AFTER a test has
  // set up its scenario — silently re-pinning to the bottom and making an
  // unrelated assertion fail. Wait until the position stops changing on its own.
  await act(async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, 30); });
  });
  expect(scrollTopValue).toBe(1200);

  return {
    container,
    scrollEl,
    get scrollTop() { return scrollTopValue; },
    /** Simulate the browser leaving the view above the bottom after a shrink. */
    setScrollTop: (v: number) => { scrollTopValue = v; },
    shrinkViewport: (to: number) => { clientHeightValue = to; },
    /** A block mounting ABOVE the messages makes the whole list taller. */
    growContent: (to: number) => { scrollHeightValue = to; },
    /** Drive a real user scroll-up so follow mode disengages. */
    scrollUpTo: (v: number) => {
      scrollTopValue = v;
      fireEvent.scroll(scrollEl);
    },
  };
}

describe('ChatView — post-refresh re-pin to bottom', () => {
  beforeEach(() => {
    resizeCallbacks.length = 0;
    ioInstances.length = 0;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver as unknown as typeof ResizeObserver);
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver as unknown as typeof IntersectionObserver);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('re-pins to the bottom when the viewport shrinks right after mount', async () => {
    const chat = await renderPinnedChat();

    // The post-refresh settle: --vvh lands / composer draft rehydrates / the
    // sub-session bar finishes its transition, so the pane loses height and the
    // browser leaves the reading position above the bottom.
    chat.shrinkViewport(140);
    chat.setScrollTop(1040);
    act(() => { fireResize(); });

    // Must snap back to the bottom. Before the fix the mount-stamped suppression
    // swallowed this resize entirely and the view stayed at 1040 forever.
    await waitFor(() => expect(chat.scrollTop).toBe(1200));
  });

  it('still does NOT re-pin for the pin banner toggling its own height', async () => {
    const chat = await renderPinnedChat();

    // A real toggle: the last user bubble goes above the viewport, so the banner
    // mounts and steals ~60px. Re-pinning here would snap the user back down,
    // which re-hides the banner and starts the height-oscillation jitter loop.
    await waitFor(() => expect(ioInstances.length).toBeGreaterThan(0));

    // The suppression is a 300ms WALL-CLOCK window, so freeze the clock before
    // the toggle stamps it. Otherwise this test just races the machine: under
    // full-suite parallel load the gap between the stamp and the resize exceeded
    // 300ms, the suppression expired, and the failure looked like a product bug
    // when it was only the test being slow.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      act(() => {
        ioInstances[ioInstances.length - 1].fire([{
          isIntersecting: false,
          boundingClientRect: { bottom: -10, top: -30 } as DOMRectReadOnly,
          rootBounds: { top: 0, bottom: 500 } as DOMRectReadOnly,
        }]);
      });
      expect(chat.container.querySelector('.chat-pinned-last-sent')).not.toBeNull();

      chat.shrinkViewport(140);
      chat.setScrollTop(600); // user is reading up here; must not be yanked
      act(() => { fireResize(); });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(chat.scrollTop).toBe(600);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('re-pins when a block mounts ABOVE the messages and grows the list (no images involved)', async () => {
    const chat = await renderPinnedChat();

    // The reported case with no images in the chat at all: the "Load older" row
    // appears once `hasOlderHistory` resolves from the first history response, the
    // agent todo list mounts, the tool-chooser banner lands behind its async pref
    // fetch. All sit above every message, so the list gets taller ABOVE the
    // viewport while `clientHeight` never changes — the ResizeObserver is blind to
    // it and `overflow-anchor: none` means the browser will not compensate.
    chat.growContent(1320);

    await waitFor(() => expect(chat.scrollTop).toBe(1320), { timeout: 1000 });
  });

  it('leaves the view alone if the user scrolled up before the content grew', async () => {
    const chat = await renderPinnedChat();

    // A gentle scroll-up must win — this is precisely the "auto-update fights my
    // scrolling" complaint behind the earlier Safari jitter fixes.
    chat.scrollUpTo(400);
    chat.growContent(1320);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(chat.scrollTop).toBe(400);
  });

  it('keeps .chat-pinned-last-sent stable across null rootBounds, detached zero rects, sub-pixel jitter, and bottom overscroll', async () => {
    const chat = await renderPinnedChat();
    await waitFor(() => expect(ioInstances.length).toBeGreaterThan(0));
    const io = ioInstances[ioInstances.length - 1];

    // Bubble scrolled clearly above viewport -> banner mounts
    chat.setScrollTop(600);
    act(() => {
      io.fire([{
        isIntersecting: false,
        boundingClientRect: { top: -40, bottom: -10, width: 200, height: 30 } as DOMRectReadOnly,
        rootBounds: { top: 0, bottom: 500 } as DOMRectReadOnly,
      }]);
    });
    expect(chat.container.querySelector('.chat-pinned-last-sent')).not.toBeNull();

    // 1) Missing rootBounds (transient observer state) -> must NOT flash off
    act(() => {
      io.fire([{
        isIntersecting: false,
        boundingClientRect: { top: 0, bottom: 0, width: 200, height: 30 } as DOMRectReadOnly,
        rootBounds: null as unknown as DOMRectReadOnly,
      }]);
    });
    expect(chat.container.querySelector('.chat-pinned-last-sent')).not.toBeNull();

    // 2) Zero-sized non-intersecting target rect (virtualizer swap / unmeasured) -> must NOT flash off
    act(() => {
      io.fire([{
        isIntersecting: false,
        boundingClientRect: { top: 0, bottom: 0, width: 0, height: 0 } as DOMRectReadOnly,
        rootBounds: { top: 0, bottom: 500 } as DOMRectReadOnly,
      }]);
    });
    expect(chat.container.querySelector('.chat-pinned-last-sent')).not.toBeNull();

    // 3) Sub-pixel boundary jitter around rootBounds.top (< +8px) -> hysteresis keeps banner mounted
    act(() => {
      io.fire([{
        isIntersecting: true,
        boundingClientRect: { top: -20, bottom: 2, width: 200, height: 22 } as DOMRectReadOnly,
        rootBounds: { top: 0, bottom: 500 } as DOMRectReadOnly,
      }]);
    });
    expect(chat.container.querySelector('.chat-pinned-last-sent')).not.toBeNull();

    // 4) Bottom rubber-band overscroll -> must NOT transiently flash off
    chat.setScrollTop(1040);
    act(() => {
      io.fire([{
        isIntersecting: true,
        boundingClientRect: { top: 0, bottom: 30, width: 200, height: 30 } as DOMRectReadOnly,
        rootBounds: { top: 0, bottom: 500 } as DOMRectReadOnly,
      }]);
    });
    expect(chat.container.querySelector('.chat-pinned-last-sent')).not.toBeNull();

    // 5) Genuine scroll back into view (non-overscrolled, clearly inside top) -> hides cleanly
    chat.setScrollTop(0);
    act(() => {
      io.fire([{
        isIntersecting: true,
        boundingClientRect: { top: 10, bottom: 40, width: 200, height: 30 } as DOMRectReadOnly,
        rootBounds: { top: 0, bottom: 500 } as DOMRectReadOnly,
      }]);
    });
    expect(chat.container.querySelector('.chat-pinned-last-sent')).toBeNull();
  });
});

function statusEvent(eventId: string, ts: number, label = 'working'): TimelineEvent {
  return {
    eventId,
    type: 'agent.status',
    ts,
    epoch: 1,
    seq: ts,
    sessionId: 'deck_switch_target',
    source: 'daemon',
    confidence: 'high',
    payload: { status: label },
  } as unknown as TimelineEvent;
}

function usageEvent(eventId: string, ts: number, tokens = 100): TimelineEvent {
  return {
    eventId,
    type: 'usage.update',
    ts,
    epoch: 1,
    seq: ts,
    sessionId: 'deck_switch_target',
    source: 'daemon',
    confidence: 'high',
    payload: { inputTokens: tokens, outputTokens: 20 },
  } as unknown as TimelineEvent;
}

/**
 * Harness with browser-accurate clamped `scrollTop` (`[0, max(0, scrollHeight - clientHeight)]`)
 * and mutable props (`serverId`, `sessionId`, `visible`, `events`) to test server/tab switching.
 */
async function renderSwitchableChat(initialProps: {
  serverId: string;
  sessionId: string;
  visible: boolean;
  events: TimelineEvent[];
  initialScrollHeight?: number;
  initialClientHeight?: number;
  skipInitialDrain?: boolean;
}) {
  let currentProps = { ...initialProps };
  const rendered = render(
    <ChatView
      events={currentProps.events as never}
      loading={false}
      hasOlderHistory={false}
      serverId={currentProps.serverId}
      sessionId={currentProps.sessionId}
      visible={currentProps.visible}
    />,
  );
  const scrollEl = rendered.container.querySelector('.chat-view') as HTMLDivElement;
  let scrollTopValue = 0;
  let scrollTopWrites = 0;
  let clientHeightValue = initialProps.initialClientHeight ?? 200;
  let scrollHeightValue = initialProps.initialScrollHeight ?? 1200;
  const clampTop = (v: number) => Math.max(0, Math.min(v, Math.max(0, scrollHeightValue - clientHeightValue)));

  Object.defineProperty(scrollEl, 'scrollTop', {
    configurable: true,
    get: () => scrollTopValue,
    set: (v: number) => {
      scrollTopWrites += 1;
      scrollTopValue = clampTop(v);
    },
  });
  Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, get: () => scrollHeightValue });
  Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, get: () => clientHeightValue });

  const drainFrames = async () => {
    await act(async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
    });
  };

  if (!initialProps.skipInitialDrain) {
    await drainFrames();
  }

  return {
    container: rendered.container,
    scrollEl,
    get scrollTop() { return scrollTopValue; },
    get scrollTopWriteCount() { return scrollTopWrites; },
    resetScrollTopWriteCount: () => { scrollTopWrites = 0; },
    get maxTop() { return Math.max(0, scrollHeightValue - clientHeightValue); },
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
        />,
      );
      if (drain) await drainFrames();
    },
    drainFrames,
  };
}

describe('ChatView — server/tab switch active session & async media pin stability', () => {
  beforeEach(() => {
    resizeCallbacks.length = 0;
    ioInstances.length = 0;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver as unknown as typeof ResizeObserver);
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver as unknown as typeof IntersectionObserver);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('stays pinned at bottom after server/tab switch when events tick (agent.status) and late <img> load expands scrollHeight', async () => {
    const eventsA = [userEvent('a-u1', 'tab A', 1000)];
    const eventsB = [
      userEvent('b-u1', 'check screenshot', 2000),
      assistantEvent('b-a1', 'working on it\n\n![shot](https://example.test/shot.png)', 3000),
    ];

    const chat = await renderSwitchableChat({
      serverId: 'srv-1',
      sessionId: 'deck_tab_a',
      visible: true,
      events: eventsA,
    });

    // Switch server + tab to an active session whose last user message contains an image.
    await chat.updateProps({
      serverId: 'srv-2',
      sessionId: 'deck_tab_b',
      events: eventsB,
    });
    expect(chat.scrollTop).toBe(1000);
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();

    // Non-rendered status event ticks (new `events` identity without renderedRevision bump).
    await chat.updateProps({
      events: [...eventsB, statusEvent('b-s1', 3500)],
    }, false);

    // Late <img> decode expands scrollHeight during active status ticks (even before
    // the 80ms settle timer ticks): capture-phase `load` keeps bottom pinned without
    // showing `.chat-scroll-btn`.
    const img = chat.container.querySelector('img[alt="shot"]') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    chat.setGeometry({ scrollHeight: 1650 });
    fireEvent(img!, new Event('load', { bubbles: false }));

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(chat.scrollTop).toBe(1450);
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();
  });

  it('re-pins when a slow <img> finishes loading after the 1.5s settle window without showing the scroll button', async () => {
    const eventsB = [
      userEvent('late-u1', 'check slow image', 2000),
      assistantEvent('late-a1', 'screenshot\n\n![shot](https://example.test/shot.png)', 3000),
    ];

    let fakeNow = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    try {
      const chat = await renderSwitchableChat({
        serverId: 'srv-1',
        sessionId: 'deck_a',
        visible: true,
        events: [userEvent('a-only', 'tab A', 1000)],
      });

      await chat.updateProps({ serverId: 'srv-2', sessionId: 'deck_b', events: eventsB });
      expect(chat.scrollTop).toBe(1000);

      // Advance past CHAT_MOUNT_SETTLE_MS so the mount-settle interval exits.
      fakeNow += 2000;
      await new Promise((resolve) => setTimeout(resolve, 100));

      const img = chat.container.querySelector('img[alt="shot"]') as HTMLImageElement | null;
      expect(img).not.toBeNull();
      chat.setGeometry({ scrollHeight: 1650 });
      fireEvent(img!, new Event('load', { bubbles: false }));

      await waitFor(() => expect(chat.scrollTop).toBe(1450));
      expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps bottom pinned when visible becomes true and clientHeight shrinks (>180px) before a lagging scroll event fires', async () => {
    const eventsB = [
      userEvent('v-u1', 'switched tab message', 2000),
      assistantEvent('v-a1', 'Agent 工作中...', 3000),
    ];

    const chat = await renderSwitchableChat({
      serverId: 'srv-2',
      sessionId: 'deck_tab_b',
      visible: false,
      events: eventsB,
      initialScrollHeight: 1200,
      initialClientHeight: 500,
    });

    // User switches tab back to this session (`visible: false -> true`).
    await chat.updateProps({ visible: true });
    expect(chat.scrollTop).toBe(700);

    // Working bar / composer / keyboard shrinks `clientHeight` (500 -> 260), moving
    // `maxTop` from 700 to 940 (`distance = 240 > disengageThreshold`) when `scroll` fires.
    chat.setGeometry({ clientHeight: 260 });
    fireEvent.scroll(chat.scrollEl);

    await waitFor(() => expect(chat.scrollTop).toBe(940));
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();
  });

  it('re-pins when switching across short (scrollHeight <= clientHeight) and tall sessions with late image load', async () => {
    const shortEvents = [userEvent('s-u1', 'short msg', 1000)];
    const tallEvents = [
      userEvent('t-u1', 'tall msg', 2000),
      assistantEvent('t-a1', 'reply with\n\n![shot](https://example.test/shot.png)', 3000),
    ];

    const chat = await renderSwitchableChat({
      serverId: 'srv-1',
      sessionId: 'deck_short',
      visible: true,
      events: shortEvents,
      initialScrollHeight: 140,
      initialClientHeight: 200,
    });
    expect(chat.scrollTop).toBe(0);

    // Rapid consecutive switches ending on a tall session whose image finishes loading shortly after.
    await chat.updateProps({ serverId: 'srv-2', sessionId: 'deck_mid', events: shortEvents }, false);
    chat.setGeometry({ scrollHeight: 1100 });
    await chat.updateProps({ serverId: 'srv-3', sessionId: 'deck_tall', events: tallEvents });
    expect(chat.scrollTop).toBe(900);

    const img = chat.container.querySelector('img[alt="shot"]') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    chat.setGeometry({ scrollHeight: 1500 });
    fireEvent(img!, new Event('load', { bubbles: false }));

    await waitFor(() => expect(chat.scrollTop).toBe(1300));
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();
  });

  it('aborts post-switch settle immediately within <50ms on real upward touch without draining frames, and stays unfollowed', async () => {
    const eventsB = [
      userEvent('u-img', 'look at screenshot', 2000),
      assistantEvent('a-img', 'inspecting\n\n![shot](https://example.test/shot.png)', 3000),
    ];

    const chat = await renderSwitchableChat({
      serverId: 'srv-1',
      sessionId: 'deck_a',
      visible: true,
      events: [userEvent('a1', 'hi', 1000)],
    });

    // Switch scope WITHOUT draining frames: simulate immediate <50ms real touch-up drag.
    await chat.updateProps({ serverId: 'srv-2', sessionId: 'deck_b', events: eventsB }, false);
    expect(chat.scrollTop).toBe(1000);

    fireEvent.touchStart(chat.scrollEl, { touches: [{ clientY: 200 }] });
    fireEvent.touchMove(chat.scrollEl, { touches: [{ clientY: 260 }] });
    chat.setGeometry({ scrollTop: 550 });
    fireEvent.scroll(chat.scrollEl);
    fireEvent.touchEnd(chat.scrollEl);
    expect(chat.container.querySelector('.chat-scroll-btn')).not.toBeNull();

    // Subsequent status tick, viewport shrink, and image load MUST NOT yank reader back to bottom.
    await chat.updateProps({ events: [...eventsB, statusEvent('s-up', 3500)] }, false);
    chat.setGeometry({ scrollHeight: 1600, clientHeight: 150 });
    const img = chat.container.querySelector('img[alt="shot"]') as HTMLImageElement | null;
    fireEvent(img!, new Event('load', { bubbles: false }));

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(chat.scrollTop).toBe(550);
    expect(chat.container.querySelector('.chat-scroll-btn')).not.toBeNull();
  });

  it('clears stale ↓ button, unread count, and reader anchor when switching scrollScopeKey or visible: false -> true', async () => {
    const eventsA = [
      userEvent('a-u1', 'tab A msg 1', 1000),
      assistantEvent('a-a1', 'tab A reply 1', 2000),
    ];
    const eventsB = [
      userEvent('b-u1', 'tab B msg 1', 3000),
      assistantEvent('b-a1', 'tab B reply 1', 4000),
    ];

    const chat = await renderSwitchableChat({
      serverId: 'srv-1',
      sessionId: 'deck_scope_a',
      visible: true,
      events: eventsA,
    });
    expect(chat.scrollTop).toBe(1000);

    // 1) Scroll up on scope A and accumulate an unread badge on `.chat-scroll-btn`.
    fireEvent.wheel(chat.scrollEl, { deltaY: -120 });
    chat.setGeometry({ scrollTop: 400 });
    fireEvent.scroll(chat.scrollEl);
    await chat.updateProps({ events: [...eventsA, assistantEvent('a-a2', 'unread reply', 2500)] });
    expect(chat.container.querySelector('.chat-scroll-btn')?.textContent).toContain('↓ 1');

    // Switch server/session (`scrollScopeKey` change): synchronously pins to bottom & clears ↓ / unread.
    await chat.updateProps({ serverId: 'srv-2', sessionId: 'deck_scope_b', events: eventsB });
    expect(chat.scrollTop).toBe(1000);
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();

    // 2) Scroll up on scope B with unread badge, then toggle `visible: false -> true` (kept-alive switch).
    fireEvent.wheel(chat.scrollEl, { deltaY: -120 });
    chat.setGeometry({ scrollTop: 350 });
    fireEvent.scroll(chat.scrollEl);
    await chat.updateProps({ events: [...eventsB, assistantEvent('b-a2', 'unread on B', 4500)] });
    expect(chat.container.querySelector('.chat-scroll-btn')?.textContent).toContain('↓ 1');

    await chat.updateProps({ visible: false }, false);
    chat.setGeometry({ scrollHeight: 1450 });
    await chat.updateProps({ visible: true });
    expect(chat.scrollTop).toBe(1250);
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();
  });

  it('re-pins pure scrollHeight growth inside CHAT_MOUNT_SETTLE during continuous 40ms status/usage ticks without unnecessary writes on steady geometry', async () => {
    vi.useFakeTimers();
    try {
      const baseEvents = [
        userEvent('st-u1', 'active status test', 1000),
        assistantEvent('st-a1', 'working continuously', 2000),
      ];
      const chat = await renderSwitchableChat({
        serverId: 'srv-1',
        sessionId: 'deck_steady',
        visible: true,
        events: [userEvent('init', 'init', 500)],
        skipInitialDrain: true,
      });

      await chat.updateProps({ serverId: 'srv-2', sessionId: 'deck_active_ticks', events: baseEvents }, false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(chat.scrollTop).toBe(1000);

      // Continuous status + usage updates every 40ms (<80ms settle tick) with UNCHANGED geometry:
      // must NOT write `scrollTop` unnecessarily.
      chat.resetScrollTopWriteCount();
      let currentEvents = [...baseEvents];
      for (let i = 1; i <= 5; i++) {
        currentEvents = [
          ...currentEvents,
          i % 2 === 0 ? usageEvent(`u-${i}`, 2000 + i * 40, i * 100) : statusEvent(`s-${i}`, 2000 + i * 40),
        ];
        await chat.updateProps({ events: currentEvents }, false);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(40);
        });
      }
      expect(chat.scrollTopWriteCount).toBe(0);
      expect(chat.scrollTop).toBe(1000);

      // Now pure `scrollHeight` grows (NO `load` event, NO `scroll` event) while 40ms
      // status/usage updates keep arriving every tick inside the 1.5s settle window.
      chat.setGeometry({ scrollHeight: 1680 });
      for (let i = 6; i <= 10; i++) {
        currentEvents = [
          ...currentEvents,
          i % 2 === 0 ? usageEvent(`u-${i}`, 2000 + i * 40, i * 100) : statusEvent(`s-${i}`, 2000 + i * 40),
        ];
        await chat.updateProps({ events: currentEvents }, false);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(40);
        });
      }

      expect(chat.scrollTop).toBe(1480);
      expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();

      // Genuine content commit (changes `renderedRevision`): content-update layout
      // effect pins to 1800; on the settle tick seeing that revision bump, settle
      // yields (updates baseline) and only catches post-commit lag on the next tick.
      chat.setGeometry({ scrollHeight: 2000 });
      currentEvents = [...currentEvents, assistantEvent('c-rev', 'rendered content update', 3000)];
      await chat.updateProps({ events: currentEvents }, false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(chat.scrollTop).toBe(1800);

      chat.resetScrollTopWriteCount();
      chat.setGeometry({ scrollHeight: 2150 });
      // First settle tick after revision change yields to the content path.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(chat.scrollTopWriteCount).toBe(0);
      expect(chat.scrollTop).toBe(1800);

      // Next quiet/status tick (renderedRevision unchanged) catches remaining lag.
      await chat.updateProps({ events: [...currentEvents, statusEvent('s-post-rev', 3100)] }, false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120);
      });
      expect(chat.scrollTop).toBe(1950);
      expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps >100 virtualized items with real ChatMarkdown code block, row ResizeObserver measurement, and late <img> load pinned at bottom after switch', async () => {
    const longEvents: TimelineEvent[] = Array.from({ length: 120 }, (_, i) => (
      i % 2 === 0
        ? userEvent(`v-${i}`, `user prompt ${i}`, 1000 + i * 10)
        : assistantEvent(
          `v-${i}`,
          i === 119
            ? 'final code:\n```ts\nconst ok = true;\n```\n\n![shot](https://example.test/shot.png)'
            : `assistant response ${i}`,
          1000 + i * 10,
        )
    ));

    const chat = await renderSwitchableChat({
      serverId: 'srv-1',
      sessionId: 'deck_short_prev',
      visible: true,
      events: [userEvent('short-1', 'hello', 500)],
      initialScrollHeight: 2400,
      initialClientHeight: 400,
    });

    await chat.updateProps({
      serverId: 'srv-2',
      sessionId: 'deck_virtual_120',
      events: longEvents,
    });

    // Confirm >100 list is virtualized (tail present, head virtualized out) with real ChatMarkdown code block DOM.
    const tailEvent = chat.container.querySelector('[data-event-id="v-119"]') as HTMLElement | null;
    expect(tailEvent).not.toBeNull();
    expect(tailEvent?.querySelector('pre code')).not.toBeNull();
    expect(tailEvent?.querySelector('.chat-code-lang')?.textContent).toBe('ts');
    expect(chat.container.querySelector('[data-event-id="v-0"]')).toBeNull();
    expect(chat.scrollTop).toBe(2000);
    expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();

    // Trigger real virtual row ResizeObserver measurement on the tail `[data-virtual-key]` wrapper.
    const tailVirtualRow = tailEvent!.closest('[data-virtual-key]') as HTMLElement | null;
    expect(tailVirtualRow).not.toBeNull();
    const rectSpy = vi.spyOn(tailVirtualRow!, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 240, width: 320, height: 240, toJSON: () => ({}),
    } as DOMRect);
    try {
      chat.setGeometry({ scrollHeight: 2850 });
      act(() => {
        fireResize([tailVirtualRow!]);
      });
      expect(chat.scrollTop).toBe(2450);
      expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();

      // Tail <img> load expands scrollHeight further while active.
      const img = chat.container.querySelector('img[alt="shot"]') as HTMLImageElement | null;
      expect(img).not.toBeNull();
      chat.setGeometry({ scrollHeight: 3150 });
      fireEvent(img!, new Event('load', { bubbles: false }));

      await waitFor(() => expect(chat.scrollTop).toBe(2750));
      expect(chat.container.querySelector('.chat-scroll-btn')).toBeNull();
    } finally {
      rectSpy.mockRestore();
    }
  });
});
