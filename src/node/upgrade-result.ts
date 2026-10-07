import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CONTROLLED_NODE_UPGRADE_HEALTH,
  CONTROLLED_NODE_UPGRADE_RESULT_FILE,
  CONTROLLED_NODE_UPGRADE_RESULT_STATUS,
  CONTROLLED_NODE_UPGRADE_ROLLBACK_STALL_MS,
} from '../../shared/controlled-node-service.js';
import { DAEMON_UPGRADE_BLOCK_REASON } from '../../shared/daemon-upgrade.js';

/**
 * The durable outcome of the last Windows self-upgrade (`last-upgrade-result.json`).
 *
 * Two writers share it: the one-shot upgrade script (`in_progress`, the rollback
 * steps, and its own terminal states) and the node itself. The NODE is the
 * authority for success and for finding an abandoned attempt: the script runs
 * inside a scheduled task that the healthy node deletes, so it can be gone before
 * it writes its own `success`, and a script that is killed mid-rollback never
 * writes any terminal state at all.
 */
export interface UpgradeResultRecord {
  status: string;
  targetVersion?: string;
  failedPhase?: string;
  reason?: string;
  error?: string;
  recordedAt?: number;
  completedAt?: number;
  rollbackProgress?: string[];
  [key: string]: unknown;
}

const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){1,3}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

/** The result file sits beside the install journal (the executable's directory). */
export function upgradeResultPathFor(journalPath: string): string {
  return join(dirname(journalPath), CONTROLLED_NODE_UPGRADE_RESULT_FILE);
}

export async function readUpgradeResult(journalPath: string): Promise<UpgradeResultRecord | null> {
  try {
    const raw = JSON.parse(await readFile(upgradeResultPathFor(journalPath), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as UpgradeResultRecord;
    return typeof record.status === 'string' ? record : null;
  } catch {
    return null;
  }
}

/** Atomic replace; a reader (or a concurrent script write) never sees a torn file. */
export async function writeUpgradeResult(journalPath: string, record: UpgradeResultRecord): Promise<void> {
  const path = upgradeResultPathFor(journalPath);
  const temporary = `${path}.node-${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, ...record }), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export interface PreviousUpgradeFailure {
  targetVersion: string;
  /** Wire reason for the server's failure backoff (a DAEMON_UPGRADE_BLOCK_REASON). */
  reason: string;
}

/** An `in_progress` record older than a full transaction (health cap + rollback) is abandoned. */
const IN_PROGRESS_ABANDONED_MS = CONTROLLED_NODE_UPGRADE_HEALTH.HARD_CAP_MS + CONTROLLED_NODE_UPGRADE_ROLLBACK_STALL_MS;

/**
 * Decide, from the durable record and the version this node is running, what the
 * previous upgrade attempt amounted to — and repair the record when it is stale.
 *
 * - The node running the target IS the outcome: the record becomes `success`
 *   whatever the script managed to write (or not).
 * - `rolled_back` / `rollback_failed` / `rollback_interrupted`: a failure of that
 *   exact target, reported to the server (which applies its own backoff).
 * - `rollback_started` that stopped advancing: the rollback script died. The node
 *   is by now running a previous image (the transaction recovery has restored or
 *   adopted it), so it is recorded as `rollback_interrupted` and reported once
 *   instead of staying invisible forever.
 * - `in_progress` that outlived any possible transaction: the script died before
 *   any outcome; the target never got installed.
 * Anything else (`success`, preflight failures, unparseable files, a record still
 * being advanced by a live script) is inert.
 */
export async function reconcilePreviousUpgrade(input: {
  journalPath: string;
  runningVersion: string;
  now: number;
}): Promise<PreviousUpgradeFailure | null> {
  const record = await readUpgradeResult(input.journalPath);
  if (!record || typeof record.targetVersion !== 'string') return null;
  const targetVersion = record.targetVersion.trim();
  if (!VERSION_PATTERN.test(targetVersion)) return null;
  const S = CONTROLLED_NODE_UPGRADE_RESULT_STATUS;
  if (record.status === S.SUCCESS) return null;

  const base = {
    targetVersion,
    ...(typeof record.artifactSha256 === 'string' ? { artifactSha256: record.artifactSha256 } : {}),
  };
  if (targetVersion === input.runningVersion) {
    await writeUpgradeResult(input.journalPath, {
      ...base, status: S.SUCCESS, phase: 'complete', completedAt: input.now, recordedAt: input.now, recordedBy: 'node',
    }).catch(() => {});
    return null;
  }

  const recordedAt = typeof record.recordedAt === 'number' ? record.recordedAt : 0;
  const age = input.now - recordedAt;
  switch (record.status) {
    case S.ROLLED_BACK:
      return { targetVersion, reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED };
    case S.ROLLBACK_FAILED:
      return { targetVersion, reason: DAEMON_UPGRADE_BLOCK_REASON.ROLLBACK_FAILED };
    case S.ROLLBACK_INTERRUPTED:
      return { targetVersion, reason: DAEMON_UPGRADE_BLOCK_REASON.ROLLBACK_INTERRUPTED };
    case S.ROLLBACK_STARTED:
      if (age < CONTROLLED_NODE_UPGRADE_ROLLBACK_STALL_MS) return null;
      await writeUpgradeResult(input.journalPath, {
        ...record, status: S.ROLLBACK_INTERRUPTED, completedAt: input.now, recordedAt: input.now, recordedBy: 'node',
      }).catch(() => {});
      return { targetVersion, reason: DAEMON_UPGRADE_BLOCK_REASON.ROLLBACK_INTERRUPTED };
    case S.IN_PROGRESS:
      if (age < IN_PROGRESS_ABANDONED_MS) return null;
      await writeUpgradeResult(input.journalPath, {
        ...record, status: S.ROLLED_BACK, failedPhase: 'interrupted', completedAt: input.now, recordedAt: input.now, recordedBy: 'node',
      }).catch(() => {});
      return { targetVersion, reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED };
    default:
      return null;
  }
}
