import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SUPERVISION_WORKTREE_GC_MAX_ASSIGNMENTS,
  SUPERVISION_WORKTREE_GC_REASONS,
  inspectSupervisionGitWorktree,
  runSupervisionWorktreeGc,
  type SupervisionWorktreeGitInspection,
  type SupervisionWorktreeMetadata,
  type SupervisionWorktreeRegistryReference,
} from '../../src/daemon/supervision-worktree-gc.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(prefix = 'supervision-worktree-gc-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function createCandidate(
  root: string,
  assignmentId: string,
  options: { evidence?: boolean; unknownContent?: boolean; taskId?: string } = {},
): Promise<{ path: string; repoPath: string; metadata: SupervisionWorktreeMetadata; metadataText: string }> {
  const path = join(root, 'imcodes', 'deck_gc_brain', assignmentId);
  const repoPath = join(path, 'repo');
  await mkdir(repoPath, { recursive: true });
  const metadata: SupervisionWorktreeMetadata = {
    taskId: options.taskId ?? `task_${assignmentId}`,
    assignmentId,
    sessionName: 'deck_gc_brain',
    baseRevision: 'a'.repeat(40),
    repoPath,
    createdAt: '2026-08-30T00:00:00Z',
  };
  const metadataText = `${JSON.stringify(metadata)}\n`;
  await writeFile(join(path, 'metadata.json'), metadataText);
  if (options.evidence) {
    await mkdir(join(path, 'evidence'));
    await writeFile(join(path, 'evidence', 'owned-files.sha256'), 'unique\n');
  }
  if (options.unknownContent) await writeFile(join(path, 'notes.txt'), 'unknown owner bytes');
  return { path, repoPath, metadata, metadataText };
}

function registryReference(
  metadata: SupervisionWorktreeMetadata,
  input: { status?: string; leaseId?: string; claims?: boolean; archivedAt?: number } = {},
): SupervisionWorktreeRegistryReference {
  const status = input.status ?? 'finalized';
  return {
    available: true,
    assignment: {
      assignmentId: metadata.assignmentId,
      taskId: metadata.taskId,
      status,
      leaseId: input.leaseId ?? '',
    },
    task: {
      taskId: metadata.taskId,
      projectName: 'cd',
      status: status === 'finalized' ? 'finalized' : 'implementing',
      ...(input.archivedAt === undefined ? {} : { archivedAt: input.archivedAt }),
      assignments: [{ assignmentId: metadata.assignmentId, status, leaseId: input.leaseId ?? '' }],
    },
    claims: input.claims ? [{ assignmentId: metadata.assignmentId, path: 'src/owned.ts' }] : [],
  };
}

const eligibleGit = (commonDir = '/tmp/git-common'): SupervisionWorktreeGitInspection => ({
  ok: true,
  commonDir,
  registered: true,
  locked: false,
  dirty: false,
  untracked: false,
  branchOnly: false,
  unpushed: false,
});

