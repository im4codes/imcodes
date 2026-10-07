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
