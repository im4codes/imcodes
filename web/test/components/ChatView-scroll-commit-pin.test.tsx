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

class FakeResizeObserver {
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
const geometry = { scrollTop: 0, scrollHeight: 1200, clientHeight: 200, aboveShift: 0 };
const isChatView = (el: Element): boolean => el.classList.contains('chat-view') && !el.classList.contains('chat-view-preview');
function installGeometry(): void {
  geometry.scrollTop = 0; geometry.scrollHeight = 1200; geometry.clientHeight = 200; geometry.aboveShift = 0;
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', { configurable: true, get(this: HTMLElement) { return isChatView(this) ? geometry.scrollTop : 0; }, set(this: HTMLElement, v: number) { if (isChatView(this)) geometry.scrollTop = v; } });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get(this: HTMLElement) { return isChatView(this) ? geometry.scrollHeight : 0; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get(this: HTMLElement) { return isChatView(this) ? geometry.clientHeight : 0; } });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const el = this as HTMLElement;
    // Message rows: 100px tall, stacked, shifted by whatever mounted above them,
    // relative to the (fixed, top = 0) viewport.
    const eventId = el.getAttribute?.('data-event-id');
    if (eventId) {
      const top = Number(eventId.replace('evt-', '')) * 100 + geometry.aboveShift - geometry.scrollTop;
      return { x: 0, y: top, top, left: 0, right: 0, bottom: top + 100, width: 0, height: 100, toJSON: () => ({}) } as DOMRect;
    }
    const height = el.dataset?.virtualKey ? 72 : 0;
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height, toJSON: () => ({}) } as DOMRect;
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

  it("keeps a reader's row exactly where it was when a block mounts ABOVE it", async () => {
    const { scrollEl } = await mountPinned(30);

    // The reader scrolls up and reads around row 12 (its top sits a little
    // below the viewport top).
    geometry.scrollTop = 1180;
    fireEvent.wheel(scrollEl, { deltaY: -120 });
    fireEvent.scroll(scrollEl);
    const before = (scrollEl.querySelector('[data-event-id="evt-12"]') as HTMLElement).getBoundingClientRect().top;

    // A 150px banner mounts above every row (tool-chooser / load-older / todo list):
    // every row moves down 150px while scrollTop stays put.
    geometry.aboveShift = 150;
    geometry.scrollHeight += 150;
    await act(async () => {
      scrollEl.insertBefore(document.createElement('div'), scrollEl.firstChild);
      await Promise.resolve();
    });

    const after = (scrollEl.querySelector('[data-event-id="evt-12"]') as HTMLElement).getBoundingClientRect().top;
    expect(after).toBe(before); // the viewport followed the row: nothing moved on screen
    expect(geometry.scrollTop).toBe(1180 + 150);
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
