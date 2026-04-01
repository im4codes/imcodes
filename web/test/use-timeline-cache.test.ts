/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TimelineEvent } from '../src/ws-client.js';
import {
  __getTimelineCacheKeysForTests,
  __resetTimelineCacheForTests,
  __setTimelineCacheForTests,
} from '../src/hooks/useTimeline.js';

function makeEvents(sessionId: string, count: number): TimelineEvent[] {
  return Array.from({ length: count }, (_, idx) => ({
    eventId: `${sessionId}-${idx}`,
    sessionId,
    ts: idx,
    epoch: 1,
    seq: idx,
    source: 'daemon',
    confidence: 'high',
    type: 'assistant.text',
    payload: { text: `${sessionId}-${idx}` },
  }));
}

describe('useTimeline global cache bounds', () => {
  beforeEach(() => {
    __resetTimelineCacheForTests();
  });

  it('evicts least recently used sessions when session-count cap is exceeded', () => {
    for (let i = 0; i < 13; i++) {
      __setTimelineCacheForTests(`server:s${i}`, makeEvents(`s${i}`, 100));
    }

    const keys = __getTimelineCacheKeysForTests();
    expect(keys).toHaveLength(12);
    expect(keys).not.toContain('server:s0');
    expect(keys).toContain('server:s12');
  });

  it('evicts older sessions when total cached events exceed the global cap', () => {
    __setTimelineCacheForTests('server:a', makeEvents('a', 4000));
    __setTimelineCacheForTests('server:b', makeEvents('b', 4000));
    __setTimelineCacheForTests('server:c', makeEvents('c', 4000));
    __setTimelineCacheForTests('server:d', makeEvents('d', 4000));

    const keys = __getTimelineCacheKeysForTests();
    expect(keys).toHaveLength(3);
    expect(keys).not.toContain('server:a');
    expect(keys).toContain('server:b');
    expect(keys).toContain('server:c');
    expect(keys).toContain('server:d');
  });
});
