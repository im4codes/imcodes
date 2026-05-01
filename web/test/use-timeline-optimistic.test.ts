/**
 * @vitest-environment jsdom
 *
 * Tests for the optimistic-send flow:
 *   addOptimisticUserMessage → spinner
 *   command.ack error         → red "!" (markOptimisticFailed)
 *   echoed user.message       → cleanup (matches by commandId first, text second)
 *   optimistic timeout (90s)  → auto-fail
 *   removeOptimisticMessage   → explicit cleanup (retry path)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, act, cleanup, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import type { ServerMessage, WsClient } from '../src/ws-client.js';

// Mock api.js so tests can control whether the HTTP-send fallback "succeeds"
// (resolves) or "fails" (rejects). The auto-retry-on-command.failed flow ends
// with a single HTTP attempt before marking the bubble red — controlling this
// resolution is what lets tests deterministically reach the failed state
// without waiting for real network timeouts.
vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api.js')>();
  return {
    ...actual,
    fetchTimelineHistoryHttp: vi.fn(async () => ({ events: [] })),
    sendSessionViaHttp: vi.fn(async () => { throw new Error('http unavailable in test'); }),
  };
});

import {
  __clearPersistedTimelineSnapshotsForTests,
  __resetTimelineCacheForTests,
  useTimeline,
  type UseTimelineResult,
} from '../src/hooks/useTimeline.js';
import { sendSessionViaHttp } from '../src/api.js';

const sendSessionViaHttpMock = vi.mocked(sendSessionViaHttp);

/**
 * Total wall time for the auto-retry chain to reach its "give up and mark
 * failed" state when HTTP fallback rejects: sum of CLIENT_RETRY_DELAYS_MS
 * (800 + 2000 + 3200 = 6000ms) + a small buffer for the HTTP rejection
 * promise to flush. The hook's internal constants are not exported.
 */
const AUTO_RETRY_EXHAUSTION_MS = 6_500;

type HookRef = UseTimelineResult | null;

