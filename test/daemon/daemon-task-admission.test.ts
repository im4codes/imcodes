import { describe, expect, it } from 'vitest';
import { DaemonTaskAdmissionController } from '../../src/daemon/daemon-task-admission.js';

describe('daemon task admission', () => {
  it('atomically reserves per-session memory and releases only for the exact owner', () => {
    const controller = new DaemonTaskAdmissionController({
      daemonMaxRssBytes: 1_000,
      sessionMaxBytes: 100,
      systemMinFreeBytes: 10,
      reservationBytes: 45,
      reservationTtlMs: 1_000,
      memoryUsage: () => ({ rss: 100 }),
      systemFreeBytes: () => 1_000,
    });
    const first = controller.acquire('deck_a', 0);
    expect(first.action).toBe('accept');
    expect(first.token).toBeTruthy();
    expect(controller.acquire('deck_a', 0).action).toBe('queue');
    expect(controller.release('deck_other', first.token!)).toBe(false);
    expect(controller.release('deck_a', first.token!)).toBe(true);
    expect(controller.release('deck_a', first.token!)).toBe(false);
    expect(controller.acquire('deck_a', 0).action).toBe('accept');
  });

  it('reaps a crashed request reservation and hard-rejects unsafe daemon memory', () => {
    let now = 100;
    let rss = 100;
    const controller = new DaemonTaskAdmissionController({
      daemonMaxRssBytes: 200,
      sessionMaxBytes: 100,
      systemMinFreeBytes: 10,
      reservationBytes: 60,
      reservationTtlMs: 50,
      memoryUsage: () => ({ rss }),
      systemFreeBytes: () => 1_000,
      now: () => now,
    });
    expect(controller.acquire('deck_a', 0).action).toBe('accept');
    expect(controller.acquire('deck_a', 0).action).toBe('reject');
    now = 151;
    expect(controller.acquire('deck_a', 0).action).toBe('accept');
    rss = 201;
    expect(controller.acquire('deck_b', 0).action).toBe('reject');
  });
});
