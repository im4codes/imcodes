import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  CONTROLLED_NODE_ARTIFACT_ASSETS,
  CONTROLLED_NODE_ARTIFACT_HEADERS,
  CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH,
  controlledNodeDaemonRuntimeTarget,
} from '../../shared/controlled-node-artifacts.js';
import {
  DESKTOP_RELEASE_MANIFEST_FILENAME,
  desktopReleaseTargetManifestFilename,
  releaseTargetFromRuntime,
  validateDesktopReleaseManifest,
  verifyDesktopReleaseComponentIdentity,
  type DesktopReleaseManifest,
  type DesktopReleaseTarget,
} from '../../shared/desktop-release-manifest.js';
import { compareImcodesVersions } from '../../shared/imcodes-version.js';
import { isPathInsideGitCheckout } from '../node/desktop-installer-probe.js';
import { imcodesStateDir, imcodesStateDirForHome } from '../util/imcodes-state-dir.js';
import { buildPosixRestartCommand } from '../util/posix-upgrade-script.js';
import { windowsTaskName } from '../util/windows-daemon-watchdog.mjs';

export const DAEMON_RUNTIME_STAGING_PREFIX = '.staging-';
export const DAEMON_RUNTIME_FILES_FILENAME = 'daemon-runtime.files.json';
export const DAEMON_RUNTIME_PREVIOUS_STATE_FILE = '.previous-target.json';
export const DAEMON_RUNTIME_CRITICAL_ENTRY_PATHS = [
  'package/package.json',
  'package/config/default.yaml',
  'package/dist/src/index.js',
  'package/dist/src/cli.js',
  'package/dist/src/daemon/memory-mcp-bootstrap.js',
  'package/dist/src/context/embedding-worker-bootstrap.mjs',
  'package/dist/src/store/context-store-worker-bootstrap.mjs',
] as const;

const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type DaemonRuntimePlatform = 'linux' | 'darwin' | 'win32';
export type DaemonRuntimeExecutionMode = 'dev_exempt' | 'bundled' | 'legacy_cli';
export type WritableRuntimeRootKind = 'in_place' | 'user_fallback';

export interface DaemonRuntimeModeInspection {
  mode: DaemonRuntimeExecutionMode;
  reason: string;
  activeRoot?: string;
  activeLayout?: string;
  devCheckoutPath?: string;
}

export interface WritableDaemonRuntimeResolution {
  targetRoot: string;
  writableRootKind: WritableRuntimeRootKind;
  activeRoot: string;
}

export type DaemonRuntimeArtifactSource =
  | {
      kind: 'server';
      serverUrl: string;
      serverId: string;
      token: string;
      fetchImpl?: typeof fetch;
    }
  | {
      kind: 'local';
      dir: string;
    };

export interface DaemonRuntimeManifestData {
  schemaVersion: 1;
  target: {
    os: 'linux' | 'darwin' | 'win32';
    arch: 'x64' | 'arm64';
    nodeRelativePath: string;
    entryRelativePath: string;
  };
  archive: {
    format: 'tar.gz' | 'zip';
    fileName: string;
    size: number;
    sha256: string;
  };
  build: {
    commit: string;
    version: string;
  };
  toolchain: {
    nodeProvider: string;
    nodeVersion: string;
  };
}

export interface DaemonRuntimeRestartContext {
  platform: DaemonRuntimePlatform;
  runtimeRoot: string;
  releaseDir: string;
  targetVersion: string;
  previousVersion?: string;
  previousTarget?: string;
}

export interface DaemonRuntimeHealthCheckContext {
  phase: 'pre_switch' | 'post_restart';
  platform: DaemonRuntimePlatform;
  runtimeRoot: string;
  releaseDir: string;
  nodePath: string;
  entryPath: string;
  expectedVersion: string;
}

export interface DaemonRuntimeUpgradeOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  currentVersion: string;
  targetVersion?: string;
  execPath?: string;
  entryScriptPath?: string;
  env?: NodeJS.ProcessEnv;
  userHome?: string;
  runtimeRootOverride?: string;
  source?: DaemonRuntimeArtifactSource;
  allowLegacyCliFallback?: boolean;
  requireFullEntries?: boolean;
  healthCheckTimeoutMs?: number;
  detachedHandoff?: boolean;
  /** Optional custom extractor (primarily for deterministic unit testing). */
  extractArchive?: (input: {
    archivePath: string;
    format: 'tar.gz' | 'zip';
    destDir: string;
    platform: DaemonRuntimePlatform;
  }) => Promise<void> | void;
  /** Optional health check hook overriding default process probes. */
  healthCheck?: (ctx: DaemonRuntimeHealthCheckContext) => Promise<void> | void;
  /** Optional service restart hook; default executes platform restart command when detached or requested. */
  restartService?: (ctx: DaemonRuntimeRestartContext) => Promise<void> | void;
  /** Custom detached runner spawner (used in daemon-handler integration & tests). */
  spawnDetachedRunner?: (scriptPath: string, args: string[], scriptDir: string) => void;
  now?: () => number;
}

export type DaemonRuntimeUpgradeResult =
  | {
      status: 'upgraded';
      targetVersion: string;
      previousVersion?: string;
      previousTarget?: string;
      runtimeRoot: string;
      releaseDir: string;
      currentLink: string;
      writableRootKind: WritableRuntimeRootKind;
      rolledBack: false;
      detachedScriptDir?: string;
    }
  | {
      status: 'rolled_back';
      targetVersion: string;
      previousVersion?: string;
      restoredTarget?: string;
      runtimeRoot: string;
      reason: string;
      rolledBack: true;
    }
  | {
      status: 'up_to_date';
      currentVersion: string;
      targetVersion?: string;
    }
  | {
      status: 'blocked';
      reason: 'dev_symlink_exempt' | 'downgrade_refused' | 'no_writable_runtime_root' | 'version_mismatch';
      message: string;
    }
  | {
      status: 'fallback_legacy_cli';
      reason: string;
    };

export interface DaemonServerCredential {
  serverUrl: string;
  serverId: string;
  token: string;
}

function sha256Buffer(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath: string): string {
  return sha256Buffer(readFileSync(filePath));
}

function toDaemonRuntimePlatform(platform: NodeJS.Platform): DaemonRuntimePlatform | null {
  if (platform === 'linux' || platform === 'darwin' || platform === 'win32') return platform;
  return null;
}

function isInsideNodeModules(resolvedPath: string): boolean {
  const norm = resolvedPath.replace(/\\/gu, '/');
  return norm.includes('/node_modules/');
}

function isSubPath(candidatePath: string, rootPath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function readPackageVersionSync(layoutDir: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(layoutDir, 'package', 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    if (typeof raw.version === 'string' && raw.version.trim().length > 0) {
      return raw.version.trim();
    }
  } catch {
    // ignore missing or malformed package.json
  }
  return undefined;
}

function safeRealpath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    return resolve(targetPath);
  }
}