describe('bounded supervision worktree GC', () => {
  it('defaults to dry-run and explains every registry, evidence, and Git refusal without deleting', async () => {
    const root = await makeRoot();
    const cases = [
      ['supervision_assignment_eligible', SUPERVISION_WORKTREE_GC_REASONS.ELIGIBLE],
      ['supervision_assignment_active', SUPERVISION_WORKTREE_GC_REASONS.ACTIVE_REFERENCE],
      ['supervision_assignment_lease', SUPERVISION_WORKTREE_GC_REASONS.ACTIVE_LEASE],
      ['supervision_assignment_claim', SUPERVISION_WORKTREE_GC_REASONS.ACTIVE_CLAIMS],
      ['supervision_assignment_unknown', SUPERVISION_WORKTREE_GC_REASONS.UNKNOWN_OWNER],
      ['supervision_assignment_unavailable', SUPERVISION_WORKTREE_GC_REASONS.REGISTRY_UNAVAILABLE],
      ['supervision_assignment_evidence', SUPERVISION_WORKTREE_GC_REASONS.UNIQUE_EVIDENCE],
      ['supervision_assignment_dirty', SUPERVISION_WORKTREE_GC_REASONS.DIRTY],
      ['supervision_assignment_untracked', SUPERVISION_WORKTREE_GC_REASONS.UNTRACKED],
      ['supervision_assignment_branch', SUPERVISION_WORKTREE_GC_REASONS.BRANCH_ONLY],
      ['supervision_assignment_unpushed', SUPERVISION_WORKTREE_GC_REASONS.UNPUSHED_BRANCH],
      ['supervision_assignment_unknown-content', SUPERVISION_WORKTREE_GC_REASONS.UNKNOWN_CONTENT],
    ] as const;
    const metadata = new Map<string, SupervisionWorktreeMetadata>();
    for (const [assignmentId] of cases) {
      const created = await createCandidate(root, assignmentId, {
        evidence: assignmentId.endsWith('evidence'),
        unknownContent: assignmentId.endsWith('unknown-content'),
      });
      metadata.set(assignmentId, created.metadata);
    }
    const removeRegisteredWorktree = vi.fn(async () => true);
    const removeDirectory = vi.fn(async () => undefined);
    const result = await runSupervisionWorktreeGc({ projectName: 'cd', worktreesRoot: root, limit: 100 }, {
      resolveRegistryReference: (candidate) => {
        if (candidate.assignmentId.endsWith('unavailable')) return { available: false };
        if (candidate.assignmentId.endsWith('unknown')) return { available: true };
        if (candidate.assignmentId.endsWith('active')) return registryReference(candidate, { status: 'implementing' });
        if (candidate.assignmentId.endsWith('lease')) return registryReference(candidate, { leaseId: 'lease-1' });
        if (candidate.assignmentId.endsWith('claim')) return registryReference(candidate, { claims: true });
        return registryReference(candidate);
      },
      inspectGit: async (repoPath) => {
        const assignmentId = basename(dirname(repoPath));
        if (assignmentId.endsWith('dirty')) return { ...eligibleGit(), dirty: true };
        if (assignmentId.endsWith('untracked')) return { ...eligibleGit(), untracked: true };
        if (assignmentId.endsWith('branch')) return { ...eligibleGit(), branchOnly: true };
        if (assignmentId.endsWith('unpushed')) return { ...eligibleGit(), unpushed: true };
        return eligibleGit();
      },
      removeRegisteredWorktree,
      removeDirectory,
      protectedPaths: [],
    });

    expect(result.mode).toBe('dryRun');
    expect(result.deleted).toBe(0);
    expect(result.registryAvailable).toBe(false);
    expect(removeRegisteredWorktree).not.toHaveBeenCalled();
    expect(removeDirectory).not.toHaveBeenCalled();
    expect(new Map(result.entries.map((entry) => [entry.assignmentId, entry.reason])))
      .toEqual(new Map(cases));
    for (const assignmentId of metadata.keys()) {
      expect(await readdir(join(root, 'imcodes', 'deck_gc_brain', assignmentId))).toContain('repo');
    }
  });

  it('applies only the bounded eligible page, yields between entries, and is restart-idempotent', async () => {
    const root = await makeRoot();
    const assignments = [
      'supervision_assignment_apply-a',
      'supervision_assignment_apply-b',
      'supervision_assignment_apply-c',
    ];
    for (const assignmentId of assignments) await createCandidate(root, assignmentId);
    const yields: number[] = [];
    const removeRegisteredWorktree = vi.fn(async (_inspection, repoPath: string) => {
      await rm(repoPath, { recursive: true, force: false });
      return true;
    });
    const deps = {
      resolveRegistryReference: (metadata: SupervisionWorktreeMetadata) => registryReference(metadata),
      inspectGit: async () => eligibleGit(),
      removeRegisteredWorktree,
      removeDirectory: (path: string) => rm(path, { recursive: true, force: false }),
      pruneRegistrations: async () => [],
      yieldControl: async () => { yields.push(1); },
      protectedPaths: [],
    };
    const first = await runSupervisionWorktreeGc({
      projectName: 'cd', mode: 'apply', worktreesRoot: root, limit: 2,
    }, deps);
    expect(first).toMatchObject({ deleted: 2, scanned: 2, hasMore: true, lock: 'acquired' });
    expect(removeRegisteredWorktree).toHaveBeenCalledTimes(2);
    expect(yields.length).toBeGreaterThanOrEqual(2);
    expect(await readdir(join(root, 'imcodes', 'deck_gc_brain'))).toEqual(['supervision_assignment_apply-c']);

    const second = await runSupervisionWorktreeGc({
      projectName: 'cd', mode: 'apply', worktreesRoot: root, cursor: first.nextCursor, limit: 2,
    }, deps);
    expect(second).toMatchObject({ deleted: 1, scanned: 1, hasMore: false });
    expect(await readdir(join(root, 'imcodes', 'deck_gc_brain'))).toEqual([]);

    const replay = await runSupervisionWorktreeGc({ projectName: 'cd', mode: 'apply', worktreesRoot: root }, deps);
    expect(replay).toMatchObject({ deleted: 0, scanned: 0, hasMore: false });
  });

  it('refuses apply while another live run owns the concurrency lock', async () => {
    const root = await makeRoot();
    const created = await createCandidate(root, 'supervision_assignment_locked-run');
    await writeFile(join(root, '.supervision-worktree-gc.lock'), JSON.stringify({
      runId: 'live-run', pid: 4242, startedAt: 10_000,
    }));
    const removeRegisteredWorktree = vi.fn(async () => true);
    const result = await runSupervisionWorktreeGc({
      projectName: 'cd', mode: 'apply', worktreesRoot: root,
    }, {
      now: () => 10_001,
      isProcessAlive: () => true,
      resolveRegistryReference: (metadata) => registryReference(metadata),
      inspectGit: async () => eligibleGit(),
      removeRegisteredWorktree,
      protectedPaths: [],
    });
    expect(result).toMatchObject({ lock: 'busy', deleted: 0 });
    expect(result.entries[0]?.reason).toBe(SUPERVISION_WORKTREE_GC_REASONS.CONCURRENT_RUN);
    expect(removeRegisteredWorktree).not.toHaveBeenCalled();
    expect(await readdir(created.path)).toContain('repo');
  });

  it('recovers a crash after Git deregistration before starting the next bounded page', async () => {
    const root = await makeRoot();
    const created = await createCandidate(root, 'supervision_assignment_crash-recovery');
    const canonicalPath = await realpath(created.path);
    const canonicalRepoPath = await realpath(created.repoPath);
    await rm(created.repoPath, { recursive: true, force: false });
    await writeFile(join(root, '.supervision-worktree-gc-journal.json'), `${JSON.stringify({
      version: 1,
      runId: 'dead-run',
      state: 'git_removed',
      candidatePath: canonicalPath,
      repoPath: canonicalRepoPath,
      assignmentId: created.metadata.assignmentId,
      taskId: created.metadata.taskId,
      projectName: 'cd',
      metadataText: created.metadataText,
      updatedAt: 1,
    })}\n`);
    const result = await runSupervisionWorktreeGc({
      projectName: 'cd', mode: 'apply', worktreesRoot: root,
    }, {
      resolveRegistryReference: (metadata) => registryReference(metadata),
      protectedPaths: [],
      pruneRegistrations: async () => [],
    });
    expect(result.deleted).toBe(1);
    expect(await readdir(join(root, 'imcodes', 'deck_gc_brain'))).toEqual([]);
    await expect(readFile(join(root, '.supervision-worktree-gc-journal.json'))).rejects.toThrow();
  });

  it('shares limit=1 atomically between successful recovery and the fresh candidate page', async () => {
    const root = await makeRoot();
    const recovery = await createCandidate(root, 'supervision_assignment_a-recovery');
    const fresh = await createCandidate(root, 'supervision_assignment_b-fresh');
    const recoveryPath = await realpath(recovery.path);
    const recoveryRepoPath = await realpath(recovery.repoPath);
    await rm(recovery.repoPath, { recursive: true, force: false });
    await writeFile(join(root, '.supervision-worktree-gc-journal.json'), `${JSON.stringify({
      version: 1,
      runId: 'budget-recovery',
      state: 'git_removed',
      candidatePath: recoveryPath,
      repoPath: recoveryRepoPath,
      assignmentId: recovery.metadata.assignmentId,
      taskId: recovery.metadata.taskId,
      projectName: 'cd',
      metadataText: recovery.metadataText,
      updatedAt: 1,
    })}\n`);
    const removeRegisteredWorktree = vi.fn(async (_inspection, repoPath: string) => {
      await rm(repoPath, { recursive: true, force: false });
      return true;
    });
    const removeDirectory = vi.fn((path: string) => rm(path, { recursive: true, force: false }));
    const onScanOperation = vi.fn();
    const deps = {
      resolveRegistryReference: (metadata: SupervisionWorktreeMetadata) => registryReference(metadata),
      inspectGit: async () => eligibleGit(),
      removeRegisteredWorktree,
      removeDirectory,
      pruneRegistrations: async () => [],
      onScanOperation,
      protectedPaths: [],
    };

    const recovered = await runSupervisionWorktreeGc({
      projectName: 'cd', mode: 'apply', worktreesRoot: root, limit: 1,
    }, deps);
    expect(recovered).toMatchObject({ deleted: 1, mutations: 1, scanned: 0, hasMore: true });
    expect(removeDirectory).toHaveBeenCalledTimes(1);
    expect(removeRegisteredWorktree).not.toHaveBeenCalled();
    expect(onScanOperation).not.toHaveBeenCalled();
    expect(await readdir(fresh.path)).toContain('repo');

    const nextPage = await runSupervisionWorktreeGc({
      projectName: 'cd', mode: 'apply', worktreesRoot: root, limit: 1,
    }, deps);
    expect(nextPage).toMatchObject({ deleted: 1, mutations: 1, scanned: 1 });
    expect(onScanOperation).toHaveBeenCalled();
    expect(removeRegisteredWorktree).toHaveBeenCalledTimes(1);
    expect(removeDirectory).toHaveBeenCalledTimes(2);
  });

  it('retains the journal and touches no fresh candidate when recovery fails', async () => {
    const root = await makeRoot();
    const recovery = await createCandidate(root, 'supervision_assignment_a-failed-recovery');
    const fresh = await createCandidate(root, 'supervision_assignment_b-untouched');
    const recoveryPath = await realpath(recovery.path);
    const recoveryRepoPath = await realpath(recovery.repoPath);
    await rm(recovery.repoPath, { recursive: true, force: false });
    const journalPath = join(root, '.supervision-worktree-gc-journal.json');
    await writeFile(journalPath, `${JSON.stringify({
      version: 1,
      runId: 'blocked-recovery',
      state: 'git_removed',
      candidatePath: recoveryPath,
      repoPath: recoveryRepoPath,
      assignmentId: recovery.metadata.assignmentId,
      taskId: recovery.metadata.taskId,
      projectName: 'cd',
      metadataText: recovery.metadataText,
      updatedAt: 1,
    })}\n`);
    const removeRegisteredWorktree = vi.fn(async () => true);
    const removeDirectory = vi.fn(async () => undefined);
    const result = await runSupervisionWorktreeGc({
      projectName: 'cd', mode: 'apply', worktreesRoot: root, limit: 1,
    }, {
      resolveRegistryReference: (metadata) => registryReference(metadata, {
        status: metadata.assignmentId === recovery.metadata.assignmentId ? 'implementing' : 'finalized',
      }),
      inspectGit: async () => eligibleGit(),
      removeRegisteredWorktree,
      removeDirectory,
      protectedPaths: [],
    });
    expect(result).toMatchObject({ deleted: 0, mutations: 0, scanned: 0 });
    expect(result.entries[0]?.reason).toBe(SUPERVISION_WORKTREE_GC_REASONS.RECOVERY_BLOCKED);
    expect(removeRegisteredWorktree).not.toHaveBeenCalled();
    expect(removeDirectory).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(journalPath, 'utf8'))).toMatchObject({ state: 'git_removed' });
    expect(await readdir(fresh.path)).toContain('repo');
  });

  it('fails the whole apply page closed when any registry lookup is unavailable', async () => {
    const root = await makeRoot();
    await createCandidate(root, 'supervision_assignment_a-eligible');
    await createCandidate(root, 'supervision_assignment_z-registry-down');
    const removeRegisteredWorktree = vi.fn(async () => true);
    const result = await runSupervisionWorktreeGc({
      projectName: 'cd', mode: 'apply', worktreesRoot: root, limit: 10,
    }, {
      resolveRegistryReference: (metadata) => metadata.assignmentId.endsWith('registry-down')
        ? { available: false }
        : registryReference(metadata),
      inspectGit: async () => eligibleGit(),
      removeRegisteredWorktree,
      protectedPaths: [],
    });
    expect(result.registryAvailable).toBe(false);
    expect(result.deleted).toBe(0);
    expect(removeRegisteredWorktree).not.toHaveBeenCalled();
    expect(result.entries.find((entry) => entry.assignmentId.endsWith('eligible')))
      .toMatchObject({ action: 'retain', reason: SUPERVISION_WORKTREE_GC_REASONS.REGISTRY_UNAVAILABLE });
  });

  it('rechecks registry activity immediately before Git removal', async () => {
    const root = await makeRoot();
    await createCandidate(root, 'supervision_assignment_reactivated');
    let lookups = 0;
    const removeRegisteredWorktree = vi.fn(async () => true);
    const result = await runSupervisionWorktreeGc({
      projectName: 'cd', mode: 'apply', worktreesRoot: root,
    }, {
      resolveRegistryReference: (metadata) => registryReference(metadata, {
        status: ++lookups === 1 ? 'finalized' : 'implementing',
      }),
      inspectGit: async () => eligibleGit(),
      removeRegisteredWorktree,
      protectedPaths: [],
    });
    expect(result.deleted).toBe(0);
    expect(result.entries[0]).toMatchObject({
      action: 'retain', reason: SUPERVISION_WORKTREE_GC_REASONS.ACTIVE_REFERENCE,
    });
    expect(removeRegisteredWorktree).not.toHaveBeenCalled();
  });

  it('retains a terminal owner while the same task still has another active assignment', async () => {
    const root = await makeRoot();
    await createCandidate(root, 'supervision_assignment_terminal-with-auditor');
    const result = await runSupervisionWorktreeGc({ projectName: 'cd', worktreesRoot: root }, {
      resolveRegistryReference: (metadata) => {
        const reference = registryReference(metadata);
        reference.task!.assignments = [
          ...reference.task!.assignments,
          { assignmentId: 'supervision_assignment_live-auditor', status: 'auditing', leaseId: '' },
        ];
        return reference;
      },
      inspectGit: async () => eligibleGit(),
      protectedPaths: [],
    });
    expect(result.entries[0]).toMatchObject({
      action: 'retain', reason: SUPERVISION_WORKTREE_GC_REASONS.ACTIVE_REFERENCE,
    });
  });

  it('keeps a recovery journal when Git removal reports a partial/unknown failure', async () => {
    const root = await makeRoot();
    await createCandidate(root, 'supervision_assignment_partial-remove');
    let inspections = 0;
    const result = await runSupervisionWorktreeGc({
      projectName: 'cd', mode: 'apply', worktreesRoot: root,
    }, {
      resolveRegistryReference: (metadata) => registryReference(metadata),
      inspectGit: async () => ++inspections <= 2 ? eligibleGit() : { ok: false },
      removeRegisteredWorktree: async () => false,
      protectedPaths: [],
    });
    expect(result.entries[0]).toMatchObject({
      action: 'retain', reason: SUPERVISION_WORKTREE_GC_REASONS.RECOVERY_BLOCKED,
    });
    expect(JSON.parse(await readFile(join(root, '.supervision-worktree-gc-journal.json'), 'utf8')))
      .toMatchObject({ state: 'planned', projectName: 'cd' });
  });

  it('refuses crash recovery when a quarantined assignment becomes active', async () => {
    const root = await makeRoot();
    const created = await createCandidate(root, 'supervision_assignment_quarantine-active');
    const canonicalPath = await realpath(created.path);
    const canonicalRepoPath = await realpath(created.repoPath);
    await rm(created.repoPath, { recursive: true, force: false });
    const quarantinePath = `${canonicalPath}.gc-dead-run`;
    await rename(canonicalPath, quarantinePath);
    await writeFile(join(root, '.supervision-worktree-gc-journal.json'), `${JSON.stringify({
      version: 1,
      runId: 'dead-run',
      state: 'quarantined',
      candidatePath: canonicalPath,
      repoPath: canonicalRepoPath,
      assignmentId: created.metadata.assignmentId,
      taskId: created.metadata.taskId,
      projectName: 'cd',
      metadataText: created.metadataText,
      quarantinePath,
      updatedAt: 1,
    })}\n`);
    const removeDirectory = vi.fn(async () => undefined);
    const result = await runSupervisionWorktreeGc({ projectName: 'cd', mode: 'apply', worktreesRoot: root }, {
      resolveRegistryReference: (metadata) => registryReference(metadata, { status: 'implementing' }),
      removeDirectory,
      protectedPaths: [],
    });
    expect(result.entries[0]?.reason).toBe(SUPERVISION_WORKTREE_GC_REASONS.RECOVERY_BLOCKED);
    expect(removeDirectory).not.toHaveBeenCalled();
    expect(await readdir(quarantinePath)).toContain('metadata.json');
  });

  it('hard-bounds a crowded assignment root before registry or Git work', async () => {
    const root = await makeRoot('supervision-worktree-gc-crowded-');
    for (let index = 0; index < SUPERVISION_WORKTREE_GC_MAX_ASSIGNMENTS + 40; index += 1) {
      await createCandidate(root, `supervision_assignment_bulk-${String(index).padStart(4, '0')}`);
    }
    const operations = { project: 0, session: 0, assignment: 0, registry: 0, git: 0 };
    const result = await runSupervisionWorktreeGc({
      projectName: 'cd', worktreesRoot: root, limit: 100,
    }, {
      resolveRegistryReference: (metadata) => registryReference(metadata),
      inspectGit: async () => eligibleGit(),
      protectedPaths: [],
      onScanOperation: (operation) => { operations[operation] += 1; },
    });
    expect(result).toMatchObject({ scanned: 100, hasMore: true });
    expect(operations.assignment).toBe(SUPERVISION_WORKTREE_GC_MAX_ASSIGNMENTS);
    expect(operations.registry).toBe(100);
    expect(operations.git).toBe(100);
  });

  it('bounds invalid directory entries instead of scanning past the assignment ceiling', async () => {
    const root = await makeRoot('supervision-worktree-gc-invalid-crowd-');
    const sessionPath = join(root, 'imcodes', 'deck_gc_brain');
    await mkdir(sessionPath, { recursive: true });
    await Promise.all(Array.from({ length: SUPERVISION_WORKTREE_GC_MAX_ASSIGNMENTS + 40 }, (_, index) =>
      writeFile(join(sessionPath, `foreign_${String(index).padStart(4, '0')}`), 'x')));
    const operations = { project: 0, session: 0, assignment: 0, registry: 0, git: 0 };
    const result = await runSupervisionWorktreeGc({ projectName: 'cd', worktreesRoot: root }, {
      resolveRegistryReference: (metadata) => registryReference(metadata),
      protectedPaths: [],
      onScanOperation: (operation) => { operations[operation] += 1; },
    });
    expect(result).toMatchObject({ scanned: 0, hasMore: true });
    expect(operations.assignment).toBe(SUPERVISION_WORKTREE_GC_MAX_ASSIGNMENTS);
    expect(operations.registry).toBe(0);
    expect(operations.git).toBe(0);
  });

  it('uses real Git status, registration, and remote reachability evidence', async () => {
    const root = await makeRoot('supervision-worktree-gc-real-git-');
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    const worktree = join(root, 'worktree');
    await execFileAsync('git', ['init', '--bare', origin]);
    await execFileAsync('git', ['clone', origin, seed]);
    await execFileAsync('git', ['config', 'user.email', 'gc@example.test'], { cwd: seed });
    await execFileAsync('git', ['config', 'user.name', 'GC Test'], { cwd: seed });
    await writeFile(join(seed, 'tracked.txt'), 'base\n');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: seed });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: seed });
    await execFileAsync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: seed });
    await execFileAsync('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: seed });

    expect(await inspectSupervisionGitWorktree(worktree)).toMatchObject({
      ok: true, registered: true, dirty: false, untracked: false, unpushed: false,
    });
    await writeFile(join(worktree, 'untracked.txt'), 'owner bytes\n');
    expect(await inspectSupervisionGitWorktree(worktree)).toMatchObject({ ok: true, untracked: true });
    await rm(join(worktree, 'untracked.txt'));
    await execFileAsync('git', ['config', 'user.email', 'gc@example.test'], { cwd: worktree });
    await execFileAsync('git', ['config', 'user.name', 'GC Test'], { cwd: worktree });
    await writeFile(join(worktree, 'tracked.txt'), 'local-only\n');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: worktree });
    await execFileAsync('git', ['commit', '-m', 'local-only'], { cwd: worktree });
    expect(await inspectSupervisionGitWorktree(worktree)).toMatchObject({ ok: true, unpushed: true });
  });
});
