/**
 * @vitest-environment jsdom
 *
 * Tests for the optimistic-send flow:
 *   addOptimisticUserMessage → spinner
 *   command.ack error         → red "!" (markOptimisticFailed)
 *   echoed user.message       → cleanup (matches by commandId first, text second)
 *   30s timeout               → auto-fail
 *   removeOptimisticMessage   → explicit cleanup (retry path)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/preact';
import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import type { ServerMessage, WsClient } from '../src/ws-client.js';
import {
  __resetTimelineCacheForTests,
  useTimeline,
  type UseTimelineResult,
} from '../src/hooks/useTimeline.js';

type HookRef = UseTimelineResult | null;

function captureHookRef(ref: { current: HookRef }, handlerBox: { fn: ((msg: ServerMessage) => void) | null }) {
  const ws: WsClient = {
    connected: true,
    onMessage: (next: (msg: ServerMessage) => void) => {
      handlerBox.fn = next;
      return () => { handlerBox.fn = null; };
    },
    sendTimelineHistoryRequest: () => 'history-req',
  } as unknown as WsClient;

  function Probe({ sessionId }: { sessionId: string }) {
    const result = useTimeline(sessionId, ws, 'srv');
    useEffect(() => {
      ref.current = result;
    });
    return null;
  }

  return { ws, Probe };
}

describe('useTimeline optimistic send flow', () => {
  beforeEach(() => {
    __resetTimelineCacheForTests();
    cleanup();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('injects a pending user.message bubble keyed by commandId', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_a' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('hi', 'cmd-1');
    });

    const [event] = ref.current!.events;
    expect(event.type).toBe('user.message');
    expect(event.payload.text).toBe('hi');
    expect(event.payload.pending).toBe(true);
    expect(event.payload.commandId).toBe('cmd-1');
    expect(event.eventId).toContain('optimistic:deck_opt_a:cmd-1');
  });

  it('flips to failed state with reason on command.ack error', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_b' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('boom', 'cmd-2');
    });

    act(() => {
      handlerBox.fn?.({
        type: 'command.ack',
        commandId: 'cmd-2',
        status: 'error',
        session: 'deck_opt_b',
        error: 'daemon not connected',
      } as unknown as ServerMessage);
    });

    const [event] = ref.current!.events;
    expect(event.payload.pending).toBe(false);
    expect(event.payload.failed).toBe(true);
    expect(event.payload.failureReason).toBe('daemon not connected');
  });

  it('real echoed user.message clears the pending bubble via commandId match', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_c' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('hello', 'cmd-3');
    });
    expect(ref.current!.events).toHaveLength(1);

    act(() => {
      handlerBox.fn?.({
        type: 'timeline.event',
        event: {
          eventId: 'real-echo-3',
          sessionId: 'deck_opt_c',
          ts: Date.now(),
          epoch: 1,
          seq: 5,
          source: 'daemon',
          confidence: 'high',
          type: 'user.message',
          // Daemon normalized the prompt text — text-only dedup would fail here,
          // but commandId carries through and cleans the optimistic bubble.
          payload: { text: 'hello (normalized)', commandId: 'cmd-3' },
        },
      } as unknown as ServerMessage);
    });

    const texts = ref.current!.events.map((e) => e.payload.text);
    expect(texts).toEqual(['hello (normalized)']);
    expect(ref.current!.events[0].payload.pending).toBeFalsy();
  });

  it('removes a transport optimistic bubble when the daemon authoritatively queues the send', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_queue' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('queue me', 'cmd-queued');
    });
    expect(ref.current!.events).toHaveLength(1);

    act(() => {
      handlerBox.fn?.({
        type: 'timeline.event',
        event: {
          eventId: 'queued-state-1',
          sessionId: 'deck_opt_queue',
          ts: Date.now(),
          epoch: 1,
          seq: 4,
          source: 'daemon',
          confidence: 'high',
          type: 'session.state',
          payload: {
            state: 'queued',
            pendingMessages: ['queue me'],
            pendingMessageEntries: [{ clientMessageId: 'cmd-queued', text: 'queue me' }],
          },
        },
      } as unknown as ServerMessage);
    });

    expect(ref.current!.events).toHaveLength(1);
    expect(ref.current!.events[0].type).toBe('session.state');
  });

  it('late echo also clears a previously-failed bubble (retry arrived)', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_d' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('retry me', 'cmd-4');
    });
    act(() => {
      ref.current!.markOptimisticFailed('cmd-4', 'timeout');
    });
    expect(ref.current!.events[0].payload.failed).toBe(true);

    act(() => {
      handlerBox.fn?.({
        type: 'timeline.event',
        event: {
          eventId: 'real-echo-4',
          sessionId: 'deck_opt_d',
          ts: Date.now(),
          epoch: 1,
          seq: 7,
          source: 'daemon',
          confidence: 'high',
          type: 'user.message',
          payload: { text: 'retry me', commandId: 'cmd-4' },
        },
      } as unknown as ServerMessage);
    });

    // The failed bubble is removed when the authoritative echo arrives so the
    // chat doesn't permanently show the red "!" for a message the agent
    // eventually saw.
    expect(ref.current!.events).toHaveLength(1);
    expect(ref.current!.events[0].payload.pending).toBeFalsy();
    expect(ref.current!.events[0].payload.failed).toBeFalsy();
  });

  it('drops a timed-out duplicate when the same text is already confirmed', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_confirmed_dup' }));

    act(() => {
      handlerBox.fn?.({
        type: 'timeline.event',
        event: {
          eventId: 'real-user-confirmed',
          sessionId: 'deck_opt_confirmed_dup',
          ts: Date.now(),
          epoch: 1,
          seq: 5,
          source: 'daemon',
          confidence: 'high',
          type: 'user.message',
          payload: { text: 'already sent' },
        },
      } as unknown as ServerMessage);
    });
    act(() => {
      ref.current!.addOptimisticUserMessage('already sent', 'cmd-confirmed-dup');
    });
    expect(ref.current!.events).toHaveLength(2);

    act(() => {
      handlerBox.fn?.({
        type: 'command.failed',
        commandId: 'cmd-confirmed-dup',
        session: 'deck_opt_confirmed_dup',
        reason: 'ack_timeout',
        retryable: true,
      } as unknown as ServerMessage);
    });

    expect(ref.current!.events).toHaveLength(1);
    expect(ref.current!.events[0].eventId).toBe('real-user-confirmed');
    expect(ref.current!.events[0].payload.failed).toBeFalsy();
  });

  it('auto-fails after the 30s timeout when no ack and no echo arrive', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_e' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('slow net', 'cmd-5');
    });
    expect(ref.current!.events[0].payload.pending).toBe(true);

    act(() => {
      vi.advanceTimersByTime(30_001);
    });

    expect(ref.current!.events[0].payload.pending).toBe(false);
    expect(ref.current!.events[0].payload.failed).toBe(true);
    expect(ref.current!.events[0].payload.failureReason).toBe('timeout');
  });

  it('success-ish command.ack cancels the failure timer', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_f' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('ok', 'cmd-6');
    });

    act(() => {
      handlerBox.fn?.({
        type: 'command.ack',
        commandId: 'cmd-6',
        status: 'accepted',
        session: 'deck_opt_f',
      } as unknown as ServerMessage);
    });
    // Even past the 30s mark the bubble must not auto-fail — daemon acked.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(ref.current!.events[0].payload.pending).toBe(true);
    expect(ref.current!.events[0].payload.failed).toBeFalsy();
  });

  it('removeOptimisticMessage deletes the entry (retry path)', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_g' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('drop me', 'cmd-7');
      ref.current!.markOptimisticFailed('cmd-7', 'timeout');
    });
    expect(ref.current!.events).toHaveLength(1);

    act(() => {
      ref.current!.removeOptimisticMessage('cmd-7');
    });
    expect(ref.current!.events).toHaveLength(0);
  });

  it('scopes command.ack to the current session', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_h' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('mine', 'cmd-8');
    });

    act(() => {
      // ack for a different session must not affect ours
      handlerBox.fn?.({
        type: 'command.ack',
        commandId: 'cmd-8',
        status: 'error',
        session: 'deck_opt_different',
        error: 'not me',
      } as unknown as ServerMessage);
    });

    expect(ref.current!.events[0].payload.pending).toBe(true);
    expect(ref.current!.events[0].payload.failed).toBeFalsy();
  });

  it('ignores duplicate addOptimisticUserMessage for the same commandId', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_i' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('once', 'cmd-9');
      ref.current!.addOptimisticUserMessage('twice', 'cmd-9');
    });

    expect(ref.current!.events).toHaveLength(1);
    expect(ref.current!.events[0].payload.text).toBe('once');
  });
});