function inferBundledRootFromLayout(layoutDir: string): string | null {
  const base = basename(layoutDir);
  const parent = dirname(layoutDir);
  if (basename(parent) === 'releases') {
    return dirname(parent);
  }
  if (base === 'current' || base === 'daemon-runtime') {
    return base === 'current' ? parent : layoutDir;
  }
  if (basename(parent) === 'daemon-runtime') {
    return parent;
  }
  return null;
}

function layoutDirFromExecPath(execPath: string, platform: NodeJS.Platform): string | null {
  const execDir = dirname(execPath);
  if (platform === 'win32') {
    if (basename(execPath).toLowerCase() === 'node.exe') return execDir;
    return null;
  }
  if (basename(execDir) === 'bin' && basename(execPath) === 'node') {
    return dirname(execDir);
  }
  return null;
}

/**
 * Determine whether the current execution is running inside a dev checkout/symlink
 * (exempt from mutation), a bundled `daemon-runtime`, or a legacy npm/CLI install.
 */
export function inspectDaemonRuntimeMode(options: {
  platform?: NodeJS.Platform;
  execPath?: string;
  entryScriptPath?: string;
  env?: NodeJS.ProcessEnv;
  runtimeRootOverride?: string;
} = {}): DaemonRuntimeModeInspection {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const entryScriptPath = options.entryScriptPath ?? process.argv[1];

  if (entryScriptPath) {
    const resolvedEntry = safeRealpath(entryScriptPath);
    if (!isInsideNodeModules(resolvedEntry) && isPathInsideGitCheckout(resolvedEntry)) {
      return {
        mode: 'dev_exempt',
        reason: 'dev_symlink_exempt',
        devCheckoutPath: resolvedEntry,
      };
    }
  }

  if (options.runtimeRootOverride?.trim()) {
    const activeRoot = resolve(options.runtimeRootOverride.trim());
    const resolvedRoot = safeRealpath(activeRoot);
    if (isPathInsideGitCheckout(resolvedRoot)) {
      return {
        mode: 'dev_exempt',
        reason: 'dev_symlink_exempt',
        devCheckoutPath: resolvedRoot,
      };
    }
    const currentLayout = join(activeRoot, 'current');
    if (existsSync(currentLayout) && isPathInsideGitCheckout(safeRealpath(currentLayout))) {
      return {
        mode: 'dev_exempt',
        reason: 'dev_symlink_exempt',
        devCheckoutPath: safeRealpath(currentLayout),
      };
    }
    return {
      mode: 'bundled',
      reason: 'runtime_root_override',
      activeRoot,
      activeLayout: existsSync(currentLayout) ? currentLayout : activeRoot,
    };
  }

  // Inspect both unresolved execPath (preserves `current/` symlink identity) and realpath
  for (const candidateExec of [execPath, safeRealpath(execPath)]) {
    const layoutDir = layoutDirFromExecPath(candidateExec, platform);
    if (!layoutDir) continue;
    const root = inferBundledRootFromLayout(layoutDir);
    if (!root) continue;
    const hasEntry =
      existsSync(join(layoutDir, 'package', 'dist', 'src', 'index.js')) ||
      (entryScriptPath ? isSubPath(safeRealpath(entryScriptPath), safeRealpath(layoutDir)) : false);
    if (!hasEntry) continue;
    const resolvedLayout = safeRealpath(layoutDir);
    if (isPathInsideGitCheckout(resolvedLayout)) {
      return {
        mode: 'dev_exempt',
        reason: 'dev_symlink_exempt',
        devCheckoutPath: resolvedLayout,
      };
    }
    return {
      mode: 'bundled',
      reason: 'bundled_exec_path',
      activeRoot: root,
      activeLayout: layoutDir,
    };
  }

  const envRuntimeDir = env.IMCODES_DAEMON_RUNTIME_DIR?.trim();
  if (envRuntimeDir && entryScriptPath) {
    const resolvedEnvRoot = resolve(envRuntimeDir);
    const resolvedEntry = safeRealpath(entryScriptPath);
    if (isSubPath(resolvedEntry, safeRealpath(resolvedEnvRoot))) {
      return {
        mode: 'bundled',
        reason: 'env_daemon_runtime_dir',
        activeRoot: resolvedEnvRoot,
        activeLayout: existsSync(join(resolvedEnvRoot, 'current'))
          ? join(resolvedEnvRoot, 'current')
          : resolvedEnvRoot,
      };
    }
  }

  return {
    mode: 'legacy_cli',
    reason: 'not_running_inside_daemon_runtime',
  };
}

/**
 * Probe real filesystem writability using exclusive file creation & cleanup.
 */
