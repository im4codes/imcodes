/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineEvent } from '../src/ws-client.js';
import {
  attachMobileNavigationGestures,
  MOBILE_LONG_PRESS_MS,
  type TouchPointSnapshot,
} from '../src/mobile-navigation-gestures.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key.split('.').pop() ?? key }),
}));
vi.mock('../src/components/FileBrowser.js', () => ({ FileBrowser: () => null }));
vi.mock('../src/api.js', () => ({ downloadAttachment: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/hooks/usePref.js', () => ({
  parseBooleanish: () => null,
  usePref: () => ({
    value: false,
    rawValue: false,
    loaded: true,
    loading: false,
    stale: false,
    error: null,
    save: async () => undefined,
    set: () => undefined,
    reload: async () => true,
  }),
}));

import { ChatView } from '../src/components/ChatView.js';

function makeCoarseMatchMedia(): typeof window.matchMedia {
  return ((query: string) => ({
    matches: query === '(pointer: coarse)',
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function dispatchTouch(
  target: EventTarget,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  touches: TouchPointSnapshot[],
  changedTouches: TouchPointSnapshot[] = [],
): Event {
  const evt = new Event(type, { bubbles: true, cancelable: true }) as Event & {
    touches: TouchPointSnapshot[];
    changedTouches: TouchPointSnapshot[];
  };
  Object.defineProperty(evt, 'touches', { configurable: true, value: touches });
  Object.defineProperty(evt, 'changedTouches', { configurable: true, value: changedTouches });
  target.dispatchEvent(evt);
  return evt;
}

function makeAssistantEvent(seq: number, text = `Hello from assistant ${seq}`): TimelineEvent {
  return {
    eventId: `evt-${seq}`,
    type: 'assistant.text',
    sessionId: 'sess-mobile',
    ts: 1000 + seq,
    epoch: 1,
    seq,
    source: 'daemon',
    confidence: 'high',
    payload: { text },
  } as TimelineEvent;
}

function makeScrollableChatView(container: HTMLElement): HTMLElement {
  const chatView = container.querySelector('.chat-view') as HTMLElement;
  expect(chatView).toBeTruthy();
  Object.defineProperty(chatView, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(chatView, 'clientHeight', { configurable: true, value: 400 });
  Object.defineProperty(chatView, 'scrollTop', { configurable: true, value: 600, writable: true });
  return chatView;
}

describe('ChatView mobile navigation gesture isolation', () => {
  const origMatchMedia = window.matchMedia;

  afterEach(() => {
    vi.useRealTimers();
    window.matchMedia = origMatchMedia;
    document.documentElement.className = '';
    cleanup();
  });

  it('ignores 2-finger touch on ChatView without triggering navigation', () => {
    vi.useFakeTimers();
    window.matchMedia = makeCoarseMatchMedia();
    const actions: string[] = [];
    const detach = attachMobileNavigationGestures({
      isMobile: true,
      onAction: (a) => actions.push(a),
    });

    const { container } = render(
      <ChatView events={[makeAssistantEvent(1), makeAssistantEvent(2)]} loading={false} sessionId="sess-mobile" />,
    );
    act(() => {});
    makeScrollableChatView(container);
    const bubble = container.querySelector('.chat-event') as HTMLElement;
    expect(bubble).toBeTruthy();

    act(() => {
      const startEvt = dispatchTouch(bubble, 'touchstart', [
        { identifier: 1, clientX: 120, clientY: 160, target: bubble },
        { identifier: 2, clientX: 180, clientY: 160, target: bubble },
      ]);
      expect(startEvt.defaultPrevented).toBe(false);

      const moveEvt = dispatchTouch(bubble, 'touchmove', [
        { identifier: 1, clientX: 120, clientY: 250, target: bubble },
        { identifier: 2, clientX: 180, clientY: 250, target: bubble },
      ]);
      expect(moveEvt.defaultPrevented).toBe(false);

      vi.advanceTimersByTime(500);
      dispatchTouch(bubble, 'touchend', []);
    });

    expect(actions).toEqual([]);
    detach();
  });

  it('clears ChatView long-press highlight/menu and prevents follow disengage on 1-finger long-press + drag', () => {
    vi.useFakeTimers();
    window.matchMedia = makeCoarseMatchMedia();
    const actions: string[] = [];
    const detach = attachMobileNavigationGestures({
      isMobile: true,
      onAction: (a) => actions.push(a),
    });

    const { container } = render(
      <ChatView events={[makeAssistantEvent(1)]} loading={false} sessionId="sess-mobile" />,
    );
    act(() => {});
    makeScrollableChatView(container);
    const bubble = container.querySelector('.chat-event') as HTMLElement;
    expect(bubble).toBeTruthy();

    act(() => {
      const s = dispatchTouch(bubble, 'touchstart', [{ identifier: 1, clientX: 140, clientY: 180, target: bubble }]);
      expect(s.defaultPrevented).toBe(false);
      // Advance past both 380ms gesture arm AND 400ms ChatView LONG_PRESS_MS
      vi.advanceTimersByTime(420);
    });
    expect(container.querySelector('.chat-highlight')).toBeTruthy();
    expect(container.querySelector('.chat-sel-menu')).toBeTruthy();

    // Sliding down after long-press engages nav gesture, clears menu/highlight, and suppresses scroll-up intent
    act(() => {
      const m = dispatchTouch(bubble, 'touchmove', [{ identifier: 1, clientX: 140, clientY: 260, target: bubble }]);
      expect(m.defaultPrevented).toBe(true);
    });
    expect(container.querySelector('.chat-highlight')).toBeNull();
    expect(container.querySelector('.chat-sel-menu')).toBeNull();
    expect(container.querySelector('.chat-scroll-btn')).toBeNull();

    act(() => {
      const e = dispatchTouch(bubble, 'touchend', []);
      expect(e.defaultPrevented).toBe(true);
    });
    expect(actions).toEqual(['serverNext']);
    expect(container.querySelector('.chat-scroll-btn')).toBeNull();

    detach();
  });

  it('preserves ChatView long-press menu without triggering navigation when held without swipe', () => {
    vi.useFakeTimers();
    window.matchMedia = makeCoarseMatchMedia();
    const actions: string[] = [];
    const detach = attachMobileNavigationGestures({
      isMobile: true,
      onAction: (a) => actions.push(a),
    });

    const { container } = render(
      <ChatView events={[makeAssistantEvent(1)]} loading={false} sessionId="sess-mobile" />,
    );
    act(() => {});
    makeScrollableChatView(container);
    const bubble = container.querySelector('.chat-event') as HTMLElement;

    act(() => {
      dispatchTouch(bubble, 'touchstart', [{ identifier: 1, clientX: 140, clientY: 180, target: bubble }]);
      vi.advanceTimersByTime(500);
      const endEvt = dispatchTouch(bubble, 'touchend', []);
      // ChatView's own cancelEvent eats the post-menu touchend once opened
      expect(endEvt.defaultPrevented).toBe(true);
    });

    expect(actions).toEqual([]);
    expect(container.querySelector('.chat-highlight')).toBeTruthy();
    expect(container.querySelector('.chat-sel-menu')).toBeTruthy();

    detach();
  });

  it('allows normal 1-finger immediate scroll-up intent without preventDefault or navigation', () => {
    vi.useFakeTimers();
    window.matchMedia = makeCoarseMatchMedia();
    const actions: string[] = [];
    const detach = attachMobileNavigationGestures({
      isMobile: true,
      onAction: (a) => actions.push(a),
    });

    const { container } = render(
      <ChatView events={[makeAssistantEvent(1), makeAssistantEvent(2)]} loading={false} sessionId="sess-mobile" />,
    );
    act(() => {});
    makeScrollableChatView(container);
    const bubble = container.querySelector('.chat-event') as HTMLElement;

    act(() => {
      const s = dispatchTouch(bubble, 'touchstart', [{ identifier: 1, clientX: 140, clientY: 150, target: bubble }]);
      vi.advanceTimersByTime(50);
      const m = dispatchTouch(bubble, 'touchmove', [{ identifier: 1, clientX: 140, clientY: 240, target: bubble }]);
      expect(s.defaultPrevented).toBe(false);
      expect(m.defaultPrevented).toBe(false);
      vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS + 100);
      const e = dispatchTouch(bubble, 'touchend', []);
      expect(e.defaultPrevented).toBe(false);
    });

    expect(actions).toEqual([]);
    expect(container.querySelector('.chat-scroll-btn')).toBeTruthy();

    detach();
  });
});
