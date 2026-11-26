import { describe, expect, it } from 'vitest';
import { formatTaskDuration, resolveTaskDurationMs } from '../src/util/tool-duration.js';

const units = { day: 'd', hour: 'h', minute: 'm', second: 's', separator: ' ' };

describe('task duration resolution', () => {
  it('counts active work from start to now and formats compactly', () => {
    expect(resolveTaskDurationMs({ startedAt: 1_000, now: 61_000 })).toBe(60_000);
    expect(formatTaskDuration({ startedAt: 1_000, now: 61_000 }, units)).toBe('1m 0s');
  });

  it('freezes terminal duration at finished/ended time', () => {
    expect(resolveTaskDurationMs({ startedAt: 1_000, finishedAt: 3661_000, now: 99_000_000, terminal: true })).toBe(3_660_000);
    expect(resolveTaskDurationMs({ startedAt: 1_000, endedAt: 3_661_000, terminal: true })).toBe(3_660_000);
  });

  it('honours explicit zero duration and clamps clock rollback to zero', () => {
    expect(resolveTaskDurationMs({ startedAt: 10_000, durationMs: 0, now: 99_000 })).toBe(0);
    expect(resolveTaskDurationMs({ startedAt: 10_000, now: 9_000 })).toBe(0);
    expect(formatTaskDuration({ startedAt: 10_000, now: 9_000 }, units)).toBe('0s');
  });

  it('does not fabricate a value for missing or malformed legacy timestamps', () => {
    expect(resolveTaskDurationMs({ now: 20_000 })).toBeUndefined();
    expect(resolveTaskDurationMs({ startedAt: 'not-a-time', now: 20_000 })).toBeUndefined();
    expect(resolveTaskDurationMs({ startedAt: 1_000, now: Number.NaN })).toBeUndefined();
    expect(formatTaskDuration({ startedAt: 1_000, now: Number.NaN }, units)).toBeUndefined();
  });

  it('prefers the authoritative duration in replayed terminal payloads', () => {
    expect(formatTaskDuration({ startedAt: 1_000, durationMs: 86_400_000 + 3_600_000, updatedAt: 2_000, terminal: true }, units)).toBe('1d 1h');
  });
});