export function isDirectoryWritable(dirPath: string): boolean {
  try {
    mkdirSync(dirPath, { recursive: true });
    const probeFile = join(dirPath, `.imcodes-write-probe-${process.pid}-${randomBytes(4).toString('hex')}`);
    const fd = openSync(probeFile, 'wx', 0o600);
    closeSync(fd);
    unlinkSync(probeFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the per-user writable `daemon-runtime` fallback directory inside IM.codes state dir
 * (`~/.imcodes/daemon-runtime` or `%USERPROFILE%\.imcodes\daemon-runtime`).
 */
export function resolveUserDaemonRuntimeRoot(options: {
  env?: NodeJS.ProcessEnv;
  userHome?: string;
} = {}): string {
  const env = options.env ?? process.env;
  const stateDir = options.userHome?.trim()
    ? imcodesStateDirForHome(options.userHome.trim(), env)
    : imcodesStateDir(env);
  return join(stateDir, 'daemon-runtime');
}

/**
 * Select writable target `daemon-runtime` root: in-place if writable, else user state fallback.
 */
export function resolveWritableDaemonRuntimeRoot(options: {
  activeRoot: string;
  env?: NodeJS.ProcessEnv;
  userHome?: string;
}): WritableDaemonRuntimeResolution | null {
  const activeRoot = resolve(options.activeRoot);
  if (isDirectoryWritable(activeRoot)) {
    return {
      activeRoot,
      targetRoot: activeRoot,
      writableRootKind: 'in_place',
    };
  }
  const userRoot = resolve(resolveUserDaemonRuntimeRoot({ env: options.env, userHome: options.userHome }));
  if (userRoot !== activeRoot && isDirectoryWritable(userRoot)) {
    return {
      activeRoot,
      targetRoot: userRoot,
      writableRootKind: 'user_fallback',
    };
  }
  return null;
}

/**
 * Load bound daemon server credentials from `<stateDir>/server.json` if present.
 */
export function loadDaemonServerCredential(env: NodeJS.ProcessEnv = process.env): DaemonServerCredential | null {
  try {
    const credsPath = join(imcodesStateDir(env), 'server.json');
    if (!existsSync(credsPath)) return null;
    const raw = JSON.parse(readFileSync(credsPath, 'utf8')) as {
      serverUrl?: unknown;
      serverId?: unknown;
      token?: unknown;
    };
    const serverUrl = typeof raw.serverUrl === 'string' ? raw.serverUrl.trim().replace(/\/+$/u, '') : '';
    const serverId = typeof raw.serverId === 'string' ? raw.serverId.trim() : '';
    const token = typeof raw.token === 'string' ? raw.token.trim() : '';
    if (!serverUrl || !serverId || !token) return null;
    return { serverUrl, serverId, token };
  } catch {
    return null;
  }
}

export function validateDaemonRuntimeManifestObject(
  value: unknown,
  expectedTarget: DesktopReleaseTarget,
): DaemonRuntimeManifestData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('daemon_runtime_manifest_invalid:not_object');
  }
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    throw new Error('daemon_runtime_manifest_invalid:schemaVersion');
  }
  const target = obj.target as Record<string, unknown> | undefined;
  const archive = obj.archive as Record<string, unknown> | undefined;
  const build = obj.build as Record<string, unknown> | undefined;
  const toolchain = obj.toolchain as Record<string, unknown> | undefined;
  if (!target || typeof target !== 'object' || !archive || typeof archive !== 'object' || !build || typeof build !== 'object') {
    throw new Error('daemon_runtime_manifest_invalid:missing_sections');
  }
  const actualTarget = `${String(target.os ?? '')}-${String(target.arch ?? '')}`;
  if (actualTarget !== expectedTarget) {
    throw new Error(`daemon_runtime_manifest_target_mismatch:${actualTarget}_vs_${expectedTarget}`);
  }
  if (archive.format !== 'tar.gz' && archive.format !== 'zip') {
    throw new Error('daemon_runtime_manifest_invalid:archive_format');
  }
  const fileName = archive.fileName;
  if (typeof fileName !== 'string' || !SAFE_BASENAME_RE.test(fileName) || basename(fileName) !== fileName) {
    throw new Error('daemon_runtime_manifest_invalid:archive_fileName');
  }
  const size = archive.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error('daemon_runtime_manifest_invalid:archive_size');
  }
  const sha256 = archive.sha256;
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
    throw new Error('daemon_runtime_manifest_invalid:archive_sha256');
  }
  const version = build.version;
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error('daemon_runtime_manifest_invalid:build_version');
  }
  const commit = build.commit;
  if (typeof commit !== 'string' || !/^[a-f0-9]{7,64}$/u.test(commit)) {
    throw new Error('daemon_runtime_manifest_invalid:build_commit');
  }
  const nodeRelativePath =
    typeof target.nodeRelativePath === 'string' && target.nodeRelativePath
      ? target.nodeRelativePath
      : target.os === 'win32'
        ? 'node.exe'
        : 'bin/node';
  const entryRelativePath =
    typeof target.entryRelativePath === 'string' && target.entryRelativePath
      ? target.entryRelativePath
      : 'package/dist/src/index.js';
  return {
    schemaVersion: 1,
    target: {
      os: target.os as 'linux' | 'darwin' | 'win32',
      arch: target.arch as 'x64' | 'arm64',
      nodeRelativePath,
      entryRelativePath,
    },
    archive: {
      format: archive.format,
      fileName,
      size,
      sha256,
    },
    build: {
      commit,
      version: version.trim(),
    },
    toolchain: {
      nodeProvider: typeof toolchain?.nodeProvider === 'string' ? toolchain.nodeProvider : 'unknown',
      nodeVersion: typeof toolchain?.nodeVersion === 'string' ? toolchain.nodeVersion : 'unknown',
    },
  };
}

/**
 * Walk an extracted `daemon-runtime` staging root, rejecting any escaping/dangling symlinks
 * and confirming all critical runtime files (and optional `daemon-runtime.files.json` hashes).
 */
export function verifyStagedDaemonRuntimeTree(
  stagingDir: string,
  platform: DaemonRuntimePlatform,
  expectedVersion: string,
  options: { requireFullEntries?: boolean } = {},
): { nodePath: string; entryPath: string } {
  const realRoot = realpathSync(stagingDir);

  const walk = (absDir: string): void => {
    for (const dirent of readdirSync(absDir, { withFileTypes: true })) {
      const childAbs = join(absDir, dirent.name);
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) {
        const rawTarget = readlinkSync(childAbs);
        if (isAbsolute(rawTarget)) {
          throw new Error(`daemon_runtime_symlink_escape:${childAbs}->${rawTarget}`);
        }
        const resolvedLinkTarget = resolve(dirname(childAbs), rawTarget);
        if (!isSubPath(resolvedLinkTarget, stagingDir)) {
          throw new Error(`daemon_runtime_symlink_escape:${childAbs}->${rawTarget}`);
        }
        if (!existsSync(resolvedLinkTarget)) {
          throw new Error(`daemon_runtime_dangling_symlink:${childAbs}->${rawTarget}`);
        }
        const realLinkTarget = realpathSync(resolvedLinkTarget);
        if (!isSubPath(realLinkTarget, realRoot)) {
          throw new Error(`daemon_runtime_symlink_escape_realpath:${childAbs}->${realLinkTarget}`);
        }
        continue;
      }
      if (st.isDirectory()) {
        walk(childAbs);
      } else if (!st.isFile()) {
        throw new Error(`daemon_runtime_unsupported_entry_type:${childAbs}`);
      }
    }
  };
  walk(stagingDir);

  const nodeRel = platform === 'win32' ? 'node.exe' : join('bin', 'node');
  const nodePath = join(stagingDir, nodeRel);
  if (!existsSync(nodePath) || !lstatSync(nodePath).isFile()) {
    throw new Error(`daemon_runtime_missing_node_binary:${nodeRel}`);
  }
  if (platform !== 'win32') {
    const mode = statSync(nodePath).mode;
    if ((mode & 0o111) === 0) {
      throw new Error(`daemon_runtime_node_not_executable:${nodeRel}`);
    }
  }

  const requiredEntries =
    options.requireFullEntries === false
      ? DAEMON_RUNTIME_CRITICAL_ENTRY_PATHS.slice(0, 4)
      : DAEMON_RUNTIME_CRITICAL_ENTRY_PATHS;
  for (const rel of requiredEntries) {
    const abs = join(stagingDir, ...rel.split('/'));
    if (!existsSync(abs) || !lstatSync(abs).isFile()) {
      throw new Error(`daemon_runtime_missing_critical_entry:${rel}`);
    }
  }

  const pkgVer = readPackageVersionSync(stagingDir);
  if (!pkgVer || (pkgVer !== expectedVersion && compareImcodesVersions(pkgVer, expectedVersion) !== 0)) {
    throw new Error(`daemon_runtime_extracted_version_mismatch:expected_${expectedVersion}_got_${pkgVer ?? 'missing'}`);
  }

  const filesDocPath = join(stagingDir, DAEMON_RUNTIME_FILES_FILENAME);
  if (existsSync(filesDocPath)) {
    const filesDoc = JSON.parse(readFileSync(filesDocPath, 'utf8')) as {
      files?: Array<{ path?: unknown; size?: unknown; sha256?: unknown }>;
    };
    if (Array.isArray(filesDoc.files)) {
      for (const entry of filesDoc.files) {
        if (
          typeof entry.path !== 'string'
          || entry.path.includes('..')
          || isAbsolute(entry.path)
          || typeof entry.size !== 'number'
          || typeof entry.sha256 !== 'string'
          || !SHA256_RE.test(entry.sha256)
        ) {
          throw new Error('daemon_runtime_files_doc_invalid_entry');
        }
        const abs = resolve(stagingDir, ...entry.path.split('/'));
        if (!isSubPath(abs, stagingDir)) {
          throw new Error(`daemon_runtime_files_doc_path_escape:${entry.path}`);
        }
        if (!existsSync(abs)) {
          throw new Error(`daemon_runtime_files_doc_missing:${entry.path}`);
        }
        const st = statSync(abs);
        if (st.size !== entry.size || sha256File(abs) !== entry.sha256) {
          throw new Error(`daemon_runtime_files_doc_digest_mismatch:${entry.path}`);
        }
      }
    }
  }

  return {
    nodePath,
    entryPath: join(stagingDir, 'package', 'dist', 'src', 'index.js'),
  };
}

