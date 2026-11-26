/**
 * @vitest-environment jsdom
 *
 * Chat scroll jitter (real-browser measurements: 15/36/42 px transient bottom
 * gaps and reverse jumps while pinned + streaming, and a reader snapped back down
 * while scrolling up). The three ownership rules under test:
 *
 *  1. A pin that was QUEUED for the next animation frame must re-check follow
 *     intent when it runs: a wheel scroll-away that lands in between wins.
 *  2. A pinned viewport is re-pinned in the COMMIT phase (virtual rows are
 *     measured and the range re-pinned before paint), not one frame later.
 *  3. Local DOM growth no ChatView render owns (tool-card expand) re-pins in a
 *     microtask - before the next frame - only while follow is engaged.
 *
 * Every test stalls `requestAnimationFrame`, so anything that passes here did
 * NOT depend on a later frame.
 */
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/preact';

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

import { ChatView, __VirtualizedViewItemsForTests } from '../../src/components/ChatView.js';
import { applyUiScale, UI_SCALE_EVENT } from '../../src/ui-scale.js';
import type { TimelineEvent } from '../../src/ws-client.js';

/** Records every callback so a test can deliver ResizeObserver entries itself. */
const resizeCallbacks = new Set<ResizeObserverCallback>();
class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) { resizeCallbacks.add(callback); }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void { resizeCallbacks.delete(this.callback); }
}
function deliverResize(targets: Element[]): void {
  act(() => { for (const cb of [...resizeCallbacks]) cb(targets.map((target) => ({ target })) as unknown as ResizeObserverEntry[], {} as ResizeObserver); });
}
class FakeIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

const SESSION = 'deck_commit_pin_brain';
function message(i: number): TimelineEvent {
  return {
    eventId: `evt-${i}`, type: i % 2 ? 'user.message' : 'assistant.text', ts: 1000 + i, epoch: 1, seq: i,
    sessionId: SESSION, source: 'daemon', confidence: 'high', payload: { text: `message ${i}`, streaming: false },
  } as unknown as TimelineEvent;
}
const events = (count: number): TimelineEvent[] => Array.from({ length: count }, (_, i) => message(i));

/** rAF callbacks are only run when the test says so, so no assertion can lean on "a later frame". */
let queuedFrames: FrameRequestCallback[] = [];
function flushFrames(): void {
  const run = queuedFrames;
  queuedFrames = [];
  act(() => { for (const cb of run) cb(performance.now()); });
}

/** jsdom has no layout. Geometry lives on the prototype so it is in place BEFORE
 * the first render (the virtualizer reads the viewport height at mount) and rows
 * measure at exactly the virtualizer's own estimate (no spurious re-measure). */
const geometry = { scrollTop: 0, scrollHeight: 1200, clientHeight: 200, aboveShift: 0, spacerBase: 0 };
const isChatView = (el: Element): boolean => el.classList.contains('chat-view') && !el.classList.contains('chat-view-preview');
/** Change of the virtual list's top offset since the test recorded its baseline. */
function topOffsetDelta(el: Element): number {
  const root = el.closest('.chat-view');
  const spacer = root?.querySelector(':scope > [aria-hidden="true"]') as HTMLElement | null;
  if (!spacer) return 0;
  const offset = (parseFloat(spacer.style.height) || 0) + (parseFloat(spacer.style.marginTop) || 0);
  return offset - geometry.spacerBase;
}
function recordTopOffsetBaseline(scrollEl: HTMLElement): void {
  const spacer = scrollEl.querySelector(':scope > [aria-hidden="true"]') as HTMLElement | null;
  geometry.spacerBase = spacer ? (parseFloat(spacer.style.height) || 0) + (parseFloat(spacer.style.marginTop) || 0) : 0;
}
function installGeometry(): void {
  geometry.scrollTop = 0; geometry.scrollHeight = 1200; geometry.clientHeight = 200; geometry.aboveShift = 0; geometry.spacerBase = 0;
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', { configurable: true, get(this: HTMLElement) { return isChatView(this) ? geometry.scrollTop : 0; }, set(this: HTMLElement, v: number) { if (isChatView(this)) geometry.scrollTop = v; } });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get(this: HTMLElement) { return isChatView(this) ? geometry.scrollHeight : 0; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get(this: HTMLElement) { return isChatView(this) ? geometry.clientHeight : 0; } });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const el = this as HTMLElement;
    // A detached element has no box: browsers report an all-zero rect for it.
    if (!el.isConnected) return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
    // Message rows: 100px tall, stacked, shifted by whatever mounted above them,
    // relative to the (fixed, top = 0) viewport.
    const eventId = el.getAttribute?.('data-event-id');
    if (eventId) {
      // The virtual list's top offset (spacer height + negative margin) is real DOM state the
      // code under test writes: a shift it absorbs there moves every row on screen, exactly as
      // it would in a browser.
      const top = Number(eventId.replace('evt-', '')) * 100 + geometry.aboveShift + topOffsetDelta(el) - geometry.scrollTop;
      return { x: 0, y: top, top, left: 0, right: 0, bottom: top + 100, width: 0, height: 100, toJSON: () => ({}) } as DOMRect;
    }
    if (el.dataset?.virtualKey) {
      // A virtual row wrapper sits where its (72px estimate) slot in the list is.
      const inner = el.querySelector?.('[data-event-id]')?.getAttribute('data-event-id');
      const index = inner ? Number(inner.replace('evt-', '')) : 0;
      const top = index * 72 + geometry.aboveShift + topOffsetDelta(el) - geometry.scrollTop;
      return { x: 0, y: top, top, left: 0, right: 0, bottom: top + 72, width: 0, height: 72, toJSON: () => ({}) } as DOMRect;
    }
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
  });
}

async function mountPinned(count: number) {
  const view = render(<ChatView events={events(count) as never} loading={false} hasOlderHistory={false} sessionId={SESSION} />);
  const scrollEl = view.container.querySelector('.chat-view') as HTMLDivElement;
  // Let the mount pin/settle work run and DRAIN its frames (never discard them:
  // ChatView keeps one single-flight pin frame, and dropping it would wedge it).
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  flushFrames();
  geometry.scrollTop = geometry.scrollHeight - geometry.clientHeight;
  fireEvent.scroll(scrollEl);
  flushFrames();
  recordTopOffsetBaseline(scrollEl);
  return { view, scrollEl, geometry };
}

