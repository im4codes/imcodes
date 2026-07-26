import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { DAEMON_UPGRADE_BLOCKED_ACK_DISPOSITION } from '../../shared/daemon-upgrade.js';
import { UpgradeBlockedOutbox, type UpgradeInstallFailedMessage } from '../../src/daemon/upgrade-blocked-outbox.js';

const tempDirs: string[] = [];

function makeFixture(now = 10_000) {
  const dir = mkdtempSync(join(tmpdir(), 'imcodes-upgrade-blocked-outbox-'));
  tempDirs.push(dir);
  const file = join(dir, 'pending.json');
  const message: UpgradeInstallFailedMessage = {
    type: DAEMON_MSG.UPGRADE_BLOCKED,
    reason: 'install_failed',
    failureId: 'failure-1',
    upgradeId: 'upgrade-1',
    fromVersion: '2026.7.3157-dev.3556',
    targetVersion: '2026.7.3192-dev.3593',
    retryReason: 'stale-staging-dir',
    attempts: 5,
    exitCode: 217,
    log: '/tmp/imcodes-upgrade-test/upgrade.log',
    ts: now,
  };
  return { file, message, now };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('UpgradeBlockedOutbox', () => {
  it('retains an accepted terminal blocker so a later server restart can rebuild the target gate', async () => {
    const { file, message, now } = makeFixture();
    const first = new UpgradeBlockedOutbox(file, () => now);

    expect(await first.report(message, () => false)).toBe(false);
    expect(existsSync(file)).toBe(true);

    const afterRestart = new UpgradeBlockedOutbox(file, () => now + 1);
    const send = vi.fn(() => true);
    expect(await afterRestart.flushOnReconnect(send, message.fromVersion)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(message);
    expect(existsSync(file)).toBe(true);

    expect(await afterRestart.acknowledge(
      message.failureId,
      DAEMON_UPGRADE_BLOCKED_ACK_DISPOSITION.ACCEPTED,
    )).toBe(true);
    expect(existsSync(file)).toBe(true);

    const afterServerRestart = new UpgradeBlockedOutbox(file, () => now + 2);
    expect(await afterServerRestart.flushOnReconnect(send, message.fromVersion)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);

    expect(await afterServerRestart.acknowledge(
      message.failureId,
      DAEMON_UPGRADE_BLOCKED_ACK_DISPOSITION.OBSOLETE,
    )).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('clears a persisted failure superseded by a newer explicit manual upgrade', async () => {
    const { file, message, now } = makeFixture();
    const outbox = new UpgradeBlockedOutbox(file, () => now);
    await outbox.report(message, () => false);

    expect(await outbox.acknowledge(
      message.failureId,
      DAEMON_UPGRADE_BLOCKED_ACK_DISPOSITION.SUPERSEDED,
    )).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('clears an obsolete failure after a later daemon version starts', async () => {
    const { file, message, now } = makeFixture();
    const outbox = new UpgradeBlockedOutbox(file, () => now);
    await outbox.report(message, () => false);

    const send = vi.fn(() => true);
    expect(await outbox.flushOnReconnect(send, '2026.7.3192-dev.3593')).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
  });
});