/**
 * Extract a verified `daemon-runtime` archive into `destDir`.
 */
export function extractDaemonRuntimeArchive(
  archivePath: string,
  format: 'tar.gz' | 'zip',
  destDir: string,
  platform: DaemonRuntimePlatform,
): void {
  mkdirSync(destDir, { recursive: true });
  if (format === 'tar.gz') {
    execFileSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'pipe' });
    return;
  }
  if (platform === 'win32') {
    const psScript = `Expand-Archive -LiteralPath '${archivePath.replace(/'/gu, "''")}' -DestinationPath '${destDir.replace(/'/gu, "''")}' -Force`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { stdio: 'pipe' });
    return;
  }
  execFileSync('unzip', ['-q', archivePath, '-d', destDir], { stdio: 'pipe' });
}

/**
 * Default pre-switch health probe: verify bundled `node --version` and `package/dist/src/index.js --version`.
 */
export function runDefaultRuntimeBinaryProbe(
  nodePath: string,
  entryPath: string,
  expectedVersion: string,
  timeoutMs = 15_000,
): void {
  const nodeRes = execFileSync(nodePath, ['--version'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!/^v\d+\.\d+\.\d+/u.test(nodeRes.trim())) {
    throw new Error(`daemon_runtime_node_probe_invalid_output:${nodeRes.trim()}`);
  }
  const appRes = execFileSync(nodePath, [entryPath, '--version'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!appRes) {
    throw new Error('daemon_runtime_entry_probe_empty_output');
  }
  if (appRes !== expectedVersion && !appRes.includes(expectedVersion)) {
    throw new Error(`daemon_runtime_entry_probe_version_mismatch:expected_${expectedVersion}_got_${appRes}`);
  }
}

function readPreviousStateFile(runtimeRoot: string): { previousTarget?: string; previousVersion?: string } {
  try {
    const p = join(runtimeRoot, DAEMON_RUNTIME_PREVIOUS_STATE_FILE);
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { previousTarget?: unknown; previousVersion?: unknown };
    return {
      previousTarget: typeof parsed.previousTarget === 'string' ? parsed.previousTarget : undefined,
      previousVersion: typeof parsed.previousVersion === 'string' ? parsed.previousVersion : undefined,
    };
  } catch {
    return {};
  }
}

export function readCurrentPointerTarget(runtimeRoot: string): { targetPath?: string; version?: string } {
  const currentPath = join(runtimeRoot, 'current');
  if (!existsSync(currentPath)) return {};
  try {
    const st = lstatSync(currentPath);
    const targetPath = st.isSymbolicLink() ? resolve(dirname(currentPath), readlinkSync(currentPath)) : resolve(currentPath);
    const version = readPackageVersionSync(targetPath) ?? basename(targetPath);
    return { targetPath, version };
  } catch {
    return {};
  }
}

/**
 * Atomically point `<runtimeRoot>/current` at `releaseDir` and record previous target for rollback.
 */
export function switchDaemonRuntimeCurrentPointer(
  runtimeRoot: string,
  releaseDir: string,
  platform: DaemonRuntimePlatform,
  nowMs = Date.now(),
): { currentLink: string; previousTarget?: string; previousVersion?: string } {
  const resolvedRoot = resolve(runtimeRoot);
  const resolvedRelease = resolve(releaseDir);
  const currentLink = join(resolvedRoot, 'current');
  mkdirSync(resolvedRoot, { recursive: true });

  const prev = readCurrentPointerTarget(resolvedRoot);
  if (prev.targetPath) {
    writeFileSync(
      join(resolvedRoot, DAEMON_RUNTIME_PREVIOUS_STATE_FILE),
      JSON.stringify({
        previousTarget: prev.targetPath,
        previousVersion: prev.version ?? null,
        switchedAt: nowMs,
      }, null, 2),
    );
  }

  const nonce = `${process.pid}-${randomBytes(4).toString('hex')}`;
  if (platform === 'win32') {
    const nextLink = join(resolvedRoot, `.current-next-${nonce}`);
    const backupLink = join(resolvedRoot, `.current-prev-${nonce}`);
    symlinkSync(resolvedRelease, nextLink, 'junction');
    let movedExisting = false;
    try {
      if (existsSync(currentLink)) {
        renameSync(currentLink, backupLink);
        movedExisting = true;
      }
      renameSync(nextLink, currentLink);
      if (movedExisting) {
        rmSync(backupLink, { recursive: true, force: true });
      }
    } catch (err) {
      rmSync(nextLink, { recursive: true, force: true });
      if (movedExisting && !existsSync(currentLink) && existsSync(backupLink)) {
        try { renameSync(backupLink, currentLink); } catch { /* best effort */ }
      }
      throw err;
    }
  } else {
    const tempLink = join(resolvedRoot, `.current-next-${nonce}`);
    symlinkSync(resolvedRelease, tempLink, 'dir');
    try {
      let existingIsDir = false;
      try {
        const st = lstatSync(currentLink);
        existingIsDir = st.isDirectory() && !st.isSymbolicLink();
      } catch {
        existingIsDir = false;
      }
      if (existingIsDir) {
        const legacyBackup = join(resolvedRoot, `.current-legacy-${nonce}`);
        renameSync(currentLink, legacyBackup);
        try {
          renameSync(tempLink, currentLink);
          rmSync(legacyBackup, { recursive: true, force: true });
        } catch (err) {
          if (!existsSync(currentLink) && existsSync(legacyBackup)) {
            try { renameSync(legacyBackup, currentLink); } catch { /* best effort */ }
          }
          throw err;
        }
      } else {
        renameSync(tempLink, currentLink);
      }
    } catch (err) {
      rmSync(tempLink, { recursive: true, force: true });
      throw err;
    }
  }

  return {
    currentLink,
    ...(prev.targetPath ? { previousTarget: prev.targetPath } : {}),
    ...(prev.version ? { previousVersion: prev.version } : {}),
  };
}

/**
 * Roll `<runtimeRoot>/current` back to `previousTarget` (or unlink `current` if switching back
 * from a first-time user fallback to the read-only system `daemon-runtime`).
 */
export function rollbackDaemonRuntimeCurrentPointer(
  runtimeRoot: string,
  previousTarget: string | undefined,
  platform: DaemonRuntimePlatform,
  nowMs = Date.now(),
): { restoredTarget?: string } {
  const resolvedRoot = resolve(runtimeRoot);
  const resolvedPrev = previousTarget ?? readPreviousStateFile(resolvedRoot).previousTarget;
  if (resolvedPrev && existsSync(resolvedPrev)) {
    switchDaemonRuntimeCurrentPointer(resolvedRoot, resolvedPrev, platform, nowMs);
    return { restoredTarget: resolve(resolvedPrev) };
  }
  const currentLink = join(resolvedRoot, 'current');
  try {
    if (lstatSync(currentLink)) {
      rmSync(currentLink, { recursive: true, force: true });
    }
  } catch {
    // already absent
  }
  return {};
}

/**
 * Prune stale staging directories and releases older than `current` + `previousTarget`.
 */
export function pruneOldDaemonRuntimeReleases(
  runtimeRoot: string,
  keepTargets: readonly (string | undefined)[],
): string[] {
  const releasesDir = join(resolve(runtimeRoot), 'releases');
  if (!existsSync(releasesDir)) return [];
  const keepSet = new Set<string>();
  for (const target of keepTargets) {
    if (!target) continue;
    keepSet.add(resolve(target));
    try {
      keepSet.add(realpathSync(target));
    } catch {
      // ignore dangling path
    }
  }
  const removed: string[] = [];
  for (const name of readdirSync(releasesDir)) {
    const entryPath = join(releasesDir, name);
    const resolvedEntry = resolve(entryPath);
    if (name.startsWith(DAEMON_RUNTIME_STAGING_PREFIX) || !keepSet.has(resolvedEntry)) {
      rmSync(entryPath, { recursive: true, force: true });
      removed.push(entryPath);
    }
  }
  return removed;
}

function buildNodeArtifactUrl(
  serverUrl: string,
  params: { serverId: string; os: string; arch: string; asset: string },
): string {
  const qs = new URLSearchParams({
    serverId: params.serverId,
    os: params.os,
    arch: params.arch,
    asset: params.asset,
  });
  return `${serverUrl.replace(/\/+$/u, '')}${CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH}?${qs.toString()}`;
}

async function fetchAndVerifyFromServer(input: {
  source: Extract<DaemonRuntimeArtifactSource, { kind: 'server' }>;
  platform: DaemonRuntimePlatform;
  arch: 'x64' | 'arm64';
  expectedTarget: DesktopReleaseTarget;
  tempDir: string;
}): Promise<
  | { status: 'ready'; manifest: DaemonRuntimeManifestData; archivePath: string; archiveSha256: string }
  | { status: 'not_published'; httpStatus: number }
> {
  const fetchImpl = input.source.fetchImpl ?? fetch;
  const targetQuery = {
    serverId: input.source.serverId,
    os: input.platform === 'darwin' ? 'mac' : input.platform === 'win32' ? 'win' : 'linux',
    arch: input.arch,
  };
  const authHeaders = { authorization: `Bearer ${input.source.token}` };

  const manifestUrl = buildNodeArtifactUrl(input.source.serverUrl, {
    ...targetQuery,
    asset: CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME_MANIFEST,
  });
  const manifestRes = await fetchImpl(manifestUrl, { headers: authHeaders });
  if (manifestRes.status === 404 || manifestRes.status === 503 || manifestRes.status === 409) {
    return { status: 'not_published', httpStatus: manifestRes.status };
  }
  if (!manifestRes.ok) {
    throw new Error(`daemon_runtime_manifest_http_error:${manifestRes.status}`);
  }
  const manifestBytes = Buffer.from(await manifestRes.arrayBuffer());
  const expectedManifestSha = manifestRes.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256)?.trim().toLowerCase();
  if (expectedManifestSha && sha256Buffer(manifestBytes) !== expectedManifestSha) {
    throw new Error('daemon_runtime_manifest_header_sha256_mismatch');
  }
  const manifest = validateDaemonRuntimeManifestObject(
    JSON.parse(manifestBytes.toString('utf8')),
    input.expectedTarget,
  );

  const archiveUrl = buildNodeArtifactUrl(input.source.serverUrl, {
    ...targetQuery,
    asset: CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME,
  });
  const archiveRes = await fetchImpl(archiveUrl, { headers: authHeaders });
  if (archiveRes.status === 404 || archiveRes.status === 503 || archiveRes.status === 409) {
    return { status: 'not_published', httpStatus: archiveRes.status };
  }
  if (!archiveRes.ok) {
    throw new Error(`daemon_runtime_archive_http_error:${archiveRes.status}`);
  }
  const archiveBytes = Buffer.from(await archiveRes.arrayBuffer());
  const archiveSha256 = sha256Buffer(archiveBytes);
  const headerSha = archiveRes.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256)?.trim().toLowerCase();
  const headerVersion = archiveRes.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION)?.trim();
  const headerReleaseManifestSha = archiveRes.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.RELEASE_MANIFEST_SHA256)?.trim().toLowerCase();

  if (headerSha && headerSha !== archiveSha256) {
    throw new Error('daemon_runtime_archive_header_sha256_mismatch');
  }
  if (headerVersion && headerVersion !== manifest.build.version) {
    throw new Error('daemon_runtime_header_version_mismatch');
  }
  if (archiveBytes.length !== manifest.archive.size || archiveSha256 !== manifest.archive.sha256) {
    throw new Error('daemon_runtime_archive_digest_mismatch');
  }

  if (headerReleaseManifestSha) {
    const rmUrl = buildNodeArtifactUrl(input.source.serverUrl, {
      ...targetQuery,
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.DESKTOP_RELEASE_MANIFEST,
    });
    const rmRes = await fetchImpl(rmUrl, { headers: authHeaders });
    if (!rmRes.ok) {
      throw new Error(`desktop_release_manifest_http_error:${rmRes.status}`);
    }
    const rmBytes = Buffer.from(await rmRes.arrayBuffer());
    if (sha256Buffer(rmBytes) !== headerReleaseManifestSha) {
      throw new Error('desktop_release_manifest_header_sha256_mismatch');
    }
    verifyUnifiedReleaseAlignment(
      JSON.parse(rmBytes.toString('utf8')),
      input.expectedTarget,
      manifest,
      archiveBytes.length,
      archiveSha256,
    );
  }

  const archivePath = join(input.tempDir, manifest.archive.fileName);
  writeFileSync(archivePath, archiveBytes);
  return { status: 'ready', manifest, archivePath, archiveSha256 };
}

