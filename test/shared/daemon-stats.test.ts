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

  it('a full frame is authoritative for optional objects: what it omits or sends malformed clears', () => {
    const failing = { stage: 'persist_store', failures: 3, lastFailureAt: 1, lastError: 'ENOSPC' };
    const direct = { state: 'available' };
    let view = mergeDaemonStats<DaemonStatsView>(null, { ...full, shortRefHealth: failing, directConnectivity: direct }, 1_000) as DaemonStatsView & Record<string, unknown>;
    expect(view.shortRefHealth).toEqual(failing);
    expect(view.directConnectivity).toEqual(direct);
    expect(view.disks).toEqual(full.disks);
    expect(view.embedding).toEqual(full.embedding);

    // Recovery: the daemon stops sending shortRefHealth. The alert must clear.
    const { disks: _disks, embedding: _embedding, ...healthyWithoutObjects } = full;
    view = mergeDaemonStats(view, healthyWithoutObjects, 2_000) as typeof view;
    expect(view.shortRefHealth).toBeNull();
    expect(view.directConnectivity).toBeNull();
    expect(view.disks).toBeNull();
    expect(view.embedding).toBeNull();
    expect(view.cpu).toBe(12);

    // Malformed optional values are "none", not the previous value.
    view = mergeDaemonStats(view, { ...full, shortRefHealth: failing }, 3_000) as typeof view;
    view = mergeDaemonStats(view, { ...full, shortRefHealth: 'disk full', disks: 'nope', embedding: 7, directConnectivity: [] }, 4_000) as typeof view;
    expect(view).toMatchObject({ shortRefHealth: null, disks: null, embedding: null, directConnectivity: null });
  });

  it('a number-less (degraded) frame keeps the previous optional objects', () => {
    const failing = { stage: 'persist_store', failures: 3, lastFailureAt: 1, lastError: 'ENOSPC' };
    let view = mergeDaemonStats<DaemonStatsView>(null, { ...full, shortRefHealth: failing }, 1_000) as DaemonStatsView & Record<string, unknown>;
    view = mergeDaemonStats(view, { daemonVersion: '1.0.0' }, 2_000) as typeof view;
    expect(view.shortRefHealth).toEqual(failing);
    expect(view.disks).toEqual(full.disks);
    expect(view.embedding).toEqual(full.embedding);
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

describe('automatic-upgrade status on the stats frame', () => {
  const frame = { cpu: 1, memUsed: 1, memTotal: 2, load1: 0, load5: 0, load15: 0, uptime: 1 };
  const auto = { status: 'deferred', reason: 'session_busy', targetVersion: '2.0.0', nextRetryAt: 123 };

  it('shows the pending automatic upgrade and clears it as soon as a full frame omits it', () => {
    const waiting = mergeDaemonStats<DaemonStatsView>(null, { ...frame, autoUpgrade: auto });
    expect(waiting.autoUpgrade).toEqual(auto);
    expect(mergeDaemonStats<DaemonStatsView>(waiting, { ...frame }).autoUpgrade).toBeNull();
  });

  it('ignores a malformed value and never lets a number-less frame blank it', () => {
    const waiting = mergeDaemonStats<DaemonStatsView>(null, { ...frame, autoUpgrade: auto });
    expect(mergeDaemonStats<DaemonStatsView>(waiting, { ...frame, autoUpgrade: 'junk' }).autoUpgrade).toBeNull();
    expect(mergeDaemonStats<DaemonStatsView>(waiting, { daemonVersion: '1.0.1' }).autoUpgrade).toEqual(auto);
  });
});

