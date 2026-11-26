import { describe, expect, it } from 'vitest';

import {
  isCanonicalSupervisionRepoPath,
  projectSupervisionSnapshotToAssignmentScope,
  supervisionBundleMatchesAssignmentScope,
} from '../../src/daemon/supervision-integration-scope.js';
import type { SupervisionWorktreeSnapshot } from '../../src/daemon/supervision-worktree-inspector.js';

const HEAD = 'a'.repeat(40);
const HASH = 'b'.repeat(64);

function snapshot(paths: Array<string | { path: string; deleted: true }>, overrides: Partial<SupervisionWorktreeSnapshot> = {}): SupervisionWorktreeSnapshot {
  return {
    worktreePath: '/tmp/assignment/repo',
    headSha: HEAD,
    files: paths.map((entry) => typeof entry === 'string'
      ? { path: entry, sha256: HASH }
      : entry),
    stagedPaths: [],
    conflictedPaths: [],
    untrackedPaths: [],
    ...overrides,
  };
}

describe('supervision integration assignment scope', () => {
  it('freezes exactly five owned rows and excludes byte-identical CRLF noise without touching it', () => {
    const owned = [
      'shared/audit-convergence.ts',
      'src/daemon/supervision-prompts.ts',
      'test/shared/audit-convergence.test.ts',
      'test/daemon/supervision-prompts.test.ts',
      'test/agent/transport-runtime-assembly.test.ts',
    ];
    const ps1 = 'native/windows-remote-desktop/build-worker-from-sdk.ps1';
    const observed = snapshot([...owned, ps1]);

    const projected = projectSupervisionSnapshotToAssignmentScope({
      snapshot: observed,
      scopeFiles: owned,
    });

    expect(projected).toMatchObject({
      ok: true,
      scopeFiles: [...owned].sort(),
      excludedPaths: [ps1],
      snapshot: { files: expect.any(Array) },
    });
    if (!projected.ok) throw new Error(projected.reason);
    expect(projected.snapshot.files.map((file) => file.path).sort()).toEqual([...owned].sort());
    expect(projected.snapshot.files).toHaveLength(5);
    expect(observed.files.map((file) => file.path)).toContain(ps1);
  });

  it('retains modified, new, deleted, and both rename endpoints only when owned', () => {
    const paths = ['src/modified.ts', 'src/new.ts', { path: 'src/rename-old.ts', deleted: true } as const, 'src/rename-new.ts'];
    const projected = projectSupervisionSnapshotToAssignmentScope({
      snapshot: snapshot([...paths, 'src/other-owner.ts'], {
        stagedPaths: ['src/rename-old.ts', 'src/rename-new.ts', 'src/other-owner.ts'],
        untrackedPaths: ['src/new.ts', 'src/other-owner.ts'],
      }),
      scopeFiles: paths.map((entry) => typeof entry === 'string' ? entry : entry.path),
    });
    expect(projected).toMatchObject({
      ok: true,
      excludedPaths: ['src/other-owner.ts'],
      snapshot: {
        stagedPaths: ['src/rename-old.ts', 'src/rename-new.ts'],
        untrackedPaths: ['src/new.ts'],
      },
    });
    if (!projected.ok) throw new Error(projected.reason);
    expect(projected.snapshot.files.map((file) => file.path)).toEqual(paths.map((entry) => (
      typeof entry === 'string' ? entry : entry.path
    )));
  });

  it('fails closed for duplicate or non-canonical (but non-empty) assignment scope', () => {
    const observed = snapshot(['src/a.ts']);
    for (const scopeFiles of [
      ['src/a.ts', 'src/a.ts'],
      ['./src/a.ts'],
      ['src/../outside.ts'],
      ['/src/a.ts'],
      ['src\\a.ts'],
      ['src//a.ts'],
      ['src/a.ts\u0000'],
    ]) {
      expect(projectSupervisionSnapshotToAssignmentScope({ snapshot: observed, scopeFiles }), scopeFiles.join(','))
        .toEqual({ ok: false, reason: 'invalid_scope' });
    }
  });

  it('regression: an assignment with an empty (never-declared) scopeFiles no longer rejects a real committed change', () => {
    // Before the fix, `scopeFiles: []` made `allowed = new Set([])`, so
    // `snapshot.files.filter((f) => allowed.has(f.path))` was ALWAYS empty
    // and every projection failed (`invalid_scope` via
    // `uniqueCanonicalPaths([])`, or `empty_manifest` once that returned a
    // scope) regardless of what the implementer actually committed. This is
    // the norm today: send_message's task object has no required
    // scopeFiles/ownedFiles, so a caller who never sets one gets
    // `scopeFiles: []` on the assignment -- indistinguishable from a
    // (degenerate, never-real) "declared empty" scope.
    const committed = ['src/real-change.ts', 'test/real-change.test.ts'];
    const observed = snapshot(committed, {
      stagedPaths: [],
      untrackedPaths: ['test/real-change.test.ts'],
    });

    const projected = projectSupervisionSnapshotToAssignmentScope({
      snapshot: observed,
      scopeFiles: [],
    });

    expect(projected).toMatchObject({ ok: true, excludedPaths: [] });
    if (!projected.ok) throw new Error(projected.reason);
    // No scope declared -> the fix trusts the already-verified committed
    // diff (every file in the snapshot) as the scope, not "reject outright".
    expect(projected.scopeFiles).toEqual([...committed].sort());
    expect(projected.snapshot.files.map((file) => file.path).sort()).toEqual([...committed].sort());
    expect(projected.snapshot.untrackedPaths).toEqual(['test/real-change.test.ts']);
  });

  it('a genuinely empty snapshot with no declared scope still fails closed (nothing to freeze)', () => {
    const projected = projectSupervisionSnapshotToAssignmentScope({
      snapshot: snapshot([]),
      scopeFiles: [],
    });
    expect(projected).toEqual({ ok: false, reason: 'empty_manifest' });
  });

  it('safety property preserved: a genuinely restrictive non-empty scope still excludes out-of-scope files exactly as before', () => {
    const owned = ['src/owned-a.ts', 'src/owned-b.ts'];
    const observed = snapshot([...owned, 'src/unrelated-dirty-file.ts', 'native/windows/unclaimed.ps1']);

    const projected = projectSupervisionSnapshotToAssignmentScope({
      snapshot: observed,
      scopeFiles: owned,
    });

    expect(projected).toMatchObject({
      ok: true,
      scopeFiles: [...owned].sort(),
      excludedPaths: ['native/windows/unclaimed.ps1', 'src/unrelated-dirty-file.ts'],
    });
    if (!projected.ok) throw new Error(projected.reason);
    expect(projected.snapshot.files.map((file) => file.path).sort()).toEqual([...owned].sort());

    // A declared scope that matches NOTHING in the snapshot is still a real
    // restriction that excludes everything -- must stay `empty_manifest`,
    // never silently fall back to "trust everything" like the [] case.
    const noMatch = projectSupervisionSnapshotToAssignmentScope({
      snapshot: observed,
      scopeFiles: ['src/never-touched.ts'],
    });
    expect(noMatch).toEqual({ ok: false, reason: 'empty_manifest' });
  });

  it('includes a newly observed file only after durable scope expansion', () => {
    const observed = snapshot(['src/initial.ts', 'test/expanded.test.ts']);
    const before = projectSupervisionSnapshotToAssignmentScope({
      snapshot: observed,
      scopeFiles: ['src/initial.ts'],
    });
    const after = projectSupervisionSnapshotToAssignmentScope({
      snapshot: observed,
      scopeFiles: ['src/initial.ts', 'test/expanded.test.ts'],
    });
    expect(before).toMatchObject({ ok: true, excludedPaths: ['test/expanded.test.ts'] });
    expect(after).toMatchObject({ ok: true, excludedPaths: [] });
    if (!before.ok || !after.ok) throw new Error('projection failed');
    expect(before.snapshot.files).toHaveLength(1);
    expect(after.snapshot.files).toHaveLength(2);
  });

  it('allows an explicitly shared path while excluding another owner path', () => {
    const projected = projectSupervisionSnapshotToAssignmentScope({
      snapshot: snapshot(['shared/common.ts', 'src/other-owner.ts']),
      scopeFiles: ['shared/common.ts'],
    });
    expect(projected).toMatchObject({
      ok: true,
      excludedPaths: ['src/other-owner.ts'],
      snapshot: { files: [{ path: 'shared/common.ts', sha256: HASH }] },
    });
  });

  it('rejects malformed snapshots instead of laundering them through filtering', () => {
    const cases = [
      snapshot(['src/a.ts', 'src/a.ts']),
      snapshot(['./src/a.ts']),
      snapshot(['src/a.ts'], { headSha: 'not-a-commit' }),
      snapshot(['src/a.ts'], { untrackedPaths: ['src/not-in-manifest.ts'] }),
      snapshot(['src/a.ts'], { stagedPaths: ['src/not-in-manifest.ts'] }),
      snapshot(['src/a.ts'], { conflictedPaths: ['src/a.ts', 'src/a.ts'] }),
      snapshot(['src/a.ts'], { worktreePath: 'relative/repo' }),
    ];
    for (const observed of cases) {
      expect(projectSupervisionSnapshotToAssignmentScope({
        snapshot: observed,
        scopeFiles: ['src/a.ts'],
      })).toEqual({ ok: false, reason: 'invalid_snapshot' });
    }
  });

  it('requires new bundle scope binding and reuses legacy manifests only when every row is in scope', () => {
    const assignmentScopeFiles = ['src/a.ts', 'test/a.test.ts'];
    expect(supervisionBundleMatchesAssignmentScope({
      assignmentScopeFiles,
      bundleScopeFiles: [...assignmentScopeFiles].reverse(),
      bundleFiles: [{ path: 'src/a.ts' }],
    })).toBe(true);
    expect(supervisionBundleMatchesAssignmentScope({
      assignmentScopeFiles,
      bundleScopeFiles: ['src/a.ts'],
      bundleFiles: [{ path: 'src/a.ts' }],
    })).toBe(false);
    expect(supervisionBundleMatchesAssignmentScope({
      assignmentScopeFiles,
      bundleFiles: assignmentScopeFiles.map((path) => ({ path })),
    })).toBe(true);
    expect(supervisionBundleMatchesAssignmentScope({
      assignmentScopeFiles,
      bundleFiles: [{ path: 'src/a.ts' }, { path: 'outside.ps1' }],
    })).toBe(false);
    expect(supervisionBundleMatchesAssignmentScope({
      assignmentScopeFiles,
      bundleFiles: [{ path: 'src/a.ts' }],
    })).toBe(true);

    const productionScope = Array.from({ length: 14 }, (_, index) => `src/owned-${index}.ts`);
    expect(supervisionBundleMatchesAssignmentScope({
      assignmentScopeFiles: productionScope,
      bundleFiles: productionScope.slice(0, 11).map((path) => ({ path })),
    })).toBe(true);
    expect(supervisionBundleMatchesAssignmentScope({
      assignmentScopeFiles: productionScope,
      bundleFiles: [
        ...productionScope.slice(0, 11).map((path) => ({ path })),
        { path: 'native/windows/unclaimed.ps1' },
      ],
    })).toBe(false);
  });

  it('defines canonical repository paths without normalizing attacker input', () => {
    expect(isCanonicalSupervisionRepoPath('src/a.ts')).toBe(true);
    expect(isCanonicalSupervisionRepoPath('native/windows/x.ps1')).toBe(true);
    expect(isCanonicalSupervisionRepoPath(' src/a.ts')).toBe(false);
    expect(isCanonicalSupervisionRepoPath('src/./a.ts')).toBe(false);
    expect(isCanonicalSupervisionRepoPath('src/../a.ts')).toBe(false);
  });
});
