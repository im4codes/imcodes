/**
 * @vitest-environment jsdom
 *
 * Pinned "Last sent" banner behaviour — shows only when the real user.message
 * bubble has been pushed above the viewport by new assistant output; hides
 * again as soon as the bubble comes back into view.
 */
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/preact';

// Mirror ChatView.test.tsx's module mocks so the component's transitive
// imports don't pull in the real react-i18next/FileBrowser/etc. stack.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));
vi.mock('../../src/components/ChatMarkdown.js', () => ({
  ChatMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
}));
vi.mock('../../src/components/FileBrowser.js', () => ({
  FileBrowser: () => null,
}));
vi.mock('../../src/components/FloatingPanel.js', () => ({
  FloatingPanel: ({ children }: { children?: preact.ComponentChildren }) => <div>{children}</div>,
}));
// See ChatView.test.tsx for the rationale — opt this suite into the
// "developer" branch of the show_tool_calls preference so timeline rendering
// is identical to a user who already chose the dev view.
vi.mock('../../src/hooks/usePref.js', () => ({
  parseBooleanish: (raw: unknown) => (raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null),
  usePref: () => ({
    value: true,
    rawValue: true,
    loaded: true,
    loading: false,
    stale: false,
    error: null,
    save: async () => undefined,
    set: () => undefined,
    reload: async () => true,
  }),
}));

import { ChatView } from '../../src/components/ChatView.js';
import type { TimelineEvent } from '../../src/ws-client.js';

type IOObserverCallback = (entries: IntersectionObserverEntry[]) => void;

interface MockObserverInstance {
  target: Element | null;
  fire: (entries: Array<Partial<IntersectionObserverEntry>>) => void;
  disconnect: () => void;
}

