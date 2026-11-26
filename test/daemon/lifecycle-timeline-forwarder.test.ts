import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTimelineForwarder } from '../../src/daemon/lifecycle.js';
import type { TimelineEvent } from '../../src/daemon/timeline-event.js';
import { isVisibleSessionStatePayload } from '../../shared/session-activity-types.js';

function makeEvent(
  seq: number,
  type: TimelineEvent['type'],
  payload: Record<string, unknown>,
  sessionId = 'deck_cdn-m_brain',
): TimelineEvent {
  return {
    eventId: `ev-${seq}`,
    sessionId,
    ts: 1000 + seq,
    epoch: 1,
    seq,
    source: 'daemon',
    confidence: 'high',
    type,
    payload,
  };
}

describe('createTimelineForwarder — visible session.state live preservation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards stopping (user_cancel) immediately without being overwritten by follow-up idle 1ms later', async () => {
    const sent: TimelineEvent[] = [];
    const forward = createTimelineForwarder({
      serverLink: {
        send: (msg) => {
          if (msg.type === 'timeline.event') sent.push(msg.event as TimelineEvent);
        },
        sendTimelineEvent: (ev) => { sent.push(ev); },
      } as never,
      listSessions: () => [{ name: 'deck_cdn-m_brain', agentType: 'claude-code-sdk' }],
      getLastAssistantText: async () => undefined,
      shouldSuppressIdlePush: () => false,
      coalesceMs: 40,
    });

    forward(makeEvent(6, 'session.state', { state: 'stopping', reason: 'user_cancel' }));
    await vi.advanceTimersByTimeAsync(1);
    forward(makeEvent(7, 'session.state', { state: 'idle' }));

    // stopping is forwarded immediately on emit, before the 40ms coalesce window fires.
    expect(sent.map((e) => e.payload.state)).toEqual(['stopping']);

    await vi.advanceTimersByTimeAsync(40);
    expect(sent.map((e) => e.payload)).toEqual([
      { state: 'stopping', reason: 'user_cancel' },
      { state: 'idle' },
    ]);
  });

  it('clears pending stale running state so it never flushes after stopping', async () => {
    const sent: TimelineEvent[] = [];
    const forward = createTimelineForwarder({
      serverLink: {
        send: (msg) => {
          if (msg.type === 'timeline.event') sent.push(msg.event as TimelineEvent);
        },
        sendTimelineEvent: (ev) => { sent.push(ev); },
      } as never,
      listSessions: () => [{ name: 'deck_cdn-m_brain', agentType: 'claude-code-sdk' }],
      getLastAssistantText: async () => undefined,
      shouldSuppressIdlePush: () => false,
      coalesceMs: 40,
    });

    forward(makeEvent(5, 'session.state', { state: 'running' }));
    await vi.advanceTimersByTimeAsync(1);
    forward(makeEvent(6, 'session.state', { state: 'stopping', reason: 'user_cancel' }));
    await vi.advanceTimersByTimeAsync(50);

    expect(sent.map((e) => e.payload.state)).toEqual(['stopping']);
  });

  it('keeps coalescing high-frequency running -> queued -> idle bursts without visible states', async () => {
    const sent: TimelineEvent[] = [];
    const forward = createTimelineForwarder({
      serverLink: {
        send: (msg) => {
          if (msg.type === 'timeline.event') sent.push(msg.event as TimelineEvent);
        },
        sendTimelineEvent: (ev) => { sent.push(ev); },
      } as never,
      listSessions: () => [{ name: 'deck_cdn-m_brain', agentType: 'claude-code-sdk' }],
      getLastAssistantText: async () => undefined,
      shouldSuppressIdlePush: () => false,
      coalesceMs: 40,
    });

    forward(makeEvent(1, 'session.state', { state: 'queued' }));
    forward(makeEvent(2, 'session.state', { state: 'running' }));
    forward(makeEvent(3, 'session.state', { state: 'idle' }));
    expect(sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(40);
    expect(sent.map((e) => e.payload.state)).toEqual(['idle']);
  });

  it('treats error-bearing idle, stopped, and compacting as visible while keeping plain states hidden', () => {
    expect(isVisibleSessionStatePayload({ state: 'stopping', reason: 'user_cancel' })).toBe(true);
    expect(isVisibleSessionStatePayload({ state: 'stopped' })).toBe(true);
    expect(isVisibleSessionStatePayload({ state: 'compacting' })).toBe(true);
    expect(isVisibleSessionStatePayload({ state: 'started' })).toBe(true);
    expect(isVisibleSessionStatePayload({ state: 'starting' })).toBe(true);
    expect(isVisibleSessionStatePayload({ state: 'error' })).toBe(true);
    expect(isVisibleSessionStatePayload({ state: 'idle', error: 'crashed' })).toBe(true);
    expect(isVisibleSessionStatePayload({ state: 'idle' })).toBe(false);
    expect(isVisibleSessionStatePayload({ state: 'running' })).toBe(false);
    expect(isVisibleSessionStatePayload({ state: 'queued' })).toBe(false);
    expect(isVisibleSessionStatePayload({ text: 'synthetic-no-state' })).toBe(false);
  });
});