function verifyUnifiedReleaseAlignment(
  rawReleaseManifest: unknown,
  expectedTarget: DesktopReleaseTarget,
  manifest: DaemonRuntimeManifestData,
  archiveSize: number,
  archiveSha256: string,
): DesktopReleaseManifest {
  const rm = validateDesktopReleaseManifest(rawReleaseManifest);
  const check = verifyDesktopReleaseComponentIdentity(rm, expectedTarget, 'daemon-runtime', {
    version: manifest.build.version,
    fileName: manifest.archive.fileName,
    sha256: archiveSha256,
    sizeBytes: archiveSize,
  });
  if (!check.ok) {
    throw new Error(`desktop_release_manifest_mismatch:${check.reason}`);
  }
  return rm;
}

function loadAndVerifyFromLocalDir(input: {
  dir: string;
  expectedTarget: DesktopReleaseTarget;
  platform: DaemonRuntimePlatform;
}):
  | { status: 'ready'; manifest: DaemonRuntimeManifestData; archivePath: string; archiveSha256: string }
  | { status: 'not_published' } {
  const dir = resolve(input.dir);
  const ext = input.platform === 'win32' ? 'zip' : 'tar.gz';
  const candidateManifestNames = [
    `daemon-runtime-${input.expectedTarget}.${ext}.manifest.json`,
    `daemon-runtime.${ext}.manifest.json`,
  ];
  const candidateDirs = [dir, join(dir, 'daemon-runtime')];
  let manifestPath: string | undefined;
  let baseDir = dir;
  for (const d of candidateDirs) {
    for (const name of candidateManifestNames) {
      const p = join(d, name);
      if (existsSync(p)) {
        manifestPath = p;
        baseDir = d;
        break;
      }
    }
    if (manifestPath) break;
  }
  if (!manifestPath) {
    return { status: 'not_published' };
  }

  const manifest = validateDaemonRuntimeManifestObject(
    JSON.parse(readFileSync(manifestPath, 'utf8')),
    input.expectedTarget,
  );
  const archivePath = join(baseDir, manifest.archive.fileName);
  if (!existsSync(archivePath) || lstatSync(archivePath).isSymbolicLink()) {
    throw new Error('daemon_runtime_local_archive_missing_or_symlink');
  }
  const st = statSync(archivePath);
  const archiveSha256 = sha256File(archivePath);
  if (st.size !== manifest.archive.size || archiveSha256 !== manifest.archive.sha256) {
    throw new Error('daemon_runtime_archive_digest_mismatch');
  }

  for (const rmCandidate of [
    join(dir, desktopReleaseTargetManifestFilename(input.expectedTarget)),
    join(dir, DESKTOP_RELEASE_MANIFEST_FILENAME),
  ]) {
    if (existsSync(rmCandidate)) {
      verifyUnifiedReleaseAlignment(
        JSON.parse(readFileSync(rmCandidate, 'utf8')),
        input.expectedTarget,
        manifest,
        st.size,
        archiveSha256,
      );
      break;
    }
  }

  return { status: 'ready', manifest, archivePath, archiveSha256 };
}

