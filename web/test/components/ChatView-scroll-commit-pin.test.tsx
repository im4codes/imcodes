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

import { ChatView } from '../../src/components/ChatView.js';
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

  it('re-pins local DOM growth (tool card expand) in a microtask, only while following', async () => {
    const { scrollEl, geometry } = await mountPinned(8);

    geometry.scrollHeight = 1600;
    await act(async () => {
      const fold = document.createElement('div');
      fold.className = 'chat-tool-fold-body';
      scrollEl.appendChild(fold); // a DOM change no ChatView render owns
      await Promise.resolve(); // MutationObserver callbacks are microtasks
    });
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
});
