import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import type {
  SupervisionWorktreeFileSnapshot,
  SupervisionWorktreeSnapshot,
} from './supervision-worktree-inspector.js';
import { isCanonicalSupervisionRepoPath } from './supervision-integration-scope.js';

const BUNDLE_VERSION = 1 as const;
const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;

export interface SupervisionIntegrationBundle {
  version: typeof BUNDLE_VERSION;
  taskId: string;
  sourceAssignmentId: string;
  revision: string;
  headSha: string;
  manifestSha256: string;
  bundleRoot: string;
  bundlePath: string;
  /** Exact durable assignment scope that authorized this projection. */
  scopeFiles?: string[];
  files: SupervisionIntegrationBundleFile[];
}

export interface SupervisionIntegrationBundleFile extends SupervisionWorktreeFileSnapshot {
  /** Git's durable regular-file mode, not the bundle object's read-only mode. */
  mode?: 0o644 | 0o755;
}

interface BundleManifest {
  version: typeof BUNDLE_VERSION;
  taskId: string;
  sourceAssignmentId: string;
  revision: string;
  headSha: string;
  /** Absent only on legacy manifests frozen before scope binding existed. */
  scopeFiles?: string[];
  files: SupervisionIntegrationBundleFile[];
}

export type SupervisionIntegrationBundleResult<T> =
  | ({ ok: true } & T)
  | { ok: false; reason: 'invalid' | 'unsafe_path' | 'source_mismatch' | 'hash_mismatch' | 'target_conflict' | 'unavailable'; path?: string };

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileSha256(path: string): string {
  const fd = openSync(path, 'r');
  try { return sha256(readFileSync(fd)); } finally { closeSync(fd); }
}

function canonicalFiles(files: readonly SupervisionIntegrationBundleFile[]): SupervisionIntegrationBundleFile[] {
  return files.map((file) => file.deleted === true
    ? { path: file.path, deleted: true as const }
    : { path: file.path, sha256: file.sha256?.toLowerCase(), mode: file.mode })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function canonicalManifest(input: {
  taskId: string;
  assignmentId: string;
  revision: string;
  headSha: string;
  scopeFiles?: readonly string[];
  files: SupervisionIntegrationBundleFile[];
}): BundleManifest | undefined {
  const taskId = input.taskId.trim();
  const sourceAssignmentId = input.assignmentId.trim();
  const revision = input.revision.trim();
  const headSha = input.headSha.trim().toLowerCase();
  const scopeFiles = input.scopeFiles === undefined
    ? undefined
    : [...input.scopeFiles].sort((left, right) => left.localeCompare(right));
  const files = canonicalFiles(input.files);
  const scopeSet = scopeFiles ? new Set(scopeFiles) : undefined;
  if (!taskId || !sourceAssignmentId || !revision || !COMMIT_RE.test(headSha)
    || (scopeFiles !== undefined && (scopeFiles.length === 0
      || scopeFiles.length !== new Set(scopeFiles).size
      || !scopeFiles.every(isCanonicalSupervisionRepoPath)))
    || files.length === 0 || files.length !== new Set(files.map((file) => file.path)).size
    || !files.every((file) => isCanonicalSupervisionRepoPath(file.path)
      && (!scopeSet || scopeSet.has(file.path))
      && (file.deleted === true
        ? !file.sha256 && file.mode === undefined
        : Boolean(file.sha256 && SHA256_RE.test(file.sha256)
          && (file.mode === 0o644 || file.mode === 0o755))))) {
    return undefined;
  }
  return {
    version: BUNDLE_VERSION, taskId, sourceAssignmentId, revision, headSha,
    ...(scopeFiles ? { scopeFiles } : {}),
    files,
  };
}

function manifestText(manifest: BundleManifest): string {
  return `${JSON.stringify(manifest)}\n`;
}

export function resolveSupervisionIntegrationBundleRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.IMCODES_HOME?.trim() || join(homedir(), '.imcodes');
  return resolve(env.IMCODES_SUPERVISION_BUNDLES_ROOT?.trim()
    || join(home, 'supervision-integration-bundles'));
}

function expectedBundlePath(root: string, manifestSha256: string): string {
  return join(root, manifestSha256.slice(0, 2), manifestSha256);
}

function verifyManifestBinding(bundle: SupervisionIntegrationBundle): BundleManifest | undefined {
  if (bundle.version !== BUNDLE_VERSION) return undefined;
  const manifest = canonicalManifest({
    taskId: bundle.taskId,
    assignmentId: bundle.sourceAssignmentId,
    revision: bundle.revision,
    headSha: bundle.headSha,
    ...(bundle.scopeFiles !== undefined ? { scopeFiles: bundle.scopeFiles } : {}),
    files: canonicalFiles(bundle.files),
  });
  if (!manifest) return undefined;
  return sha256(manifestText(manifest)) === bundle.manifestSha256 ? manifest : undefined;
}

