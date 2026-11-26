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

  it('normalizes zoomed documentElement.clientHeight across 60%..150% without false keyboard shrink or stale overflow', () => {
    // Closed soft keyboard on 360x780 across 60%, 90%, 100%, 125%, 150%:
    // zoomed <html> reports clientHeight ≈ Math.round(780 / zoom) (or floor).
    for (const cssZoom of [0.6, 0.9, 1, 1.25, 1.5]) {
      const roundedClientH = Math.round(780 / cssZoom);
      const flooredClientH = Math.floor(780 / cssZoom);
      expect(boundedVisualViewportHeight(780, 780, roundedClientH, cssZoom)).toBe(780);
      expect(boundedVisualViewportHeight(780, 780, flooredClientH, cssZoom)).toBe(780);
    }
    // Legacy WebView that scaled clientHeight by zoom (780 * 0.9 = 702) also normalizes to 780
    expect(boundedVisualViewportHeight(780, 780, 702, 0.9)).toBe(780);

    // Open soft keyboard on 360x780 (visualViewport shrinks to 450px):
    for (const cssZoom of [0.6, 0.9, 1, 1.25, 1.5]) {
      const zoomedClientH = Math.round(780 / cssZoom);
      const bounded = boundedVisualViewportHeight(450, 780, zoomedClientH, cssZoom);
      expect(bounded).toBe(450);
      expect(Math.max(0, 780 - bounded!)).toBe(330);
    }

    // Safari transient oversize visualViewport (1100px) with 20px chrome bar under 150% zoom (780 / 1.5 = 520)
    expect(boundedVisualViewportHeight(1_100, 800, 520, 1.5)).toBe(780);
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