/**
 * Write and launch a self-contained detached switch+restart+healthcheck+rollback runner
 * (used when the running daemon upgrades itself cleanly without in-place overwrites).
 */
export function launchDetachedDaemonRuntimeSwitchRunner(input: {
  scriptDir?: string;
  platform: DaemonRuntimePlatform;
  runtimeRoot: string;
  stagedReleaseDir: string;
  previousTarget?: string;
  targetVersion: string;
  stateDir: string;
  homeDir: string;
  keepTargets: string[];
  restartCommand?: string;
  spawnRunner?: (scriptPath: string, args: string[], scriptDir: string) => void;
}): { scriptDir: string; scriptPath: string; logFile: string } {
  const scriptDir = input.scriptDir ?? mkdtempSync(join(tmpdir(), 'imcodes-rt-upgrade-'));
  const logFile = join(scriptDir, 'runtime-upgrade.log');
  const configPath = join(scriptDir, 'runtime-upgrade.json');
  const scriptPath = join(scriptDir, 'switch-runner.mjs');
  const restartCommand =
    input.restartCommand ??
    (input.platform === 'win32'
      ? ''
      : buildPosixRestartCommand({
          platform: input.platform,
          home: input.homeDir,
          stateDir: input.stateDir,
        }));

  const defaultStateDir = imcodesStateDirForHome(input.homeDir);
  const windowsTask = input.platform === 'win32'
    ? windowsTaskName('daemon', input.stateDir, defaultStateDir)
    : '';

  writeFileSync(
    configPath,
    JSON.stringify({
      platform: input.platform,
      runtimeRoot: resolve(input.runtimeRoot),
      stagedReleaseDir: resolve(input.stagedReleaseDir),
      previousTarget: input.previousTarget ? resolve(input.previousTarget) : null,
      targetVersion: input.targetVersion,
      stateDir: resolve(input.stateDir),
      keepTargets: input.keepTargets.map((t) => resolve(t)),
      restartCommand,
      windowsTask,
      logFile,
    }, null, 2),
  );

  const runnerSource = `import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const log = (msg) => {
  try { appendFileSync(cfg.logFile, '[' + new Date().toISOString() + '] ' + msg + '\\n'); } catch {}
};

const switchPtr = (targetDir) => {
  const root = cfg.runtimeRoot;
  const currentLink = join(root, 'current');
  const nonce = process.pid + '-' + randomBytes(4).toString('hex');
  if (cfg.platform === 'win32') {
    const next = join(root, '.current-next-' + nonce);
    const prev = join(root, '.current-prev-' + nonce);
    symlinkSync(targetDir, next, 'junction');
    let moved = false;
    try {
      if (existsSync(currentLink)) { renameSync(currentLink, prev); moved = true; }
      renameSync(next, currentLink);
      if (moved) rmSync(prev, { recursive: true, force: true });
    } catch (err) {
      rmSync(next, { recursive: true, force: true });
      if (moved && !existsSync(currentLink) && existsSync(prev)) {
        try { renameSync(prev, currentLink); } catch {}
      }
      throw err;
    }
  } else {
    const tmpLink = join(root, '.current-next-' + nonce);
    symlinkSync(targetDir, tmpLink, 'dir');
    try {
      let existingDir = false;
      try { const st = lstatSync(currentLink); existingDir = st.isDirectory() && !st.isSymbolicLink(); } catch {}
      if (existingDir) {
        const legacy = join(root, '.current-legacy-' + nonce);
        renameSync(currentLink, legacy);
        renameSync(tmpLink, currentLink);
        rmSync(legacy, { recursive: true, force: true });
      } else {
        renameSync(tmpLink, currentLink);
      }
    } catch (err) {
      rmSync(tmpLink, { recursive: true, force: true });
      throw err;
    }
  }
};

const rollbackPtr = () => {
  if (cfg.previousTarget && existsSync(cfg.previousTarget)) {
    switchPtr(cfg.previousTarget);
  } else {
    rmSync(join(cfg.runtimeRoot, 'current'), { recursive: true, force: true });
  }
};

const isAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const readPid = () => {
  try {
    const n = Number(readFileSync(join(cfg.stateDir, 'daemon.pid'), 'utf8').trim());
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch { return null; }
};

const runRestart = () => {
  if (cfg.platform === 'win32') {
    const oldPid = readPid();
    if (oldPid) {
      try { execFileSync('taskkill', ['/F', '/T', '/PID', String(oldPid)], { stdio: 'ignore' }); } catch {}
    }
    try { execFileSync('schtasks', ['/Run', '/TN', cfg.windowsTask], { stdio: 'ignore' }); return true; } catch { return false; }
  }
  const r = spawnSync('/bin/bash', ['-lc', cfg.restartCommand], { stdio: 'pipe', encoding: 'utf8' });
  if (r.status !== 0) log('restart stderr: ' + (r.stderr || '').trim());
  return r.status === 0;
};

const lockFile = join(cfg.stateDir, 'upgrade.lock');
try {
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(lockFile, String(process.pid));
  const oldPid = readPid();
  log('switching current -> ' + cfg.stagedReleaseDir);
  switchPtr(cfg.stagedReleaseDir);
  try { unlinkSync(lockFile); } catch {}
  const restarted = runRestart();
  let healthy = false;
  if (restarted) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const pid = readPid();
      if (pid && pid !== oldPid && isAlive(pid)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
        if (isAlive(readPid())) { healthy = true; break; }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  if (!healthy) {
    log('post-restart health failed; rolling back to ' + (cfg.previousTarget || 'system fallback'));
    rollbackPtr();
    runRestart();
    process.exitCode = 1;
  } else {
    log('post-restart health passed');
    const keep = new Set(cfg.keepTargets);
    try { keep.add(realpathSync(join(cfg.runtimeRoot, 'current'))); } catch {}
    const relDir = join(cfg.runtimeRoot, 'releases');
    if (existsSync(relDir)) {
      for (const name of readdirSync(relDir)) {
        const p = resolve(relDir, name);
        if (name.startsWith('.staging-') || !keep.has(p)) rmSync(p, { recursive: true, force: true });
      }
    }
  }
} catch (err) {
  log('error: ' + (err && err.stack ? err.stack : String(err)));
  try { rollbackPtr(); runRestart(); } catch {}
  process.exitCode = 1;
} finally {
  try { unlinkSync(lockFile); } catch {}
}
`;
  writeFileSync(scriptPath, runnerSource, { mode: 0o700 });

  if (input.spawnRunner) {
    input.spawnRunner(scriptPath, [configPath], scriptDir);
  } else {
    const child = spawn(process.execPath, [scriptPath, configPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }

  return { scriptDir, scriptPath, logFile };
}

/**
 * Execute User Daemon runtime self-upgrade for `daemon-runtime/releases/<ver>` + `current`:
 * 1) Dev checkout/symlink exemption -> refuse cleanly
 * 2) Legacy CLI or unavailable bundled artifact -> return `fallback_legacy_cli` when allowed
 * 3) Bundled mode (writable in-place OR `~/.imcodes/daemon-runtime` user fallback) -> verify digests,
 *    extract cleanly without symlink escapes, pre-check binary, atomically switch `current`, prune
 *    older releases keeping current + rollback target, and auto-rollback on health failure.
 */
export async function upgradeBundledDaemonRuntime(
  options: DaemonRuntimeUpgradeOptions,
): Promise<DaemonRuntimeUpgradeResult> {
  const platform = toDaemonRuntimePlatform(options.platform ?? process.platform);
  if (!platform) {
    return { status: 'fallback_legacy_cli', reason: 'unsupported_platform' };
  }
  const archRaw = options.arch ?? process.arch;
  const target = releaseTargetFromRuntime(platform, archRaw);
  if (!target) {
    return { status: 'fallback_legacy_cli', reason: `unsupported_arch:${archRaw}` };
  }
  const targetMeta = controlledNodeDaemonRuntimeTarget(platform, archRaw);
  if (!targetMeta) {
    return { status: 'fallback_legacy_cli', reason: 'unsupported_target' };
  }

  const env = options.env ?? process.env;
  const inspection = inspectDaemonRuntimeMode({
    platform,
    execPath: options.execPath,
    entryScriptPath: options.entryScriptPath,
    env,
    runtimeRootOverride: options.runtimeRootOverride,
  });

  if (inspection.mode === 'dev_exempt') {
    return {
      status: 'blocked',
      reason: 'dev_symlink_exempt',
      message: `Refusing to auto-upgrade development checkout/symlink: ${inspection.devCheckoutPath ?? ''}`,
    };
  }

  if (inspection.mode !== 'bundled' || !inspection.activeRoot) {
    return { status: 'fallback_legacy_cli', reason: inspection.reason };
  }

  const writableResolution = resolveWritableDaemonRuntimeRoot({
    activeRoot: inspection.activeRoot,
    env,
    userHome: options.userHome,
  });
  if (!writableResolution) {
    if (options.allowLegacyCliFallback) {
      return { status: 'fallback_legacy_cli', reason: 'no_writable_runtime_root' };
    }
    return {
      status: 'blocked',
      reason: 'no_writable_runtime_root',
      message: `Neither ${inspection.activeRoot} nor user daemon-runtime directory is writable`,
    };
  }

  let source: DaemonRuntimeArtifactSource | undefined = options.source;
  if (!source) {
    const creds = loadDaemonServerCredential(env);
    if (creds) {
      source = { kind: 'server', ...creds };
    }
  }
  if (!source) {
    return { status: 'fallback_legacy_cli', reason: 'daemon_runtime_source_not_configured' };
  }

  const workTmpDir = mkdtempSync(join(tmpdir(), 'imcodes-daemon-rt-dl-'));
  let stagingDir: string | undefined;
  let downloaded:
    | { status: 'ready'; manifest: DaemonRuntimeManifestData; archivePath: string; archiveSha256: string }
    | { status: 'not_published'; httpStatus?: number };

  try {
    if (source.kind === 'local') {
      const localRes = loadAndVerifyFromLocalDir({ dir: source.dir, expectedTarget: target, platform });
      downloaded = localRes;
    } else {
      const arch = targetMeta.endsWith('-arm64') ? 'arm64' : 'x64';
      downloaded = await fetchAndVerifyFromServer({
        source,
        platform,
        arch,
        expectedTarget: target,
        tempDir: workTmpDir,
      });
    }

    if (downloaded.status === 'not_published') {
      if (options.allowLegacyCliFallback !== false) {
        return {
          status: 'fallback_legacy_cli',
          reason: `daemon_runtime_not_published${downloaded.httpStatus ? `:${downloaded.httpStatus}` : ''}`,
        };
      }
      throw new Error('daemon_runtime_not_published');
    }

    const targetVer = downloaded.manifest.build.version;
    const requested = options.targetVersion?.trim();
    if (requested && requested !== 'latest') {
      const reqCmp = compareImcodesVersions(targetVer, requested);
      if (targetVer !== requested && reqCmp !== 0) {
        return {
          status: 'blocked',
          reason: 'version_mismatch',
          message: `Published daemon-runtime version ${targetVer} does not match requested ${requested}`,
        };
      }
    }

    const verCmp = compareImcodesVersions(targetVer, options.currentVersion);
    if (verCmp !== null && verCmp < 0) {
      return {
        status: 'blocked',
        reason: 'downgrade_refused',
        message: `Refusing to downgrade daemon-runtime from ${options.currentVersion} to ${targetVer}`,
      };
    }
    if ((targetVer === options.currentVersion || verCmp === 0) && existsSync(join(writableResolution.targetRoot, 'current'))) {
      return { status: 'up_to_date', currentVersion: options.currentVersion, targetVersion: targetVer };
    }

    const releasesDir = join(writableResolution.targetRoot, 'releases');
    mkdirSync(releasesDir, { recursive: true });
    stagingDir = join(
      releasesDir,
      `${DAEMON_RUNTIME_STAGING_PREFIX}${targetVer}-${process.pid}-${randomBytes(4).toString('hex')}`,
    );

    if (options.extractArchive) {
      await options.extractArchive({
        archivePath: downloaded.archivePath,
        format: downloaded.manifest.archive.format,
        destDir: stagingDir,
        platform,
      });
    } else {
      extractDaemonRuntimeArchive(
        downloaded.archivePath,
        downloaded.manifest.archive.format,
        stagingDir,
        platform,
      );
    }

    const verified = verifyStagedDaemonRuntimeTree(stagingDir, platform, targetVer, {
      requireFullEntries: options.requireFullEntries,
    });

    if (options.healthCheck) {
      await options.healthCheck({
        phase: 'pre_switch',
        platform,
        runtimeRoot: writableResolution.targetRoot,
        releaseDir: stagingDir,
        nodePath: verified.nodePath,
        entryPath: verified.entryPath,
        expectedVersion: targetVer,
      });
    } else {
      runDefaultRuntimeBinaryProbe(
        verified.nodePath,
        verified.entryPath,
        targetVer,
        options.healthCheckTimeoutMs,
      );
    }

    const releaseDir = join(releasesDir, targetVer);
    const liveCurrent = readCurrentPointerTarget(writableResolution.targetRoot);
    if (existsSync(releaseDir)) {
      if (liveCurrent.targetPath && resolve(liveCurrent.targetPath) === resolve(releaseDir)) {
        // Rare same-version repair into distinct versioned directory would need a different name
        throw new Error(`daemon_runtime_release_in_use:${releaseDir}`);
      }
      rmSync(releaseDir, { recursive: true, force: true });
    }
    renameSync(stagingDir, releaseDir);
    stagingDir = undefined;

    const prev = readCurrentPointerTarget(writableResolution.targetRoot);
    const keepTargets = [releaseDir, prev.targetPath].filter((v): v is string => Boolean(v));

    if (options.detachedHandoff) {
      const stateDir = imcodesStateDir(env);
      const launched = launchDetachedDaemonRuntimeSwitchRunner({
        platform,
        runtimeRoot: writableResolution.targetRoot,
        stagedReleaseDir: releaseDir,
        previousTarget: prev.targetPath,
        targetVersion: targetVer,
        stateDir,
        homeDir: options.userHome ?? homedir(),
        keepTargets,
        spawnRunner: options.spawnDetachedRunner,
      });
      return {
        status: 'upgraded',
        targetVersion: targetVer,
        ...(prev.version ?? options.currentVersion ? { previousVersion: prev.version ?? options.currentVersion } : {}),
        ...(prev.targetPath ? { previousTarget: prev.targetPath } : {}),
        runtimeRoot: writableResolution.targetRoot,
        releaseDir,
        currentLink: join(writableResolution.targetRoot, 'current'),
        writableRootKind: writableResolution.writableRootKind,
        rolledBack: false,
        detachedScriptDir: launched.scriptDir,
      };
    }

    const nowMs = options.now?.() ?? Date.now();
    const switched = switchDaemonRuntimeCurrentPointer(writableResolution.targetRoot, releaseDir, platform, nowMs);
    const switchedNodePath = join(switched.currentLink, platform === 'win32' ? 'node.exe' : join('bin', 'node'));
    const switchedEntryPath = join(switched.currentLink, 'package', 'dist', 'src', 'index.js');

    try {
      if (options.restartService) {
        await options.restartService({
          platform,
          runtimeRoot: writableResolution.targetRoot,
          releaseDir,
          targetVersion: targetVer,
          previousVersion: switched.previousVersion ?? options.currentVersion,
          previousTarget: switched.previousTarget,
        });
      }
      if (options.healthCheck) {
        await options.healthCheck({
          phase: 'post_restart',
          platform,
          runtimeRoot: writableResolution.targetRoot,
          releaseDir: switched.currentLink,
          nodePath: switchedNodePath,
          entryPath: switchedEntryPath,
          expectedVersion: targetVer,
        });
      } else {
        runDefaultRuntimeBinaryProbe(
          switchedNodePath,
          switchedEntryPath,
          targetVer,
          options.healthCheckTimeoutMs,
        );
      }
    } catch (healthErr) {
      const restored = rollbackDaemonRuntimeCurrentPointer(
        writableResolution.targetRoot,
        switched.previousTarget,
        platform,
        options.now?.() ?? Date.now(),
      );
      if (options.restartService) {
        try {
          await options.restartService({
            platform,
            runtimeRoot: writableResolution.targetRoot,
            releaseDir: restored.restoredTarget ?? writableResolution.activeRoot,
            targetVersion: switched.previousVersion ?? options.currentVersion,
            previousVersion: targetVer,
            previousTarget: releaseDir,
          });
        } catch {
          // rollback pointer already restored; best-effort restart attempt recorded
        }
      }
      return {
        status: 'rolled_back',
        targetVersion: targetVer,
        ...(switched.previousVersion ?? options.currentVersion
          ? { previousVersion: switched.previousVersion ?? options.currentVersion }
          : {}),
        ...(restored.restoredTarget ? { restoredTarget: restored.restoredTarget } : {}),
        runtimeRoot: writableResolution.targetRoot,
        reason: healthErr instanceof Error ? healthErr.message : String(healthErr),
        rolledBack: true,
      };
    }

    pruneOldDaemonRuntimeReleases(writableResolution.targetRoot, [
      releaseDir,
      switched.previousTarget,
    ]);

    return {
      status: 'upgraded',
      targetVersion: targetVer,
      ...(switched.previousVersion ?? options.currentVersion
        ? { previousVersion: switched.previousVersion ?? options.currentVersion }
        : {}),
      ...(switched.previousTarget ? { previousTarget: switched.previousTarget } : {}),
      runtimeRoot: writableResolution.targetRoot,
      releaseDir,
      currentLink: switched.currentLink,
      writableRootKind: writableResolution.writableRootKind,
      rolledBack: false,
    };
  } finally {
    if (stagingDir && existsSync(stagingDir)) {
      rmSync(stagingDir, { recursive: true, force: true });
    }
    rmSync(workTmpDir, { recursive: true, force: true });
  }
}
