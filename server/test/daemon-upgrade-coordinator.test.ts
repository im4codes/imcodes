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
});

