import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CONTROLLED_NODE_WINDOWS_UPGRADE_PRODUCT,
  CONTROLLED_NODE_WINDOWS_UPGRADE_TASK_PREFIX,
  CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_FILE,
  CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_VERSION,
} from '../../shared/controlled-node-service.js';
import type { StagedExecutableReceipt } from './enrollment.js';
import { loadInstallJournal, writeInstallPhase, type InstallJournal } from './install-journal.js';

export interface WindowsUpgradeTransaction {
  version: typeof CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_VERSION;
  product: typeof CONTROLLED_NODE_WINDOWS_UPGRADE_PRODUCT;
  startedAt: number;
  targetVersion: string;
  taskName: string;
  executablePath: string;
  backupExecutablePath: string;
  journalPath: string;
  backupJournalPath: string;
  previousReceipt: StagedExecutableReceipt;
  targetReceipt: StagedExecutableReceipt;
}

export type WindowsUpgradeRecoveryOutcome =
  | 'none'
  | 'target_receipt_completed'
  | 'previous_receipt_restored'
  | 'trusted_executable_adopted'
  | 'rollback_resumed';

function isReceipt(value: unknown): value is StagedExecutableReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return typeof r.path === 'string' && r.path.length > 0
    && typeof r.size === 'number' && Number.isSafeInteger(r.size) && r.size > 0
    && typeof r.sha256 === 'string' && /^[a-f0-9]{64}$/.test(r.sha256);
}

function parseTransaction(raw: string): WindowsUpgradeTransaction | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.version !== CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_VERSION
    || r.product !== CONTROLLED_NODE_WINDOWS_UPGRADE_PRODUCT
    || typeof r.startedAt !== 'number' || !Number.isSafeInteger(r.startedAt)
    || typeof r.targetVersion !== 'string' || r.targetVersion.length > 128
    || typeof r.taskName !== 'string' || !r.taskName.startsWith(CONTROLLED_NODE_WINDOWS_UPGRADE_TASK_PREFIX)
    || typeof r.executablePath !== 'string' || typeof r.backupExecutablePath !== 'string'
    || typeof r.journalPath !== 'string' || typeof r.backupJournalPath !== 'string'
    || !isReceipt(r.previousReceipt) || !isReceipt(r.targetReceipt)) return null;
  return r as unknown as WindowsUpgradeTransaction;
}

