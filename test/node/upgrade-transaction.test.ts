import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROLLED_NODE_WINDOWS_UPGRADE_PRODUCT,
  CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_FILE,
  CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_VERSION,
} from '../../shared/controlled-node-service.js';
import type { StagedExecutableReceipt } from '../../src/node/enrollment.js';
import { loadInstallJournal, type InstallJournal } from '../../src/node/install-journal.js';
import {
  finalizeWindowsUpgradeTransaction,
  recoverWindowsUpgradeJournalBackup,
  recoverWindowsUpgradeTransaction,
} from '../../src/node/upgrade-transaction.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function receipt(path: string, bytes: Buffer): Promise<StagedExecutableReceipt> {
  await writeFile(path, bytes);
  const s = await stat(path);
  const identity = { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, dev: s.dev, ino: s.ino };
  return {
    path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    sourceIdentity: identity, stagedIdentity: identity,
  };
}

function journalWith(stagedReceipt: StagedExecutableReceipt): InstallJournal {
  return {
    version: 1,
    phase: 'service_healthy',
    updatedAt: 10,
    installId: 'install-1',
    nodeTokenHash: 'a'.repeat(64),
    sourceExePath: stagedReceipt.path,
    sourceArtifact: { sha256: stagedReceipt.sha256, size: stagedReceipt.size },
    stagedExePath: stagedReceipt.path,
    stagedReceipt,
    serverId: 'srv-1',
    serviceName: 'imcodes-node',
    serviceReceipt: { name: 'imcodes-node', platform: 'win32', action: stagedReceipt.path },
    serviceStartRequestedAt: 8,
    healthyAt: 9,
  };
}

async function setup(currentKind: 'old' | 'target' | 'other', journalKind: 'old' | 'target') {
  const dir = await mkdtemp(join(tmpdir(), 'imcodes-upgrade-transaction-'));
  dirs.push(dir);
  const exePath = join(dir, 'imcodes-node.exe');
  const backupPath = `${exePath}.upgrade-old`;
  const journalPath = join(dir, 'install-journal.json');
  const oldBytes = Buffer.from('old signed executable');
  const targetBytes = Buffer.from('new signed executable');
  const oldReceipt = await receipt(exePath, oldBytes);
  const targetScratch = join(dir, 'target.exe');
  const targetReceiptAtScratch = await receipt(targetScratch, targetBytes);
  const targetReceipt = { ...targetReceiptAtScratch, path: exePath };
  await writeFile(exePath, currentKind === 'old' ? oldBytes : currentKind === 'target' ? targetBytes : Buffer.from('unknown image'));
  await writeFile(backupPath, oldBytes);
  const journal = journalWith(journalKind === 'old' ? oldReceipt : targetReceipt);
  await writeFile(journalPath, JSON.stringify(journal));
  await writeFile(join(dir, CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_FILE), JSON.stringify({
    version: CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_VERSION,
    product: CONTROLLED_NODE_WINDOWS_UPGRADE_PRODUCT,
    startedAt: 11,
    targetVersion: '2026.9.1',
    taskName: 'imcodes-node-upgrade-test123',
    executablePath: exePath,
    backupExecutablePath: backupPath,
    journalPath,
    backupJournalPath: `${journalPath}.upgrade-old`,
    previousReceipt: oldReceipt,
    targetReceipt,
  }));
  return { dir, exePath, backupPath, journalPath, oldReceipt, targetReceipt, journal };
}

