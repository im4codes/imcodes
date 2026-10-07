import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTROLLED_NODE_UPGRADE_HEALTH,
  CONTROLLED_NODE_UPGRADE_RESULT_FILE,
  CONTROLLED_NODE_UPGRADE_RESULT_STATUS as S,
  CONTROLLED_NODE_UPGRADE_ROLLBACK_STALL_MS,
} from '../../shared/controlled-node-service.js';
import { DAEMON_UPGRADE_BLOCK_REASON } from '../../shared/daemon-upgrade.js';
import {
  readUpgradeResult,
  reconcilePreviousUpgrade,
  upgradeResultPathFor,
  writeUpgradeResult,
} from '../../src/node/upgrade-result.js';

const OLD = '2026.10.5462-dev.5926';
const TARGET = '2026.10.5470-dev.5934';
const NOW = 1_800_000_000_000;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function journalWith(record: Record<string, unknown> | string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'imcodes-upgrade-result-'));
  dirs.push(dir);
  const journalPath = join(dir, 'install-journal.json');
  if (record !== null) {
    await writeFile(upgradeResultPathFor(journalPath), typeof record === 'string' ? record : JSON.stringify(record));
  }
  return journalPath;
}

const reconcile = (journalPath: string, runningVersion = OLD, now = NOW) =>
  reconcilePreviousUpgrade({ journalPath, runningVersion, now });

