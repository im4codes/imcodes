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
import { render, cleanup, act, waitFor } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock('../../src/components/ChatMarkdown.js', () => ({
  ChatMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
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
function fireResize(): void {
  for (const cb of resizeCallbacks) cb([], {} as ResizeObserver);
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
  Object.defineProperty(scrollEl, 'scrollTop', {
    configurable: true,
    get: () => scrollTopValue,
    set: (v: number) => { scrollTopValue = v; },
  });
  Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, get: () => 1200 });
  Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, get: () => clientHeightValue });

  // Initial pin to the bottom (this is the state the user is in before refresh).
  await waitFor(() => expect(scrollTopValue).toBe(1200));

  return {
    container,
    get scrollTop() { return scrollTopValue; },
    /** Simulate the browser leaving the view above the bottom after a shrink. */
    setScrollTop: (v: number) => { scrollTopValue = v; },
    shrinkViewport: (to: number) => { clientHeightValue = to; },
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
  });
});