describe('ChatView — scroll ownership across commits', () => {
  beforeEach(() => {
    queuedFrames = [];
    resizeCallbacks.clear();
    installGeometry();
    vi.stubGlobal('ResizeObserver', FakeResizeObserver as unknown as typeof ResizeObserver);
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver as unknown as typeof IntersectionObserver);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      queuedFrames.push(cb);
      return queuedFrames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    for (const prop of ['scrollTop', 'scrollHeight', 'clientHeight']) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('a pin queued for the next frame does not snap a reader back down after a wheel scroll-away', async () => {
    const { view, scrollEl, geometry } = await mountPinned(8);

    // A stream chunk arrives: the follow effect queues its pin for the next frame.
    geometry.scrollHeight = 1500;
    act(() => { view.rerender(<ChatView events={events(9) as never} loading={false} hasOlderHistory={false} sessionId={SESSION} />); });
    expect(queuedFrames.length).toBeGreaterThan(0);

    // ...and BEFORE that frame the user wheels up and lands 500px above the tail.
    fireEvent.wheel(scrollEl, { deltaY: -120 });
    geometry.scrollTop = 800;
    fireEvent.scroll(scrollEl);

    flushFrames();
    expect(geometry.scrollTop).toBe(800);
  });

  it('re-pins a pinned viewport in the commit phase, without waiting for a frame', async () => {
    const { view, geometry } = await mountPinned(30); // > 24 rows: virtualized list

    geometry.scrollHeight = 2000; // the streamed row made the range taller
    act(() => { view.rerender(<ChatView events={events(31) as never} loading={false} hasOlderHistory={false} sessionId={SESSION} />); });

    // No frame has run: the commit itself must have moved the viewport to the new bottom.
    expect(geometry.scrollTop).toBe(2000 - geometry.clientHeight);
  });

  it('does not re-pin a reader in the commit phase', async () => {
    const { view, scrollEl, geometry } = await mountPinned(30);

    fireEvent.wheel(scrollEl, { deltaY: -120 });
    geometry.scrollTop = 500;
    fireEvent.scroll(scrollEl);

    geometry.scrollHeight = 2000;
    act(() => { view.rerender(<ChatView events={events(31) as never} loading={false} hasOlderHistory={false} sessionId={SESSION} />); });
    flushFrames();
    expect(geometry.scrollTop).toBe(500);
  });

  it('re-pins local DOM growth (tool card expand) in the coalesced frame, only while following', async () => {
    const { scrollEl, geometry } = await mountPinned(8);

    geometry.scrollHeight = 1600;
    await act(async () => {
      const fold = document.createElement('div');
      fold.className = 'chat-tool-fold-body';
      scrollEl.appendChild(fold); // a DOM change no ChatView render owns
      await Promise.resolve();
    });
    flushFrames();
    expect(geometry.scrollTop).toBe(1600 - geometry.clientHeight);

    // A reader who scrolled away is left alone by the same kind of growth.
    fireEvent.wheel(scrollEl, { deltaY: -120 });
    geometry.scrollTop = 400;
    fireEvent.scroll(scrollEl);
    geometry.scrollHeight = 2100;
    await act(async () => {
      scrollEl.appendChild(document.createElement('div'));
      await Promise.resolve();
    });
    flushFrames();
    expect(geometry.scrollTop).toBe(400);
  });

  it("keeps a reader's row exactly where it was when a block mounts ABOVE it, without writing scrollTop (virtualized list)", async () => {
    const { scrollEl } = await mountPinned(30);

    // The reader scrolls up and reads around row 12 (its top sits a little
    // below the viewport top).
    geometry.scrollTop = 1180;
    fireEvent.wheel(scrollEl, { deltaY: -120 });
    fireEvent.scroll(scrollEl);
    recordTopOffsetBaseline(scrollEl);
    const before = (scrollEl.querySelector('[data-event-id="evt-12"]') as HTMLElement).getBoundingClientRect().top;

    // A 150px banner mounts above every row (tool-chooser / load-older / todo list):
    // every row moves down 150px while scrollTop stays put.
    geometry.aboveShift = 150;
    geometry.scrollHeight += 150;
    const scrollTopWrites: number[] = [];
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, v: number) {
      if (isChatView(this)) { scrollTopWrites.push(v); geometry.scrollTop = v; }
    });
    await act(async () => {
      scrollEl.insertBefore(document.createElement('div'), scrollEl.firstChild);
      await Promise.resolve();
    });
    flushFrames();
    spy.mockRestore();

    const after = (scrollEl.querySelector('[data-event-id="evt-12"]') as HTMLElement).getBoundingClientRect().top;
    expect(after).toBe(before); // the row did not move on screen...
    expect(scrollTopWrites).toEqual([]); // ...and nothing wrote scrollTop (a write would cancel iOS momentum)
    expect(geometry.scrollTop).toBe(1180);
  });

  it("falls back to a scrollTop write for a reader's row when the list is not virtualized", async () => {
    const { scrollEl } = await mountPinned(12);
    geometry.scrollTop = 500;
    fireEvent.wheel(scrollEl, { deltaY: -120 });
    fireEvent.scroll(scrollEl);
    const before = (scrollEl.querySelector('[data-event-id="evt-6"]') as HTMLElement).getBoundingClientRect().top;

    geometry.aboveShift = 150;
    geometry.scrollHeight += 150;
    await act(async () => {
      scrollEl.insertBefore(document.createElement('div'), scrollEl.firstChild);
      await Promise.resolve();
    });
    flushFrames();

    const after = (scrollEl.querySelector('[data-event-id="evt-6"]') as HTMLElement).getBoundingClientRect().top;
    expect(after).toBe(before);
    expect(geometry.scrollTop).toBe(500 + 150);
  });

  it('does not re-measure a row that was just unmounted as 1px (the ResizeObserver also reports removed rows)', async () => {
    const { scrollEl } = await mountPinned(60);
    const spacerHeights = () => [...scrollEl.querySelectorAll(':scope > [aria-hidden="true"]')].map((el) => parseFloat((el as HTMLElement).style.height) || 0);
    const bottomRows = [...scrollEl.querySelectorAll('[data-virtual-key]')] as HTMLElement[];
    expect(bottomRows.length).toBeGreaterThan(0);

    // The reader jumps far up: the rows at the bottom leave the mounted range.
    geometry.scrollTop = 300;
    fireEvent.wheel(scrollEl, { deltaY: -120 });
    fireEvent.scroll(scrollEl);
    flushFrames();
    const unmounted = bottomRows.filter((row) => !row.isConnected);
    expect(unmounted.length).toBeGreaterThan(0);
    const before = spacerHeights();

    // The browser now reports the removed rows (0x0). Their real height must survive.
    deliverResize(unmounted);
    flushFrames();
    expect(spacerHeights()).toEqual(before);
  });

  it('absorbs a shift bigger than the spacer as content above the scroll origin, and reconciles it with one write once idle', async () => {
    const { scrollEl } = await mountPinned(30);
    geometry.scrollTop = 1180;
    fireEvent.wheel(scrollEl, { deltaY: -120 });
    fireEvent.scroll(scrollEl);
    recordTopOffsetBaseline(scrollEl);
    const before = (scrollEl.querySelector('[data-event-id="evt-12"]') as HTMLElement).getBoundingClientRect().top;

    // A finger is down and momentum is running while a huge block mounts above.
    fireEvent.touchStart(scrollEl, { touches: [{ clientY: 100 }] });
    const writes: number[] = [];
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, v: number) {
      if (isChatView(this)) { writes.push(v); geometry.scrollTop = v; }
    });
    geometry.aboveShift = 5_000;
    geometry.scrollHeight += 5_000;
    await act(async () => {
      scrollEl.insertBefore(document.createElement('div'), scrollEl.firstChild);
      await Promise.resolve();
    });
    flushFrames();
    const spacer = scrollEl.querySelector(':scope > [aria-hidden="true"]') as HTMLElement;
    expect(parseFloat(spacer.style.marginTop)).toBeLessThan(0); // hidden above the origin, not written to scrollTop
    expect((scrollEl.querySelector('[data-event-id="evt-12"]') as HTMLElement).getBoundingClientRect().top).toBe(before);

    // Still touching: no reconcile, however long it takes.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(writes).toEqual([]);

    // Finger up and the scroller stays still: exactly one compensated write.
    fireEvent.touchEnd(scrollEl);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    spy.mockRestore();
    expect(writes).toHaveLength(1);
    expect(parseFloat(spacer.style.marginTop)).toBe(0);
    expect((scrollEl.querySelector('[data-event-id="evt-12"]') as HTMLElement).getBoundingClientRect().top).toBe(before);
  });

  it('a short upward drag inside the re-engage band does not re-engage follow mid-gesture', async () => {
    const { view, scrollEl } = await mountPinned(8);

    // The reader drags only ~50px up: still inside the bottom re-engage band.
    geometry.scrollTop = geometry.scrollHeight - geometry.clientHeight - 50;
    fireEvent.wheel(scrollEl, { deltaY: -50 });
    fireEvent.scroll(scrollEl);
    const readerTop = geometry.scrollTop;

    // The stream keeps producing rows; the pin must not snap the reader back down.
    geometry.scrollHeight = 1500;
    act(() => { view.rerender(<ChatView events={events(9) as never} loading={false} hasOlderHistory={false} sessionId={SESSION} />); });
    flushFrames();
    expect(geometry.scrollTop).toBe(readerTop);
  });

  it('re-pins in the commit that resizes the viewport (a banner mounting beside the list)', async () => {
    const { view } = await mountPinned(30);

    // Something mounts below the list in the same commit and steals 50px of viewport.
    geometry.clientHeight = 150;
    act(() => { view.rerender(<ChatView events={events(30) as never} loading={false} hasOlderHistory={false} sessionId={SESSION} />); });

    // No frame ran: the commit itself must already sit at the new bottom.
    expect(geometry.scrollTop).toBe(geometry.scrollHeight - 150);
  });

  it('does not move the viewport for a render that changed nothing visible', async () => {
    const { view } = await mountPinned(30);
    const before = geometry.scrollTop;

    // The pane is (artificially) a bit above the bottom while follow is engaged, and a
    // non-rendered update re-renders the list with identical rows and geometry.
    geometry.scrollTop = before - 40;
    act(() => { view.rerender(<ChatView events={events(30) as never} loading={false} hasOlderHistory={false} sessionId={SESSION} />); });
    expect(geometry.scrollTop).toBe(before - 40);
  });

  it('normalizes CSS zoom (1.25) in virtualized row measurement and reader-anchor restoration without looping', async () => {
    document.documentElement.style.setProperty('--imcodes-ui-zoom', '1.25');
    document.documentElement.style.setProperty('zoom', '1.25');
    const zoom = 1.25;

    // Re-install getBoundingClientRect scaling all coordinates/heights by active CSS zoom (1.25).
    vi.restoreAllMocks();
    vi.stubGlobal('ResizeObserver', FakeResizeObserver as unknown as typeof ResizeObserver);
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver as unknown as typeof IntersectionObserver);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      queuedFrames.push(cb);
      return queuedFrames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const el = this as HTMLElement;
      if (!el.isConnected) return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
      const eventId = el.getAttribute?.('data-event-id');
      if (eventId) {
        const cssTop = Number(eventId.replace('evt-', '')) * 100 + geometry.aboveShift + topOffsetDelta(el) - geometry.scrollTop;
        return { x: 0, y: cssTop * zoom, top: cssTop * zoom, left: 0, right: 0, bottom: (cssTop + 100) * zoom, width: 0, height: 100 * zoom, toJSON: () => ({}) } as DOMRect;
      }
      if (el.dataset?.virtualKey) {
        const inner = el.querySelector?.('[data-event-id]')?.getAttribute('data-event-id');
        const index = inner ? Number(inner.replace('evt-', '')) : 0;
        const cssTop = index * 72 + geometry.aboveShift + topOffsetDelta(el) - geometry.scrollTop;
        return { x: 0, y: cssTop * zoom, top: cssTop * zoom, left: 0, right: 0, bottom: (cssTop + 72) * zoom, width: 0, height: 72 * zoom, toJSON: () => ({}) } as DOMRect;
      }
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
    });

    try {
      const { scrollEl } = await mountPinned(30);
      geometry.scrollTop = 1180;
      fireEvent.wheel(scrollEl, { deltaY: -120 });
      fireEvent.scroll(scrollEl);
      recordTopOffsetBaseline(scrollEl);
      const beforeZoomedTop = (scrollEl.querySelector('[data-event-id="evt-12"]') as HTMLElement).getBoundingClientRect().top;

      // Mount a 120px CSS block above rows -> 150px zoomed shift; absorber must subtract 120 (not 150) and converge cleanly.
      geometry.aboveShift = 120;
      geometry.scrollHeight += 120;
      await act(async () => {
        scrollEl.insertBefore(document.createElement('div'), scrollEl.firstChild);
        await Promise.resolve();
      });
      flushFrames();

      const afterZoomedTop = (scrollEl.querySelector('[data-event-id="evt-12"]') as HTMLElement).getBoundingClientRect().top;
      expect(topOffsetDelta(scrollEl.querySelector('[data-event-id="evt-12"]')!)).toBe(-120);
      expect(afterZoomedTop).toBe(beforeZoomedTop);
      expect(queuedFrames).toHaveLength(0);
    } finally {
      document.documentElement.style.removeProperty('--imcodes-ui-zoom');
      document.documentElement.style.removeProperty('zoom');
    }
  });

  it('bounds un-converging restoreReaderAnchor passes and ignores virtual spacer mutations', async () => {
    // Override getBoundingClientRect WITHOUT topOffsetDelta so patchTopSpacer never moves evt-12.
    vi.restoreAllMocks();
    vi.stubGlobal('ResizeObserver', FakeResizeObserver as unknown as typeof ResizeObserver);
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver as unknown as typeof IntersectionObserver);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      queuedFrames.push(cb);
      return queuedFrames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const el = this as HTMLElement;
      if (!el.isConnected) return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
      const eventId = el.getAttribute?.('data-event-id');
      if (eventId) {
        const top = Number(eventId.replace('evt-', '')) * 100 + geometry.aboveShift - geometry.scrollTop;
        return { x: 0, y: top, top, left: 0, right: 0, bottom: top + 100, width: 0, height: 100, toJSON: () => ({}) } as DOMRect;
      }
      if (el.dataset?.virtualKey) {
        const inner = el.querySelector?.('[data-event-id]')?.getAttribute('data-event-id');
        const index = inner ? Number(inner.replace('evt-', '')) : 0;
        const top = index * 72 + geometry.aboveShift - geometry.scrollTop;
        return { x: 0, y: top, top, left: 0, right: 0, bottom: top + 72, width: 0, height: 72, toJSON: () => ({}) } as DOMRect;
      }
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
    });

    const { view, scrollEl } = await mountPinned(30);
    geometry.scrollTop = 1180;
    fireEvent.wheel(scrollEl, { deltaY: -120 });
    fireEvent.scroll(scrollEl);

    // Mutate virtual spacer directly -> must be ignored (0 rAF scheduled).
    const spacer = scrollEl.querySelector('[data-virtual-spacer="true"]') as HTMLElement;
    expect(spacer).toBeTruthy();
    queuedFrames = [];
    await act(async () => {
      spacer.classList.add('spacer-touch');
      await Promise.resolve();
    });
    expect(queuedFrames).toHaveLength(0);

    // Trigger un-converging layout shift + multiple rapid DOM mutations -> coalesced to 1 rAF & bounded passes.
    geometry.aboveShift = 150;
    geometry.scrollHeight += 150;
    await act(async () => {
      scrollEl.insertBefore(document.createElement('div'), scrollEl.firstChild);
      scrollEl.insertBefore(document.createElement('div'), scrollEl.firstChild);
      scrollEl.insertBefore(document.createElement('div'), scrollEl.firstChild);
      await Promise.resolve();
    });
    expect(queuedFrames).toHaveLength(1);
    flushFrames();
    expect(queuedFrames).toHaveLength(0);

    // Unrelated events reference update with identical items does not re-ignite an unbounded loop.
    act(() => {
      view.rerender(<ChatView events={events(30) as never} loading={false} hasOlderHistory={false} sessionId={SESSION} />);
    });
    expect(queuedFrames).toHaveLength(0);
  });

  it('starts from the bottom slice when crossing into virtualization (> 24 items) after chunked cold hydration', async () => {
    const onLoadOlder = vi.fn();
    const view = render(
      <ChatView
        events={[] as never}
        loading
        hasOlderHistory
        onLoadOlder={onLoadOlder}
        serverId="srv-idle"
        sessionId={SESSION}
      />,
    );
    const scrollEl = view.container.querySelector('.chat-view') as HTMLDivElement;

    // Chunk 1 (10 items): still unvirtualized, layout establishes viewportRef > 0 while scrollTop starts at 0.
    geometry.scrollHeight = 720;
    act(() => {
      view.rerender(
        <ChatView
          events={events(10) as never}
          loading={false}
          hasOlderHistory
          onLoadOlder={onLoadOlder}
          serverId="srv-idle"
          sessionId={SESSION}
        />,
      );
    });
    // Spurious browser/layout scroll at 0 during initial settle must not disengage or trigger Load Older.
    geometry.scrollTop = 0;
    fireEvent.scroll(scrollEl);

    // Chunk 2 (30 items): crosses > 24 virtual threshold; first virtualized render must mount bottom slice, not top.
    geometry.scrollHeight = 2160;
    act(() => {
      view.rerender(
        <ChatView
          events={events(30) as never}
          loading={false}
          hasOlderHistory
          onLoadOlder={onLoadOlder}
          serverId="srv-idle"
          sessionId={SESSION}
        />,
      );
    });
    flushFrames();

    expect(scrollEl.querySelector('[data-event-id="evt-29"]')).not.toBeNull();
    expect(scrollEl.querySelector('[data-event-id="evt-0"]')).toBeNull();
    expect(geometry.scrollTop).toBeGreaterThanOrEqual(2160 - geometry.clientHeight);
    expect(onLoadOlder).not.toHaveBeenCalled();
    expect(view.container.querySelector('.chat-scroll-btn')).toBeNull();
  });

  it('preserves real upward wheel scroll immediately after mount without snapping back', async () => {
    const view = render(
      <ChatView events={events(12) as never} loading={false} hasOlderHistory={false} sessionId={SESSION} />,
    );
    const scrollEl = view.container.querySelector('.chat-view') as HTMLDivElement;

    // User scrolls up immediately before initial mount frames flush.
    fireEvent.wheel(scrollEl, { deltaY: -120 });
    geometry.scrollTop = 500;
    fireEvent.scroll(scrollEl);
    flushFrames();

    expect(geometry.scrollTop).toBe(500);
    expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();
  });

  it('pins pre-seeded initial mount to the bottom synchronously before any rAF runs', () => {
    geometry.scrollHeight = 1400;
    const view = render(
      <ChatView
        events={events(15) as never}
        loading={false}
        hasOlderHistory={false}
        serverId="srv-preseeded-short"
        sessionId={SESSION}
      />,
    );
    // Do NOT flush rAFs: initial mount commit itself must have pinned scrollTop before paint.
    expect(geometry.scrollTop).toBe(1400 - geometry.clientHeight);
    view.unmount();

    geometry.scrollTop = 0;
    geometry.scrollHeight = 2160;
    const virtualView = render(
      <ChatView
        events={events(30) as never}
        loading={false}
        hasOlderHistory={false}
        serverId="srv-preseeded-virtual"
        sessionId={SESSION}
      />,
    );
    const scrollEl = virtualView.container.querySelector('.chat-view') as HTMLDivElement;
    // Still before any rAF runs: synchronous commit must sit at bottom with tail mounted.
    expect(geometry.scrollTop).toBe(2160 - geometry.clientHeight);
    expect(scrollEl.querySelector('[data-event-id="evt-29"]')).not.toBeNull();
    expect(scrollEl.querySelector('[data-event-id="evt-0"]')).toBeNull();
  });

  it('re-pins to bottom when visible transitions false -> true and keeps onScrollBottomFn live after mounting hidden', async () => {
    let scrollBottomFn: (() => void) | null = null;
    geometry.scrollHeight = 2160;
    geometry.scrollTop = 2160 - geometry.clientHeight;
    const view = render(
      <ChatView
        events={events(30) as never}
        loading={false}
        hasOlderHistory={false}
        sessionId={SESSION}
        visible={false}
        onScrollBottomFn={(fn) => { scrollBottomFn = fn; }}
      />,
    );

    // Simulate user scrolling up while visible, then hiding (switching window/tab away)
    act(() => {
      view.rerender(
        <ChatView
          events={events(30) as never}
          loading={false}
          hasOlderHistory={false}
          sessionId={SESSION}
          visible={true}
          onScrollBottomFn={(fn) => { scrollBottomFn = fn; }}
        />,
      );
    });
    const scrollEl = view.container.querySelector('.chat-view') as HTMLDivElement;
    geometry.scrollTop = 400;
    fireEvent.wheel(scrollEl, { deltaY: -120 });
    fireEvent.scroll(scrollEl);
    expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();

    // Hide the pane (visible=false)
    act(() => {
      view.rerender(
        <ChatView
          events={events(30) as never}
          loading={false}
          hasOlderHistory={false}
          sessionId={SESSION}
          visible={false}
          onScrollBottomFn={(fn) => { scrollBottomFn = fn; }}
        />,
      );
    });

    // Switch back to the pane (visible: false -> true): must re-engage bottom follow & pin synchronously
    geometry.scrollHeight = 2300;
    act(() => {
      view.rerender(
        <ChatView
          events={events(31) as never}
          loading={false}
          hasOlderHistory={false}
          sessionId={SESSION}
          visible={true}
          onScrollBottomFn={(fn) => { scrollBottomFn = fn; }}
        />,
      );
    });
    expect(geometry.scrollTop).toBeGreaterThanOrEqual(2300 - geometry.clientHeight);
    expect(view.container.querySelector('.chat-scroll-btn')).toBeNull();

    // Verify manual scroll-up while remaining visible=true stays unfollowed on incoming chunks
    geometry.scrollTop = 500;
    fireEvent.wheel(scrollEl, { deltaY: -120 });
    fireEvent.scroll(scrollEl);
    geometry.scrollHeight = 2400;
    act(() => {
      view.rerender(
        <ChatView
          events={events(32) as never}
          loading={false}
          hasOlderHistory={false}
          sessionId={SESSION}
          visible={true}
          onScrollBottomFn={(fn) => { scrollBottomFn = fn; }}
        />,
      );
    });
    flushFrames();
    expect(geometry.scrollTop).toBe(500);
    expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();

    // Calling the captured onScrollBottomFn after visible false->true->true must still work (no stale visible=false closure)
    act(() => {
      scrollBottomFn?.();
    });
    flushFrames();
    expect(geometry.scrollTop).toBeGreaterThanOrEqual(2400 - geometry.clientHeight);
    expect(view.container.querySelector('.chat-scroll-btn')).toBeNull();
  });

  it('honors onScrollBottomFn called while visible=false once visible transitions to true and keeps autoScroll engaged', async () => {
    let scrollBottomFn: (() => void) | null = null;
    geometry.scrollHeight = 2160;
    geometry.scrollTop = 2160 - geometry.clientHeight;
    const view = render(
      <ChatView
        events={events(30) as never}
        loading={false}
        hasOlderHistory={false}
        sessionId={SESSION}
        visible={true}
        onScrollBottomFn={(fn) => { scrollBottomFn = fn; }}
      />,
    );
    flushFrames();
    const scrollEl = view.container.querySelector('.chat-view') as HTMLDivElement;

    // User scrolls up (disengages autoScroll), then pane becomes hidden (visible=false).
    geometry.scrollTop = 320;
    fireEvent.wheel(scrollEl, { deltaY: -120 });
    fireEvent.scroll(scrollEl);
    expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();

    act(() => {
      view.rerender(
        <ChatView
          events={events(30) as never}
          loading={false}
          hasOlderHistory={false}
          sessionId={SESSION}
          visible={false}
          onScrollBottomFn={(fn) => { scrollBottomFn = fn; }}
        />,
      );
    });

    // Background update while hidden must not snap scrollTop to bottom while still visible=false.
    geometry.scrollHeight = 2240;
    act(() => {
      view.rerender(
        <ChatView
          events={events(31) as never}
          loading={false}
          hasOlderHistory={false}
          sessionId={SESSION}
          visible={false}
          onScrollBottomFn={(fn) => { scrollBottomFn = fn; }}
        />,
      );
    });
    flushFrames();
    expect(geometry.scrollTop).toBe(320);

    // Shortcut switch invokes onScrollBottomFn BEFORE Preact commits visible=true.
    act(() => {
      scrollBottomFn?.();
    });
    flushFrames();
    // Still hidden, so DOM scrollTop hasn't jumped yet, but the scroll button is cleared.
    expect(view.container.querySelector('.chat-scroll-btn')).toBeNull();

    // Now visible transitions false -> true: pending scroll-to-bottom must fire and re-engage follow.
    act(() => {
      view.rerender(
        <ChatView
          events={events(31) as never}
          loading={false}
          hasOlderHistory={false}
          sessionId={SESSION}
          visible={true}
          onScrollBottomFn={(fn) => { scrollBottomFn = fn; }}
        />,
      );
    });
    flushFrames();
    expect(geometry.scrollTop).toBeGreaterThanOrEqual(2240 - geometry.clientHeight);
    expect(view.container.querySelector('.chat-scroll-btn')).toBeNull();

    // Subsequent incoming events continue to auto-follow bottom.
    geometry.scrollHeight = 2360;
    act(() => {
      view.rerender(
        <ChatView
          events={events(32) as never}
          loading={false}
          hasOlderHistory={false}
          sessionId={SESSION}
          visible={true}
          onScrollBottomFn={(fn) => { scrollBottomFn = fn; }}
        />,
      );
    });
    flushFrames();
    expect(geometry.scrollTop).toBeGreaterThanOrEqual(2360 - geometry.clientHeight);
  });

  it('pins to bottom after async hydration from empty state across virtualization boundary and pre-pin scroll growth, while still honoring user scroll-up', async () => {
    let scrollBottomFn: (() => void) | null = null;
    geometry.scrollHeight = 200;
    geometry.scrollTop = 0;

    // 1) Mount on a newly switched server/session while events are still empty.
    const view = render(
      <ChatView
        events={[] as never}
        loading={false}
        hasOlderHistory={false}
        serverId="srv-switch-a"
        sessionId={SESSION}
        visible={true}
        onScrollBottomFn={(fn) => { scrollBottomFn = fn; }}
      />,
    );
    // Parent triggers onScrollBottomFn on mount before timeline data hydrates.
    act(() => {
      scrollBottomFn?.();
    });
    flushFrames();
    expect(geometry.scrollTop).toBe(200);

    // 2) Cache snapshot arrives first (<= 24 items, unvirtualized), growing scrollTop > 0.
    geometry.scrollHeight = 600;
    act(() => {
      view.rerender(
        <ChatView
          events={events(6) as never}
          loading={false}
          hasOlderHistory={false}
          serverId="srv-switch-b"
          sessionId={SESSION}
          visible={true}
          onScrollBottomFn={(fn) => { scrollBottomFn = fn; }}
        />,
      );
    });
    // Parent server switch calls onScrollBottomFn while session scope is still hydrating.
    act(() => {
      scrollBottomFn?.();
    });
    const scrollEl = view.container.querySelector('.chat-view') as HTMLDivElement;

    // Simulate a late native scroll event fired before the next frame pins the expanded container.
    geometry.scrollHeight = 2600;
    geometry.scrollTop = 0;
    fireEvent.scroll(scrollEl);
    flushFrames();

    // 3) Full history hydrates asynchronously (> 24 items -> virtualizer activates).
    geometry.scrollHeight = 3200;
    act(() => {
      view.rerender(
        <ChatView
          events={events(36) as never}
          loading={false}
          hasOlderHistory={false}
          serverId="srv-switch-b"
          sessionId={SESSION}
          visible={true}
          onScrollBottomFn={(fn) => { scrollBottomFn = fn; }}
        />,
      );
    });
    flushFrames();

    expect(geometry.scrollTop).toBeGreaterThanOrEqual(3200 - geometry.clientHeight);
    expect(view.container.querySelector('.chat-scroll-btn')).toBeNull();
    // Tail event must be mounted by the virtualizer (not stuck near top item evt-0).
    expect(scrollEl.querySelector('[data-event-id="evt-35"]')).not.toBeNull();

    // 4) Explicit user wheel scroll-up after hydration disengages follow and is never overridden.
    geometry.scrollTop = 300;
    fireEvent.wheel(scrollEl, { deltaY: -120 });
    fireEvent.scroll(scrollEl);
    expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();

    geometry.scrollHeight = 3400;
    act(() => {
      view.rerender(
        <ChatView
          events={events(38) as never}
          loading={false}
          hasOlderHistory={false}
          serverId="srv-switch-b"
          sessionId={SESSION}
          visible={true}
          onScrollBottomFn={(fn) => { scrollBottomFn = fn; }}
        />,
      );
    });
    flushFrames();
    expect(geometry.scrollTop).toBe(300);
  });

  it('restarts the post-hydration settle window when content arrives >1500ms after empty mount', async () => {
    vi.useFakeTimers();
    try {
      geometry.scrollHeight = 200;
      geometry.scrollTop = 0;
      const view = render(
        <ChatView
          events={[] as never}
          loading={false}
          hasOlderHistory={false}
          serverId="srv-slow"
          sessionId={SESSION}
          visible={true}
        />,
      );
      flushFrames();

      // Slow network: 2000ms elapses before events arrive (past initial 1500ms mount window).
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      geometry.scrollHeight = 1400;
      act(() => {
        view.rerender(
          <ChatView
            events={events(14) as never}
            loading={false}
            hasOlderHistory={false}
            serverId="srv-slow"
            sessionId={SESSION}
            visible={true}
          />,
        );
      });
      flushFrames();
      expect(geometry.scrollTop).toBeGreaterThanOrEqual(1400 - geometry.clientHeight);

      // Post-hydration layout growth (e.g. "Load older" banner / todo list / code block expanding)
      // lands 300ms after hydration under unchanged events -> settle timer still re-pins to bottom.
      geometry.scrollHeight = 1680;
      await act(async () => {
        vi.advanceTimersByTime(160);
      });
      flushFrames();
      expect(geometry.scrollTop).toBeGreaterThanOrEqual(1680 - geometry.clientHeight);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-pins synchronously on two-stage short->long hydration >1500ms after switch even if browser fires scrollTop=0', async () => {
    vi.useFakeTimers();
    try {
      // Simulate real browser clamping: writing scrollTop = scrollHeight when scrollHeight <= clientHeight yields scrollTop = 0.
      Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
        configurable: true,
        get(this: HTMLElement) { return isChatView(this) ? geometry.scrollTop : 0; },
        set(this: HTMLElement, v: number) {
          if (isChatView(this)) {
            geometry.scrollTop = Math.max(0, Math.min(v, geometry.scrollHeight - geometry.clientHeight));
          }
        },
      });
      // Stage 1: short pre-overflow snippet renders first (scrollHeight <= clientHeight -> scrollTop=0, hasInitialPinCompletedRef=true).
      geometry.scrollHeight = 200;
      geometry.clientHeight = 200;
      geometry.scrollTop = 0;
      const view = render(
        <ChatView
          events={events(1) as never}
          loading={false}
          hasOlderHistory={false}
          serverId="srv-two-stage"
          sessionId={SESSION}
          visible={true}
        />,
      );
      flushFrames();
      expect(geometry.scrollTop).toBe(0);

      // Slow remote server: >1500ms passes (past suppressLoadOlder 1200ms window) before full history arrives.
      await act(async () => {
        vi.advanceTimersByTime(1600);
      });

      const scrollEl = view.container.querySelector('.chat-view') as HTMLDivElement;
      geometry.scrollHeight = 4000;
      act(() => {
        view.rerender(
          <ChatView
            events={events(60) as never}
            loading={false}
            hasOlderHistory={false}
            serverId="srv-two-stage"
            sessionId={SESSION}
            visible={true}
          />,
        );
      });
      // Synchronous pre-paint pin must already move scrollTop to bottom before any frame runs.
      expect(geometry.scrollTop).toBeGreaterThanOrEqual(4000 - geometry.clientHeight);

      // Even if a stale browser scroll event at scrollTop=0 arrives without user intent, follow must recover to bottom.
      geometry.scrollTop = 0;
      fireEvent.scroll(scrollEl);
      flushFrames();
      expect(geometry.scrollTop).toBeGreaterThanOrEqual(4000 - geometry.clientHeight);
      expect(view.container.querySelector('.chat-scroll-btn')).toBeNull();
      expect(scrollEl.querySelector('[data-event-id="evt-59"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-pins to bottom when events clear to empty at scrollTop=0 and repopulate >1500ms later', async () => {
    vi.useFakeTimers();
    try {
      geometry.scrollHeight = 2200;
      geometry.clientHeight = 200;
      const view = render(
        <ChatView
          events={events(30) as never}
          loading={false}
          hasOlderHistory={false}
          serverId="srv-clear-repop"
          sessionId={SESSION}
          visible={true}
        />,
      );
      flushFrames();
      const scrollEl = view.container.querySelector('.chat-view') as HTMLDivElement;
      expect(geometry.scrollTop).toBeGreaterThanOrEqual(2200 - geometry.clientHeight);

      // Browser clears the chat DOM (events -> [], scrollHeight collapses and scrollTop clamps to 0).
      geometry.scrollHeight = 200;
      geometry.scrollTop = 0;
      act(() => {
        view.rerender(
          <ChatView
            events={[] as never}
            loading={true}
            hasOlderHistory={false}
            serverId="srv-clear-repop"
            sessionId={SESSION}
            visible={true}
          />,
        );
      });
      fireEvent.scroll(scrollEl);
      flushFrames();

      // Advance >1500ms past suppressLoadOlder window before repopulating.
      await act(async () => {
        vi.advanceTimersByTime(1600);
      });

      geometry.scrollHeight = 4200;
      act(() => {
        view.rerender(
          <ChatView
            events={events(60) as never}
            loading={false}
            hasOlderHistory={false}
            serverId="srv-clear-repop"
            sessionId={SESSION}
            visible={true}
          />,
        );
      });
      // Stale scroll event at scrollTop=0 must not lock the chat at the top.
      geometry.scrollTop = 0;
      fireEvent.scroll(scrollEl);
      flushFrames();

      expect(geometry.scrollTop).toBeGreaterThanOrEqual(4200 - geometry.clientHeight);
      expect(view.container.querySelector('.chat-scroll-btn')).toBeNull();
      expect(scrollEl.querySelector('[data-event-id="evt-59"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never locks VirtualizedViewItems viewportAnchor to row 0 during onScroll/ResizeObserver while following', async () => {
    const { view, scrollEl } = await mountPinned(30);

    // Browser resets scrollTop to 0 and delivers scroll + ResizeObserver on row 0 while follow is still engaged.
    geometry.scrollTop = 0;
    fireEvent.scroll(scrollEl);
    const firstVirtualNode = scrollEl.querySelector('[data-virtual-key]') as HTMLElement | null;
    if (firstVirtualNode) deliverResize([firstVirtualNode]);
    flushFrames();

    // Virtualizer must keep tail items rendered and re-pin to bottom on the next commit/frame.
    geometry.scrollHeight = 2400;
    act(() => {
      view.rerender(
        <ChatView
          events={events(32) as never}
          loading={false}
          hasOlderHistory={false}
          sessionId={SESSION}
          visible={true}
        />,
      );
    });
    flushFrames();

    expect(geometry.scrollTop).toBeGreaterThanOrEqual(2400 - geometry.clientHeight);
    expect(view.container.querySelector('.chat-scroll-btn')).toBeNull();
    expect(scrollEl.querySelector('[data-event-id="evt-31"]')).not.toBeNull();
  });

  it('still disengages follow on genuine user scroll-up via scrollbar pointerdown, keyboard Home/PageUp, touch swipe, and wheel', async () => {
    const { view, scrollEl } = await mountPinned(30);

    // 1) Keyboard Home / PageUp -> scrollTop=0 must disengage follow and stay at top.
    fireEvent.keyDown(scrollEl, { key: 'Home' });
    geometry.scrollTop = 0;
    fireEvent.scroll(scrollEl);
    flushFrames();
    expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();
    geometry.scrollHeight = 2200;
    act(() => {
      view.rerender(<ChatView events={events(31) as never} loading={false} hasOlderHistory={false} sessionId={SESSION} visible={true} />);
    });
    flushFrames();
    expect(geometry.scrollTop).toBe(0);

    // Re-engage via End key.
    fireEvent.keyDown(scrollEl, { key: 'End' });
    flushFrames();
    expect(geometry.scrollTop).toBe(2200);

    // 2) Scrollbar pointerdown -> drag to scrollTop=0 must disengage follow and stay at top.
    vi.spyOn(scrollEl, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 200, width: 300, height: 200, toJSON: () => ({}) } as DOMRect);
    fireEvent.pointerDown(scrollEl, { clientX: 295 });
    geometry.scrollTop = 0;
    fireEvent.scroll(scrollEl);
    flushFrames();
    expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();
    geometry.scrollHeight = 2300;
    act(() => {
      view.rerender(<ChatView events={events(32) as never} loading={false} hasOlderHistory={false} sessionId={SESSION} visible={true} />);
    });
    flushFrames();
    expect(geometry.scrollTop).toBe(0);

    // Re-engage via scroll button click.
    fireEvent.click(view.container.querySelector('.chat-scroll-btn') as HTMLButtonElement);
    flushFrames();
    expect(geometry.scrollTop).toBe(2300);

    // 3) Touch swipe down (> 6px) -> scroll up must disengage follow and stay at 400.
    fireEvent.touchStart(scrollEl, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(scrollEl, { touches: [{ clientY: 120 }] });
    geometry.scrollTop = 400;
    fireEvent.scroll(scrollEl);
    flushFrames();
    expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();
    geometry.scrollHeight = 2400;
    act(() => {
      view.rerender(<ChatView events={events(33) as never} loading={false} hasOlderHistory={false} sessionId={SESSION} visible={true} />);
    });
    flushFrames();
    expect(geometry.scrollTop).toBe(400);
  });

  it('pins to bottom without calling onLoadOlder across empty->loading->history and cached->full hydration >1500ms after switch', async () => {
    vi.useFakeTimers();
    try {
      const onLoadOlder = vi.fn();
      // 1) Empty -> loading -> hydrated history (>1500ms delay) with hasOlderHistory=true.
      geometry.scrollHeight = 200;
      geometry.clientHeight = 200;
      geometry.scrollTop = 0;
      const view = render(
        <ChatView
          events={[] as never}
          loading={true}
          hasOlderHistory={true}
          onLoadOlder={onLoadOlder}
          serverId="srv-empty-load"
          sessionId={SESSION}
          visible={true}
        />,
      );
      flushFrames();
      const scrollEl = view.container.querySelector('.chat-view') as HTMLDivElement;

      await act(async () => {
        vi.advanceTimersByTime(1700);
      });

      geometry.scrollHeight = 4000;
      act(() => {
        view.rerender(
          <ChatView
            events={events(60) as never}
            loading={false}
            hasOlderHistory={true}
            onLoadOlder={onLoadOlder}
            serverId="srv-empty-load"
            sessionId={SESSION}
            visible={true}
          />,
        );
      });
      expect(geometry.scrollTop).toBeGreaterThanOrEqual(4000 - geometry.clientHeight);
      // Spurious browser scrollTop=0 reset after >1500ms must NOT disengage or call onLoadOlder.
      geometry.scrollTop = 0;
      fireEvent.scroll(scrollEl);
      flushFrames();
      expect(geometry.scrollTop).toBeGreaterThanOrEqual(4000 - geometry.clientHeight);
      expect(scrollEl.querySelector('[data-event-id="evt-59"]')).not.toBeNull();
      expect(view.container.querySelector('.chat-scroll-btn')).toBeNull();
      expect(onLoadOlder).not.toHaveBeenCalled();

      // 2) Cached short scrollable history (loading=false, lastScrollTopRef > 0) -> >1500ms -> full history.
      geometry.scrollHeight = 500;
      geometry.scrollTop = 0;
      act(() => {
        view.rerender(
          <ChatView
            events={events(5) as never}
            loading={false}
            hasOlderHistory={true}
            onLoadOlder={onLoadOlder}
            serverId="srv-cached-then-full"
            sessionId={SESSION}
            visible={true}
          />,
        );
      });
      flushFrames();
      expect(geometry.scrollTop).toBe(500);

      await act(async () => {
        vi.advanceTimersByTime(1700);
      });

      geometry.scrollHeight = 4200;
      act(() => {
        view.rerender(
          <ChatView
            events={events(60) as never}
            loading={false}
            hasOlderHistory={true}
            onLoadOlder={onLoadOlder}
            serverId="srv-cached-then-full"
            sessionId={SESSION}
            visible={true}
          />,
        );
      });
      expect(geometry.scrollTop).toBeGreaterThanOrEqual(4200 - geometry.clientHeight);
      geometry.scrollTop = 0;
      fireEvent.scroll(scrollEl);
      flushFrames();
      expect(geometry.scrollTop).toBeGreaterThanOrEqual(4200 - geometry.clientHeight);
      expect(scrollEl.querySelector('[data-event-id="evt-59"]')).not.toBeNull();
      expect(view.container.querySelector('.chat-scroll-btn')).toBeNull();
      expect(onLoadOlder).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pins to bottom when switching serverId with same sessionId from scrolled-up state and still allows genuine user scroll-up', async () => {
    const onLoadOlder = vi.fn();
    geometry.scrollHeight = 2600;
    geometry.clientHeight = 200;
    const view = render(
      <ChatView
        events={events(40) as never}
        loading={false}
        hasOlderHistory={true}
        onLoadOlder={onLoadOlder}
        serverId="srv-same-session-a"
        sessionId={SESSION}
        visible={true}
      />,
    );
    flushFrames();
    const scrollEl = view.container.querySelector('.chat-view') as HTMLDivElement;
    expect(geometry.scrollTop).toBeGreaterThanOrEqual(2600 - geometry.clientHeight);

    // User genuinely scrolls up on Server A -> disengages follow.
    fireEvent.wheel(scrollEl, { deltaY: -120 });
    geometry.scrollTop = 600;
    fireEvent.scroll(scrollEl);
    flushFrames();
    expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();

    // Switch serverId while keeping identical sessionId -> must reset to bottom immediately.
    geometry.scrollHeight = 2800;
    geometry.scrollTop = 0;
    act(() => {
      view.rerender(
        <ChatView
          events={events(40) as never}
          loading={false}
          hasOlderHistory={true}
          onLoadOlder={onLoadOlder}
          serverId="srv-same-session-b"
          sessionId={SESSION}
          visible={true}
        />,
      );
    });
    flushFrames();

    expect(geometry.scrollTop).toBeGreaterThanOrEqual(2800 - geometry.clientHeight);
    expect(scrollEl.querySelector('[data-event-id="evt-39"]')).not.toBeNull();
    expect(view.container.querySelector('.chat-scroll-btn')).toBeNull();
    expect(onLoadOlder).not.toHaveBeenCalled();

    // After server switch, genuine user scroll-up still disengages cleanly without snapping back.
    fireEvent.wheel(scrollEl, { deltaY: -120 });
    geometry.scrollTop = 500;
    fireEvent.scroll(scrollEl);
    flushFrames();
    expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();

    geometry.scrollHeight = 3000;
    act(() => {
      view.rerender(
        <ChatView
          events={events(41) as never}
          loading={false}
          hasOlderHistory={true}
          onLoadOlder={onLoadOlder}
          serverId="srv-same-session-b"
          sessionId={SESSION}
          visible={true}
        />,
      );
    });
    flushFrames();
    expect(geometry.scrollTop).toBe(500);

    // Genuine user scroll near top (< 100) still triggers onLoadOlder after disengaging.
    fireEvent.wheel(scrollEl, { deltaY: -120 });
    geometry.scrollTop = 40;
    fireEvent.scroll(scrollEl);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('still disengages follow and allows onLoadOlder on slow scrollbar pointer drag lasting >400ms', async () => {
    vi.useFakeTimers();
    try {
      const onLoadOlder = vi.fn();
      geometry.scrollHeight = 2400;
      geometry.clientHeight = 200;
      const view = render(
        <ChatView
          events={events(40) as never}
          loading={false}
          hasOlderHistory={true}
          onLoadOlder={onLoadOlder}
          serverId="srv-slow-drag"
          sessionId={SESSION}
          visible={true}
        />,
      );
      flushFrames();
      const scrollEl = view.container.querySelector('.chat-view') as HTMLDivElement;
      expect(geometry.scrollTop).toBeGreaterThanOrEqual(2400 - geometry.clientHeight);

      vi.spyOn(scrollEl, 'getBoundingClientRect').mockReturnValue({
        x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 200, width: 300, height: 200, toJSON: () => ({}),
      } as DOMRect);
      fireEvent.pointerDown(scrollEl, { clientX: 295 });

      // Slow scrollbar thumb drag takes longer than CHAT_USER_SCROLL_UP_HOLD_MS (400ms).
      await act(async () => {
        vi.advanceTimersByTime(650);
      });

      geometry.scrollTop = 400;
      fireEvent.scroll(scrollEl);
      flushFrames();

      expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();
      expect(geometry.scrollTop).toBe(400);
      expect(onLoadOlder).not.toHaveBeenCalled();

      // Releasing pointer after the drag leaves follow disengaged across new updates.
      fireEvent.pointerUp(window);
      geometry.scrollHeight = 2600;
      act(() => {
        view.rerender(
          <ChatView
            events={events(41) as never}
            loading={false}
            hasOlderHistory={true}
            onLoadOlder={onLoadOlder}
            serverId="srv-slow-drag"
            sessionId={SESSION}
            visible={true}
          />,
        );
      });
      flushFrames();
      expect(geometry.scrollTop).toBe(400);

      // Slow scrollbar drag (>400ms) all the way into <100px zone stays at 40 and triggers onLoadOlder.
      fireEvent.pointerDown(scrollEl, { clientX: 295 });
      await act(async () => {
        vi.advanceTimersByTime(650);
      });
      geometry.scrollTop = 40;
      fireEvent.scroll(scrollEl);
      flushFrames();
      fireEvent.pointerUp(window);

      expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();
      expect(geometry.scrollTop).toBe(40);
      expect(onLoadOlder).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prevents row-height inflation and upward scroll jump on WebKit unzoomed-rect engines at 75% and 85% UI zoom', async () => {
    vi.useFakeTimers();
    try {
      for (const pct of [75, 85]) {
        const z = pct / 100;
        applyUiScale(pct);
        vi.restoreAllMocks();
        vi.stubGlobal('ResizeObserver', FakeResizeObserver as unknown as typeof ResizeObserver);
        vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver as unknown as typeof IntersectionObserver);
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
          queuedFrames.push(cb);
          return queuedFrames.length;
        });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

        // Mock WebKit behavior under CSS zoom: DOM offsetHeight and getBoundingClientRect().height
        // BOTH report unzoomed CSS layout pixels (scale = 1, even though html.style.zoom = z).
        geometry.scrollTop = 0;
        geometry.scrollHeight = 4000;
        geometry.clientHeight = 200;
        geometry.aboveShift = 0;
        geometry.spacerBase = 0;
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
          configurable: true,
          get(this: HTMLElement) { return isChatView(this) ? 200 : (this.dataset?.virtualKey ? 100 : 0); },
        });
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
          configurable: true,
          get(this: HTMLElement) { return isChatView(this) ? 360 : 0; },
        });
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
          const el = this as HTMLElement;
          if (!el.isConnected) return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
          if (isChatView(el)) {
            return { x: 0, y: 0, top: 0, left: 0, right: 360, bottom: 200, width: 360, height: 200, toJSON: () => ({}) } as DOMRect;
          }
          const eventId = el.getAttribute?.('data-event-id');
          if (eventId) {
            const top = Number(eventId.replace('evt-', '')) * 100 + geometry.aboveShift + topOffsetDelta(el) - geometry.scrollTop;
            return { x: 0, y: top, top, left: 0, right: 360, bottom: top + 100, width: 360, height: 100, toJSON: () => ({}) } as DOMRect;
          }
          if (el.dataset?.virtualKey) {
            const inner = el.querySelector?.('[data-event-id]')?.getAttribute('data-event-id');
            const index = inner ? Number(inner.replace('evt-', '')) : 0;
            const top = index * 100 + geometry.aboveShift + topOffsetDelta(el) - geometry.scrollTop;
            return { x: 0, y: top, top, left: 0, right: 360, bottom: top + 100, width: 360, height: 100, toJSON: () => ({}) } as DOMRect;
          }
          return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
        });

        const view = render(<ChatView events={events(40) as never} loading={false} hasOlderHistory={false} sessionId={`${SESSION}-wk-${pct}`} visible={true} />);
        await act(async () => { vi.advanceTimersByTime(40); });
        flushFrames();
        const scrollEl = view.container.querySelector('.chat-view') as HTMLDivElement;

        // Disengage follow and scroll up to mid-history (evt-18 in view)
        geometry.scrollTop = 1800;
        fireEvent.wheel(scrollEl, { deltaY: -120 });
        fireEvent.scroll(scrollEl);
        flushFrames();
        recordTopOffsetBaseline(scrollEl);

        // Scroll further up by 300px with ZERO layout change: old code computed phantom delta = (1/z - 1)*300
        // and inflated row heights to ceil(100/z), triggering biasRef shifts + reconcileIdle upward snap!
        geometry.scrollTop = 1500;
        fireEvent.wheel(scrollEl, { deltaY: -120 });
        fireEvent.scroll(scrollEl);
        flushFrames();
        await act(async () => { vi.advanceTimersByTime(220); });
        flushFrames();

        expect(topOffsetDelta(scrollEl.querySelector('[data-event-id]')!)).toBe(0);
        expect(geometry.scrollTop).toBe(1500);

        // Now simulate a genuine 80px block above rows: must absorb exact -80 (not -80/z).
        expect(z).toBeLessThan(1);
        recordTopOffsetBaseline(scrollEl);
        geometry.aboveShift = 80;
        geometry.scrollHeight += 80;
        await act(async () => {
          scrollEl.insertBefore(document.createElement('div'), scrollEl.firstChild);
          await Promise.resolve();
        });
        flushFrames();
        expect(topOffsetDelta(scrollEl.querySelector('[data-event-id="evt-15"]')!)).toBe(-80);
        expect(geometry.scrollTop).toBe(1500);

        cleanup();
      }
    } finally {
      applyUiScale(100);
      delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
      delete (HTMLElement.prototype as { offsetWidth?: unknown }).offsetWidth;
      vi.useRealTimers();
    }
  });

  it('continues dividing by zoom on Chromium zoomed-rect engines at 75% and 85% UI zoom', async () => {
    vi.useFakeTimers();
    try {
      for (const pct of [75, 85]) {
        const z = pct / 100;
        applyUiScale(pct);
        vi.restoreAllMocks();
        vi.stubGlobal('ResizeObserver', FakeResizeObserver as unknown as typeof ResizeObserver);
        vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver as unknown as typeof IntersectionObserver);
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
          queuedFrames.push(cb);
          return queuedFrames.length;
        });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

        geometry.scrollTop = 0;
        geometry.scrollHeight = 4000;
        geometry.clientHeight = 200;
        geometry.aboveShift = 0;
        geometry.spacerBase = 0;
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
          configurable: true,
          get(this: HTMLElement) { return isChatView(this) ? 200 : (this.dataset?.virtualKey ? 100 : 0); },
        });
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
          configurable: true,
          get(this: HTMLElement) { return isChatView(this) ? 360 : 0; },
        });
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
          const el = this as HTMLElement;
          if (!el.isConnected) return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
          if (isChatView(el)) {
            return { x: 0, y: 0, top: 0, left: 0, right: 360 * z, bottom: 200 * z, width: 360 * z, height: 200 * z, toJSON: () => ({}) } as DOMRect;
          }
          const eventId = el.getAttribute?.('data-event-id');
          if (eventId) {
            const top = Number(eventId.replace('evt-', '')) * 100 + geometry.aboveShift + topOffsetDelta(el) - geometry.scrollTop;
            return { x: 0, y: top * z, top: top * z, left: 0, right: 360 * z, bottom: (top + 100) * z, width: 360 * z, height: 100 * z, toJSON: () => ({}) } as DOMRect;
          }
          if (el.dataset?.virtualKey) {
            const inner = el.querySelector?.('[data-event-id]')?.getAttribute('data-event-id');
            const index = inner ? Number(inner.replace('evt-', '')) : 0;
            const top = index * 100 + geometry.aboveShift + topOffsetDelta(el) - geometry.scrollTop;
            return { x: 0, y: top * z, top: top * z, left: 0, right: 360 * z, bottom: (top + 100) * z, width: 360 * z, height: 100 * z, toJSON: () => ({}) } as DOMRect;
          }
          return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
        });

        const view = render(<ChatView events={events(40) as never} loading={false} hasOlderHistory={false} sessionId={`${SESSION}-cr-${pct}`} visible={true} />);
        await act(async () => { vi.advanceTimersByTime(40); });
        flushFrames();
        const scrollEl = view.container.querySelector('.chat-view') as HTMLDivElement;

        // Disengage follow and scroll up to mid-history
        geometry.scrollTop = 1800;
        fireEvent.wheel(scrollEl, { deltaY: -120 });
        fireEvent.scroll(scrollEl);
        flushFrames();
        recordTopOffsetBaseline(scrollEl);

        geometry.scrollTop = 1500;
        fireEvent.wheel(scrollEl, { deltaY: -120 });
        fireEvent.scroll(scrollEl);
        flushFrames();
        await act(async () => { vi.advanceTimersByTime(220); });
        flushFrames();

        expect(topOffsetDelta(scrollEl.querySelector('[data-event-id]')!)).toBe(0);
        expect(geometry.scrollTop).toBe(1500);

        // Shift by 80px CSS (80*z zoomed DOMRect) -> must absorb exact -80 CSS px (not -80/z)
        recordTopOffsetBaseline(scrollEl);
        geometry.aboveShift = 80;
        geometry.scrollHeight += 80;
        await act(async () => {
          scrollEl.insertBefore(document.createElement('div'), scrollEl.firstChild);
          await Promise.resolve();
        });
        flushFrames();

        expect(topOffsetDelta(scrollEl.querySelector('[data-event-id="evt-15"]')!)).toBe(-80);
        expect(geometry.scrollTop).toBe(1500);

        cleanup();
      }
    } finally {
      applyUiScale(100);
      delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
      delete (HTMLElement.prototype as { offsetWidth?: unknown }).offsetWidth;
      vi.useRealTimers();
    }
  });

  it('marks reconcileIdle scrollTop writes as programmatic, scales scrollbar hit-testing under zoom, and resets cached row heights on live UI_SCALE_EVENT', async () => {
    vi.useFakeTimers();
    try {
      applyUiScale(100);
      geometry.scrollHeight = 4000;
      geometry.clientHeight = 200;
      const view = render(<ChatView events={events(40) as never} loading={false} hasOlderHistory={false} sessionId={`${SESSION}-reconcile-scale`} visible={true} />);
      await act(async () => { vi.advanceTimersByTime(40); });
      flushFrames();
      const scrollEl = view.container.querySelector('.chat-view') as HTMLDivElement;

      // Force biasRef < 0 via a shift larger than the top spacer while touching, then release and let reconcileIdle write scrollTop.
      // Simulate a synchronous browser scroll event inside the scrollTop setter to verify onProgrammaticScrollRef is active before the write.
      geometry.scrollTop = 300;
      fireEvent.wheel(scrollEl, { deltaY: -100 });
      fireEvent.scroll(scrollEl);
      flushFrames();
      recordTopOffsetBaseline(scrollEl);

      fireEvent.touchStart(scrollEl, { touches: [{ clientY: 100 }] });
      geometry.aboveShift = 5000;
      geometry.scrollHeight += 5000;
      await act(async () => {
        scrollEl.insertBefore(document.createElement('div'), scrollEl.firstChild);
        await Promise.resolve();
      });
      flushFrames();
      fireEvent.touchEnd(scrollEl);

      const writes: number[] = [];
      const spy = vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, v: number) {
        if (isChatView(this)) {
          writes.push(v);
          geometry.scrollTop = v;
          fireEvent.scroll(scrollEl);
        }
      });
      await act(async () => { vi.advanceTimersByTime(220); });
      flushFrames();
      spy.mockRestore();
      expect(writes.length).toBeGreaterThanOrEqual(1);
      expect(geometry.scrollTop).toBe(5300);

      // Live UI_SCALE_EVENT invalidates cached heights & adjusts markPointerScrollbarIntent threshold under Chromium zoom
      applyUiScale(75);
      Object.defineProperty(scrollEl, 'offsetWidth', { configurable: true, value: 400 });
      Object.defineProperty(scrollEl, 'offsetHeight', { configurable: true, value: 200 });
      Object.defineProperty(scrollEl, 'clientWidth', { configurable: true, value: 390 });
      vi.spyOn(scrollEl, 'getBoundingClientRect').mockReturnValue({
        x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 150, width: 300, height: 150, toJSON: () => ({}),
      } as DOMRect);

      // Let programmatic-scroll suppression window from reconcileIdle expire before user-like scroll to bottom
      await act(async () => { vi.advanceTimersByTime(300); });
      // Re-engage bottom follow
      geometry.scrollTop = geometry.scrollHeight - geometry.clientHeight;
      fireEvent.scroll(scrollEl);
      flushFrames();

      // At 75% Chromium zoom, visual clientWidth = 390 * 0.75 = 292.5px.
      // Click inside chat at clientX = 250 must NOT mark scrollbar intent (staying pinned at bottom).
      fireEvent.pointerDown(scrollEl, { clientX: 250 });
      fireEvent.pointerUp(window);

      await act(async () => {
        window.dispatchEvent(new CustomEvent(UI_SCALE_EVENT, { detail: { scale: 75 } }));
        await Promise.resolve();
      });
      flushFrames();
      expect(view.container.querySelector('.chat-scroll-btn')).toBeNull();
    } finally {
      applyUiScale(100);
      vi.useRealTimers();
    }
  });

  it('does not read scroll root offsetHeight or offsetWidth during commitMeasuredRows at 100% UI scale', async () => {
    applyUiScale(100);
    const { view, scrollEl } = await mountPinned(40);
    const offsetHeightSpy = vi.fn(() => 200);
    const offsetWidthSpy = vi.fn(() => 360);
    Object.defineProperty(scrollEl, 'offsetHeight', { configurable: true, get: offsetHeightSpy });
    Object.defineProperty(scrollEl, 'offsetWidth', { configurable: true, get: offsetWidthSpy });

    const mountedRows = [...scrollEl.querySelectorAll<HTMLElement>('[data-virtual-key]')];
    expect(mountedRows.length).toBeGreaterThan(0);

    // Trigger both commitMeasuredRows via render commit and ResizeObserver batch at 100% zoom
    geometry.scrollHeight = 4100;
    act(() => {
      view.rerender(<ChatView events={events(41) as never} loading={false} hasOlderHistory={false} sessionId={SESSION} />);
    });
    deliverResize(mountedRows);
    flushFrames();

    expect(offsetHeightSpy).not.toHaveBeenCalled();
    expect(offsetWidthSpy).not.toHaveBeenCalled();
  });

  it('does not snap bottom overscroll or fight same-touch upward direction reversal after pulling to bottom', async () => {
    const { view, scrollEl } = await mountPinned(30);
    const writes: number[] = [];
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, v: number) {
      if (isChatView(this)) {
        writes.push(v);
        geometry.scrollTop = v;
      }
    });

    try {
      // 1) iOS rubber-band overscroll at bottom while touching: pure scroll frames must never write scrollTop back to 1000.
      geometry.scrollTop = 1040;
      fireEvent.touchStart(scrollEl, { touches: [{ clientY: 500 }] });
      fireEvent.touchMove(scrollEl, { touches: [{ clientY: 250 }] });
      fireEvent.scroll(scrollEl);
      flushFrames();
      expect(writes).toEqual([]);
      expect(geometry.scrollTop).toBe(1040);

      // 2) Same-touch reversal: without lifting finger, user pulls down (+20px from touchMinY=250) -> immediately disengages follow!
      fireEvent.touchMove(scrollEl, { touches: [{ clientY: 270 }] });
      expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();
      geometry.scrollTop = 960;
      fireEvent.scroll(scrollEl);
      flushFrames();
      expect(writes).toEqual([]);
      expect(geometry.scrollTop).toBe(960);
      expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('never re-engages auto-follow in handleScroll while scrolling upward inside reengageThreshold after hold expiry', async () => {
    const { view, scrollEl } = await mountPinned(30);
    vi.useFakeTimers();
    try {
      geometry.scrollTop = 980;
      fireEvent.wheel(scrollEl, { deltaY: -40 });
      fireEvent.scroll(scrollEl);
      expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();

      // Advance past CHAT_USER_SCROLL_UP_HOLD_MS (400ms) while continuing to scroll upward inside reengageThreshold (60px)
      await act(async () => { vi.advanceTimersByTime(500); });
      geometry.scrollTop = 955; // moving UP (955 < 980) even though distance=45 < 60
      fireEvent.scroll(scrollEl);
      expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();

      // Scrolling back DOWN inside reengageThreshold (975 > 955) cleanly re-engages follow
      geometry.scrollTop = 975;
      fireEvent.scroll(scrollEl);
      expect(view.container.querySelector('.chat-scroll-btn')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not pin when appending a 31st row while touching at bottom, and resumes follow once touch ends', async () => {
    const { view, scrollEl } = await mountPinned(30);
    geometry.scrollTop = 980;
    fireEvent.scroll(scrollEl);
    flushFrames();
    expect(view.container.querySelector('.chat-scroll-btn')).toBeNull();

    const writes: number[] = [];
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, v: number) {
      if (isChatView(this)) {
        writes.push(v);
        geometry.scrollTop = v;
      }
    });

    try {
      // Touch down at bottom without pulling up, then append row 31 (1200 -> 1340).
      fireEvent.touchStart(scrollEl, { touches: [{ clientY: 500 }] });
      geometry.scrollHeight = 1340;
      act(() => {
        view.rerender(<ChatView events={events(31) as never} loading={false} hasOlderHistory={false} sessionId={SESSION} />);
      });
      flushFrames();
      expect(writes).toEqual([]);
      expect(geometry.scrollTop).toBe(980);

      // Positive control: releasing the finger without upward scroll resumes auto-follow to the new bottom.
      fireEvent.touchEnd(scrollEl, { touches: [] });
      flushFrames();
      expect(writes.length).toBeGreaterThanOrEqual(1);
      expect(geometry.scrollTop).toBeGreaterThanOrEqual(1340 - geometry.clientHeight);
    } finally {
      spy.mockRestore();
    }
  });

  it('never invokes onMeasuredLayout on pure scroll commits for followers or readers', () => {
    expect(__VirtualizedViewItemsForTests).toBeTypeOf('function');
    let following = true;
    const onMeasuredLayout = vi.fn();
    const root = document.createElement('div');
    root.className = 'chat-view';
    const content = document.createElement('div');
    root.appendChild(content);
    document.body.appendChild(root);
    const scrollRef = { current: root };
    const items = Array.from({ length: 30 }, (_, i) => ({
      key: `item-${i}`,
      type: 'event' as const,
      event: events(30)[i],
    }));

    try {
      geometry.clientHeight = 200;
      geometry.scrollHeight = 1200;
      geometry.scrollTop = 1000;
      act(() => {
        render(
          <__VirtualizedViewItemsForTests
            items={items as never}
            scrollRef={scrollRef}
            enabled={true}
            onMeasuredLayout={onMeasuredLayout}
            resetKey={SESSION}
            isFollowing={() => following}
            renderItem={(item) => <div data-event-id={item.key}>{item.key}</div>}
          />,
          { container: content },
        );
      });
      flushFrames();
      expect(content.querySelectorAll('[data-virtual-key]').length).toBeGreaterThan(0);
      onMeasuredLayout.mockClear();

      // Pure scroll tick while following: must NOT invoke onMeasuredLayout.
      geometry.scrollTop = 990;
      fireEvent.scroll(root);
      flushFrames();
      expect(onMeasuredLayout).not.toHaveBeenCalled();

      // Pure scroll tick while reading (not following): must NOT invoke onMeasuredLayout either.
      following = false;
      geometry.scrollTop = 600;
      fireEvent.scroll(root);
      flushFrames();
      expect(onMeasuredLayout).not.toHaveBeenCalled();
    } finally {
      root.remove();
    }
  });

  it('does not overwrite scrollTop on two-frame transientTopJump recovery when touch starts between frames, and recovers when untouched', async () => {
    const first = await mountPinned(30);
    const writes: number[] = [];
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, v: number) {
      if (isChatView(this)) {
        writes.push(v);
        geometry.scrollTop = v;
      }
    });

    try {
      // Frame 1: transientTopJump schedules follow recovery frame.
      geometry.scrollTop = 0;
      fireEvent.scroll(first.scrollEl);
      flushFrames();
      expect(writes).toEqual([]);

      // User starts touching and dragging before Frame 2 runs.
      fireEvent.touchStart(first.scrollEl, { touches: [{ clientY: 300 }] });
      fireEvent.touchMove(first.scrollEl, { touches: [{ clientY: 285 }] });
      geometry.scrollTop = 30;
      flushFrames();
      expect(writes).toEqual([]);
      expect(geometry.scrollTop).toBe(30);
    } finally {
      spy.mockRestore();
      cleanup();
    }

    // Positive control: without touch, two-frame transientTopJump recovery restores bottom cleanly.
    const second = await mountPinned(30);
    const controlWrites: number[] = [];
    const controlSpy = vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, v: number) {
      if (isChatView(this)) {
        controlWrites.push(v);
        geometry.scrollTop = v;
      }
    });

    try {
      geometry.scrollTop = 0;
      fireEvent.scroll(second.scrollEl);
      flushFrames();
      flushFrames();
      expect(controlWrites.length).toBeGreaterThanOrEqual(1);
      expect(geometry.scrollTop).toBeGreaterThanOrEqual(geometry.scrollHeight - geometry.clientHeight);
    } finally {
      controlSpy.mockRestore();
    }
  });

  it('never re-engages auto-follow when scrollHeight shrinks to meet an upward scrollTop move after upward-hold expiry', async () => {
    const { view, scrollEl } = await mountPinned(30);

    // Reader disengages by scrolling up from bottom (max=1000 -> 980) and waits past CHAT_USER_SCROLL_UP_HOLD_MS (400ms).
    geometry.scrollTop = 980;
    fireEvent.wheel(scrollEl, { deltaY: -120 });
    fireEvent.scroll(scrollEl);
    expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });

    // Content shrinks (1200 -> 1155, new max=955) while reader simultaneously scrolls UP (980 -> 955).
    // Even though distance to the new bottom is 0, scrollTop moved UP (< lastScrollTopRef) -> MUST stay unfollowed.
    geometry.scrollHeight = 1155;
    geometry.scrollTop = 955;
    fireEvent.scroll(scrollEl);
    expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();

    // Subsequent streamed row must not snap the reader down.
    geometry.scrollHeight = 1235;
    act(() => {
      view.rerender(<ChatView events={events(31) as never} loading={false} hasOlderHistory={false} sessionId={SESSION} />);
    });
    flushFrames();
    expect(geometry.scrollTop).toBe(955);
    expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();
  });

  it('re-engages auto-follow immediately when scrolling back down to bottom within the 400ms upward-scroll hold window', async () => {
    const { view, scrollEl } = await mountPinned(30);

    // Pause follow via touch reversal upward inside reengageThreshold (distance = 40 > 2).
    fireEvent.touchStart(scrollEl, { touches: [{ clientY: 400 }] });
    fireEvent.touchMove(scrollEl, { touches: [{ clientY: 350 }] });
    fireEvent.touchMove(scrollEl, { touches: [{ clientY: 380 }] });
    geometry.scrollTop = 960;
    fireEvent.scroll(scrollEl);
    fireEvent.touchEnd(scrollEl, { touches: [] });
    expect(view.container.querySelector('.chat-scroll-btn')).not.toBeNull();

    // Within 400ms (at ~20ms), reader deliberately scrolls all the way back down to bottom (960 -> 1000).
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    geometry.scrollTop = 1000;
    fireEvent.scroll(scrollEl);
    expect(view.container.querySelector('.chat-scroll-btn')).toBeNull();

    // Subsequent streamed row follows to new bottom cleanly.
    geometry.scrollHeight = 1240;
    act(() => {
      view.rerender(<ChatView events={events(31) as never} loading={false} hasOlderHistory={false} sessionId={SESSION} />);
    });
    flushFrames();
    expect(geometry.scrollTop).toBeGreaterThanOrEqual(1240 - geometry.clientHeight);
  });
});
