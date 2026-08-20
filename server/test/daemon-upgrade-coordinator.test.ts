import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import { DAEMON_UPGRADE_DELIVERY_STATUS } from '../../shared/daemon-upgrade.js';
import { DaemonUpgradeCoordinator } from '../src/ws/daemon-upgrade-coordinator.js';
import {
  DaemonUpgradePublicationGate,
  daemonUpgradeTarballUrl,
  type DaemonUpgradePublicationProbeResult,
} from '../src/ws/daemon-upgrade-publication-gate.js';

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('DaemonUpgradeCoordinator npm publication gate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds the exact npm tarball URL used for target-version publication probes', () => {
    expect(daemonUpgradeTarballUrl('2026.4.905-dev.877')).toBe(
      'https://registry.npmjs.org/imcodes/-/imcodes-2026.4.905-dev.877.tgz',
    );
  });

  it('does not send daemon.upgrade until the target tarball is published, then caches the success', async () => {
    vi.useFakeTimers();
    const targetVersion = '2026.4.905-dev.877';
    const probe = vi.fn<[], Promise<DaemonUpgradePublicationProbeResult>>()
      .mockResolvedValueOnce({ status: 'missing', statusCode: 404 })
      .mockResolvedValueOnce({ status: 'available', statusCode: 200 });
    const gate = new DaemonUpgradePublicationGate({
      probe: async () => probe(),
      retryDelaysMs: [100],
    });
    const coordinator = new DaemonUpgradeCoordinator(gate);
    const sent: Record<string, unknown>[] = [];

    const result = coordinator.request({
      targetVersion,
      source: 'auto',
      isDaemonReady: () => true,
      isStillCurrent: () => true,
      send: (message) => sent.push(message),
      now: 0,
    });

    expect(result).toMatchObject({
      ok: true,
      targetVersion,
      deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.PENDING_PUBLICATION,
    });
    expect(sent).toEqual([]);
    expect(probe).toHaveBeenCalledTimes(1);

    await flushPromises();
    expect(sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(sent).toEqual([{
      type: DAEMON_COMMAND_TYPES.DAEMON_UPGRADE,
      upgradeId: expect.any(String),
      targetVersion,
    }]);

    const nextCoordinator = new DaemonUpgradeCoordinator(gate);
    const nextSent: Record<string, unknown>[] = [];
    const nextResult = nextCoordinator.request({
      targetVersion,
      source: 'manual',
      isDaemonReady: () => true,
      send: (message) => nextSent.push(message),
    });

    expect(nextResult.deliveryStatus).toBe(DAEMON_UPGRADE_DELIVERY_STATUS.SENT);
    expect(nextSent).toHaveLength(1);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('coalesces repeated requests for an unpublished target into one in-flight HEAD probe', async () => {
    let resolveProbe: ((result: DaemonUpgradePublicationProbeResult) => void) | null = null;
    const probe = vi.fn(() => new Promise<DaemonUpgradePublicationProbeResult>((resolve) => {
      resolveProbe = resolve;
    }));
    const gate = new DaemonUpgradePublicationGate({
      probe: async () => probe(),
      retryDelaysMs: [100],
    });
    const coordinator = new DaemonUpgradeCoordinator(gate);
    const targetVersion = '2026.4.906-dev.1';
    const sent: Record<string, unknown>[] = [];
    const request = {
      targetVersion,
      source: 'manual' as const,
      isDaemonReady: () => true,
      send: (message: Record<string, unknown>) => sent.push(message),
    };

    coordinator.request(request);
    coordinator.request(request);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);

    resolveProbe?.({ status: 'available', statusCode: 200 });
    await flushPromises();

    expect(sent).toHaveLength(1);
  });

  it('bypasses npm publication for controlled-node image artifacts', () => {
    const probe = vi.fn<[], Promise<DaemonUpgradePublicationProbeResult>>()
      .mockResolvedValue({ status: 'missing', statusCode: 404 });
    const coordinator = new DaemonUpgradeCoordinator(new DaemonUpgradePublicationGate({
      probe: async () => probe(),
      retryDelaysMs: [100],
    }));
    const sent: Record<string, unknown>[] = [];

    const result = coordinator.request({
      targetVersion: '2026.7.1234-dev.5',
      source: 'manual',
      skipPublicationGate: true,
      isDaemonReady: () => true,
      send: (message) => sent.push(message),
    });

    expect(result.deliveryStatus).toBe(DAEMON_UPGRADE_DELIVERY_STATUS.SENT);
    expect(sent).toEqual([{
      type: DAEMON_COMMAND_TYPES.DAEMON_UPGRADE,
      upgradeId: expect.any(String),
      targetVersion: '2026.7.1234-dev.5',
    }]);
    expect(probe).not.toHaveBeenCalled();
  });

  it('retries the current auto upgrade after a transient daemon block without 15-minute suppression', async () => {
    vi.useFakeTimers();
    const coordinator = new DaemonUpgradeCoordinator();
    const sent: Record<string, unknown>[] = [];
    const daemonReady = vi.fn(() => true);
    const stillCurrent = vi.fn(() => true);

    const result = coordinator.request({
      source: 'auto',
      isDaemonReady: daemonReady,
      isStillCurrent: stillCurrent,
      send: (message) => sent.push(message),
      now: 0,
    });

    expect(result.deliveryStatus).toBe(DAEMON_UPGRADE_DELIVERY_STATUS.SENT);
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(sent).toHaveLength(1);

    const retry = coordinator.retryAutoAfterBlocked({
      retryDelayMs: 1_000,
      isDaemonReady: daemonReady,
      isStillCurrent: stillCurrent,
      send: (message) => sent.push(message),
      now: 5_000,
    });

    expect(retry).toMatchObject({
      ok: true,
      deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.SENT,
    });
    await vi.advanceTimersByTimeAsync(999);
    await flushPromises();
    expect(sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(sent).toHaveLength(2);
  });

  it('keeps the same lifecycle pending and retries immediately after a legacy daemon restart', async () => {
    vi.useFakeTimers();
    const coordinator = new DaemonUpgradeCoordinator();
    const sent: Record<string, unknown>[] = [];
    let ready = true;
    const base = {
      targetVersion: '2026.8.3409-dev.3847',
      source: 'auto' as const,
      skipPublicationGate: true,
      isDaemonReady: () => ready,
      isStillCurrent: () => true,
      send: (message: Record<string, unknown>) => sent.push(message),
    };

    const first = coordinator.request({ ...base, now: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(sent).toHaveLength(1);
    for (let cycle = 0; cycle < 4; cycle += 1) {
      expect(coordinator.prepareRetryAfterDaemonRestart(5_001 + cycle)).toBe(true);
      expect(coordinator.prepareRetryAfterDaemonRestart(5_101 + cycle)).toBe(false);

      ready = false;
      const reconnect = coordinator.request({ ...base, now: 5_201 + cycle });
      expect(reconnect).toMatchObject({
        upgradeId: first.upgradeId,
        deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.PENDING_OFFLINE,
      });

      ready = true;
      const flushed = coordinator.flushPending({
        skipPublicationGate: true,
        isDaemonReady: () => ready,
        isStillCurrent: () => true,
        send: base.send,
      });
      expect(flushed).toMatchObject({
        upgradeId: first.upgradeId,
        deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.SENT,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await flushPromises();
      expect(sent).toHaveLength(cycle + 2);
    }
  });

  it('cancels a scheduled auto send and terminally blocks only that target until manual override', async () => {
    vi.useFakeTimers();
    const coordinator = new DaemonUpgradeCoordinator();
    const sent: Record<string, unknown>[] = [];
    const targetVersion = '2026.7.3192-dev.3593';
    const request = {
      targetVersion,
      source: 'auto' as const,
      skipPublicationGate: true,
      isDaemonReady: () => true,
      isStillCurrent: () => true,
      send: (message: Record<string, unknown>) => sent.push(message),
      now: 0,
    };

    expect(coordinator.request(request).deliveryStatus).toBe(DAEMON_UPGRADE_DELIVERY_STATUS.SENT);
    expect(coordinator.blockTargetAfterTerminalFailure(targetVersion, 1)).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(sent).toEqual([]);
    expect(coordinator.request({ ...request, now: 5_001 })).toMatchObject({
      deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.BACKOFF,
      reason: 'terminal_install_failure',
    });

    expect(coordinator.request({
      ...request,
      source: 'manual',
      now: 5_002,
    }).deliveryStatus).toBe(DAEMON_UPGRADE_DELIVERY_STATUS.SENT);
    expect(sent).toHaveLength(1);
  });

  it('keeps an offline manual lifecycle authoritative over reconnect auto traffic', () => {
    const coordinator = new DaemonUpgradeCoordinator();
    const sent: Record<string, unknown>[] = [];
    const targetVersion = '2026.7.3192-dev.3593';
    let ready = false;
    const base = {
      targetVersion,
      skipPublicationGate: true,
      isDaemonReady: () => ready,
      isStillCurrent: () => true,
      send: (message: Record<string, unknown>) => sent.push(message),
    };

    const manual = coordinator.request({ ...base, source: 'manual' });
    expect(manual.deliveryStatus).toBe(DAEMON_UPGRADE_DELIVERY_STATUS.PENDING_OFFLINE);

    const authAuto = coordinator.request({ ...base, source: 'auto' });
    expect(authAuto).toMatchObject({
      upgradeId: manual.upgradeId,
      deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.ALREADY_IN_PROGRESS,
    });

    ready = true;
    const flushed = coordinator.flushPending({
      skipPublicationGate: true,
      isDaemonReady: () => ready,
      isStillCurrent: () => true,
      send: (message) => sent.push(message),
    });
    expect(flushed).toMatchObject({
      upgradeId: manual.upgradeId,
      deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.SENT,
    });
    expect(sent).toEqual([{
      type: DAEMON_COMMAND_TYPES.DAEMON_UPGRADE,
      upgradeId: manual.upgradeId,
      targetVersion,
    }]);
  });

  it('identifies an older failure superseded by a newer manual lifecycle', () => {
    const coordinator = new DaemonUpgradeCoordinator();
    const targetVersion = '2026.7.3192-dev.3593';
    coordinator.blockTargetAfterTerminalFailure(targetVersion, 1);
    const manual = coordinator.request({
      targetVersion,
      source: 'manual',
      skipPublicationGate: true,
      isDaemonReady: () => false,
      send: () => {},
      now: 2,
    });

    expect(coordinator.isTerminalFailureSupersededByManual(targetVersion, 'older-upgrade')).toBe(true);
    expect(coordinator.isTerminalFailureSupersededByManual(targetVersion, manual.upgradeId)).toBe(false);
    expect(coordinator.hasManualLifecycleForTarget(targetVersion)).toBe(true);
  });

  it('allows a fresh auto lifecycle when the requested target version changes', async () => {
    vi.useFakeTimers();
    const coordinator = new DaemonUpgradeCoordinator();
    const sent: Record<string, unknown>[] = [];
    coordinator.blockTargetAfterTerminalFailure('2026.7.3192-dev.3593', 0);

    expect(coordinator.request({
      targetVersion: '2026.7.3193-dev.3594',
      source: 'auto',
      skipPublicationGate: true,
      isDaemonReady: () => true,
      isStillCurrent: () => true,
      send: (message) => sent.push(message),
      now: 1,
    }).deliveryStatus).toBe(DAEMON_UPGRADE_DELIVERY_STATUS.SENT);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(sent).toHaveLength(1);
  });
});
