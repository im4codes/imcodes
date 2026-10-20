import { isAbsolute } from 'node:path';

import type {
  SupervisionWorktreeFileSnapshot,
  SupervisionWorktreeSnapshot,
} from './supervision-worktree-inspector.js';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export type SupervisionIntegrationScopeResult =
  | {
    ok: true;
    scopeFiles: string[];
    snapshot: SupervisionWorktreeSnapshot;
    excludedPaths: string[];
  }
  | { ok: false; reason: 'invalid_scope' | 'invalid_snapshot' | 'empty_manifest' };

/**
 * Git reports repository paths with `/` separators and without `.` segments.
 * Requiring that exact representation prevents a scope entry such as
 * `src/../outside.ts` or `./src/a.ts` from becoming a second spelling of a
 * manifest path at an authority boundary.
 */
export function isCanonicalSupervisionRepoPath(path: string): boolean {
  return Boolean(path)
    && path === path.trim()
    && !path.startsWith('/')
    && !path.includes('\\')
    && !CONTROL_CHARS.test(path)
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function validFile(file: SupervisionWorktreeFileSnapshot): boolean {
  return isCanonicalSupervisionRepoPath(file.path)
    && (file.deleted === true
      ? file.sha256 === undefined
      : Boolean(file.sha256 && SHA256_RE.test(file.sha256)));
}

function uniqueCanonicalPaths(paths: readonly string[]): string[] | undefined {
  if (paths.length === 0 || !paths.every(isCanonicalSupervisionRepoPath)) return undefined;
  const unique = [...new Set(paths)];
  return unique.length === paths.length ? unique.sort() : undefined;
}

/**
 * Project a machine-observed worktree snapshot onto one assignment's durable
 * scope. The inspector intentionally observes the whole worktree; this is the
 * authority boundary that prevents unrelated dirty files from becoming
 * immutable implementation evidence.
 *
 * Scope is fail-closed: a REAL declared scope that is ambiguous or
 * non-canonical can never fall back to "all dirty files", and a real
 * declared scope that matches nothing in the snapshot is `empty_manifest`.
 * Outside-scope staging/conflicts/untracked files belong to another owner
 * and are excluded alongside their manifest rows. Inside-scope
 * staging/conflicts remain visible for the caller's normal refusal checks.
 *
 * `scopeFiles: []` is NOT treated as "a real scope declared as empty" --
 * per this project's own supervision_task_registry_v1 contract, scopeFiles
 * is record-only, non-authoritative metadata (`mode: 'record_only'`,
 * `authority: false`), and today every assignment that never had a scope
 * set (the norm: callers routinely omit ownedFiles/scopeFiles) is persisted
 * as `scopeFiles: []` -- indistinguishable at the type level from a
 * deliberately-empty scope, which would be a degenerate declaration no real
 * caller intends (it can only ever exclude every file). Treating `[]` as
 * "no scope was ever declared" and falling back to trusting the
 * already-verified snapshot (`snapshot.files`, which by the time this runs
 * reflects the real committed diff since the task's base revision, not
 * uncommitted-only state) preserves the actual security boundary -- an
 * implementer who DID declare a real, non-empty scope is still fail-closed
 * to exactly that scope, unchanged -- while no longer rejecting every
 * assignment that simply never set one.
 */
export function projectSupervisionSnapshotToAssignmentScope(input: {
  snapshot: SupervisionWorktreeSnapshot;
  scopeFiles: readonly string[];
}): SupervisionIntegrationScopeResult {
  const scopeDeclared = input.scopeFiles.length > 0;
  let scopeFiles: string[] = [];
  if (scopeDeclared) {
    const canonical = uniqueCanonicalPaths(input.scopeFiles);
    if (!canonical) return { ok: false, reason: 'invalid_scope' };
    scopeFiles = canonical;
  }

  const snapshot = input.snapshot;
  const filePaths = snapshot.files.map((file) => file.path);
  const filePathSet = new Set(filePaths);
  const validObservedPathList = (paths: readonly string[]) => (
    paths.length === new Set(paths).size
    && paths.every((path) => isCanonicalSupervisionRepoPath(path) && filePathSet.has(path))
  );
  if (!isAbsolute(snapshot.worktreePath)
    || !/^[a-f0-9]{40}$/.test(snapshot.headSha)
    || snapshot.files.length !== filePathSet.size
    || !snapshot.files.every(validFile)
    || !validObservedPathList(snapshot.stagedPaths)
    || !validObservedPathList(snapshot.conflictedPaths)
    || !validObservedPathList(snapshot.untrackedPaths)) {
    return { ok: false, reason: 'invalid_snapshot' };
  }

  // No declared scope trusts every already-verified snapshot file (the real
  // committed diff); a declared scope still filters down to exactly itself.
  const allowed = scopeDeclared ? new Set(scopeFiles) : filePathSet;
  const files = snapshot.files.filter((file) => allowed.has(file.path));
  if (files.length === 0) return { ok: false, reason: 'empty_manifest' };
  const included = new Set(files.map((file) => file.path));
  return {
    ok: true,
    scopeFiles: scopeDeclared ? scopeFiles : filePaths.slice().sort(),
    snapshot: {
      ...snapshot,
      files,
      stagedPaths: snapshot.stagedPaths.filter((path) => included.has(path)),
      conflictedPaths: snapshot.conflictedPaths.filter((path) => included.has(path)),
      untrackedPaths: snapshot.untrackedPaths.filter((path) => included.has(path)),
    },
    excludedPaths: filePaths.filter((path) => !included.has(path)).sort(),
  };
}

/**
 * New manifests carry the exact assignment scope that authorized their file
 * projection. A legacy manifest has no such field because the old freezer
 * recorded dirty files rather than every declared scope entry. It is safe when
 * every recorded file is inside the current assignment scope; unchanged scope
 * entries are expected to be absent. Any outside-scope row proves pollution.
 */
export function supervisionBundleMatchesAssignmentScope(input: {
  assignmentScopeFiles: readonly string[];
  bundleScopeFiles?: readonly string[];
  bundleFiles: readonly Pick<SupervisionWorktreeFileSnapshot, 'path'>[];
}): boolean {
  const assignmentScope = uniqueCanonicalPaths(input.assignmentScopeFiles);
  if (!assignmentScope) return false;
  const bundlePaths = input.bundleFiles.map((file) => file.path);
  if (bundlePaths.length === 0 || bundlePaths.length !== new Set(bundlePaths).size
    || !bundlePaths.every(isCanonicalSupervisionRepoPath)) return false;
  const assignmentSet = new Set(assignmentScope);
  if (!bundlePaths.every((path) => assignmentSet.has(path))) return false;

  if (input.bundleScopeFiles === undefined) {
    return true;
  }
  const boundScope = uniqueCanonicalPaths(input.bundleScopeFiles);
  return Boolean(boundScope
    && boundScope.length === assignmentScope.length
    && boundScope.every((path, index) => path === assignmentScope[index]));
}
