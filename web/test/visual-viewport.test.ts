import { describe, expect, it, vi } from 'vitest';
import {
  boundedVisualViewportHeight,
  createSettledViewportUpdater,
} from '../src/visual-viewport.js';

describe('visual viewport height stabilization', () => {
  it('never lets a stale Safari visual viewport exceed the visible layout height', () => {
    expect(boundedVisualViewportHeight(1_100, 800, 780)).toBe(780);
    expect(boundedVisualViewportHeight(620, 800, 780)).toBe(620);
    expect(boundedVisualViewportHeight(Number.NaN, 800, 780)).toBeNull();
  });

  it('re-reads viewport geometry after Safari fires resize before updating height', () => {
    let nextId = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const timers = new Map<number, () => void>();
    const scheduler = {
      requestFrame: vi.fn((callback: FrameRequestCallback) => {
        const id = nextId++;
        frames.set(id, callback);
        return id;
      }),
      cancelFrame: vi.fn((handle: number) => { frames.delete(handle); }),
      setTimer: vi.fn((callback: () => void) => {
        const id = nextId++;
        timers.set(id, callback);
        return id;
      }),
      clearTimer: vi.fn((handle: number) => { timers.delete(handle); }),
    };
    let reportedHeight = 1_000;
    const updates: number[] = [];
    const updater = createSettledViewportUpdater(() => {
      updates.push(reportedHeight);
    }, scheduler);

    updater.schedule();
    expect(updates).toEqual([1_000]);

    reportedHeight = 760;
    const firstFrame = [...frames.entries()][0];
    if (!firstFrame) throw new Error('first animation frame was not scheduled');
    frames.delete(firstFrame[0]);
    firstFrame[1](0);

    reportedHeight = 740;
    const secondFrame = [...frames.entries()][0];
    if (!secondFrame) throw new Error('second animation frame was not scheduled');
    frames.delete(secondFrame[0]);
    secondFrame[1](16);

    reportedHeight = 720;
    const settle = [...timers.entries()][0];
    if (!settle) throw new Error('settle timer was not scheduled');
    timers.delete(settle[0]);
    settle[1]();

    expect(updates).toEqual([1_000, 760, 740, 720]);
  });

  it('cancels stale follow-up reads when a newer viewport event arrives', () => {
    let nextId = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const timers = new Map<number, () => void>();
    const scheduler = {
      requestFrame: (callback: FrameRequestCallback) => {
        const id = nextId++;
        frames.set(id, callback);
        return id;
      },
      cancelFrame: (handle: number) => { frames.delete(handle); },
      setTimer: (callback: () => void) => {
        const id = nextId++;
        timers.set(id, callback);
        return id;
      },
      clearTimer: (handle: number) => { timers.delete(handle); },
    };
    const update = vi.fn();
    const updater = createSettledViewportUpdater(update, scheduler);

    updater.schedule();
    const staleFrameIds = [...frames.keys()];
    const staleTimerIds = [...timers.keys()];
    updater.schedule();

    expect(update).toHaveBeenCalledTimes(2);
    expect(staleFrameIds.every((id) => !frames.has(id))).toBe(true);
    expect(staleTimerIds.every((id) => !timers.has(id))).toBe(true);

    updater.cancel();
    expect(frames.size).toBe(0);
    expect(timers.size).toBe(0);
  });
});