async function sha256File(path: string): Promise<{ sha256: string; size: number; mtimeMs: number; ctimeMs: number; dev?: number; ino?: number } | null> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) return null;
    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(path);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.once('error', reject);
      stream.once('end', resolve);
    });
    const after = await lstat(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('controlled node executable changed during upgrade recovery inspection');
    }
    return {
      sha256: hash.digest('hex'), size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs,
      ...(typeof after.dev === 'number' ? { dev: after.dev } : {}),
      ...(typeof after.ino === 'number' ? { ino: after.ino } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function matches(file: Awaited<ReturnType<typeof sha256File>>, receipt: StagedExecutableReceipt): boolean {
  return file !== null && file.size === receipt.size && file.sha256 === receipt.sha256;
}

function receiptForCurrent(path: string, file: NonNullable<Awaited<ReturnType<typeof sha256File>>>): StagedExecutableReceipt {
  const identity = {
    size: file.size, mtimeMs: file.mtimeMs, ctimeMs: file.ctimeMs,
    ...(file.dev === undefined ? {} : { dev: file.dev }),
    ...(file.ino === undefined ? {} : { ino: file.ino }),
  };
  return { path, size: file.size, sha256: file.sha256, sourceIdentity: identity, stagedIdentity: identity };
}

async function refreshReceipt(journalPath: string, journal: InstallJournal, receipt: StagedExecutableReceipt, now: number): Promise<InstallJournal> {
  return writeInstallPhase(journalPath, journal.phase, {
    now: Math.max(now, journal.updatedAt), previous: journal,
    stagedExePath: receipt.path, stagedReceipt: receipt,
  });
}

async function cleanupCompletedTransaction(
  markerPath: string,
  transaction: WindowsUpgradeTransaction | null,
  cleanupTask?: (taskName: string) => void | Promise<void>,
): Promise<void> {
  if (transaction) {
    await rm(transaction.backupExecutablePath, { force: true });
    await rm(transaction.backupJournalPath, { force: true });
    await cleanupTask?.(transaction.taskName);
  }
  await rm(markerPath, { force: true });
}

/**
 * Reconcile every executable/receipt state that can be observed after a hard
 * stop of the Windows one-shot upgrader. Credentials are deliberately not
 * touched: recovery changes only the byte receipt for the already-enrolled ID.
 */
export async function recoverWindowsUpgradeTransaction(input: {
  journal: InstallJournal;
  journalPath: string;
  executablePath: string;
  now: number;
  verifyTrustedExecutable: (path: string) => Promise<boolean>;
  resumeTask?: (taskName: string) => void | Promise<void>;
  cleanupTask?: (taskName: string) => void | Promise<void>;
}): Promise<{ journal: InstallJournal; outcome: WindowsUpgradeRecoveryOutcome; handoff: boolean }> {
  const markerPath = join(dirname(input.executablePath), CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_FILE);
  let markerRaw: string | null = null;
  try { markerRaw = await readFile(markerPath, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const transaction = markerRaw === null ? null : parseTransaction(markerRaw);
  const current = await sha256File(input.executablePath);

  if (transaction) {
    if (transaction.executablePath !== input.executablePath || transaction.journalPath !== input.journalPath) {
      throw new Error('controlled node upgrade recovery intent targets unexpected paths');
    }
    if (matches(current, transaction.targetReceipt)) {
      const journal = matches(current, input.journal.stagedReceipt ?? transaction.previousReceipt)
        ? input.journal
        : await refreshReceipt(input.journalPath, input.journal, transaction.targetReceipt, input.now);
      // Keep the rollback image and task until an authenticated health lease
      // proves the new generation is genuinely online. markServiceHealthy is
      // the sole terminal cleanup boundary.
      return { journal, outcome: 'target_receipt_completed', handoff: false };
    }
    if (matches(current, transaction.previousReceipt)) {
      const journal = input.journal.stagedReceipt?.sha256 === transaction.previousReceipt.sha256
        ? input.journal
        : await refreshReceipt(input.journalPath, input.journal, transaction.previousReceipt, input.now);
      await cleanupCompletedTransaction(markerPath, transaction, input.cleanupTask);
      return { journal, outcome: 'previous_receipt_restored', handoff: false };
    }
    // An explicit reinstall may have published a third, newer official image
    // while an old upgrade transaction was still present. The freshly trusted
    // install must win; replaying the stale task would undo the reinstall.
    if (current && await input.verifyTrustedExecutable(input.executablePath)) {
      const journal = await refreshReceipt(
        input.journalPath, input.journal, receiptForCurrent(input.executablePath, current), input.now,
      );
      await cleanupCompletedTransaction(markerPath, transaction, input.cleanupTask);
      return { journal, outcome: 'trusted_executable_adopted', handoff: false };
    }
    const backup = await sha256File(transaction.backupExecutablePath);
    if (matches(backup, transaction.previousReceipt)) {
      await input.resumeTask?.(transaction.taskName);
      return { journal: input.journal, outcome: 'rollback_resumed', handoff: true };
    }
  }

  // Compatibility recovery for the confirmed field incident: old upgraders
  // wrote only `{version:1,startedAt}` (or died before writing a marker). If
  // the currently executing image is still signed by our compiled publisher,
  // it is a trusted release and can safely become the receipt authority.
  if (current && input.journal.stagedReceipt
    && !matches(current, input.journal.stagedReceipt)
    && await input.verifyTrustedExecutable(input.executablePath)) {
    const journal = await refreshReceipt(
      input.journalPath, input.journal, receiptForCurrent(input.executablePath, current), input.now,
    );
    await cleanupCompletedTransaction(markerPath, transaction, input.cleanupTask);
    return { journal, outcome: 'trusted_executable_adopted', handoff: false };
  }

  if (markerRaw !== null) {
    throw new Error('controlled node upgrade recovery found neither a trusted current image nor a verified rollback image');
  }
  return { journal: input.journal, outcome: 'none', handoff: false };
}

/** Restore only a validated transaction-owned journal backup after a torn legacy copy. */
export async function recoverWindowsUpgradeJournalBackup(journalPath: string): Promise<InstallJournal | null> {
  const markerPath = join(dirname(journalPath), CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_FILE);
  let transaction: WindowsUpgradeTransaction | null = null;
  try { transaction = parseTransaction(await readFile(markerPath, 'utf8')); } catch { return null; }
  if (!transaction || transaction.journalPath !== journalPath || transaction.backupJournalPath !== `${journalPath}.upgrade-old`) {
    return null;
  }
  // Validate the backup through the same parser/invariant checks before it can
  // replace the authoritative file. Copy to a sibling temp, then atomic rename.
  const backup = await loadInstallJournal(transaction.backupJournalPath);
  const receipt = backup.stagedReceipt;
  if (backup.phase === 'uninstalled' || !receipt
    || receipt.path !== transaction.previousReceipt.path
    || receipt.size !== transaction.previousReceipt.size
    || receipt.sha256 !== transaction.previousReceipt.sha256) return null;
  const temp = `${journalPath}.recovery-${process.pid}.tmp`;
  await writeFile(temp, await readFile(transaction.backupJournalPath));
  await rename(temp, journalPath);
  return loadInstallJournal(journalPath);
}

/** Delete rollback authority only after the new generation is authenticated healthy. */
export async function finalizeWindowsUpgradeTransaction(input: {
  journal: InstallJournal;
  journalPath: string;
  executablePath: string;
  cleanupTask?: (taskName: string) => void | Promise<void>;
}): Promise<boolean> {
  const markerPath = join(dirname(input.executablePath), CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_FILE);
  let transaction: WindowsUpgradeTransaction | null = null;
  try { transaction = parseTransaction(await readFile(markerPath, 'utf8')); } catch { return false; }
  if (!transaction || transaction.journalPath !== input.journalPath
    || transaction.executablePath !== input.executablePath
    || input.journal.stagedReceipt?.sha256 !== transaction.targetReceipt.sha256) return false;
  const current = await sha256File(input.executablePath);
  if (!matches(current, transaction.targetReceipt)) return false;
  await cleanupCompletedTransaction(markerPath, transaction, input.cleanupTask);
  return true;
}
