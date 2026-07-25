/**
 * The healing fix (activation / reconnect requesting a no-lower-bound window)
 * removes the user-visible symptom of dropped timeline events, which is exactly
 * why the drop itself has to become a number. These tests pin the classifier so
 * the counters cannot silently start counting the wrong thing:
 *
 *  - content-bearing events (a lost one leaves a hole in the chat) are counted;
 *  - status/telemetry chatter is NOT — `agent.status` fires about once a second
 *    during a turn and would bury the signal under noise.
 */
import { describe, expect, it } from 'vitest';

import {
  TIMELINE_DELIVERY_METRICS,
  isContentBearingTimelineEvent,
  timelineEventTypeOf,
} from '../../shared/timeline-delivery-telemetry.js';

describe('timeline delivery telemetry classifier', () => {
  it('counts events whose loss leaves a visible hole in the chat', () => {
    for (const type of [
      'user.message',
      'assistant.text',
      'tool.call',
      'tool.result',
      'file.change',
      'ask.question',
      'peer_audit.result',
    ]) {
      expect(isContentBearingTimelineEvent({ type })).toBe(true);
    }
  });

  it('ignores high-frequency status/telemetry so it cannot drown the signal', () => {
    for (const type of [
      'agent.status',
      'usage.update',
      'session.state',
      'assistant.thinking',
      'memory.context',
      'memory.compression',
      'transport.queue.snapshot',
      'command.ack',
    ]) {
      expect(isContentBearingTimelineEvent({ type })).toBe(false);
    }
  });

  it('treats unknown and malformed events as non-counting (fail closed)', () => {
    // A future noisy event type must not inflate the drop series by default.
    expect(isContentBearingTimelineEvent({ type: 'something.new' })).toBe(false);
    expect(isContentBearingTimelineEvent({})).toBe(false);
    expect(isContentBearingTimelineEvent(null)).toBe(false);
    expect(isContentBearingTimelineEvent(undefined)).toBe(false);
    expect(isContentBearingTimelineEvent('assistant.text')).toBe(false);
    expect(isContentBearingTimelineEvent([{ type: 'assistant.text' }])).toBe(false);
  });

  it('reads the inner event type out of a timeline.event envelope', () => {
    expect(timelineEventTypeOf({ type: 'timeline.event', event: { type: 'assistant.text' } }))
      .toBe('assistant.text');
    expect(timelineEventTypeOf({ type: 'timeline.event' })).toBeUndefined();
    expect(timelineEventTypeOf({ type: 'timeline.event', event: null })).toBeUndefined();
    expect(timelineEventTypeOf(null)).toBeUndefined();
  });

  it('keeps one shared counter name per drop site so daemon and server agree', () => {
    // Daemon and server both emit these; drifting names would split the series
    // and hide a regression in plain sight.
    expect(TIMELINE_DELIVERY_METRICS.DAEMON_LINK_DOWN_DROPPED)
      .toBe('timeline.delivery.daemon_link_down_dropped');
    expect(TIMELINE_DELIVERY_METRICS.SERVER_NO_SUBSCRIBER_DROPPED)
      .toBe('timeline.delivery.server_no_subscriber_dropped');
    expect(TIMELINE_DELIVERY_METRICS.SERVER_DELIVERED)
      .toBe('timeline.delivery.server_delivered');
    expect(new Set(Object.values(TIMELINE_DELIVERY_METRICS)).size)
      .toBe(Object.values(TIMELINE_DELIVERY_METRICS).length);
  });
});