describe('Windows controlled-node interrupted upgrade recovery', () => {
  it('keeps an already-complete target transaction until authenticated health finalizes it', async () => {
    const state = await setup('target', 'target');
    const result = await recoverWindowsUpgradeTransaction({
      journal: state.journal, journalPath: state.journalPath, executablePath: state.exePath, now: 20,
      verifyTrustedExecutable: vi.fn(async () => false),
    });
    expect(result).toMatchObject({ outcome: 'target_receipt_completed', handoff: false });
    await expect(readFile(join(state.dir, CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_FILE), 'utf8'))
      .resolves.toContain('imcodes-node-upgrade-test123');
  });

  it('cleans an interrupted intent when both executable and receipt are still the old generation', async () => {
    const state = await setup('old', 'old');
    const cleanupTask = vi.fn();
    const result = await recoverWindowsUpgradeTransaction({
      journal: state.journal, journalPath: state.journalPath, executablePath: state.exePath, now: 20,
      verifyTrustedExecutable: vi.fn(async () => false), cleanupTask,
    });
    expect(result).toMatchObject({ outcome: 'previous_receipt_restored', handoff: false });
    expect(cleanupTask).toHaveBeenCalledWith('imcodes-node-upgrade-test123');
    await expect(readFile(join(state.dir, CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_FILE)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('completes the receipt when the new executable was published before the journal', async () => {
    const state = await setup('target', 'old');
    const cleanupTask = vi.fn();
    const result = await recoverWindowsUpgradeTransaction({
      journal: state.journal, journalPath: state.journalPath, executablePath: state.exePath, now: 20,
      verifyTrustedExecutable: vi.fn(async () => true), cleanupTask,
    });
    expect(result).toMatchObject({ outcome: 'target_receipt_completed', handoff: false });
    expect((await loadInstallJournal(state.journalPath)).stagedReceipt?.sha256).toBe(state.targetReceipt.sha256);
    expect(cleanupTask).not.toHaveBeenCalled();
    expect(await readFile(join(state.dir, CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_FILE), 'utf8')).toContain('imcodes-node-upgrade-test123');
    await expect(finalizeWindowsUpgradeTransaction({
      journal: result.journal,
      journalPath: state.journalPath,
      executablePath: state.exePath,
      cleanupTask,
    })).resolves.toBe(true);
    expect(cleanupTask).toHaveBeenCalledWith('imcodes-node-upgrade-test123');
    await expect(readFile(join(state.dir, CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores the old receipt when the journal advanced but the executable did not', async () => {
    const state = await setup('old', 'target');
    const result = await recoverWindowsUpgradeTransaction({
      journal: state.journal, journalPath: state.journalPath, executablePath: state.exePath, now: 20,
      verifyTrustedExecutable: vi.fn(async () => true),
    });
    expect(result.outcome).toBe('previous_receipt_restored');
    expect((await loadInstallJournal(state.journalPath)).stagedReceipt?.sha256).toBe(state.oldReceipt.sha256);
  });

  it('resumes the durable one-shot task when only the verified rollback image is known', async () => {
    const state = await setup('other', 'target');
    const resumeTask = vi.fn();
    const result = await recoverWindowsUpgradeTransaction({
      journal: state.journal, journalPath: state.journalPath, executablePath: state.exePath, now: 20,
      verifyTrustedExecutable: vi.fn(async () => false), resumeTask,
    });
    expect(result).toMatchObject({ outcome: 'rollback_resumed', handoff: true });
    expect(resumeTask).toHaveBeenCalledWith('imcodes-node-upgrade-test123');
    expect(await readFile(state.backupPath, 'utf8')).toBe('old signed executable');
  });

  it('lets an explicit trusted reinstall supersede a stale upgrade task without changing node identity', async () => {
    const state = await setup('other', 'target');
    const resumeTask = vi.fn();
    const cleanupTask = vi.fn();
    const result = await recoverWindowsUpgradeTransaction({
      journal: state.journal, journalPath: state.journalPath, executablePath: state.exePath, now: 20,
      verifyTrustedExecutable: vi.fn(async () => true), resumeTask, cleanupTask,
    });
    expect(result.outcome).toBe('trusted_executable_adopted');
    expect(resumeTask).not.toHaveBeenCalled();
    expect(cleanupTask).toHaveBeenCalledWith('imcodes-node-upgrade-test123');
    const repaired = await loadInstallJournal(state.journalPath);
    expect(repaired.installId).toBe('install-1');
    expect(repaired.serverId).toBe('srv-1');
    expect(repaired.stagedReceipt?.sha256).toBe(createHash('sha256').update('unknown image').digest('hex'));
  });

  it('adopts a trusted release for legacy v1 interrupted upgrades without changing enrollment identity', async () => {
    const state = await setup('target', 'old');
    await writeFile(join(state.dir, CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_FILE), JSON.stringify({ version: 1, startedAt: 11 }));
    const result = await recoverWindowsUpgradeTransaction({
      journal: state.journal, journalPath: state.journalPath, executablePath: state.exePath, now: 20,
      verifyTrustedExecutable: vi.fn(async () => true),
    });
    expect(result.outcome).toBe('trusted_executable_adopted');
    const repaired = await loadInstallJournal(state.journalPath);
    expect(repaired.stagedReceipt?.sha256).toBe(state.targetReceipt.sha256);
    expect(repaired.installId).toBe('install-1');
    expect(repaired.serverId).toBe('srv-1');
  });

  it('fails visibly instead of silently starting with an unknown image', async () => {
    const state = await setup('other', 'target');
    await rm(state.backupPath);
    await expect(recoverWindowsUpgradeTransaction({
      journal: state.journal, journalPath: state.journalPath, executablePath: state.exePath, now: 20,
      verifyTrustedExecutable: vi.fn(async () => false),
    })).rejects.toThrow('neither a trusted current image nor a verified rollback image');
  });

  it('atomically restores a validated journal backup after a torn legacy journal copy', async () => {
    const state = await setup('target', 'old');
    await writeFile(`${state.journalPath}.upgrade-old`, JSON.stringify(state.journal));
    await writeFile(state.journalPath, '{"version":1,"phase":');
    const recovered = await recoverWindowsUpgradeJournalBackup(state.journalPath);
    expect(recovered).toMatchObject({ installId: 'install-1', serverId: 'srv-1' });
    expect((await loadInstallJournal(state.journalPath)).stagedReceipt?.sha256).toBe(state.oldReceipt.sha256);
  });

  it('refuses a valid-looking journal backup that is not bound to the transaction', async () => {
    const state = await setup('target', 'old');
    const unrelated = journalWith({
      ...state.oldReceipt,
      sha256: 'b'.repeat(64),
    });
    await writeFile(`${state.journalPath}.upgrade-old`, JSON.stringify(unrelated));
    await writeFile(state.journalPath, '{"version":1,"phase":');
    await expect(recoverWindowsUpgradeJournalBackup(state.journalPath)).resolves.toBeNull();
    await expect(loadInstallJournal(state.journalPath)).rejects.toThrow();
  });
});