describe('previous upgrade outcome (last-upgrade-result.json)', () => {
  it('reports a completed rollback as a failure of that exact target', async () => {
    const path = await journalWith({ status: S.ROLLED_BACK, failedPhase: 'restart_health', targetVersion: TARGET, recordedAt: NOW - 1 });
    expect(await reconcile(path)).toEqual({ targetVersion: TARGET, reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED });
    // Reported again on the next start until the node itself is on the target (the server dedups).
    expect(await reconcile(path)).toEqual({ targetVersion: TARGET, reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED });
  });

  it('reports a rollback that finished with failures under its own reason', async () => {
    const path = await journalWith({ status: S.ROLLBACK_FAILED, failedPhase: 'restart_health', targetVersion: TARGET, recordedAt: NOW - 1 });
    expect(await reconcile(path)).toEqual({ targetVersion: TARGET, reason: DAEMON_UPGRADE_BLOCK_REASON.ROLLBACK_FAILED });
  });

  it('a node running the target is the outcome: a stale rollback record becomes success and is never reported', async () => {
    // The real incident: a success was never recorded, the old rolled_back stayed, and the
    // long-installed target would have been reported as failed at the next start.
    const path = await journalWith({ status: S.ROLLED_BACK, failedPhase: 'restart_health', targetVersion: TARGET, recordedAt: NOW - 86_400_000, artifactSha256: 'a'.repeat(64) });
    expect(await reconcile(path, TARGET)).toBeNull();
    expect(await readUpgradeResult(path)).toMatchObject({
      status: S.SUCCESS, targetVersion: TARGET, recordedBy: 'node', artifactSha256: 'a'.repeat(64),
    });
    expect(await reconcile(path, TARGET)).toBeNull();
  });

  it('a rollback still being advanced by a live script is left alone', async () => {
    const path = await journalWith({
      status: S.ROLLBACK_STARTED, targetVersion: TARGET, failedPhase: 'restart_health',
      recordedAt: NOW - (CONTROLLED_NODE_UPGRADE_ROLLBACK_STALL_MS - 1_000), rollbackProgress: ['stop_new_node'],
    });
    expect(await reconcile(path)).toBeNull();
    expect((await readUpgradeResult(path))?.status).toBe(S.ROLLBACK_STARTED);
  });

  it('a rollback that stopped advancing was killed: recorded as interrupted and reported, not invisible forever', async () => {
    const path = await journalWith({
      status: S.ROLLBACK_STARTED, targetVersion: TARGET, failedPhase: 'restart_health',
      recordedAt: NOW - CONTROLLED_NODE_UPGRADE_ROLLBACK_STALL_MS - 1, rollbackProgress: ['stop_new_node', 'restore_main'],
    });
    expect(await reconcile(path)).toEqual({ targetVersion: TARGET, reason: DAEMON_UPGRADE_BLOCK_REASON.ROLLBACK_INTERRUPTED });
    expect(await readUpgradeResult(path)).toMatchObject({
      status: S.ROLLBACK_INTERRUPTED, targetVersion: TARGET, recordedBy: 'node', rollbackProgress: ['stop_new_node', 'restore_main'],
    });
    // Stable afterwards: still reported, same reason, no age maths involved.
    expect(await reconcile(path, OLD, NOW + 10 * 86_400_000)).toEqual({
      targetVersion: TARGET, reason: DAEMON_UPGRADE_BLOCK_REASON.ROLLBACK_INTERRUPTED,
    });
  });

  it('an in_progress record is inert while a transaction can still be running, and an abandoned one is a failed install', async () => {
    const window = CONTROLLED_NODE_UPGRADE_HEALTH.HARD_CAP_MS + CONTROLLED_NODE_UPGRADE_ROLLBACK_STALL_MS;
    const live = await journalWith({ status: S.IN_PROGRESS, targetVersion: TARGET, recordedAt: NOW - window + 1_000 });
    expect(await reconcile(live)).toBeNull();
    const dead = await journalWith({ status: S.IN_PROGRESS, targetVersion: TARGET, recordedAt: NOW - window - 1 });
    expect(await reconcile(dead)).toEqual({ targetVersion: TARGET, reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED });
    expect(await readUpgradeResult(dead)).toMatchObject({ status: S.ROLLED_BACK, failedPhase: 'interrupted', recordedBy: 'node' });
  });

  it.each([
    ['success', { status: S.SUCCESS, targetVersion: TARGET }],
    ['a preflight failure (nothing was replaced)', { status: 'preflight_failed', targetVersion: TARGET }],
    ['an unknown status from a newer build', { status: 'something_new', targetVersion: TARGET, recordedAt: 1 }],
    ['a record without a target', { status: S.ROLLED_BACK }],
    ['a target that is not a version', { status: S.ROLLED_BACK, targetVersion: 'latest; rm -rf /' }],
    ['not JSON', 'not json at all'],
    ['a JSON array', '[1,2,3]'],
    ['no file', null],
  ])('ignores %s', async (_name, record) => {
    const path = await journalWith(record as never);
    expect(await reconcile(path)).toBeNull();
  });

  it('reads the record format written by older upgrade scripts (no node-written fields)', async () => {
    const path = await journalWith({
      schemaVersion: 1, status: 'rolled_back', phase: 'rollback', failedPhase: 'restart_health',
      targetVersion: TARGET, reason: 'controlled node upgrade failed authenticated health verification',
      recordedAt: NOW - 5, completedAt: NOW - 5, recoveryFailures: [], mainArtifactVerified: true,
    });
    expect(await reconcile(path)).toEqual({ targetVersion: TARGET, reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED });
  });

  it('writes atomically and leaves no temporary file', async () => {
    const path = await journalWith(null);
    await writeUpgradeResult(path, { status: S.SUCCESS, targetVersion: TARGET });
    expect(JSON.parse(await readFile(upgradeResultPathFor(path), 'utf8'))).toMatchObject({ schemaVersion: 1, status: S.SUCCESS });
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(join(path, '..'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(upgradeResultPathFor(path).endsWith(CONTROLLED_NODE_UPGRADE_RESULT_FILE)).toBe(true);
  });
});

describe('stale POSIX upgrade files', () => {
  it('removes exactly the rollback images and half-staged files the upgrade script creates, nothing else', async () => {
    const { mkdir: mk, readdir: rd } = await import('node:fs/promises');
    const { removeStalePosixUpgradeFiles } = await import('../../src/node/upgrade-result.js');
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-stale-upgrade-'));
    dirs.push(dir);
    const exe = join(dir, 'imcodes-node-linux');
    const journal = join(dir, 'install-journal.json');
    const stale = [
      'imcodes-node-linux.upgrade-old', 'imcodes-node-linux.manifest.json.upgrade-old', 'install-journal.json.upgrade-old',
      'imcodes-node-linux.service-def-0.upgrade-old', 'imcodes-node-linux.new', 'imcodes-node-linux.manifest.json.new',
      'install-journal.json.new',
    ];
    const keep = [
      'imcodes-node-linux', 'imcodes-node-linux.manifest.json', 'install-journal.json', 'credential.json',
      'health-lease.json', 'last-upgrade-result.json', 'unrelated.upgrade-old', 'other-node.upgrade-old',
    ];
    for (const name of [...stale, ...keep]) await writeFile(join(dir, name), 'x');
    for (const name of ['computer-use-helper.upgrade-old', 'remote-desktop-worker.upgrade-old', 'remote-desktop-worker.new']) {
      await mk(join(dir, name));
      await writeFile(join(dir, name, 'file'), 'x');
    }
    await mk(join(dir, 'remote-desktop-worker'));
    await removeStalePosixUpgradeFiles(exe, journal);
    expect((await rd(dir)).sort()).toEqual([...keep, 'remote-desktop-worker'].sort());
    // a missing directory is not an error
    await expect(removeStalePosixUpgradeFiles(join(dir, 'gone', 'node'), journal)).resolves.toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')('readPreviousUpgradeFailure on POSIX', () => {
  it('reports a rolled-back target, and clears the images a killed script left only once its upgrade is recorded as finished', async () => {
    const { readPreviousUpgradeFailure } = await import('../../src/node/self-upgrade.js');
    const journalPath = await journalWith({ status: S.ROLLED_BACK, targetVersion: TARGET, recordedAt: NOW - 1 });
    const exe = join(journalPath, '..', 'imcodes-node-linux');
    await writeFile(`${exe}.upgrade-old`, 'previous image');
    expect(await readPreviousUpgradeFailure(journalPath, OLD, NOW, exe))
      .toEqual({ targetVersion: TARGET, reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED });
    // a failed attempt may still need its images: untouched
    expect(await readFile(`${exe}.upgrade-old`, 'utf8')).toBe('previous image');

    await writeUpgradeResult(journalPath, { status: S.SUCCESS, targetVersion: TARGET, recordedAt: NOW });
    expect(await readPreviousUpgradeFailure(journalPath, TARGET, NOW, exe)).toBeNull();
    await expect(readFile(`${exe}.upgrade-old`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the images while the record is still in_progress for the running version (the script may be alive)', async () => {
    const { readPreviousUpgradeFailure } = await import('../../src/node/self-upgrade.js');
    const journalPath = await journalWith({ status: S.IN_PROGRESS, targetVersion: TARGET, recordedAt: NOW - 1 });
    const exe = join(journalPath, '..', 'imcodes-node-linux');
    await writeFile(`${exe}.upgrade-old`, 'previous image');
    expect(await readPreviousUpgradeFailure(journalPath, TARGET, NOW, exe)).toBeNull();
    expect(await readFile(`${exe}.upgrade-old`, 'utf8')).toBe('previous image');
  });
});