function captureHookRef(ref: { current: HookRef }, handlerBox: { fn: ((msg: ServerMessage) => void) | null }) {
  const ws: WsClient = {
    connected: true,
    onMessage: (next: (msg: ServerMessage) => void) => {
      handlerBox.fn = next;
      return () => { handlerBox.fn = null; };
    },
    sendTimelineHistoryRequest: vi.fn(() => 'history-req'),
    // Auto-retry-on-command.failed re-sends via WS before falling back to
    // HTTP. Mock both so tests can assert how many WS retries fired.
    sendSessionCommand: vi.fn(() => undefined),
    send: vi.fn(() => undefined),
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
    __clearPersistedTimelineSnapshotsForTests();
    cleanup();
    vi.useFakeTimers();
    sendSessionViaHttpMock.mockReset();
    // Default: HTTP fallback rejects (matches "the network is broken" tests).
    // Individual tests can override via `sendSessionViaHttpMock.mockResolvedValue`.
    sendSessionViaHttpMock.mockRejectedValue(new Error('http unavailable in test'));
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

  it('replaces the pending bubble in place when the authoritative user.message arrives', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_in_place_success' }));

    act(() => {
      handlerBox.fn?.({
        type: 'timeline.event',
        event: {
          eventId: 'assistant-before',
          sessionId: 'deck_opt_in_place_success',
          ts: Date.now() - 20,
          epoch: 1,
          seq: 1,
          source: 'daemon',
          confidence: 'high',
          type: 'assistant.text',
          payload: { text: 'before' },
        },
      } as unknown as ServerMessage);
    });
    act(() => {
      ref.current!.addOptimisticUserMessage('keep my slot', 'cmd-in-place-success');
    });
    const optimisticId = ref.current!.events[1].eventId;

    act(() => {
      handlerBox.fn?.({
        type: 'timeline.event',
        event: {
          eventId: 'real-in-place-success',
          sessionId: 'deck_opt_in_place_success',
          ts: Date.now(),
          epoch: 1,
          seq: 2,
          source: 'daemon',
          confidence: 'high',
          type: 'user.message',
          payload: { text: 'keep my slot', commandId: 'cmd-in-place-success' },
        },
      } as unknown as ServerMessage);
    });

    expect(ref.current!.events.map((event) => event.eventId)).toEqual([
      'assistant-before',
      'real-in-place-success',
    ]);
    expect(ref.current!.events.map((event) => event.eventId)).not.toContain(optimisticId);
    expect(ref.current!.events[1].payload.pending).toBeFalsy();
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
    // Advance past the auto-retry chain + the optimistic auto-fail timer so
    // every code path that could mark/dedupe the bubble has had a chance to
    // run. ack_timeout doesn't trigger the auto-retry, but the optimistic
    // 90s timer might fire — when it tries to mark failed, the duplicate
    // text + confirmed echo causes the optimistic to be removed instead.
    act(() => {
      vi.advanceTimersByTime(91_000);
    });

    expect(ref.current!.events).toHaveLength(1);
    expect(ref.current!.events[0].eventId).toBe('real-user-confirmed');
    expect(ref.current!.events[0].payload.failed).toBeFalsy();
  });

  it('auto-fails after the optimistic timeout when no ack and no echo arrive', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_e' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('slow net', 'cmd-5');
    });
    expect(ref.current!.events[0].payload.pending).toBe(true);

    // OPTIMISTIC_TIMEOUT_MS is 90s; advance just past that to trigger auto-fail.
    act(() => {
      vi.advanceTimersByTime(90_001);
    });

    expect(ref.current!.events[0].payload.pending).toBe(false);
    expect(ref.current!.events[0].payload.failed).toBe(true);
    expect(ref.current!.events[0].payload.failureReason).toBe('timeout');
  });

  it('success-ish command.ack marks the local bubble sent and cancels the failure timer', () => {
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
    // Even past the optimistic timeout the bubble must not auto-fail — daemon acked.
    act(() => {
      vi.advanceTimersByTime(120_000);
    });

    expect(ref.current!.events[0].payload.pending).toBe(false);
    expect(ref.current!.events[0].payload.acked).toBe(true);
    expect(ref.current!.events[0].payload.failed).toBeFalsy();
  });

  it('settles a pending bubble from command.ack delivered as a timeline event', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_timeline_ack' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('timeline ack', 'cmd-timeline-ack');
    });
    expect(ref.current!.events[0].payload.pending).toBe(true);

    act(() => {
      handlerBox.fn?.({
        type: 'timeline.event',
        event: {
          eventId: 'ack-event-1',
          sessionId: 'deck_opt_timeline_ack',
          ts: Date.now(),
          epoch: 1,
          seq: 2,
          source: 'daemon',
          confidence: 'high',
          type: 'command.ack',
          payload: { commandId: 'cmd-timeline-ack', status: 'accepted' },
        },
      } as unknown as ServerMessage);
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    const optimistic = ref.current!.events.find((event) => event.eventId.includes('cmd-timeline-ack'));
    expect(optimistic?.payload.pending).toBe(false);
    expect(optimistic?.payload.acked).toBe(true);
    expect(optimistic?.payload.failed).toBeFalsy();
  });

  it('marks a pending bubble failed from command.ack error delivered as a timeline event', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_timeline_ack_error' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('timeline ack error', 'cmd-timeline-ack-error');
    });

    act(() => {
      handlerBox.fn?.({
        type: 'timeline.event',
        event: {
          eventId: 'ack-error-event-1',
          sessionId: 'deck_opt_timeline_ack_error',
          ts: Date.now(),
          epoch: 1,
          seq: 2,
          source: 'daemon',
          confidence: 'high',
          type: 'command.ack',
          payload: { commandId: 'cmd-timeline-ack-error', status: 'error', error: 'duplicate_command_id' },
        },
      } as unknown as ServerMessage);
    });

    const optimistic = ref.current!.events.find((event) => event.eventId.includes('cmd-timeline-ack-error'));
    expect(optimistic?.payload.pending).toBe(false);
    expect(optimistic?.payload.failed).toBe(true);
    expect(optimistic?.payload.failureReason).toBe('duplicate_command_id');
  });

  it('settles a pending bubble from command.ack recovered through history', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_history_ack' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('history ack', 'cmd-history-ack');
    });

    act(() => {
      handlerBox.fn?.({
        type: 'timeline.history',
        sessionName: 'deck_opt_history_ack',
        requestId: 'history-req',
        epoch: 1,
        events: [{
          eventId: 'history-ack-event-1',
          sessionId: 'deck_opt_history_ack',
          ts: Date.now(),
          epoch: 1,
          seq: 3,
          source: 'daemon',
          confidence: 'high',
          type: 'command.ack',
          payload: { commandId: 'cmd-history-ack', status: 'accepted' },
        }],
      } as unknown as ServerMessage);
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    const optimistic = ref.current!.events.find((event) => event.eventId.includes('cmd-history-ack'));
    expect(optimistic?.payload.pending).toBe(false);
    expect(optimistic?.payload.acked).toBe(true);
    expect(optimistic?.payload.failed).toBeFalsy();
  });

  it('keeps pending optimistic sends visible across daemon reconnect until history reconciles them', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { ws, Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_reconnect_pending' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('still visible', 'cmd-reconnect-visible');
    });

    act(() => {
      handlerBox.fn?.({ type: 'daemon.reconnected' } as unknown as ServerMessage);
    });

    expect(ref.current!.events).toHaveLength(1);
    expect(ref.current!.events[0].payload.pending).toBe(true);
    expect(ref.current!.events[0].payload.text).toBe('still visible');
    expect(ws.sendTimelineHistoryRequest).toHaveBeenCalledWith('deck_opt_reconnect_pending', 300);
  });

  it('does not show ack_timeout failure when authoritative history arrives', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_timeout_recovered' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('arrived anyway', 'cmd-timeout-recovered');
    });

    act(() => {
      handlerBox.fn?.({
        type: 'command.failed',
        commandId: 'cmd-timeout-recovered',
        session: 'deck_opt_timeout_recovered',
        reason: 'ack_timeout',
        retryable: true,
      } as unknown as ServerMessage);
    });

    expect(ref.current!.events[0].payload.pending).toBe(true);

    act(() => {
      handlerBox.fn?.({
        type: 'timeline.event',
        event: {
          eventId: 'real-timeout-recovered',
          sessionId: 'deck_opt_timeout_recovered',
          ts: Date.now(),
          epoch: 1,
          seq: 9,
          source: 'daemon',
          confidence: 'high',
          type: 'user.message',
          payload: { text: 'arrived anyway', commandId: 'cmd-timeout-recovered' },
        },
      } as unknown as ServerMessage);
    });
    expect(ref.current!.events).toHaveLength(1);
    expect(ref.current!.events[0].eventId).toBe('real-timeout-recovered');
    expect(ref.current!.events[0].payload.failed).toBeFalsy();
  });

  it('marks ack_timeout as failed after a short HTTP backfill grace when no echo arrives', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_timeout_grace_miss' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('never confirmed', 'cmd-timeout-grace-miss');
    });

    act(() => {
      handlerBox.fn?.({
        type: 'command.failed',
        commandId: 'cmd-timeout-grace-miss',
        session: 'deck_opt_timeout_grace_miss',
        reason: 'ack_timeout',
        retryable: true,
      } as unknown as ServerMessage);
    });

    expect(ref.current!.events[0].payload.pending).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1_600);
    });

    expect(ref.current!.events[0].payload.pending).toBe(false);
    expect(ref.current!.events[0].payload.failed).toBe(true);
    expect(ref.current!.events[0].payload.failureReason).toEqual(expect.any(String));
  });

  it('settles a pending send when later assistant progress proves the session is processing it', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_progress_settled' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('work on this', 'cmd-progress-settled');
    });
    expect(ref.current!.events[0].payload.pending).toBe(true);

    act(() => {
      handlerBox.fn?.({
        type: 'timeline.event',
        event: {
          eventId: 'assistant-progress-1',
          sessionId: 'deck_opt_progress_settled',
          ts: Date.now() + 10,
          epoch: 1,
          seq: 10,
          source: 'daemon',
          confidence: 'high',
          type: 'assistant.text',
          payload: { text: 'I am working on it', streaming: true },
        },
      } as unknown as ServerMessage);
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    const optimistic = ref.current!.events.find((event) => event.eventId.includes('cmd-progress-settled'));
    expect(optimistic?.payload.pending).toBe(false);
    expect(optimistic?.payload.acked).toBe(true);
    expect(optimistic?.payload.failed).toBeFalsy();
  });

  it('uses linked memory context to replace a stuck spinner with the real sent message', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_memory_reconciled' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('local text with attachment', 'cmd-memory-reconciled');
    });

    act(() => {
      handlerBox.fn?.({
        type: 'timeline.event',
        event: {
          eventId: 'real-memory-user',
          sessionId: 'deck_opt_memory_reconciled',
          ts: Date.now(),
          epoch: 1,
          seq: 10,
          source: 'daemon',
          confidence: 'high',
          type: 'user.message',
          payload: { text: 'server normalized text' },
        },
      } as unknown as ServerMessage);
    });
    expect(ref.current!.events).toHaveLength(2);
    expect(ref.current!.events[0].payload.pending).toBe(true);

    act(() => {
      handlerBox.fn?.({
        type: 'timeline.event',
        event: {
          eventId: 'memory-for-real-user',
          sessionId: 'deck_opt_memory_reconciled',
          ts: Date.now() + 1,
          epoch: 1,
          seq: 11,
          source: 'daemon',
          confidence: 'high',
          type: 'memory.context',
          payload: { relatedToEventId: 'real-memory-user', items: [] },
        },
      } as unknown as ServerMessage);
    });

    expect(ref.current!.events.map((event) => event.eventId)).toEqual([
      'real-memory-user',
      'memory-for-real-user',
    ]);
    expect(ref.current!.events[0].payload.pending).toBeFalsy();
  });

  it('updates a failed retry bubble in place with the new command id', () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_retry_in_place' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('retry same slot', 'cmd-old-retry');
      ref.current!.markOptimisticFailed('cmd-old-retry', 'timeout');
    });
    const eventId = ref.current!.events[0].eventId;

    act(() => {
      ref.current!.retryOptimisticMessage('cmd-old-retry', 'cmd-new-retry', 'retry same slot', {
        resendExtra: { mode: 'quick' },
      });
    });

    expect(ref.current!.events).toHaveLength(1);
    expect(ref.current!.events[0].eventId).toBe(eventId);
    expect(ref.current!.events[0].payload.commandId).toBe('cmd-new-retry');
    expect(ref.current!.events[0].payload.pending).toBe(true);
    expect(ref.current!.events[0].payload.failed).toBe(false);

    act(() => {
      handlerBox.fn?.({
        type: 'timeline.event',
        event: {
          eventId: 'real-new-retry',
          sessionId: 'deck_opt_retry_in_place',
          ts: Date.now(),
          epoch: 1,
          seq: 12,
          source: 'daemon',
          confidence: 'high',
          type: 'user.message',
          payload: { text: 'retry same slot', commandId: 'cmd-new-retry' },
        },
      } as unknown as ServerMessage);
    });

    expect(ref.current!.events).toHaveLength(1);
    expect(ref.current!.events[0].eventId).toBe('real-new-retry');
    expect(ref.current!.events[0].payload.pending).toBeFalsy();
  });

  it('persists an acked local send across refresh and replaces it with authoritative history by commandId', async () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_refresh_ack' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('@/tmp/file.png hello', 'cmd-refresh-ack');
    });
    act(() => {
      handlerBox.fn?.({
        type: 'command.ack',
        commandId: 'cmd-refresh-ack',
        status: 'accepted',
        session: 'deck_opt_refresh_ack',
      } as unknown as ServerMessage);
    });
    expect(ref.current!.events[0].payload.pending).toBe(false);
    expect(ref.current!.events[0].payload.acked).toBe(true);

    cleanup();
    __resetTimelineCacheForTests();

    const refAfterReload = { current: null as HookRef };
    const handlerAfterReload = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe: ReloadProbe } = captureHookRef(refAfterReload, handlerAfterReload);
    render(h(ReloadProbe, { sessionId: 'deck_opt_refresh_ack' }));

    await waitFor(() => {
      expect(refAfterReload.current!.events).toHaveLength(1);
      expect(refAfterReload.current!.events[0].payload.acked).toBe(true);
    });

    act(() => {
      handlerAfterReload.fn?.({
        type: 'timeline.history',
        sessionName: 'deck_opt_refresh_ack',
        requestId: 'history-req',
        epoch: 1,
        events: [{
          eventId: 'real-refresh-ack',
          sessionId: 'deck_opt_refresh_ack',
          ts: Date.now(),
          epoch: 1,
          seq: 3,
          source: 'daemon',
          confidence: 'high',
          type: 'user.message',
          payload: { text: '@/tmp/file.png hello (authoritative)', commandId: 'cmd-refresh-ack' },
        }],
      } as unknown as ServerMessage);
    });

    await waitFor(() => {
      expect(refAfterReload.current!.events).toHaveLength(1);
      expect(refAfterReload.current!.events[0].eventId).toBe('real-refresh-ack');
      expect(refAfterReload.current!.events[0].payload.text).toBe('@/tmp/file.png hello (authoritative)');
    });
  });

  it('persists a failed local send across refresh so the retry affordance survives', async () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_refresh_failed' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('will fail', 'cmd-refresh-failed');
    });
    // The new auto-retry behavior keeps the bubble pending across multiple
    // `command.failed` events until WS retries are exhausted AND the HTTP
    // fallback rejects. To deterministically reach the "marked failed"
    // state, drain through every retry slot (3 WS + 1 HTTP). The test's
    // intent — that the failed bubble persists across refresh — is the
    // assertion below; the retry-chain plumbing is covered by separate
    // dedicated tests.
    for (let i = 0; i < 4; i++) {
      act(() => {
        handlerBox.fn?.({
          type: 'command.failed',
          commandId: 'cmd-refresh-failed',
          session: 'deck_opt_refresh_failed',
          reason: 'daemon_error',
          retryable: true,
        } as unknown as ServerMessage);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3300);
      });
    }
    // HTTP fallback (mocked to reject) propagates → markOptimisticFailed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(ref.current!.events[0].payload.failed).toBe(true);

    cleanup();
    __resetTimelineCacheForTests();

    const refAfterReload = { current: null as HookRef };
    const handlerAfterReload = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe: ReloadProbe } = captureHookRef(refAfterReload, handlerAfterReload);
    render(h(ReloadProbe, { sessionId: 'deck_opt_refresh_failed' }));

    await waitFor(() => {
      expect(refAfterReload.current!.events).toHaveLength(1);
      expect(refAfterReload.current!.events[0].payload.failed).toBe(true);
      expect(refAfterReload.current!.events[0].payload.pending).toBe(false);
    });
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

  // ── Auto-retry on command.failed (do not flash red on first failure) ───────

  it('auto-retries via WS up to 3 times on command.failed before HTTP fallback', async () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { ws, Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_retry_ws' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('flaky', 'cmd-retry-ws');
    });

    // Server says no — but the bubble must NOT flash red. Auto-retry kicks in.
    act(() => {
      handlerBox.fn?.({
        type: 'command.failed',
        commandId: 'cmd-retry-ws',
        session: 'deck_opt_retry_ws',
        reason: 'daemon_offline',
        retryable: true,
      } as unknown as ServerMessage);
    });
    expect(ref.current!.events[0].payload.pending).toBe(true);
    expect(ref.current!.events[0].payload.failed).toBeFalsy();

    const wsSendSpy = vi.mocked((ws as unknown as { sendSessionCommand: (...args: unknown[]) => unknown }).sendSessionCommand);
    wsSendSpy.mockClear();

    // Each retry delay fires a fresh sendSessionCommand. Walk through the
    // backoff and verify exactly one new WS dispatch per timer fire.
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(wsSendSpy).toHaveBeenCalledTimes(1);
    expect(wsSendSpy.mock.calls[0]).toEqual([
      'send',
      expect.objectContaining({ commandId: 'cmd-retry-ws', text: 'flaky' }),
    ]);

    // Server fails again — schedule next retry.
    act(() => {
      handlerBox.fn?.({
        type: 'command.failed',
        commandId: 'cmd-retry-ws',
        session: 'deck_opt_retry_ws',
        reason: 'daemon_offline',
        retryable: true,
      } as unknown as ServerMessage);
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(wsSendSpy).toHaveBeenCalledTimes(2);

    // Third retry.
    act(() => {
      handlerBox.fn?.({
        type: 'command.failed',
        commandId: 'cmd-retry-ws',
        session: 'deck_opt_retry_ws',
        reason: 'daemon_offline',
        retryable: true,
      } as unknown as ServerMessage);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(3200); });
    expect(wsSendSpy).toHaveBeenCalledTimes(3);

    // Bubble still pending — no red flash during the retry chain.
    expect(ref.current!.events[0].payload.pending).toBe(true);
    expect(ref.current!.events[0].payload.failed).toBeFalsy();
    expect(sendSessionViaHttpMock).not.toHaveBeenCalled();
  });

  it('falls back to HTTP send after WS retries are exhausted', async () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_retry_http' }));

    // HTTP fallback succeeds — bubble should stay pending (waiting for the
    // authoritative echo) instead of flipping to failed.
    sendSessionViaHttpMock.mockResolvedValue(undefined);

    act(() => {
      ref.current!.addOptimisticUserMessage('http please', 'cmd-retry-http');
    });

    // Burn through all 3 WS retry slots by sending command.failed in a loop.
    for (let i = 0; i < 3; i++) {
      act(() => {
        handlerBox.fn?.({
          type: 'command.failed',
          commandId: 'cmd-retry-http',
          session: 'deck_opt_retry_http',
          reason: 'daemon_offline',
          retryable: true,
        } as unknown as ServerMessage);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3300);
      });
    }

    // 4th failure — at MAX retries → HTTP fallback fires.
    act(() => {
      handlerBox.fn?.({
        type: 'command.failed',
        commandId: 'cmd-retry-http',
        session: 'deck_opt_retry_http',
        reason: 'daemon_offline',
        retryable: true,
      } as unknown as ServerMessage);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    expect(sendSessionViaHttpMock).toHaveBeenCalledTimes(1);
    expect(sendSessionViaHttpMock).toHaveBeenCalledWith(
      'srv',
      expect.objectContaining({ commandId: 'cmd-retry-http', text: 'http please' }),
    );
    // HTTP succeeded → bubble still pending, NOT failed.
    expect(ref.current!.events[0].payload.pending).toBe(true);
    expect(ref.current!.events[0].payload.failed).toBeFalsy();
  });

  it('marks failed only after every WS retry AND the HTTP fallback have rejected', async () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_retry_final' }));

    // Default mockRejectedValue from beforeEach — HTTP fails.
    act(() => {
      ref.current!.addOptimisticUserMessage('all paths broken', 'cmd-retry-final');
    });

    // Single command.failed; the auto-retry will internally exhaust the WS
    // slot, fall to HTTP, HTTP rejects, bubble is finally marked failed.
    act(() => {
      handlerBox.fn?.({
        type: 'command.failed',
        commandId: 'cmd-retry-final',
        session: 'deck_opt_retry_final',
        reason: 'daemon_offline',
        retryable: true,
      } as unknown as ServerMessage);
    });

    expect(ref.current!.events[0].payload.pending).toBe(true);
    expect(ref.current!.events[0].payload.failed).toBeFalsy();

    // Advance through the full retry chain, sending command.failed each time
    // a WS retry "succeeds" (the mock is a no-op so server simulator doesn't
    // exist — but the hook still schedules HTTP fallback at MAX attempts).
    for (let i = 0; i < CLIENT_RETRY_DELAYS_SUM_PLUS_BUFFER_MS / 1000; i++) {
      act(() => {
        handlerBox.fn?.({
          type: 'command.failed',
          commandId: 'cmd-retry-final',
          session: 'deck_opt_retry_final',
          reason: 'daemon_offline',
          retryable: true,
        } as unknown as ServerMessage);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
    }
    // Final HTTP fallback may need an extra microtask flush.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(sendSessionViaHttpMock).toHaveBeenCalled();
    expect(ref.current!.events[0].payload.pending).toBe(false);
    expect(ref.current!.events[0].payload.failed).toBe(true);
  });

  it('cancels pending auto-retry when the authoritative echo arrives', async () => {
    const ref = { current: null as HookRef };
    const handlerBox = { fn: null as ((msg: ServerMessage) => void) | null };
    const { ws, Probe } = captureHookRef(ref, handlerBox);
    render(h(Probe, { sessionId: 'deck_opt_retry_cancel' }));

    act(() => {
      ref.current!.addOptimisticUserMessage('eventually arrives', 'cmd-retry-cancel');
    });
    act(() => {
      handlerBox.fn?.({
        type: 'command.failed',
        commandId: 'cmd-retry-cancel',
        session: 'deck_opt_retry_cancel',
        reason: 'daemon_error',
        retryable: true,
      } as unknown as ServerMessage);
    });

    // Echo arrives before the first retry timer fires — must cancel retry.
    act(() => {
      handlerBox.fn?.({
        type: 'timeline.event',
        event: {
          eventId: 'real-cancel',
          sessionId: 'deck_opt_retry_cancel',
          ts: Date.now(),
          epoch: 1,
          seq: 1,
          source: 'daemon',
          confidence: 'high',
          type: 'user.message',
          payload: { text: 'eventually arrives', commandId: 'cmd-retry-cancel' },
        },
      } as unknown as ServerMessage);
    });

    const wsSendSpy = vi.mocked((ws as unknown as { sendSessionCommand: (...args: unknown[]) => unknown }).sendSessionCommand);
    wsSendSpy.mockClear();
    sendSessionViaHttpMock.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_RETRY_EXHAUSTION_MS); });

    // After echo settled the bubble, no further retries should have fired.
    expect(wsSendSpy).not.toHaveBeenCalled();
    expect(sendSessionViaHttpMock).not.toHaveBeenCalled();
  });
});

// Local mirror of the hook's CLIENT_RETRY_DELAYS_MS sum (800+2000+3200=6000)
// plus 1s buffer for the HTTP rejection promise to settle.
const CLIENT_RETRY_DELAYS_SUM_PLUS_BUFFER_MS = 7_000;
