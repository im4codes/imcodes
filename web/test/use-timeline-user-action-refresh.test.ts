import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_TIMELINE_REFRESH_EVENT,
  requestActiveTimelineRefreshAfterUserAction,
} from '../src/hooks/useTimeline.js';

describe('requestActiveTimelineRefreshAfterUserAction', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches an immediate and delayed active timeline refresh burst', () => {
    vi.useFakeTimers();
    const seenAt: number[] = [];
    const handler = () => seenAt.push(Date.now());
    window.addEventListener(ACTIVE_TIMELINE_REFRESH_EVENT, handler);
    try {
      requestActiveTimelineRefreshAfterUserAction();
      expect(seenAt.length).toBeGreaterThanOrEqual(1);

      const afterImmediate = seenAt.length;
      vi.advanceTimersByTime(600);
      expect(seenAt.length).toBeGreaterThan(afterImmediate);

      const afterFirstDelay = seenAt.length;
      vi.advanceTimersByTime(1200);
      expect(seenAt.length).toBeGreaterThan(afterFirstDelay);
    } finally {
      window.removeEventListener(ACTIVE_TIMELINE_REFRESH_EVENT, handler);
    }
  });
});