export function isValidSupervisionIntegrationBundleBinding(
  bundle: SupervisionIntegrationBundle,
): boolean {
  return Boolean(
    bundle.version === BUNDLE_VERSION
    && bundle.taskId.trim()
    && bundle.sourceAssignmentId.trim()
    && bundle.revision.trim()
    && COMMIT_RE.test(bundle.headSha)
    && SHA256_RE.test(bundle.manifestSha256)
    && isAbsolute(bundle.bundleRoot)
    && isAbsolute(bundle.bundlePath)
    && resolve(bundle.bundlePath) === expectedBundlePath(resolve(bundle.bundleRoot), bundle.manifestSha256)
    && verifyManifestBinding(bundle),
  );
}

export function verifySupervisionIntegrationBundle(
  bundle: SupervisionIntegrationBundle,
): SupervisionIntegrationBundleResult<Record<never, never>> {
  try {
    const manifest = verifyManifestBinding(bundle);
    if (!isValidSupervisionIntegrationBundleBinding(bundle) || !manifest) return { ok: false, reason: 'invalid' };
    const bundlePathInfo = lstatSync(bundle.bundlePath);
    if (!bundlePathInfo.isDirectory() || bundlePathInfo.isSymbolicLink()) {
      return { ok: false, reason: 'unsafe_path' };
    }
    const bundlePath = realpathSync(bundle.bundlePath);
    const root = realpathSync(bundle.bundleRoot);
    if (!within(root, bundlePath)
      || bundlePath !== realpathSync(expectedBundlePath(root, bundle.manifestSha256))
      || basename(bundlePath) !== bundle.manifestSha256
    ) return { ok: false, reason: 'unsafe_path' };
    const storedManifestPath = join(bundlePath, 'manifest.json');
    if (lstatSync(storedManifestPath).isSymbolicLink()
      || readFileSync(storedManifestPath, 'utf8') !== manifestText(manifest)) {
      return { ok: false, reason: 'hash_mismatch', path: 'manifest.json' };
    }
    const filesRoot = join(bundlePath, 'files');
    for (const file of manifest.files) {
      if (file.deleted === true) continue;
      const absolute = resolve(filesRoot, file.path);
      if (!within(filesRoot, absolute)) return { ok: false, reason: 'unsafe_path', path: file.path };
      const info = lstatSync(absolute);
      if (!info.isFile() || info.isSymbolicLink()) return { ok: false, reason: 'unsafe_path', path: file.path };
      if (fileSha256(absolute) !== file.sha256) return { ok: false, reason: 'hash_mismatch', path: file.path };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

export function freezeSupervisionIntegrationBundle(input: {
  taskId: string;
  assignmentId: string;
  revision: string;
  snapshot: SupervisionWorktreeSnapshot;
  scopeFiles: readonly string[];
  bundleRoot?: string;
  now?: number;
}): SupervisionIntegrationBundleResult<{ bundle: SupervisionIntegrationBundle; replay: boolean }> {
  const sourceRoot = resolve(input.snapshot.worktreePath);
  let canonicalSource: string;
  let files: SupervisionIntegrationBundleFile[];
  try {
    canonicalSource = realpathSync(sourceRoot);
    files = input.snapshot.files.map((file) => {
      if (file.deleted === true) return { path: file.path, deleted: true };
      const source = resolve(canonicalSource, file.path);
      if (!within(canonicalSource, source)) throw new Error('unsafe path');
      const info = lstatSync(source);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe file');
      return {
        path: file.path,
        sha256: file.sha256,
        mode: (info.mode & 0o111) === 0 ? 0o644 : 0o755,
      };
    });
  } catch {
    return { ok: false, reason: 'source_mismatch' };
  }
  const manifest = canonicalManifest({
    taskId: input.taskId,
    assignmentId: input.assignmentId,
    revision: input.revision,
    headSha: input.snapshot.headSha,
    scopeFiles: input.scopeFiles,
    files,
  });
  if (!manifest) return { ok: false, reason: 'invalid' };
  const text = manifestText(manifest);
  const manifestSha256 = sha256(text);
  const bundleRoot = resolve(input.bundleRoot ?? resolveSupervisionIntegrationBundleRoot());
  const bundlePath = expectedBundlePath(bundleRoot, manifestSha256);
  const bundle: SupervisionIntegrationBundle = {
    ...manifest,
    manifestSha256,
    bundleRoot,
    bundlePath,
  };
  if (existsSync(bundlePath)) {
    const existing = verifySupervisionIntegrationBundle(bundle);
    return existing.ok ? { ok: true, bundle, replay: true } : existing;
  }

  const temporary = `${bundlePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    mkdirSync(dirname(bundlePath), { recursive: true, mode: 0o700 });
    mkdirSync(join(temporary, 'files'), { recursive: true, mode: 0o700 });
    for (const file of manifest.files) {
      if (file.deleted === true) continue;
      const source = resolve(canonicalSource, file.path);
      if (!within(canonicalSource, source)) return { ok: false, reason: 'unsafe_path', path: file.path };
      const info = lstatSync(source);
      if (!info.isFile() || info.isSymbolicLink()) return { ok: false, reason: 'unsafe_path', path: file.path };
      if (fileSha256(source) !== file.sha256) return { ok: false, reason: 'source_mismatch', path: file.path };
      const target = resolve(temporary, 'files', file.path);
      if (!within(join(temporary, 'files'), target)) return { ok: false, reason: 'unsafe_path', path: file.path };
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(source, target);
      if (fileSha256(target) !== file.sha256) return { ok: false, reason: 'hash_mismatch', path: file.path };
      chmodSync(target, 0o400);
    }
    writeFileSync(join(temporary, 'manifest.json'), text, { encoding: 'utf8', flag: 'wx', mode: 0o400 });
    let replay = false;
    try {
      renameSync(temporary, bundlePath);
    } catch (error) {
      if (!existsSync(bundlePath)) throw error;
      rmSync(temporary, { recursive: true, force: true });
      replay = true;
    }
    const verified = verifySupervisionIntegrationBundle(bundle);
    return verified.ok ? { ok: true, bundle, replay } : verified;
  } catch {
    return { ok: false, reason: 'unavailable' };
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
  }
}

function gitShowState(
  worktreePath: string,
  headSha: string,
  path: string,
): { sha256: string; mode: 0o644 | 0o755 } | undefined {
  const shown = spawnSync('git', ['-C', worktreePath, 'show', `${headSha}:${path}`], {
    stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
  });
  if (shown.error || shown.status !== 0 || !Buffer.isBuffer(shown.stdout)) return undefined;
  const tree = spawnSync('git', ['-C', worktreePath, 'ls-tree', headSha, '--', path], {
    stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  if (tree.error || tree.status !== 0) return undefined;
  const mode = tree.stdout.trim().split(/\s+/, 1)[0];
  if (mode !== '100644' && mode !== '100755') return undefined;
  return { sha256: sha256(shown.stdout), mode: mode === '100755' ? 0o755 : 0o644 };
}

interface GitFileState {
  bytes: Buffer;
  sha256: string;
  mode: 0o644 | 0o755;
}

function gitShowFileState(
  worktreePath: string,
  headSha: string,
  path: string,
): GitFileState | undefined {
  const shown = spawnSync('git', ['-C', worktreePath, 'show', `${headSha}:${path}`], {
    stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
  });
  if (shown.error || shown.status !== 0 || !Buffer.isBuffer(shown.stdout)) return undefined;
  const state = gitShowState(worktreePath, headSha, path);
  return state ? { ...state, bytes: shown.stdout } : undefined;
}

function sameGitFileState(left: GitFileState | undefined, right: GitFileState | undefined): boolean {
  return left?.sha256 === right?.sha256 && left?.mode === right?.mode;
}

function mergeFileMode(
  base: GitFileState | undefined,
  ours: GitFileState | undefined,
  theirs: GitFileState | undefined,
): 0o644 | 0o755 | undefined | null {
  const baseMode = base?.mode;
  const oursMode = ours?.mode;
  const theirsMode = theirs?.mode;
  if (oursMode === theirsMode) return oursMode;
  if (oursMode === baseMode) return theirsMode;
  if (theirsMode === baseMode) return oursMode;
  return null;
}

/**
 * Compute the exact merge result for one bundle path without trusting caller
 * bytes. `undefined` is a legitimate deleted result; `null` is a conflict or
 * unsupported/binary merge and therefore fails closed.
 */
function mergeGitFileStates(
  base: GitFileState | undefined,
  ours: GitFileState | undefined,
  theirs: GitFileState | undefined,
): GitFileState | undefined | null {
  if (sameGitFileState(ours, theirs)) return ours;
  if (sameGitFileState(ours, base)) return theirs;
  if (sameGitFileState(theirs, base)) return ours;
  if (!base || !ours || !theirs) return null;
  const mode = mergeFileMode(base, ours, theirs);
  if (mode === null || mode === undefined) return null;
  const root = mkdtempSync(join(tmpdir(), 'imcodes-integration-merge-'));
  try {
    const oursPath = join(root, 'ours');
    const basePath = join(root, 'base');
    const theirsPath = join(root, 'theirs');
    writeFileSync(oursPath, ours.bytes);
    writeFileSync(basePath, base.bytes);
    writeFileSync(theirsPath, theirs.bytes);
    const merged = spawnSync('git', ['merge-file', '--stdout', oursPath, basePath, theirsPath], {
      stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
    });
    if (merged.error || merged.status !== 0 || !Buffer.isBuffer(merged.stdout)) return null;
    return { bytes: merged.stdout, sha256: sha256(merged.stdout), mode };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function targetFileState(path: string): { kind: 'absent' } | {
  kind: 'file'; sha256: string; mode: 0o644 | 0o755;
} | { kind: 'unsafe' } {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink()
      ? { kind: 'file', sha256: fileSha256(path), mode: (info.mode & 0o111) === 0 ? 0o644 : 0o755 }
      : { kind: 'unsafe' };
  } catch { return { kind: 'absent' }; }
}

function gitChangedPaths(worktreePath: string): string[] {
  const commands = [
    ['diff', '--name-only', 'HEAD', '--'],
    ['diff', '--cached', '--name-only', 'HEAD', '--'],
    ['ls-files', '--others', '--exclude-standard'],
    ['diff', '--name-only', '--diff-filter=U', '--'],
  ];
  return [...new Set(commands.flatMap((args) => execFileSync('git', ['-C', worktreePath, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).split('\n').map((path) => path.trim()).filter(Boolean)))].sort();
}

export function applySupervisionIntegrationBundle(input: {
  bundle: SupervisionIntegrationBundle;
  worktreePath: string;
}): SupervisionIntegrationBundleResult<{ replay: boolean }> {
  const verified = verifySupervisionIntegrationBundle(input.bundle);
  if (!verified.ok) return verified;
  let worktreePath: string;
  try {
    worktreePath = realpathSync(resolve(input.worktreePath));
    const root = realpathSync(execFileSync('git', ['-C', worktreePath, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
    const headSha = execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().toLowerCase();
    if (root !== worktreePath || headSha !== input.bundle.headSha) return { ok: false, reason: 'target_conflict' };
  } catch { return { ok: false, reason: 'unavailable' }; }

  let replay = true;
  const expectedPaths = new Set(input.bundle.files.map((file) => file.path));
  try {
    const unexpected = gitChangedPaths(worktreePath).find((path) => !expectedPaths.has(path));
    if (unexpected) return { ok: false, reason: 'target_conflict', path: unexpected };
  } catch { return { ok: false, reason: 'unavailable' }; }
  const preflight: Array<{
    file: SupervisionIntegrationBundleFile;
    current?: { sha256: string; mode: 0o644 | 0o755 };
    baseline?: { sha256: string; mode: 0o644 | 0o755 };
  }> = [];
  for (const file of input.bundle.files) {
    const absolute = resolve(worktreePath, file.path);
    if (!within(worktreePath, absolute)) return { ok: false, reason: 'unsafe_path', path: file.path };
    const state = targetFileState(absolute);
    if (state.kind === 'unsafe') return { ok: false, reason: 'target_conflict', path: file.path };
    const current = state.kind === 'file' ? { sha256: state.sha256, mode: state.mode } : undefined;
    const baseline = gitShowState(worktreePath, input.bundle.headSha, file.path);
    const desired = file.deleted === true ? undefined : { sha256: file.sha256!, mode: file.mode! };
    if (JSON.stringify(current) !== JSON.stringify(desired)) replay = false;
    if (JSON.stringify(current) !== JSON.stringify(desired)
      && JSON.stringify(current) !== JSON.stringify(baseline)) {
      return { ok: false, reason: 'target_conflict', path: file.path };
    }
    preflight.push({ file, current, baseline });
  }
  if (replay) return { ok: true, replay: true };

  try {
    for (const { file } of preflight) {
      const absolute = resolve(worktreePath, file.path);
      if (file.deleted === true) {
        if (existsSync(absolute)) unlinkSync(absolute);
        continue;
      }
      const source = resolve(input.bundle.bundlePath, 'files', file.path);
      mkdirSync(dirname(absolute), { recursive: true });
      const temporary = `${absolute}.bundle-${process.pid}-${randomUUID()}`;
      copyFileSync(source, temporary);
      if (fileSha256(temporary) !== file.sha256) {
        unlinkSync(temporary);
        return { ok: false, reason: 'hash_mismatch', path: file.path };
      }
      chmodSync(temporary, file.mode!);
      renameSync(temporary, absolute);
      const written = targetFileState(absolute);
      if (written.kind !== 'file' || written.sha256 !== file.sha256 || written.mode !== file.mode) {
        return { ok: false, reason: 'hash_mismatch', path: file.path };
      }
    }
    for (const file of input.bundle.files) {
      const state = targetFileState(resolve(worktreePath, file.path));
      if (state.kind === 'unsafe') return { ok: false, reason: 'target_conflict', path: file.path };
      const actual = state.kind === 'file' ? { sha256: state.sha256, mode: state.mode } : undefined;
      const expected = file.deleted === true ? undefined : { sha256: file.sha256!, mode: file.mode! };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        return { ok: false, reason: 'hash_mismatch', path: file.path };
      }
    }
    const changed = gitChangedPaths(worktreePath);
    // A frozen bundle may include scope-authorized files whose desired bytes
    // already equal HEAD.  The per-file verification above proves every
    // desired byte (including deletions and modes); requiring every manifest
    // path to also appear in `git diff` incorrectly rejects that valid shape
    // after the bundle has already been applied.  Only paths outside the
    // immutable bundle are conflicts.
    if (changed.some((path) => !expectedPaths.has(path))) {
      return { ok: false, reason: 'target_conflict', path: changed.find((path) => !expectedPaths.has(path)) };
    }
    return { ok: true, replay: false };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** Verify the durable Git object before finalization retires mutable worktrees. */
export function verifySupervisionIntegrationCommit(input: {
  bundle: SupervisionIntegrationBundle;
  worktreePath: string;
  commitSha: string;
}): SupervisionIntegrationBundleResult<{
  mergedWithNewerBase?: readonly { path: string; parentSha: string }[];
}> {
  const verified = verifySupervisionIntegrationBundle(input.bundle);
  if (!verified.ok) return verified;
  const commitSha = input.commitSha.trim().toLowerCase();
  if (!COMMIT_RE.test(commitSha)) return { ok: false, reason: 'invalid' };
  let worktreePath: string;
  let parentSha: string;
  try {
    worktreePath = realpathSync(resolve(input.worktreePath));
    const root = realpathSync(execFileSync('git', ['-C', worktreePath, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
    const resolvedCommit = execFileSync('git', ['-C', worktreePath, 'rev-parse', `${commitSha}^{commit}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().toLowerCase();
    parentSha = execFileSync('git', ['-C', worktreePath, 'rev-parse', `${commitSha}^1`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().toLowerCase();
    if (root !== worktreePath || resolvedCommit !== commitSha) return { ok: false, reason: 'target_conflict' };
    const ancestry = spawnSync('git', [
      '-C', worktreePath, 'merge-base', '--is-ancestor', input.bundle.headSha, parentSha,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    if (ancestry.error || ancestry.status !== 0) return { ok: false, reason: 'target_conflict' };
  } catch { return { ok: false, reason: 'unavailable' }; }
  const mergedWithNewerBase: Array<{ path: string; parentSha: string }> = [];
  for (const file of input.bundle.files) {
    const actual = gitShowFileState(worktreePath, commitSha, file.path);
    const base = gitShowFileState(worktreePath, input.bundle.headSha, file.path);
    const ours = gitShowFileState(worktreePath, parentSha, file.path);
    const exactBundleState = file.deleted === true
      ? actual === undefined
      : actual?.sha256 === file.sha256 && actual?.mode === file.mode;
    // A divergent result is admissible only when the destination actually
    // moved this exact path after the frozen base. Otherwise the immutable
    // bundle byte remains the sole authority.
    if (sameGitFileState(base, ours)) {
      if (exactBundleState) continue;
      return { ok: false, reason: 'hash_mismatch', path: file.path };
    }
    const theirs = file.deleted === true ? undefined : (() => {
      try {
        const bytes = readFileSync(resolve(input.bundle.bundlePath, 'files', file.path));
        return { bytes, sha256: sha256(bytes), mode: file.mode! };
      } catch { return null; }
    })();
    if (theirs === null) return { ok: false, reason: 'hash_mismatch', path: file.path };
    const expected = mergeGitFileStates(base, ours, theirs);
    if (expected === null || !sameGitFileState(actual, expected)) {
      return { ok: false, reason: 'hash_mismatch', path: file.path };
    }
    mergedWithNewerBase.push({ path: file.path, parentSha });
  }
  return {
    ok: true,
    ...(mergedWithNewerBase.length > 0 ? { mergedWithNewerBase } : {}),
  };
}
