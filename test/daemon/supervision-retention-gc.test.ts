import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runSupervisionRetentionGc,
  type SupervisionRetentionTask,
} from '../../src/daemon/supervision-retention-gc.js';
import {
  SUPERVISION_BUNDLE_TERMINAL_RETENTION_MS,
  SUPERVISION_RETENTION_ROTATION_MS,
  SUPERVISION_SCRATCH_TERMINAL_RETENTION_MS,
} from '../../shared/supervision-retention.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; scratch: string; bundles: string; backups: string }> {
  const root = await mkdtemp(join(tmpdir(), 'supervision-retention-'));
  roots.push(root);
  const scratch = join(root, 'scratch');
  const bundles = join(root, 'bundles');
  const backups = join(root, 'backups');
  await mkdir(scratch);
  await mkdir(bundles);
  await mkdir(backups);
  return { root, scratch, bundles, backups };
}

function task(input: Partial<SupervisionRetentionTask> = {}): SupervisionRetentionTask {
  return {
    taskId: 'tsk_done',
    status: 'finalized',
    updatedAt: 1,
    assignments: [{ assignmentId: 'asg_done', status: 'finalized', leaseId: '' }],
    ...input,
  };
}

describe('supervision retained-artifact GC', () => {
  it('has dry-run/apply parity for old terminal scratch and immutable bundles', async () => {
    const { scratch, bundles } = await fixture();
    const scratchPath = join(scratch, 'cx4', 'asg_done');
    const digest = 'a'.repeat(64);
    const bundlePath = join(bundles, 'aa', digest);
    await mkdir(scratchPath, { recursive: true });
    await writeFile(join(scratchPath, 'result.txt'), 'terminal scratch');
    await mkdir(bundlePath, { recursive: true });
    await writeFile(join(bundlePath, 'manifest.json'), JSON.stringify({ taskId: 'tsk_done' }));
    const now = Math.max(SUPERVISION_SCRATCH_TERMINAL_RETENTION_MS, SUPERVISION_BUNDLE_TERMINAL_RETENTION_MS) + 10_000;
    await utimes(scratchPath, new Date(1), new Date(1));
    await utimes(bundlePath, new Date(1), new Date(1));
    const tasks = [task({ integrationBundlePath: bundlePath })];

    const dry = await runSupervisionRetentionGc({ mode: 'dryRun', tasks, scratchRoot: scratch, bundlesRoot: bundles, now });
    expect(dry).toMatchObject({ scanned: 2, deleted: 2, retained: 0 });
    expect(await stat(scratchPath)).toBeTruthy();
    expect(await stat(bundlePath)).toBeTruthy();

    const applied = await runSupervisionRetentionGc({ mode: 'apply', tasks, scratchRoot: scratch, bundlesRoot: bundles, now });
    expect(applied.entries.map(({ kind, action, reason }) => ({ kind, action, reason })))
      .toEqual(dry.entries.map(({ kind, action, reason }) => ({ kind, action, reason })));
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(bundlePath)).rejects.toMatchObject({ code: 'ENOENT' });

    const repeat = await runSupervisionRetentionGc({ mode: 'apply', tasks, scratchRoot: scratch, bundlesRoot: bundles, now });
    expect(repeat).toMatchObject({ deleted: 0, releasedBytes: 0 });
  });

  it('retains active leases, recent terminal bytes, and malformed bundles', async () => {
    const { scratch, bundles } = await fixture();
    const active = join(scratch, 'cx4', 'asg_live');
    const recent = join(scratch, 'cx4', 'asg_done');
    const malformed = join(bundles, 'bb', 'b'.repeat(64));
    await mkdir(active, { recursive: true });
    await mkdir(recent, { recursive: true });
    await mkdir(malformed, { recursive: true });
    await writeFile(join(malformed, 'manifest.json'), '{not-json');
    const now = Date.now();
    const result = await runSupervisionRetentionGc({
      mode: 'apply', scratchRoot: scratch, bundlesRoot: bundles, now,
      tasks: [
        task(),
        task({
          taskId: 'tsk_live', status: 'implementing', updatedAt: 1,
          assignments: [{ assignmentId: 'asg_live', status: 'implementing', leaseId: 'lease' }],
        }),
      ],
    });
    expect(result.deleted).toBe(0);
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'asg_live', action: 'retain', reason: 'active_owner' }),
      expect.objectContaining({ key: 'asg_done', action: 'retain', reason: 'retention_window' }),
      expect.objectContaining({ kind: 'bundle', action: 'retain', reason: 'invalid_layout' }),
    ]));
  });

  it('rotates bounded pages so retained early entries cannot starve later cleanup', async () => {
    const { scratch, bundles } = await fixture();
    for (const assignmentId of ['asg_a', 'asg_b', 'asg_c']) {
      await mkdir(join(scratch, 'cx4', assignmentId), { recursive: true });
    }
    const tasks = ['a', 'b', 'c'].map((suffix) => task({
      taskId: `tsk_${suffix}`,
      status: 'implementing',
      assignments: [{ assignmentId: `asg_${suffix}`, status: 'implementing', leaseId: 'lease' }],
    }));
    const first = await runSupervisionRetentionGc({
      mode: 'dryRun', tasks, scratchRoot: scratch, bundlesRoot: bundles,
      limit: 1, now: SUPERVISION_RETENTION_ROTATION_MS,
    });
    const second = await runSupervisionRetentionGc({
      mode: 'dryRun', tasks, scratchRoot: scratch, bundlesRoot: bundles,
      limit: 1, now: 2 * SUPERVISION_RETENTION_ROTATION_MS,
    });
    expect(first).toMatchObject({ scanned: 1, hasMore: true });
    expect(second).toMatchObject({ scanned: 1, hasMore: true });
    expect(second.entries[0]?.key).not.toBe(first.entries[0]?.key);
  });

  it('reclaims age-gated scratch and bundle quarantine leftovers and honors retention overrides', async () => {
    const { scratch, bundles } = await fixture();
    const scratchQuarantine = join(scratch, 'cx4', 'asg_done.gc-123-456');
    const digest = 'c'.repeat(64);
    const bundleQuarantine = join(bundles, 'cc', `${digest}.gc-123-456`);
    await mkdir(scratchQuarantine, { recursive: true });
    await mkdir(bundleQuarantine, { recursive: true });
    await writeFile(join(bundleQuarantine, 'manifest.json'), JSON.stringify({ taskId: 'tsk_done' }));
    await utimes(scratchQuarantine, new Date(1), new Date(1));
    await utimes(bundleQuarantine, new Date(1), new Date(1));
    const now = 120_000;
    const result = await runSupervisionRetentionGc({
      mode: 'apply', tasks: [task({ integrationBundlePath: join(bundles, 'cc', digest) })],
      scratchRoot: scratch, bundlesRoot: bundles, now,
      quarantineGraceMs: 60_000,
      scratchRetentionMs: 60_000,
      bundleRetentionMs: 60_000,
    });
    expect(result).toMatchObject({ deleted: 2 });
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'scratch', key: 'asg_done', action: 'delete' }),
      expect.objectContaining({ kind: 'bundle', key: digest, action: 'delete' }),
    ]));
    await expect(stat(scratchQuarantine)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(bundleQuarantine)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses bounded descendant activity for ownerless scratch instead of only the top-level mtime', async () => {
    const { scratch, bundles } = await fixture();
    const workspace = join(scratch, 'cx4', 'long-lived-workspace');
    const nested = join(workspace, 'nested');
    const activeFile = join(nested, 'active.txt');
    await mkdir(nested, { recursive: true });
    await writeFile(activeFile, 'recent activity');
    await utimes(workspace, new Date(1), new Date(1));
    await utimes(nested, new Date(1), new Date(1));
    await utimes(activeFile, new Date(119_000), new Date(119_000));

    const result = await runSupervisionRetentionGc({
      mode: 'dryRun', tasks: [], scratchRoot: scratch, bundlesRoot: bundles,
      now: 120_000, orphanGraceMs: 60_000,
    });
    expect(result.entries).toContainEqual(expect.objectContaining({
      kind: 'scratch', key: 'long-lived-workspace', action: 'retain', reason: 'unknown_owner',
    }));
  });

  it('applies runtime environment overrides for scratch and bundle retention', async () => {
    const { scratch, bundles } = await fixture();
    const scratchPath = join(scratch, 'cx4', 'asg_done');
    const digest = 'd'.repeat(64);
    const bundlePath = join(bundles, 'dd', digest);
    await mkdir(scratchPath, { recursive: true });
    await mkdir(bundlePath, { recursive: true });
    await writeFile(join(bundlePath, 'manifest.json'), JSON.stringify({ taskId: 'tsk_done' }));
    await utimes(scratchPath, new Date(1), new Date(1));
    await utimes(bundlePath, new Date(1), new Date(1));
    const input = {
      mode: 'dryRun' as const,
      tasks: [task({ integrationBundlePath: bundlePath })],
      scratchRoot: scratch,
      bundlesRoot: bundles,
      now: 120_000,
    };
    expect(await runSupervisionRetentionGc(input)).toMatchObject({ deleted: 0, retained: 2 });

    vi.stubEnv('IMCODES_SUPERVISION_FINALIZED_SCRATCH_RETENTION_MS', '60000');
    vi.stubEnv('IMCODES_SUPERVISION_FINALIZED_BUNDLE_RETENTION_MS', '60000');
    expect(await runSupervisionRetentionGc(input)).toMatchObject({ deleted: 2, retained: 0 });
  });

  it('reclaims finalized bundles after the short safety window but retains them before it and while active', async () => {
    const { scratch, bundles, backups } = await fixture();
    const finalizedScratch = join(scratch, 'cx4', 'asg_done');
    const finalizedDigest = 'e'.repeat(64);
    const activeDigest = 'f'.repeat(64);
    const finalizedPath = join(bundles, 'ee', finalizedDigest);
    const activePath = join(bundles, 'ff', activeDigest);
    await mkdir(finalizedScratch, { recursive: true });
    await mkdir(finalizedPath, { recursive: true });
    await mkdir(activePath, { recursive: true });
    await writeFile(join(finalizedPath, 'manifest.json'), JSON.stringify({ taskId: 'tsk_done' }));
    await writeFile(join(activePath, 'manifest.json'), JSON.stringify({ taskId: 'tsk_live' }));
    await utimes(finalizedScratch, new Date(1), new Date(1));
    await utimes(finalizedPath, new Date(1), new Date(1));
    await utimes(activePath, new Date(1), new Date(1));
    const tasks = [
      task({ integrationBundlePath: finalizedPath }),
      task({
        taskId: 'tsk_live', status: 'auditing', updatedAt: 1, integrationBundlePath: activePath,
        assignments: [{ assignmentId: 'asg_live', status: 'auditing', leaseId: 'live-lease' }],
      }),
    ];
    const before = await runSupervisionRetentionGc({
      mode: 'dryRun', tasks, scratchRoot: scratch, bundlesRoot: bundles, backupsRoot: backups,
      now: 30 * 60_000,
    });
    expect(before.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'scratch', key: 'asg_done', action: 'retain', reason: 'retention_window' }),
      expect.objectContaining({ kind: 'bundle', key: finalizedDigest, action: 'retain', reason: 'retention_window' }),
      expect.objectContaining({ kind: 'bundle', key: activeDigest, action: 'retain', reason: 'active_owner' }),
    ]));
    const after = await runSupervisionRetentionGc({
      mode: 'dryRun', tasks, scratchRoot: scratch, bundlesRoot: bundles, backupsRoot: backups,
      now: 61 * 60_000,
    });
    expect(after.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'scratch', key: 'asg_done', action: 'retain', reason: 'retention_window' }),
      expect.objectContaining({ kind: 'bundle', key: finalizedDigest, action: 'delete' }),
      expect.objectContaining({ kind: 'bundle', key: activeDigest, action: 'retain', reason: 'active_owner' }),
    ]));
    const nextDay = await runSupervisionRetentionGc({
      mode: 'dryRun', tasks, scratchRoot: scratch, bundlesRoot: bundles, backupsRoot: backups,
      now: 24 * 60 * 60_000 + 60_001,
    });
    expect(nextDay.entries).toContainEqual(expect.objectContaining({
      kind: 'scratch', key: 'asg_done', action: 'delete', reason: 'terminal_retention_elapsed',
    }));
  });

  it('age-purges legacy backup patches with runtime override and reports count and bytes', async () => {
    const { scratch, bundles, backups } = await fixture();
    const backupDir = join(backups, 'cd', 'deck_gc_brain');
    const oldPatch = join(backupDir, 'asg_old-abc.patch');
    const youngPatch = join(backupDir, 'asg_young-def.patch');
    await mkdir(backupDir, { recursive: true });
    await writeFile(oldPatch, 'old backup');
    await writeFile(youngPatch, 'young backup');
    await utimes(oldPatch, new Date(1), new Date(1));
    await utimes(youngPatch, new Date(119_000), new Date(119_000));
    vi.stubEnv('IMCODES_SUPERVISION_WORKTREE_BACKUP_RETENTION_MS', '60000');
    const result = await runSupervisionRetentionGc({
      mode: 'apply', tasks: [], scratchRoot: scratch, bundlesRoot: bundles, backupsRoot: backups,
      now: 120_000,
    });
    expect(result).toMatchObject({ deleted: 1, retained: 1, releasedBytes: 10 });
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'backup', key: 'cd/deck_gc_brain/asg_old-abc.patch', action: 'delete', reason: 'backup_retention_elapsed', bytes: 10 }),
      expect.objectContaining({ kind: 'backup', key: 'cd/deck_gc_brain/asg_young-def.patch', action: 'retain', reason: 'retention_window' }),
    ]));
    await expect(stat(oldPatch)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(youngPatch)).resolves.toBeTruthy();
  });
});
