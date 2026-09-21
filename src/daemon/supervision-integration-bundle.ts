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
  | {
    ok: false;
    reason: 'invalid' | 'unsafe_path' | 'source_mismatch' | 'hash_mismatch' | 'target_conflict' | 'unavailable';
    path?: string;
    /** Bounded causal fingerprints for operator-facing conflict diagnostics. */
    expected?: string;
    actual?: string;
  };

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

interface GitFileFingerprint {
  sha256: string;
  byteLength: number;
  gitBlobOid: string;
  mode: 0o644 | 0o755;
}

function fingerprintText(label: string, value: GitFileFingerprint | undefined): string {
  return value
    ? `${label}:git_blob=${value.gitBlobOid},sha256=${value.sha256},bytes=${value.byteLength},mode=${value.mode.toString(8)}`
    : `${label}:absent`;
}

/**
 * Ask Git's own attribute/filter machinery for the object identity that these
 * materialized bytes would have if added at `path`. This is deliberately not
 * an LF-only rewrite: .gitattributes may select text/eol or a repository
 * filter, and Git remains the single authority for all of them.
 */
function gitFingerprintBytes(
  worktreePath: string,
  path: string,
  bytes: Buffer,
  mode: 0o644 | 0o755,
): GitFileFingerprint | undefined {
  const hashed = spawnSync('git', ['-C', worktreePath, 'hash-object', `--path=${path}`, '--stdin'], {
    input: bytes, stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  const gitBlobOid = typeof hashed.stdout === 'string' ? hashed.stdout.trim().toLowerCase() : '';
  if (hashed.error || hashed.status !== 0 || !/^[a-f0-9]{40,64}$/.test(gitBlobOid)) return undefined;
  return { sha256: sha256(bytes), byteLength: bytes.length, gitBlobOid, mode };
}

/** Return the exact clean-filtered bytes without adding an object to the repo. */
function gitCleanFileState(
  worktreePath: string,
  path: string,
  bytes: Buffer,
  mode: 0o644 | 0o755,
): GitFileState | undefined {
  const objectDirectory = mkdtempSync(join(tmpdir(), 'imcodes-clean-objects-'));
  try {
    const env = { ...process.env, GIT_OBJECT_DIRECTORY: objectDirectory };
    const hashed = spawnSync('git', [
      '-C', worktreePath, 'hash-object', '-w', `--path=${path}`, '--stdin',
    ], { input: bytes, stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8', env, maxBuffer: 1024 * 1024 });
    const gitBlobOid = typeof hashed.stdout === 'string' ? hashed.stdout.trim().toLowerCase() : '';
    if (hashed.error || hashed.status !== 0 || !/^[a-f0-9]{40,64}$/.test(gitBlobOid)) return undefined;
    const cleaned = spawnSync('git', ['-C', worktreePath, 'cat-file', 'blob', gitBlobOid], {
      stdio: ['ignore', 'pipe', 'ignore'], env, maxBuffer: 16 * 1024 * 1024,
    });
    if (cleaned.error || cleaned.status !== 0 || !Buffer.isBuffer(cleaned.stdout)) return undefined;
    return {
      bytes: cleaned.stdout,
      sha256: sha256(cleaned.stdout),
      byteLength: cleaned.stdout.length,
      gitBlobOid,
      mode,
    };
  } finally {
    rmSync(objectDirectory, { recursive: true, force: true });
  }
}

function gitShowState(
  worktreePath: string,
  headSha: string,
  path: string,
): GitFileFingerprint | undefined {
  const shown = spawnSync('git', ['-C', worktreePath, 'show', `${headSha}:${path}`], {
    stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
  });
  if (shown.error || shown.status !== 0 || !Buffer.isBuffer(shown.stdout)) return undefined;
  const tree = spawnSync('git', ['-C', worktreePath, 'ls-tree', headSha, '--', path], {
    stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  if (tree.error || tree.status !== 0) return undefined;
  const parsed = /^(100644|100755)\s+blob\s+([a-f0-9]{40,64})(?:\s|\t)/.exec(tree.stdout.trim());
  if (!parsed) return undefined;
  return {
    sha256: sha256(shown.stdout),
    byteLength: shown.stdout.length,
    gitBlobOid: parsed[2].toLowerCase(),
    mode: parsed[1] === '100755' ? 0o755 : 0o644,
  };
}

interface GitFileState extends GitFileFingerprint {
  bytes: Buffer;
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
  return left?.gitBlobOid === right?.gitBlobOid && left?.mode === right?.mode;
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
  worktreePath: string,
  path: string,
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
    const fingerprint = gitFingerprintBytes(worktreePath, path, merged.stdout, mode);
    return fingerprint ? { bytes: merged.stdout, ...fingerprint } : null;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function targetFileState(worktreePath: string, path: string, repoPath: string): { kind: 'absent' } | {
  kind: 'file'; fingerprint: GitFileFingerprint;
} | { kind: 'unsafe' } {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return { kind: 'unsafe' };
    const mode = (info.mode & 0o111) === 0 ? 0o644 : 0o755;
    const fingerprint = gitFingerprintBytes(worktreePath, repoPath, readFileSync(path), mode);
    return fingerprint ? { kind: 'file', fingerprint } : { kind: 'unsafe' };
  } catch { return { kind: 'absent' }; }
}

function bundleFileFingerprint(
  bundle: SupervisionIntegrationBundle,
  worktreePath: string,
  file: SupervisionIntegrationBundleFile,
): GitFileFingerprint | undefined | null {
  if (file.deleted === true) return undefined;
  try {
    const bytes = readFileSync(resolve(bundle.bundlePath, 'files', file.path));
    if (sha256(bytes) !== file.sha256) return null;
    return gitFingerprintBytes(worktreePath, file.path, bytes, file.mode!) ?? null;
  } catch {
    return null;
  }
}

function sameFingerprint(
  left: GitFileFingerprint | undefined,
  right: GitFileFingerprint | undefined,
): boolean {
  return left?.gitBlobOid === right?.gitBlobOid && left?.mode === right?.mode;
}

export function compareSupervisionIntegrationBundleFile(input: {
  bundle: SupervisionIntegrationBundle;
  worktreePath: string;
  file: SupervisionIntegrationBundleFile;
}): SupervisionIntegrationBundleResult<{
  matches: boolean;
  expected: string;
  actual: string;
}> {
  const absolute = resolve(input.worktreePath, input.file.path);
  if (!within(resolve(input.worktreePath), absolute)) {
    return { ok: false, reason: 'unsafe_path', path: input.file.path };
  }
  const desired = bundleFileFingerprint(input.bundle, input.worktreePath, input.file);
  if (desired === null) return { ok: false, reason: 'hash_mismatch', path: input.file.path };
  const state = targetFileState(input.worktreePath, absolute, input.file.path);
  if (state.kind === 'unsafe') return { ok: false, reason: 'target_conflict', path: input.file.path };
  const current = state.kind === 'file' ? state.fingerprint : undefined;
  return {
    ok: true,
    matches: sameFingerprint(current, desired),
    expected: fingerprintText('bundle', desired),
    actual: fingerprintText('worktree', current),
  };
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
    desired?: GitFileFingerprint;
    current?: GitFileFingerprint;
    baseline?: GitFileFingerprint;
  }> = [];
  for (const file of input.bundle.files) {
    const absolute = resolve(worktreePath, file.path);
    if (!within(worktreePath, absolute)) return { ok: false, reason: 'unsafe_path', path: file.path };
    const state = targetFileState(worktreePath, absolute, file.path);
    if (state.kind === 'unsafe') return { ok: false, reason: 'target_conflict', path: file.path };
    const current = state.kind === 'file' ? state.fingerprint : undefined;
    const baseline = gitShowState(worktreePath, input.bundle.headSha, file.path);
    const desired = bundleFileFingerprint(input.bundle, worktreePath, file);
    if (desired === null) return { ok: false, reason: 'hash_mismatch', path: file.path };
    if (!sameFingerprint(current, desired)) replay = false;
    if (!sameFingerprint(current, desired) && !sameFingerprint(current, baseline)) {
      return {
        ok: false,
        reason: 'target_conflict',
        path: file.path,
        expected: `${fingerprintText('baseline', baseline)};${fingerprintText('bundle', desired)}`,
        actual: fingerprintText('worktree', current),
      };
    }
    preflight.push({ file, desired, current, baseline });
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
      const written = targetFileState(worktreePath, absolute, file.path);
      const desired = bundleFileFingerprint(input.bundle, worktreePath, file);
      if (desired === null || written.kind !== 'file' || !sameFingerprint(written.fingerprint, desired)) {
        return { ok: false, reason: 'hash_mismatch', path: file.path };
      }
    }
    for (const file of input.bundle.files) {
      const state = targetFileState(worktreePath, resolve(worktreePath, file.path), file.path);
      if (state.kind === 'unsafe') return { ok: false, reason: 'target_conflict', path: file.path };
      const actual = state.kind === 'file' ? state.fingerprint : undefined;
      const expected = bundleFileFingerprint(input.bundle, worktreePath, file);
      if (expected === null || !sameFingerprint(actual, expected)) {
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
    const bundleState = file.deleted === true ? undefined : (() => {
      try {
        const bytes = readFileSync(resolve(input.bundle.bundlePath, 'files', file.path));
        if (sha256(bytes) !== file.sha256) return null;
        return gitCleanFileState(worktreePath, file.path, bytes, file.mode!) ?? null;
      } catch { return null; }
    })();
    if (bundleState === null) return { ok: false, reason: 'hash_mismatch', path: file.path };
    const exactBundleState = file.deleted === true
      ? actual === undefined
      : sameGitFileState(actual, bundleState);
    // A divergent result is admissible only when the destination actually
    // moved this exact path after the frozen base. Otherwise the immutable
    // bundle byte remains the sole authority.
    if (sameGitFileState(base, ours)) {
      if (exactBundleState) continue;
      return { ok: false, reason: 'hash_mismatch', path: file.path };
    }
    const expected = mergeGitFileStates(worktreePath, file.path, base, ours, bundleState);
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