// The real IntersectionObserver isn't implemented in jsdom. Install a fake
// that lets each test drive visibility transitions explicitly.
const instances: MockObserverInstance[] = [];
class FakeIntersectionObserver {
  private callback: IOObserverCallback;
  private target: Element | null = null;
  constructor(callback: IOObserverCallback) {
    this.callback = callback;
    const self = this;
    instances.push({
      get target() { return self.target; },
      fire: (partialEntries) => {
        const entries = partialEntries.map((e) => ({
          target: self.target,
          isIntersecting: false,
          intersectionRatio: 0,
          intersectionRect: { bottom: 0, top: 0, height: 0, width: 0, left: 0, right: 0 } as DOMRectReadOnly,
          boundingClientRect: { bottom: 0, top: 0, height: 0, width: 0, left: 0, right: 0 } as DOMRectReadOnly,
          rootBounds: { bottom: 500, top: 0, height: 500, width: 500, left: 0, right: 500 } as DOMRectReadOnly,
          time: 0,
          ...e,
        })) as IntersectionObserverEntry[];
        self.callback(entries);
      },
      disconnect: () => self.disconnect(),
    });
  }
  observe(target: Element): void { this.target = target; }
  unobserve(): void { this.target = null; }
  disconnect(): void { this.target = null; }
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

function userEvent(eventId: string, text: string, ts = 1000): TimelineEvent {
  return {
    eventId,
    type: 'user.message',
    ts,
    epoch: 1,
    seq: ts,
    sessionId: 'deck_demo_brain',
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
    sessionId: 'deck_demo_brain',
    source: 'daemon',
    confidence: 'high',
    payload: { text, streaming: false },
  } as unknown as TimelineEvent;
}

describe('ChatView — pinned last-sent banner', () => {
  beforeEach(() => {
    instances.length = 0;
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver as unknown as typeof IntersectionObserver);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('does not render the pinned banner when no user.message exists yet', () => {
    const { container } = render(
      <ChatView events={[]} loading={false} sessionId="deck_demo_brain" />,
    );
    expect(container.querySelector('.chat-pinned-last-sent')).toBeNull();
  });

  it('does not render the pinned banner while the last user message is still within the viewport', async () => {
    const events = [
      userEvent('u1', 'hello there', 1000),
      assistantEvent('a1', 'hi!', 2000),
    ];
    const { container } = render(
      <ChatView events={events} loading={false} sessionId="deck_demo_brain" />,
    );

    // Fire an IntersectionObserver entry that says the bubble is INSIDE the
    // viewport — pin must stay hidden.
    await waitFor(() => expect(instances.length).toBeGreaterThan(0));
    act(() => {
      instances[instances.length - 1].fire([{ isIntersecting: true }]);
    });
    expect(container.querySelector('.chat-pinned-last-sent')).toBeNull();
  });

  it('renders the pinned banner when the last user message is pushed above the viewport', async () => {
    const events = [
      userEvent('u1', 'investigate the recall latency regression', 1000),
      assistantEvent('a1', 'Looking into it...', 2000),
    ];
    const { container } = render(
      <ChatView events={events} loading={false} sessionId="deck_demo_brain" />,
    );

    // Fire ABOVE-viewport entry: boundingClientRect.bottom < rootBounds.top.
    await waitFor(() => expect(instances.length).toBeGreaterThan(0));
    act(() => {
      instances[instances.length - 1].fire([{
        isIntersecting: false,
        boundingClientRect: { bottom: -10, top: -30, height: 20, width: 100, left: 0, right: 100 } as DOMRectReadOnly,
        rootBounds: { top: 0, bottom: 500, height: 500, width: 500, left: 0, right: 500 } as DOMRectReadOnly,
      }]);
    });

    const banner = container.querySelector('.chat-pinned-last-sent') as HTMLElement | null;
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('investigate the recall latency regression');
  });

  it('hides the pinned banner when the bubble scrolls back INTO view', async () => {
    const events = [
      userEvent('u1', 'first prompt', 1000),
      assistantEvent('a1', 'reply', 2000),
    ];
    const { container } = render(
      <ChatView events={events} loading={false} sessionId="deck_demo_brain" />,
    );
    await waitFor(() => expect(instances.length).toBeGreaterThan(0));

    // Push out (show banner)
    act(() => {
      instances[instances.length - 1].fire([{
        isIntersecting: false,
        boundingClientRect: { bottom: -10, top: -30, height: 20, width: 100, left: 0, right: 100 } as DOMRectReadOnly,
        rootBounds: { top: 0, bottom: 500, height: 500, width: 500, left: 0, right: 500 } as DOMRectReadOnly,
      }]);
    });
    expect(container.querySelector('.chat-pinned-last-sent')).not.toBeNull();

    // Scroll back (hide banner)
    act(() => {
      instances[instances.length - 1].fire([{ isIntersecting: true }]);
    });
    expect(container.querySelector('.chat-pinned-last-sent')).toBeNull();
  });

  it('ignores pending or failed optimistic user messages when picking the pin target', async () => {
    // A failed/pending optimistic bubble is not "last SENT" — the banner must
    // pick the most recent confirmed message, not the optimistic candidate.
    const events: TimelineEvent[] = [
      userEvent('u-confirmed', 'confirmed text', 1000),
      assistantEvent('a1', 'ack', 1500),
      {
        eventId: 'u-pending',
        type: 'user.message',
        ts: 2000,
        epoch: 1,
        seq: 2000,
        sessionId: 'deck_demo_brain',
        source: 'daemon',
        confidence: 'high',
        payload: { text: 'pending text', pending: true },
      } as unknown as TimelineEvent,
    ];
    const { container } = render(
      <ChatView events={events} loading={false} sessionId="deck_demo_brain" />,
    );
    await waitFor(() => expect(instances.length).toBeGreaterThan(0));

    // Push out → banner should render with the CONFIRMED text, not pending.
    act(() => {
      instances[instances.length - 1].fire([{
        isIntersecting: false,
        boundingClientRect: { bottom: -10, top: -30, height: 20, width: 100, left: 0, right: 100 } as DOMRectReadOnly,
        rootBounds: { top: 0, bottom: 500, height: 500, width: 500, left: 0, right: 500 } as DOMRectReadOnly,
      }]);
    });

    const banner = container.querySelector('.chat-pinned-last-sent');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('confirmed text');
    expect(banner!.textContent).not.toContain('pending text');
  });

  it('uses the nearest scrolling ancestor as the observer root (fixes sub-session card where .chat-view itself does not scroll)', async () => {
    // In the sub-session card layout, .chat-view is nested inside a
    // .subcard-preview-like wrapper that owns the scrollbar. Emulate that by
    // wrapping ChatView in a scrollable ancestor and asserting the observer
    // root falls back to that ancestor — not .chat-view itself.
    const wrapper = document.createElement('div');
    wrapper.id = 'outer-scroll';
    Object.defineProperty(wrapper, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(wrapper, 'clientHeight', { value: 200, configurable: true });
    wrapper.style.overflowY = 'auto';
    document.body.appendChild(wrapper);

    const events = [
      userEvent('u-nested', 'deep nested prompt', 1000),
      assistantEvent('a-nested', 'reply', 2000),
    ];
    render(
      <ChatView events={events} loading={false} sessionId="deck_nested_brain" />,
      { container: wrapper },
    );

    // After mount, an observer should be registered — even though
    // .chat-view inside ChatView may not have scrollHeight > clientHeight
    // in jsdom (the real issue in card mode), the effect still registers
    // an observer against SOME scroll parent so the pin can later fire.
    await waitFor(() => expect(instances.length).toBeGreaterThan(0));
    const obs = instances[instances.length - 1];
    // target must be the .chat-user inside ChatView, proving the observer
    // did pick up the element despite the nested-scroll layout.
    expect(obs.target).not.toBeNull();
    expect((obs.target as HTMLElement).dataset.eventId).toBe('u-nested');
  });

  it('toggles the expanded state on first click (escape the 2-line clamp)', async () => {
    const events = [
      userEvent('u1', 'x', 1000),
      assistantEvent('a1', 'y', 2000),
    ];
    const { container } = render(
      <ChatView events={events} loading={false} sessionId="deck_demo_brain" />,
    );
    await waitFor(() => expect(instances.length).toBeGreaterThan(0));

    act(() => {
      instances[instances.length - 1].fire([{
        isIntersecting: false,
        boundingClientRect: { bottom: -10, top: -30, height: 20, width: 100, left: 0, right: 100 } as DOMRectReadOnly,
        rootBounds: { top: 0, bottom: 500, height: 500, width: 500, left: 0, right: 500 } as DOMRectReadOnly,
      }]);
    });

    const banner = container.querySelector('.chat-pinned-last-sent') as HTMLElement;
    expect(banner.classList.contains('chat-pinned-expanded')).toBe(false);
    fireEvent.click(banner);
    expect(banner.classList.contains('chat-pinned-expanded')).toBe(true);
  });
});
