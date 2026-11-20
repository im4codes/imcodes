/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SUBSESSION_BAR_MAX_EXPANDED_CARDS,
  SUBSESSION_CREATED_BATCH_MSG,
} from '@shared/scale-limits.js';

const { listSubSessionsMock } = vi.hoisted(() => ({
  listSubSessionsMock: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api.js')>();
  return {
    ...actual,
    listSubSessions: listSubSessionsMock,
    createSubSession: vi.fn(),
    patchSubSession: vi.fn().mockResolvedValue(undefined),
    downloadAttachment: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('../src/components/FileBrowser.js', () => ({ FileBrowser: () => null }));
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

import { WsClient, type ServerMessage } from '../src/ws-client.js';
import { useSubSessions } from '../src/hooks/useSubSessions.js';
import { SubSessionBar, selectPrioritizedExpandedSessions } from '../src/components/SubSessionBar.js';
import { ChatView } from '../src/components/ChatView.js';

describe('scale & desktop unlock recovery', () => {
  afterEach(() => {
    cleanup();
    for (const prop of ['clientHeight', 'scrollHeight', 'scrollTop']) {
      delete (HTMLElement.prototype as any)[prop];
    }
    delete (document as any).visibilityState;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    listSubSessionsMock.mockResolvedValue([]);
  });

  describe('WsClient desktop lock/focus stale-pong fast recovery', () => {
    class FakeSocket {
      static instances: FakeSocket[] = [];
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FakeSocket.OPEN;
      listeners = new Map<string, Array<(ev?: any) => void>>();
      send = vi.fn();
      close = vi.fn(() => {
        this.readyState = FakeSocket.CLOSED;
      });
      constructor(public url: string) {
        FakeSocket.instances.push(this);
      }
      addEventListener(type: string, fn: (ev?: any) => void) {
        const list = this.listeners.get(type) ?? [];
        list.push(fn);
        this.listeners.set(type, list);
      }
      removeEventListener(type: string, fn: (ev?: any) => void) {
        const list = this.listeners.get(type) ?? [];
        this.listeners.set(type, list.filter((x) => x !== fn));
      }
      emit(type: string, ev?: any) {
        for (const fn of this.listeners.get(type) ?? []) fn(ev);
      }
    }

    beforeEach(() => {
      FakeSocket.instances = [];
      vi.stubGlobal('WebSocket', FakeSocket);
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ticket: 't-desktop' }),
      })));
    });

    it('immediately reconnects dead TCP socket when desktop sleep leaves _lastPongAt > 60s stale on probeConnection', async () => {
      vi.useFakeTimers();
      const client = new WsClient('https://desk.local', 'srv-desk');
      client.connect();
      await vi.advanceTimersByTimeAsync(10);
      const sock1 = FakeSocket.instances[0]!;
      expect(sock1).toBeDefined();
      sock1.emit('open');
      sock1.emit('message', { data: JSON.stringify({ type: 'pong' }) });

      // Jump wall-clock time by 90s without firing timers (simulates desktop sleep/lock where timers freeze
      // and visibilitychange didn't fire; only focus -> probeConnection() fires on unlock).
      vi.setSystemTime(Date.now() + 90_000);
      const beforeReconnectCount = FakeSocket.instances.length;
      expect(beforeReconnectCount).toBe(1);
      client.probeConnection();
      await vi.advanceTimersByTimeAsync(20);

      expect(FakeSocket.instances.length).toBeGreaterThan(beforeReconnectCount);
      client.disconnect();
    });

    it('sends supportsCreatedBatch: true on subSessionRebuildAll', async () => {
      vi.useFakeTimers();
      const client = new WsClient('https://desk.local', 'srv-desk');
      client.connect();
      await vi.advanceTimersByTimeAsync(10);
      const sock = FakeSocket.instances[0]!;
      expect(sock).toBeDefined();
      sock.emit('open');
      sock.send.mockClear();

      client.subSessionRebuildAll([{ id: 's1', type: 'qwen' }]);
      expect(sock.send).toHaveBeenCalled();
      const frame = JSON.parse(sock.send.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(frame.type).toBe('subsession.rebuild_all');
      expect(frame.supportsCreatedBatch).toBe(true);
      client.disconnect();
    });
  });

  describe('useSubSessions batched ingestion & fallback', () => {
    it('applies subsession.created.batch in a single state pass while keeping single subsession.created compatible', async () => {
      const handlers = new Set<(m: ServerMessage) => void>();
      const mockWs = {
        subSessionRebuildAll: vi.fn(),
        onMessage: (fn: (m: ServerMessage) => void) => {
          handlers.add(fn);
          return () => handlers.delete(fn);
        },
      } as any;

      let state: ReturnType<typeof useSubSessions> | null = null;
      function Harness() {
        state = useSubSessions('srv1', mockWs, true, 'deck_demo_brain');
        return null;
      }
      render(<Harness />);
      await act(async () => {});

      const batchItems = Array.from({ length: 60 }, (_, i) => ({
        type: 'subsession.created' as const,
        id: `bat_${i}`,
        sessionName: `deck_sub_bat_${i}`,
        sessionType: 'qwen',
        parentSession: 'deck_demo_brain',
        state: 'idle',
      }));

      await act(async () => {
        for (const h of handlers) {
          h({ type: SUBSESSION_CREATED_BATCH_MSG, items: batchItems } as ServerMessage);
          h({
            type: 'subsession.created',
            id: 'single_1',
            sessionName: 'deck_sub_single_1',
            sessionType: 'shell',
            parentSession: 'deck_demo_brain',
            state: 'running',
          } as ServerMessage);
        }
      });

      expect(state!.subSessions).toHaveLength(61);
      expect(state!.visibleSubSessions).toHaveLength(61);
    });
  });

  describe('SubSessionBar expanded card budget & negative control', () => {
    function makeSub(i: number, state: 'idle' | 'running' | 'error' = 'idle') {
      return {
        id: `s_${i}`,
        serverId: 'srv1',
        type: 'qwen',
        runtimeType: 'transport' as const,
        providerId: 'qwen',
        providerSessionId: `p_${i}`,
        sessionName: `deck_sub_s_${i}`,
        label: `Worker ${i}`,
        parentSession: 'deck_demo_brain',
        state,
        createdAt: i,
        updatedAt: i,
      } as any;
    }

    it('keeps 100% of expanded items unchanged when count <= SUBSESSION_BAR_MAX_EXPANDED_CARDS (negative control)', () => {
      const subs = Array.from({ length: SUBSESSION_BAR_MAX_EXPANDED_CARDS }, (_, i) => makeSub(i));
      const { cardSessions, overflowSessions } = selectPrioritizedExpandedSessions(subs, new Set(['s_0']), 's_0');
      expect(cardSessions).toHaveLength(SUBSESSION_BAR_MAX_EXPANDED_CARDS);
      expect(overflowSessions).toHaveLength(0);
    });

    it('prioritizes open + active/error cards up to 24 and renders remaining items as clickable pills without losing sessions', () => {
      const subs = Array.from({ length: 60 }, (_, i) =>
        makeSub(i, i === 55 ? 'running' : i === 50 ? 'error' : 'idle'),
      );
      const { cardSessions, overflowSessions } = selectPrioritizedExpandedSessions(subs, new Set(['s_58']), null);
      expect(cardSessions).toHaveLength(SUBSESSION_BAR_MAX_EXPANDED_CARDS);
      expect(overflowSessions).toHaveLength(60 - SUBSESSION_BAR_MAX_EXPANDED_CARDS);
      expect(cardSessions.map((s) => s.id)).toContain('s_58');
      expect(cardSessions.map((s) => s.id)).toContain('s_55');
      expect(cardSessions.map((s) => s.id)).toContain('s_50');

      vi.useFakeTimers();
      const ws = {
        onMessage: () => () => {},
        subscribeTimelineSession: () => () => {},
        subscribeTransportSession: vi.fn(),
        unsubscribeTransportSession: vi.fn(),
        onDaemonCapabilitySnapshot: () => () => {},
        getDaemonCapabilitySnapshot: () => null,
        timelineReplayRequest: vi.fn(),
        timelineHistoryRequest: vi.fn(() => 'req-1'),
      } as any;
      render(
        <SubSessionBar
          subSessions={subs}
          openIds={new Set(['s_58'])}
          ws={ws}
          connected={true}
          serverId="srv1"
          quickClosePersistenceScope="deck_demo_brain"
          collapsed={false}
          onToggleOpen={vi.fn()}
          onNew={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onRestart={vi.fn()}
          onStop={vi.fn()}
          onSend={vi.fn()}
          onDiff={vi.fn()}
          onHistory={vi.fn()}
        />,
      );
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(document.querySelectorAll('.subcard')).toHaveLength(SUBSESSION_BAR_MAX_EXPANDED_CARDS);
      expect(document.querySelectorAll('.subsession-pill')).toHaveLength(60 - SUBSESSION_BAR_MAX_EXPANDED_CARDS);
    });
  });

  describe('Desktop ChatView VirtualChatList loop & ResizeObserver stability', () => {
    const isMainChatScroll = (el: HTMLElement) =>
      el.classList?.contains('chat-view') && !el.classList?.contains('chat-view-preview');

    function installVirtualScrollGeometry(getClientHeight: () => number, totalHeight = 3200) {
      let scrollTop = 0;
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get: () => getClientHeight(),
      });
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get(this: HTMLElement) { return isMainChatScroll(this) ? totalHeight : 0; },
      });
      Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
        configurable: true,
        get(this: HTMLElement) { return isMainChatScroll(this) ? scrollTop : 0; },
        set(this: HTMLElement, v: number) {
          if (!isMainChatScroll(this)) return;
          const maxTop = Math.max(0, totalHeight - getClientHeight());
          scrollTop = Math.max(0, Math.min(v, maxTop));
        },
      });
      return () => scrollTop;
    }

    function rowRect(vk: string, h: number, scrollTop: number): DOMRect {
      const idx = Number(vk.split('-').pop() ?? 0);
      const top = idx * 72 - scrollTop;
      return { top, bottom: top + h, height: h, left: 0, right: 400, width: 400, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    }

    it('bounds synchronous pre-paint layout oscillation to <= 3 passes and does not recreate ResizeObserver per layoutVersion', async () => {
      let observerConstructions = 0;
      class MockResizeObserver {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
        constructor(_cb: ResizeObserverCallback) {
          observerConstructions += 1;
        }
      }
      vi.stubGlobal('ResizeObserver', MockResizeObserver);

      // Force clientHeight > 0 & oscillating getBoundingClientRect() height to simulate
      // desktop DPI/zoom/scroll-range feedback that previously hung in useLayoutEffect.
      let measureFlip = 0;
      const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this?.dataset?.virtualKey) {
          measureFlip += 1;
          const h = 40 + (measureFlip % 2) * 18;
          return { top: 0, bottom: h, height: h, left: 0, right: 400, width: 400, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
        }
        return { top: 0, bottom: 600, height: 600, left: 0, right: 400, width: 400, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      });
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });

      const events = Array.from({ length: 40 }, (_, i) => ({
        eventId: `ev-${i}`,
        type: 'assistant.text',
        sessionId: 'desk-main',
        ts: 1000 + i,
        epoch: 1,
        seq: i + 1,
        source: 'daemon',
        confidence: 'high',
        payload: { text: `message ${i}` },
      })) as any[];

      const rafQueue: FrameRequestCallback[] = [];
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length;
      });
      vi.stubGlobal('cancelAnimationFrame', vi.fn());

      await act(async () => {
        render(<ChatView events={events} loading={false} sessionId="desk-main" visible={true} />);
      });

      const countAfterMount = observerConstructions;
      expect(countAfterMount).toBeGreaterThanOrEqual(1);
      expect(rafQueue.length).toBeGreaterThanOrEqual(1);
      const nextFrame = rafQueue.shift()!;
      await act(async () => {
        nextFrame(16);
      });

      // Synchronous layout passes stayed bounded instead of looping infinitely, and
      // ResizeObserver instances were never torn down and recreated across layoutVersion ticks.
      expect(measureFlip).toBeLessThan(40 * 12);
      expect(observerConstructions).toBe(countAfterMount);

      rectSpy.mockRestore();
      delete (HTMLElement.prototype as any).clientHeight;
    });

    it('stops cross-frame rAF retries under sustained row height oscillation and recovers on external item change', async () => {
      class MockResizeObserver {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      }
      vi.stubGlobal('ResizeObserver', MockResizeObserver);

      let currentClientHeight = 600;
      const getScrollTop = installVirtualScrollGeometry(() => currentClientHeight);
      const targetKey = 'ev-38';
      let targetFlip = false;
      const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const vk = this?.dataset?.virtualKey;
        if (vk) {
          if (vk === targetKey) {
            targetFlip = !targetFlip;
            return rowRect(vk, targetFlip ? 42 : 56, getScrollTop());
          }
          return rowRect(vk, 42, getScrollTop());
        }
        return { top: 0, bottom: currentClientHeight, height: currentClientHeight, left: 0, right: 400, width: 400, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      });

      const makeEvents = (count: number) => Array.from({ length: count }, (_, i) => ({
        eventId: `ev-${i}`,
        type: 'user.message',
        sessionId: 'desk-main',
        ts: 1000 + i,
        epoch: 1,
        seq: i + 1,
        source: 'daemon',
        confidence: 'high',
        payload: { text: `message ${i}` },
      })) as any[];

      const rafQueue: FrameRequestCallback[] = [];
      let totalRafScheduled = 0;
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        totalRafScheduled += 1;
        rafQueue.push(cb);
        return totalRafScheduled;
      });
      vi.stubGlobal('cancelAnimationFrame', vi.fn());

      const view = render(<ChatView events={makeEvents(40)} loading={false} sessionId="desk-main" visible={true} />);

      // Drain every rAF scheduled under perpetual row height oscillation.
      // Previously reset syncLayoutPassCountRef=0 in every rAF tick, spinning 60Hz forever.
      let ticks = 0;
      while (rafQueue.length > 0 && ticks < 20) {
        ticks += 1;
        const cb = rafQueue.shift()!;
        await act(async () => {
          cb(ticks * 16);
        });
      }
      expect(rafQueue.length).toBe(0);
      expect(totalRafScheduled).toBeLessThanOrEqual(5);
      const scheduledAfterOscillationStop = totalRafScheduled;

      // Once external events change, measurement budget replenishes cleanly.
      await act(async () => {
        view.rerender(<ChatView events={makeEvents(41)} loading={false} sessionId="desk-main" visible={true} />);
      });
      while (rafQueue.length > 0 && ticks < 40) {
        ticks += 1;
        const cb = rafQueue.shift()!;
        await act(async () => {
          cb(ticks * 16);
        });
      }
      expect(rafQueue.length).toBe(0);
      expect(totalRafScheduled).toBeGreaterThan(scheduledAfterOscillationStop);
      const scheduledAfterEventChange = totalRafScheduled;

      // Once viewport clientHeight changes, measurement budget also replenishes.
      currentClientHeight = 720;
      await act(async () => {
        view.rerender(<ChatView events={makeEvents(41)} loading={false} sessionId="desk-main" visible={true} />);
      });
      expect(totalRafScheduled).toBeGreaterThan(scheduledAfterEventChange);

      rectSpy.mockRestore();
      delete (HTMLElement.prototype as any).clientHeight;
      delete (HTMLElement.prototype as any).scrollHeight;
      delete (HTMLElement.prototype as any).scrollTop;
    });

    it('bounds active ResizeObserver oscillation after visibilitychange resume and replenishes on item/viewport changes', async () => {
      const observersByTarget = new Map<HTMLElement, { cb: ResizeObserverCallback; observer: ResizeObserver }>();
      const observedTargets = new Set<HTMLElement>();

      class ActiveResizeObserver {
        cb: ResizeObserverCallback;
        observe = vi.fn((target: Element) => {
          const el = target as HTMLElement;
          if (el.dataset?.virtualKey) {
            observedTargets.add(el);
            observersByTarget.set(el, { cb: this.cb, observer: this as unknown as ResizeObserver });
          }
        });
        unobserve = vi.fn((target: Element) => {
          const el = target as HTMLElement;
          observedTargets.delete(el);
          observersByTarget.delete(el);
        });
        disconnect = vi.fn(() => {
          for (const [el, entry] of observersByTarget.entries()) {
            if (entry.observer === (this as unknown as ResizeObserver)) {
              observersByTarget.delete(el);
              observedTargets.delete(el);
            }
          }
        });
        constructor(cb: ResizeObserverCallback) {
          this.cb = cb;
        }
      }
      vi.stubGlobal('ResizeObserver', ActiveResizeObserver);

      let currentClientHeight = 600;
      const getScrollTop = installVirtualScrollGeometry(() => currentClientHeight);
      const targetKey = 'ev-38';
      let currentTargetHeight = 42;
      let totalTargetRectReads = 0;

      const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const vk = this?.dataset?.virtualKey;
        if (vk) {
          if (vk === targetKey) {
            totalTargetRectReads += 1;
            return rowRect(vk, currentTargetHeight, getScrollTop());
          }
          return rowRect(vk, 42, getScrollTop());
        }
        return { top: 0, bottom: currentClientHeight, height: currentClientHeight, left: 0, right: 400, width: 400, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      });

      const rafQueue: FrameRequestCallback[] = [];
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length;
      });
      vi.stubGlobal('cancelAnimationFrame', vi.fn());

      let visibilityState: DocumentVisibilityState = 'visible';
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibilityState,
      });

      const makeEvents = (count: number, lastText?: string) => Array.from({ length: count }, (_, i) => ({
        eventId: `ev-${i}`,
        type: 'user.message',
        sessionId: 'desk-main',
        ts: 1000 + i,
        epoch: 1,
        seq: i + 1,
        source: 'daemon',
        confidence: 'high',
        payload: { text: i === count - 1 && lastText ? lastText : `message ${i}` },
      })) as any[];

      let nowMs = 10_000;
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

      const view = render(<ChatView events={makeEvents(40)} loading={false} sessionId="desk-main" visible={true} />);
      while (rafQueue.length > 0) {
        const cb = rafQueue.shift()!;
        await act(async () => { cb(16); });
      }

      // Background -> foreground resume
      visibilityState = 'hidden';
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      nowMs += 5_000;
      visibilityState = 'visible';
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      while (rafQueue.length > 0) {
        const cb = rafQueue.shift()!;
        await act(async () => { cb(32); });
      }

      expect(observedTargets.size).toBeGreaterThan(0);
      const targetEl = Array.from(observedTargets).find((el) => el.dataset.virtualKey === targetKey)
        ?? Array.from(observedTargets)[0]!;
      const getVirtualObserver = () => observersByTarget.get(targetEl)!;
      expect(getVirtualObserver()).toBeTruthy();

      // Simulate an active browser ResizeObserver delivering 1px/zoom-like oscillating row
      // heights across 40 consecutive layout deliveries on the resumed pane.
      // Only a bounded prefix should trigger re-layout/re-reads; after budget exhaustion it must settle.
      let reMeasureCycles = 0;
      for (let i = 0; i < 40; i += 1) {
        currentTargetHeight = i % 2 === 0 ? 56 : 42;
        const readsBefore = totalTargetRectReads;
        await act(async () => {
          const { cb, observer } = getVirtualObserver();
          cb([{ target: targetEl } as unknown as ResizeObserverEntry], observer);
        });
        while (rafQueue.length > 0) {
          const cb = rafQueue.shift()!;
          await act(async () => { cb((i + 3) * 16); });
        }
        if (totalTargetRectReads > readsBefore) {
          reMeasureCycles += 1;
        }
      }

      expect(reMeasureCycles).toBeGreaterThan(0);
      expect(reMeasureCycles).toBeLessThanOrEqual(8);

      // Genuine item update (streaming text on same count/last key) replenishes ResizeObserver budget.
      currentTargetHeight = 72;
      const readsBeforeStream = totalTargetRectReads;
      await act(async () => {
        view.rerender(<ChatView events={makeEvents(40, 'streamed update')} loading={false} sessionId="desk-main" visible={true} />);
      });
      currentTargetHeight = 84;
      await act(async () => {
        const { cb, observer } = getVirtualObserver();
        cb([{ target: targetEl } as unknown as ResizeObserverEntry], observer);
      });
      expect(totalTargetRectReads).toBeGreaterThan(readsBeforeStream);

      // Genuine viewport height change also replenishes ResizeObserver budget.
      for (let i = 0; i < 10; i += 1) {
        currentTargetHeight = i % 2 === 0 ? 50 : 64;
        await act(async () => {
          const { cb, observer } = getVirtualObserver();
          cb([{ target: targetEl } as unknown as ResizeObserverEntry], observer);
        });
      }
      currentClientHeight = 720;
      await act(async () => {
        view.rerender(<ChatView events={makeEvents(41)} loading={false} sessionId="desk-main" visible={true} />);
      });
      const readsBeforeViewportRo = totalTargetRectReads;
      currentTargetHeight = 96;
      await act(async () => {
        const { cb, observer } = getVirtualObserver();
        cb([{ target: targetEl } as unknown as ResizeObserverEntry], observer);
      });
      expect(totalTargetRectReads).toBeGreaterThan(readsBeforeViewportRo);

      nowSpy.mockRestore();
      rectSpy.mockRestore();
      delete (HTMLElement.prototype as any).clientHeight;
      delete (HTMLElement.prototype as any).scrollHeight;
      delete (HTMLElement.prototype as any).scrollTop;
      delete (document as any).visibilityState;
    });

    it('ignores ResizeObserver deliveries while hidden or collapsed (clientHeight === 0) and resumes measurement once visible', async () => {
      const observersByTarget = new Map<HTMLElement, { cb: ResizeObserverCallback; observer: ResizeObserver }>();
      const observedTargets = new Set<HTMLElement>();

      class ActiveResizeObserver {
        cb: ResizeObserverCallback;
        observe = vi.fn((target: Element) => {
          const el = target as HTMLElement;
          if (el.dataset?.virtualKey) {
            observedTargets.add(el);
            observersByTarget.set(el, { cb: this.cb, observer: this as unknown as ResizeObserver });
          }
        });
        unobserve = vi.fn((target: Element) => {
          const el = target as HTMLElement;
          observedTargets.delete(el);
          observersByTarget.delete(el);
        });
        disconnect = vi.fn(() => {
          for (const [el, entry] of observersByTarget.entries()) {
            if (entry.observer === (this as unknown as ResizeObserver)) {
              observersByTarget.delete(el);
              observedTargets.delete(el);
            }
          }
        });
        constructor(cb: ResizeObserverCallback) {
          this.cb = cb;
        }
      }
      vi.stubGlobal('ResizeObserver', ActiveResizeObserver);

      let currentClientHeight = 600;
      const getScrollTop = installVirtualScrollGeometry(() => currentClientHeight);
      const targetKey = 'ev-col-38';
      let currentTargetHeight = 42;
      let totalTargetRectReads = 0;

      const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const vk = this?.dataset?.virtualKey;
        if (vk) {
          if (vk === targetKey) {
            totalTargetRectReads += 1;
            return rowRect(vk, currentTargetHeight, getScrollTop());
          }
          return rowRect(vk, 42, getScrollTop());
        }
        return { top: 0, bottom: currentClientHeight, height: currentClientHeight, left: 0, right: 400, width: 400, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      });

      let visibilityState: DocumentVisibilityState = 'visible';
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibilityState,
      });

      const makeEvents = (count: number) => Array.from({ length: count }, (_, i) => ({
        eventId: `ev-col-${i}`,
        type: 'user.message',
        sessionId: 'desk-main',
        ts: 2000 + i,
        epoch: 1,
        seq: i + 1,
        source: 'daemon',
        confidence: 'high',
        payload: { text: `message ${i}` },
      })) as any[];

      const view = render(<ChatView events={makeEvents(40)} loading={false} sessionId="desk-main" visible={true} />);
      const targetEl = Array.from(observedTargets).find((el) => el.dataset.virtualKey === targetKey)
        ?? Array.from(observedTargets)[0]!;
      const getVirtualObserver = () => observersByTarget.get(targetEl)!;
      expect(getVirtualObserver()).toBeTruthy();

      // While hidden (visibilityState === 'hidden' or clientHeight === 0), ResizeObserver must not measure 0->1px.
      visibilityState = 'hidden';
      currentClientHeight = 0;
      currentTargetHeight = 0;
      const readsWhileHiddenStart = totalTargetRectReads;
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        const { cb, observer } = getVirtualObserver();
        cb([{ target: targetEl } as unknown as ResizeObserverEntry], observer);
      });
      expect(totalTargetRectReads).toBe(readsWhileHiddenStart);

      // Rapid visibilitychange + persisted pageshow coalesce and restore normal measurement cleanly.
      visibilityState = 'visible';
      currentClientHeight = 600;
      currentTargetHeight = 64;
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        const pageshow = new Event('pageshow') as PageTransitionEvent;
        Object.defineProperty(pageshow, 'persisted', { value: true });
        window.dispatchEvent(pageshow);
        view.rerender(<ChatView events={makeEvents(40)} loading={false} sessionId="desk-main" visible={true} />);
      });
      const readsBeforeVisibleRo = totalTargetRectReads;
      currentTargetHeight = 90;
      await act(async () => {
        const { cb, observer } = getVirtualObserver();
        cb([{ target: targetEl } as unknown as ResizeObserverEntry], observer);
      });
      expect(totalTargetRectReads).toBeGreaterThan(readsBeforeVisibleRo);

      rectSpy.mockRestore();
      delete (HTMLElement.prototype as any).clientHeight;
      delete (HTMLElement.prototype as any).scrollHeight;
      delete (HTMLElement.prototype as any).scrollTop;
      delete (document as any).visibilityState;
    });
  });
});
