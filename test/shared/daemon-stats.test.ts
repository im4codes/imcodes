import { describe, expect, it } from 'vitest';
import {
  DAEMON_LIVENESS_FRESH_MS,
  hasAnyDaemonSystemStats,
  hasDaemonLiveness,
  isDaemonMainLoopBusy,
  mergeDaemonLiveness,
  mergeDaemonStats,
  type DaemonStatsView,
} from '../../shared/daemon-stats.js';

const full = {
  daemonVersion: '1.0.0', latestDaemonVersion: null,
  cpu: 12, memUsed: 100, memTotal: 200, load1: 1, load5: 2, load15: 3, uptime: 4_000,
  disks: [{ mount: '/', totalBytes: 10, usedBytes: 5, usedPercent: 50 }],
  embedding: { state: 'ready' },
};

describe('daemon status frame merging', () => {
  it('classifies frames by what they carry', () => {
    expect(hasAnyDaemonSystemStats({ cpu: 1 })).toBe(true);
    expect(hasAnyDaemonSystemStats({ mainEventLoopBusy: true })).toBe(false);
    expect(hasDaemonLiveness({ mainEventLoopBlockedMs: 5 })).toBe(true);
    expect(hasDaemonLiveness({ mainEventLoopBlockedMs: 'x' })).toBe(false);
    expect(hasDaemonLiveness({ cpu: 1 })).toBe(false);
  });

  it('a liveness frame after full stats keeps every stat and updates only liveness', () => {
    const stats = mergeDaemonStats<DaemonStatsView>(null, full, 1_000);
    const next = mergeDaemonLiveness(stats, {
      daemonVersion: '1.0.1', mainEventLoopLagMs: 4, mainEventLoopBlockedMs: 30_000, mainEventLoopBusy: true,
    }, 2_000) as DaemonStatsView & Record<string, unknown>;
    expect(next).toMatchObject({
      cpu: 12, memUsed: 100, memTotal: 200, load1: 1, load5: 2, load15: 3, uptime: 4_000,
      disks: full.disks, embedding: full.embedding,
      daemonVersion: '1.0.1',
      mainEventLoopLagMs: 4, mainEventLoopBlockedMs: 30_000, mainEventLoopBusy: true, mainEventLoopObservedAt: 2_000,
    });
  });

  it('a stats frame missing or corrupting numbers cannot blank what was already known', () => {
    const stats = mergeDaemonStats<DaemonStatsView>(null, full, 1_000);
    const next = mergeDaemonStats(stats, {
      daemonVersion: '1.0.0', cpu: undefined, memUsed: Number.NaN, memTotal: Infinity, load1: null, load5: 'x', uptime: -Infinity,
      disks: 'nope', embedding: 'nope',
    }, 2_000) as DaemonStatsView & Record<string, unknown>;
    expect(next).toMatchObject({ cpu: 12, memUsed: 100, memTotal: 200, load1: 1, load5: 2, load15: 3, uptime: 4_000, disks: full.disks, embedding: full.embedding });
    for (const key of ['cpu', 'memUsed', 'memTotal', 'load1', 'load5', 'load15', 'uptime'] as const) {
      expect(Number.isFinite(next[key])).toBe(true);
    }
  });

  it('a main-thread stats frame without liveness keeps the last liveness until fresh liveness replaces it', () => {
    let view = mergeDaemonLiveness<DaemonStatsView>(null, { mainEventLoopLagMs: 4, mainEventLoopBlockedMs: 30_000, mainEventLoopBusy: true }, 1_000);
    view = mergeDaemonStats(view, full, 2_000);
    expect(view).toMatchObject({ mainEventLoopBusy: true, mainEventLoopBlockedMs: 30_000, mainEventLoopObservedAt: 1_000 });
    view = mergeDaemonLiveness(view, { mainEventLoopBusy: false }, 3_000);
    expect(view.mainEventLoopBusy).toBe(false);
    // One heartbeat is the whole liveness picture: no stale lag beside a fresh flag.
    expect(view.mainEventLoopBlockedMs).toBeUndefined();
    expect(view.mainEventLoopLagMs).toBeUndefined();
  });

  it('shows the busy hint only while its liveness is fresh', () => {
    const view = mergeDaemonLiveness<DaemonStatsView>(null, { mainEventLoopBusy: true }, 10_000);
    expect(isDaemonMainLoopBusy(view, 10_000 + DAEMON_LIVENESS_FRESH_MS)).toBe(true);
    expect(isDaemonMainLoopBusy(view, 10_000 + DAEMON_LIVENESS_FRESH_MS + 1)).toBe(false);
    expect(isDaemonMainLoopBusy(null)).toBe(false);
  });
});
