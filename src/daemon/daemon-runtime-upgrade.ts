import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTROLLED_NODE_ARTIFACT_ASSETS,
  CONTROLLED_NODE_ARTIFACT_HEADERS,
  CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH,
  controlledNodeDaemonRuntimeTarget,
} from '../../shared/controlled-node-artifacts.js';
import {
  DESKTOP_RELEASE_MANIFEST_FILENAME,
  daemonRuntimeManifestFilename,
  desktopReleaseTargetManifestFilename,
  releaseTargetFromRuntime,
  validateDaemonRuntimeManifest,
  validateDesktopReleaseManifest,
  verifyDesktopReleaseComponentIdentity,
  type DaemonRuntimeManifest,
  type DaemonRuntimeManifestFileEntry,
  type DesktopReleaseManifest,
  type DesktopReleaseTarget,
} from '../../shared/desktop-release-manifest.js';
import { compareImcodesVersions } from '../../shared/imcodes-version.js';
import { isPathInsideGitCheckout } from '../node/desktop-installer-probe.js';
import { imcodesStateDir, imcodesStateDirForHome, IMCODES_HOME_ENV } from '../util/imcodes-state-dir.js';
import { renderSystemdExecStart } from '../util/launch-target.js';
import { resolvePosixDaemonServicePaths } from '../util/posix-daemon-service.js';
import { windowsTaskName } from '../util/windows-daemon-watchdog.mjs';
import { renderWatchdogCmd } from '../util/windows-launch-artifacts.js';
import {
  DAEMON_RUNTIME_LOCK_DIR_NAME,
  DAEMON_RUNTIME_LOCK_OWNER_FILE,
  DAEMON_RUNTIME_PREVIOUS_STATE_FILE,
  DAEMON_RUNTIME_STAGING_PREFIX,
  DAEMON_RUNTIME_SWITCH_STATE_FILE,
  UPGRADE_COOLDOWN_SENTINEL_FILE,
  acquireRuntimeUpgradeLock,
  claimHandoffRuntimeUpgradeLock,
  prepareServiceLaunchTarget,
  pruneOldDaemonRuntimeReleases,
  readCurrentPointerTarget,
  readPackageVersionSync,
  readVerifiedDaemonIdentity,
  releaseRuntimeUpgradeLock,
  restartDaemonService,
  restoreServiceLaunchTarget,
  rollbackDaemonRuntimeCurrentPointer,
  stopVerifiedDaemon,
  switchDaemonRuntimeCurrentPointer,
  transferRuntimeUpgradeLock,
  waitForHealthyTargetDaemon,
  writeUpgradeCooldownSentinel,
  type DaemonRuntimePlatform,
  type ServiceLaunchBackup,
  type ServiceLaunchTargetSpec,
} from './daemon-runtime-switch-helper.mjs';

export {
  DAEMON_RUNTIME_LOCK_DIR_NAME,
  DAEMON_RUNTIME_LOCK_OWNER_FILE,
  DAEMON_RUNTIME_PREVIOUS_STATE_FILE,
  DAEMON_RUNTIME_STAGING_PREFIX,
  DAEMON_RUNTIME_SWITCH_STATE_FILE,
  UPGRADE_COOLDOWN_SENTINEL_FILE,
  acquireRuntimeUpgradeLock,
  claimHandoffRuntimeUpgradeLock,
  prepareServiceLaunchTarget,
  pruneOldDaemonRuntimeReleases,
  readCurrentPointerTarget,
  readVerifiedDaemonIdentity,
  releaseRuntimeUpgradeLock,
  restartDaemonService,
  restoreServiceLaunchTarget,
  rollbackDaemonRuntimeCurrentPointer,
  stopVerifiedDaemon,
  switchDaemonRuntimeCurrentPointer,
  transferRuntimeUpgradeLock,
  validateDaemonRuntimeManifest,
  waitForHealthyTargetDaemon,
  writeUpgradeCooldownSentinel,
  type DaemonRuntimeManifest,
  type DaemonRuntimePlatform,
};

export const DAEMON_RUNTIME_FILES_FILENAME = 'daemon-runtime.files.json';
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
  settleMs?: number;
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

export type LegacyNpmCliFallbackResolution =
  | {
      eligible: true;
      pkgDir: string;
      prefixDir: string;
      nodeBin: string;
      cliEntry: string;
    }
  | {
      eligible: false;
      reason: 'legacy_npm_cli_missing' | 'legacy_npm_cli_read_only' | 'legacy_npm_cli_is_git_checkout';
      message: string;
      prefixDir?: string;
    };

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

export function resolveDaemonRuntimeSwitchHelperPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = resolve(here, 'daemon-runtime-switch-helper.mjs');
  if (existsSync(sibling)) return sibling;
  const srcFallback = resolve(here, '..', '..', 'src', 'daemon', 'daemon-runtime-switch-helper.mjs');
  return existsSync(srcFallback) ? srcFallback : sibling;
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

function isExistingDirectoryWritable(dirPath: string): boolean {
  try {
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) return false;
    const probeFile = join(dirPath, `.imcodes-write-probe-${process.pid}-${randomBytes(4).toString('hex')}`);
    const fd = openSync(probeFile, 'wx', 0o600);
    closeSync(fd);
    unlinkSync(probeFile);
    return true;
  } catch {
    return false;
  }
}

function resolveRuntimeUpgradeStateDir(
  env: NodeJS.ProcessEnv = process.env,
  userHome?: string,
): string {
  if (env[IMCODES_HOME_ENV]?.trim()) {
    return imcodesStateDir(env);
  }
  if (userHome?.trim()) {
    return imcodesStateDirForHome(userHome.trim(), env);
  }
  return imcodesStateDir(env);
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
  return join(resolveRuntimeUpgradeStateDir(env, options.userHome), 'daemon-runtime');
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

function normalizeServerHttpUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString().replace(/\/+$/u, '');
  } catch {
    return '';
  }
}

/**
 * Load bound daemon server credentials from `<stateDir>/server.json` if present.
 * Matches canonical `bind-flow.ts` schema (`workerUrl` + `serverId` + `token`), accepting
 * `ws:`/`wss:` or `http:`/`https:` URLs and secondary `serverUrl` when `workerUrl` is omitted.
 */
export function loadDaemonServerCredential(env: NodeJS.ProcessEnv = process.env): DaemonServerCredential | null {
  try {
    const credsPath = join(imcodesStateDir(env), 'server.json');
    if (!existsSync(credsPath)) return null;
    if (lstatSync(credsPath).isSymbolicLink()) return null;
    const raw = JSON.parse(readFileSync(credsPath, 'utf8')) as {
      workerUrl?: unknown;
      serverUrl?: unknown;
      serverId?: unknown;
      token?: unknown;
    };
    const serverUrl = normalizeServerHttpUrl(raw.workerUrl) || normalizeServerHttpUrl(raw.serverUrl);
    const serverId = typeof raw.serverId === 'string' ? raw.serverId.trim() : '';
    const token = typeof raw.token === 'string' ? raw.token.trim() : '';
    if (!serverUrl || !serverId || !token) return null;
    return { serverUrl, serverId, token };
  } catch {
    return null;
  }
}

/**
 * Walk an extracted `daemon-runtime` staging root, rejecting any escaping/dangling symlinks
 * and confirming all critical runtime files, manifest `files` digests, and optional `daemon-runtime.files.json`.
 */
export function verifyStagedDaemonRuntimeTree(
  stagingDir: string,
  platform: DaemonRuntimePlatform,
  expectedVersion: string,
  options: {
    requireFullEntries?: boolean;
    manifestFiles?: readonly DaemonRuntimeManifestFileEntry[];
  } = {},
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

  const verifyEntryList = (entries: readonly DaemonRuntimeManifestFileEntry[], sourceLabel: string): void => {
    for (const entry of entries) {
      if (
        typeof entry.path !== 'string'
        || entry.path.includes('..')
        || isAbsolute(entry.path)
        || typeof entry.size !== 'number'
        || typeof entry.sha256 !== 'string'
        || !SHA256_RE.test(entry.sha256)
      ) {
        throw new Error(`${sourceLabel}_invalid_entry`);
      }
      const abs = resolve(stagingDir, ...entry.path.split('/'));
      if (!isSubPath(abs, stagingDir)) {
        throw new Error(`${sourceLabel}_path_escape:${entry.path}`);
      }
      if (!existsSync(abs)) {
        throw new Error(`${sourceLabel}_missing:${entry.path}`);
      }
      const st = statSync(abs);
      if (st.size !== entry.size || sha256File(abs) !== entry.sha256) {
        throw new Error(`${sourceLabel}_digest_mismatch:${entry.path}`);
      }
      if (platform !== 'win32' && entry.executable === true && (st.mode & 0o111) === 0) {
        throw new Error(`${sourceLabel}_not_executable:${entry.path}`);
      }
    }
  };

  if (options.manifestFiles && options.manifestFiles.length > 0) {
    verifyEntryList(options.manifestFiles, 'daemon_runtime_manifest_files');
  }

  const filesDocPath = join(stagingDir, DAEMON_RUNTIME_FILES_FILENAME);
  if (existsSync(filesDocPath)) {
    const filesDoc = JSON.parse(readFileSync(filesDocPath, 'utf8')) as {
      files?: Array<{ path?: unknown; size?: unknown; sha256?: unknown; executable?: unknown }>;
    };
    if (Array.isArray(filesDoc.files)) {
      verifyEntryList(filesDoc.files as DaemonRuntimeManifestFileEntry[], 'daemon_runtime_files_doc');
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
 * Default pre-switch (and stopped-daemon fallback) binary probe: verify bundled `node --version`
 * and `package/dist/src/index.js --version`.
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
  | { status: 'ready'; manifest: DaemonRuntimeManifest; archivePath: string; archiveSha256: string }
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
  const manifest = validateDaemonRuntimeManifest(
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
  if (archiveBytes.length !== manifest.artifact.size || archiveSha256 !== manifest.artifact.sha256) {
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

  const archivePath = join(input.tempDir, manifest.artifact.fileName);
  writeFileSync(archivePath, archiveBytes);
  return { status: 'ready', manifest, archivePath, archiveSha256 };
}

function verifyUnifiedReleaseAlignment(
  rawReleaseManifest: unknown,
  expectedTarget: DesktopReleaseTarget,
  manifest: DaemonRuntimeManifest,
  archiveSize: number,
  archiveSha256: string,
): DesktopReleaseManifest {
  const rm = validateDesktopReleaseManifest(rawReleaseManifest);
  const check = verifyDesktopReleaseComponentIdentity(rm, expectedTarget, 'daemon-runtime', {
    version: manifest.build.version,
    fileName: manifest.artifact.fileName,
    sha256: archiveSha256,
    sizeBytes: archiveSize,
    ...(manifest.artifact.authenticodeSignerSha256
      ? { authenticodeSignerSha256: manifest.artifact.authenticodeSignerSha256 }
      : {}),
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
  | { status: 'ready'; manifest: DaemonRuntimeManifest; archivePath: string; archiveSha256: string }
  | { status: 'not_published' } {
  const dir = resolve(input.dir);
  const candidateManifestNames = [
    daemonRuntimeManifestFilename(input.expectedTarget),
    'daemon-runtime.manifest.json',
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

  const manifest = validateDaemonRuntimeManifest(
    JSON.parse(readFileSync(manifestPath, 'utf8')),
    input.expectedTarget,
  );
  const archivePath = join(baseDir, manifest.artifact.fileName);
  if (!existsSync(archivePath) || lstatSync(archivePath).isSymbolicLink()) {
    throw new Error('daemon_runtime_local_archive_missing_or_symlink');
  }
  const st = statSync(archivePath);
  const archiveSha256 = sha256File(archivePath);
  if (st.size !== manifest.artifact.size || archiveSha256 !== manifest.artifact.sha256) {
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

function buildServiceLaunchConfig(input: {
  platform: DaemonRuntimePlatform;
  runtimeRoot: string;
  targetCurrent: string;
  homeDir: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}): {
  targetNodePath: string;
  targetEntryPath: string;
  systemdUnitPath?: string;
  systemdUnitName?: string;
  launchAgentPath?: string;
  windowsTask?: string;
  vbsPath?: string;
  launchTargetSpec: ServiceLaunchTargetSpec;
} {
  const targetNodePath =
    input.platform === 'win32'
      ? join(input.targetCurrent, 'node.exe')
      : join(input.targetCurrent, 'bin', 'node');
  const targetEntryPath = join(input.targetCurrent, 'package', 'dist', 'src', 'index.js');

  if (input.platform === 'linux') {
    const svcPaths = resolvePosixDaemonServicePaths({
      ...input.env,
      HOME: input.homeDir,
      IMCODES_HOME: input.stateDir,
    });
    const systemdUnitPath = join(input.homeDir, '.config', 'systemd', 'user', svcPaths.systemdUnitName);
    const execStart = renderSystemdExecStart({
      program: targetNodePath,
      args: [targetEntryPath, 'start', '--foreground'],
    });
    return {
      targetNodePath,
      targetEntryPath,
      systemdUnitPath,
      systemdUnitName: svcPaths.systemdUnitName,
      launchTargetSpec: {
        kind: 'systemd',
        filePath: systemdUnitPath,
        execStart,
      },
    };
  }

  if (input.platform === 'darwin') {
    const svcPaths = resolvePosixDaemonServicePaths({
      ...input.env,
      HOME: input.homeDir,
      IMCODES_HOME: input.stateDir,
    });
    const launchAgentsDir = join(input.homeDir, 'Library', 'LaunchAgents');
    const primaryPlist = join(launchAgentsDir, `${svcPaths.launchAgentLabel}.plist`);
    const legacyPlist = join(launchAgentsDir, 'cc.imcodes.daemon.plist');
    const launchAgentPath =
      !svcPaths.scoped && !existsSync(primaryPlist) && existsSync(legacyPlist)
        ? legacyPlist
        : primaryPlist;
    return {
      targetNodePath,
      targetEntryPath,
      launchAgentPath,
      launchTargetSpec: {
        kind: 'launchd',
        filePath: launchAgentPath,
        programArguments: [targetNodePath, targetEntryPath, 'start', '--foreground'],
      },
    };
  }

  const defaultStateDir = imcodesStateDirForHome(input.homeDir, input.env);
  const windowsTask = windowsTaskName('daemon', input.stateDir, defaultStateDir);
  const watchdogPath = join(input.stateDir, 'daemon-watchdog.cmd');
  const vbsPath = join(input.stateDir, 'daemon-launcher.vbs');
  const logPath = join(input.stateDir, 'watchdog.log');
  const watchdogContent = renderWatchdogCmd({
    nodeExe: targetNodePath,
    imcodesScript: targetEntryPath,
    watchdogPath,
    vbsPath,
    logPath,
  });

  return {
    targetNodePath,
    targetEntryPath,
    windowsTask,
    vbsPath,
    launchTargetSpec: {
      kind: 'windows_watchdog',
      filePath: watchdogPath,
      watchdogContent,
    },
  };
}

/**
 * Write and launch a self-contained detached switch+launch-chain-align+restart+healthcheck+rollback runner
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
  env?: NodeJS.ProcessEnv;
  keepTargets: string[];
  lockOwnerToken?: string;
  restartCommand?: string;
  rollbackRestartCommand?: string;
  healthCheckTimeoutMs?: number;
  settleMs?: number;
  spawnRunner?: (scriptPath: string, args: string[], scriptDir: string) => void;
}): { scriptDir: string; scriptPath: string; logFile: string } {
  const scriptDir = input.scriptDir ?? mkdtempSync(join(tmpdir(), 'imcodes-rt-upgrade-'));
  const logFile = join(scriptDir, 'runtime-upgrade.log');
  const configPath = join(scriptDir, 'runtime-upgrade.json');
  const scriptPath = join(scriptDir, 'switch-runner.mjs');
  const helperDestPath = join(scriptDir, 'daemon-runtime-switch-helper.mjs');

  copyFileSync(resolveDaemonRuntimeSwitchHelperPath(), helperDestPath);

  const env = input.env ?? process.env;
  const targetCurrent = join(resolve(input.runtimeRoot), 'current');
  const launchCfg = buildServiceLaunchConfig({
    platform: input.platform,
    runtimeRoot: input.runtimeRoot,
    targetCurrent,
    homeDir: input.homeDir,
    stateDir: input.stateDir,
    env,
  });

  const previousNodePath = input.previousTarget
    ? join(resolve(input.previousTarget), input.platform === 'win32' ? 'node.exe' : join('bin', 'node'))
    : undefined;
  const previousEntryPath = input.previousTarget
    ? join(resolve(input.previousTarget), 'package', 'dist', 'src', 'index.js')
    : undefined;

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
      lockOwnerToken: input.lockOwnerToken ?? null,
      targetNodePath: launchCfg.targetNodePath,
      targetEntryPath: launchCfg.targetEntryPath,
      ...(previousNodePath ? { previousNodePath } : {}),
      ...(previousEntryPath ? { previousEntryPath } : {}),
      ...(launchCfg.systemdUnitPath ? { systemdUnitPath: launchCfg.systemdUnitPath } : {}),
      ...(launchCfg.systemdUnitName ? { systemdUnitName: launchCfg.systemdUnitName } : {}),
      ...(launchCfg.launchAgentPath ? { launchAgentPath: launchCfg.launchAgentPath } : {}),
      ...(launchCfg.windowsTask ? { windowsTask: launchCfg.windowsTask } : {}),
      ...(launchCfg.vbsPath ? { vbsPath: launchCfg.vbsPath } : {}),
      ...(input.restartCommand ? { restartCommand: input.restartCommand } : {}),
      ...(input.rollbackRestartCommand ? { rollbackRestartCommand: input.rollbackRestartCommand } : {}),
      launchTargetSpec: launchCfg.launchTargetSpec,
      ...(typeof input.healthCheckTimeoutMs === 'number' ? { healthCheckTimeoutMs: input.healthCheckTimeoutMs } : {}),
      ...(typeof input.settleMs === 'number' ? { settleMs: input.settleMs } : {}),
      logFile,
    }, null, 2),
  );

  const runnerSource = [
    "import { readFileSync } from 'node:fs';",
    "import { runDetachedSwitchTransaction } from './daemon-runtime-switch-helper.mjs';",
    '',
    "const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));",
    'process.exitCode = runDetachedSwitchTransaction(cfg) ? 0 : 1;',
    '',
  ].join('\n');
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
 * Resolve whether an eligible, writable legacy npm global CLI installation exists when
 * `upgradeBundledDaemonRuntime` returns `fallback_legacy_cli`.
 * Never selects read-only system directories, bundled `daemon-runtime` layouts, or git checkouts.
 */
export function resolveLegacyNpmCliFallback(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  userHome?: string;
  stateDir?: string;
} = {}): LegacyNpmCliFallbackResolution {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathSep = platform === 'win32' ? ';' : ':';
  const candidatePrefixes: Array<{ prefixDir: string; explicitHint: boolean }> = [];
  const seenPrefixes = new Set<string>();

  const addPrefix = (rawPrefix: string | undefined, explicitHint: boolean): void => {
    if (!rawPrefix?.trim()) return;
    const resolved = resolve(rawPrefix.trim());
    if (seenPrefixes.has(resolved)) return;
    seenPrefixes.add(resolved);
    candidatePrefixes.push({ prefixDir: resolved, explicitHint });
  };

  addPrefix(env.NPM_CONFIG_PREFIX || env.npm_config_prefix, true);

  const pathEntries = (env.PATH ?? '')
    .split(pathSep)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const dirEntry of pathEntries) {
    const binNames = platform === 'win32' ? ['imcodes.cmd', 'imcodes.exe', 'imcodes'] : ['imcodes'];
    for (const binName of binNames) {
      const candidateBin = join(dirEntry, binName);
      if (!existsSync(candidateBin)) continue;
      const realBin = safeRealpath(candidateBin);
      const norm = realBin.replace(/\\/gu, '/');
      if (norm.includes('/daemon-runtime/')) continue;
      if (isPathInsideGitCheckout(realBin)) {
        return {
          eligible: false,
          reason: 'legacy_npm_cli_is_git_checkout',
          message: `Legacy CLI binary resolves into git checkout (${realBin}); refusing automated fallback`,
        };
      }
      const nmIdx = norm.lastIndexOf('/node_modules/imcodes/');
      if (nmIdx !== -1) {
        const prefixGuess =
          platform === 'win32'
            ? realBin.slice(0, nmIdx)
            : norm.slice(0, nmIdx).endsWith('/lib')
              ? dirname(realBin.slice(0, nmIdx))
              : realBin.slice(0, nmIdx);
        addPrefix(prefixGuess, true);
      } else {
        addPrefix(dirname(dirEntry), false);
      }
    }
  }

  let sawReadOnlyPrefix: string | undefined;
  let sawGitCheckout = false;

  for (const { prefixDir } of candidatePrefixes) {
    const nodeModulesDir = platform === 'win32' ? join(prefixDir, 'node_modules') : join(prefixDir, 'lib', 'node_modules');
    const binDir = platform === 'win32' ? prefixDir : join(prefixDir, 'bin');
    const pkgDir = join(nodeModulesDir, 'imcodes');
    const pkgJsonPath = join(pkgDir, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;

    const realPkgDir = safeRealpath(pkgDir);
    if (realPkgDir.replace(/\\/gu, '/').includes('/daemon-runtime/')) continue;
    if (isPathInsideGitCheckout(realPkgDir)) {
      sawGitCheckout = true;
      continue;
    }

    let pkgName = '';
    try {
      pkgName = String((JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: unknown }).name ?? '');
    } catch {
      continue;
    }
    if (pkgName !== 'imcodes') continue;

    const cliEntry = join(pkgDir, 'dist', 'src', 'cli.js');
    if (!existsSync(cliEntry)) continue;

    if (!isExistingDirectoryWritable(nodeModulesDir) || !isExistingDirectoryWritable(binDir)) {
      sawReadOnlyPrefix ??= prefixDir;
      continue;
    }

    const candidateNode = platform === 'win32' ? join(prefixDir, 'node.exe') : join(binDir, 'node');
    let nodeBin = existsSync(candidateNode) ? candidateNode : '';
    if (!nodeBin) {
      for (const dirEntry of pathEntries) {
        const p = join(dirEntry, platform === 'win32' ? 'node.exe' : 'node');
        if (existsSync(p) && !p.replace(/\\/gu, '/').includes('/daemon-runtime/')) {
          nodeBin = p;
          break;
        }
      }
    }
    if (!nodeBin) nodeBin = options.execPath ?? process.execPath;

    return {
      eligible: true,
      pkgDir,
      prefixDir,
      nodeBin,
      cliEntry,
    };
  }

  if (sawReadOnlyPrefix) {
    return {
      eligible: false,
      reason: 'legacy_npm_cli_read_only',
      prefixDir: sawReadOnlyPrefix,
      message: `Legacy npm CLI prefix ${sawReadOnlyPrefix} is read-only`,
    };
  }
  if (sawGitCheckout) {
    return {
      eligible: false,
      reason: 'legacy_npm_cli_is_git_checkout',
      message: 'Legacy CLI resolves inside a git checkout',
    };
  }
  return {
    eligible: false,
    reason: 'legacy_npm_cli_missing',
    message: 'No installed legacy npm global imcodes package found',
  };
}

/**
 * Execute User Daemon runtime self-upgrade for `daemon-runtime/releases/<ver>` + `current`:
 * 1) Dev checkout/symlink exemption -> refuse cleanly
 * 2) Legacy CLI or unavailable bundled artifact -> return `fallback_legacy_cli` when allowed
 * 3) Bundled mode (writable in-place OR `~/.imcodes/daemon-runtime` user fallback) -> single-flight lock,
 *    verify manifest & archive & extracted tree digests, pre-check binary, atomically switch `current`
 *    (preserving real-dir `current` bytes), align scoped service launcher, restart & verify live target
 *    daemon (`pid` + `startToken` + `daemon-runtime.json`), record cooldown sentinel, prune old releases,
 *    and auto-rollback pointer + service launcher + restart on any failure.
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

  const stateDir = resolveRuntimeUpgradeStateDir(env, options.userHome);
  const homeDir = options.userHome?.trim() || env.HOME?.trim() || homedir();

  const lockHandle = acquireRuntimeUpgradeLock(stateDir, {
    mode: options.detachedHandoff ? 'detached_handoff_parent' : 'in_process',
  });
  let lockHandedOff = false;

  const workTmpDir = mkdtempSync(join(tmpdir(), 'imcodes-daemon-rt-dl-'));
  let stagingDir: string | undefined;
  let downloaded:
    | { status: 'ready'; manifest: DaemonRuntimeManifest; archivePath: string; archiveSha256: string }
    | { status: 'not_published'; httpStatus?: number };

  try {
    if (source.kind === 'local') {
      downloaded = loadAndVerifyFromLocalDir({ dir: source.dir, expectedTarget: target, platform });
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
      mkdirSync(stagingDir, { recursive: true });
      await options.extractArchive({
        archivePath: downloaded.archivePath,
        format: downloaded.manifest.artifact.format,
        destDir: stagingDir,
        platform,
      });
    } else {
      extractDaemonRuntimeArchive(
        downloaded.archivePath,
        downloaded.manifest.artifact.format,
        stagingDir,
        platform,
      );
    }

    const verified = verifyStagedDaemonRuntimeTree(stagingDir, platform, targetVer, {
      requireFullEntries: options.requireFullEntries,
      manifestFiles: downloaded.manifest.files,
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
        throw new Error(`daemon_runtime_release_in_use:${releaseDir}`);
      }
      rmSync(releaseDir, { recursive: true, force: true });
    }
    renameSync(stagingDir, releaseDir);
    stagingDir = undefined;

    const prev = readCurrentPointerTarget(writableResolution.targetRoot);
    const prevTargetForHandoff = prev.targetPath && prev.targetPath !== join(resolve(writableResolution.targetRoot), 'current')
      ? prev.targetPath
      : undefined;
    const keepTargets = [releaseDir, prevTargetForHandoff].filter((v): v is string => Boolean(v));

    if (options.detachedHandoff) {
      transferRuntimeUpgradeLock(stateDir, lockHandle.ownerToken, {
        mode: 'detached_handoff_pending',
        targetVersion: targetVer,
      });
      try {
        const launched = launchDetachedDaemonRuntimeSwitchRunner({
          platform,
          runtimeRoot: writableResolution.targetRoot,
          stagedReleaseDir: releaseDir,
          previousTarget: prevTargetForHandoff,
          targetVersion: targetVer,
          stateDir,
          homeDir,
          env,
          keepTargets,
          lockOwnerToken: lockHandle.ownerToken,
          healthCheckTimeoutMs: options.healthCheckTimeoutMs,
          settleMs: options.settleMs,
          spawnRunner: options.spawnDetachedRunner,
        });
        lockHandedOff = true;
        return {
          status: 'upgraded',
          targetVersion: targetVer,
          ...(prev.version ?? options.currentVersion ? { previousVersion: prev.version ?? options.currentVersion } : {}),
          ...(prevTargetForHandoff ? { previousTarget: prevTargetForHandoff } : {}),
          runtimeRoot: writableResolution.targetRoot,
          releaseDir,
          currentLink: join(writableResolution.targetRoot, 'current'),
          writableRootKind: writableResolution.writableRootKind,
          rolledBack: false,
          detachedScriptDir: launched.scriptDir,
        };
      } catch (handoffErr) {
        lockHandedOff = false;
        throw handoffErr;
      }
    }

    const oldIdentity = readVerifiedDaemonIdentity(stateDir, platform);
    const nowMs = options.now?.() ?? Date.now();
    const switched = switchDaemonRuntimeCurrentPointer(writableResolution.targetRoot, releaseDir, platform, nowMs);
    const switchedNodePath = join(switched.currentLink, platform === 'win32' ? 'node.exe' : join('bin', 'node'));
    const switchedEntryPath = join(switched.currentLink, 'package', 'dist', 'src', 'index.js');
    const launchCfg = buildServiceLaunchConfig({
      platform,
      runtimeRoot: writableResolution.targetRoot,
      targetCurrent: switched.currentLink,
      homeDir,
      stateDir,
      env,
    });

    let launchBackup: ServiceLaunchBackup | null = null;
    let executedOsServiceRestart = false;

    try {
      launchBackup = prepareServiceLaunchTarget(launchCfg.launchTargetSpec);
      const restartBeganAtMs = Date.now();

      if (options.restartService) {
        await options.restartService({
          platform,
          runtimeRoot: writableResolution.targetRoot,
          releaseDir,
          targetVersion: targetVer,
          previousVersion: switched.previousVersion ?? options.currentVersion,
          previousTarget: switched.previousTarget,
        });
      } else {
        const restartRes = restartDaemonService({
          platform,
          stateDir,
          nodePath: launchCfg.targetNodePath,
          entryPath: launchCfg.targetEntryPath,
          systemdUnitPath: launchCfg.systemdUnitPath,
          systemdUnitName: launchCfg.systemdUnitName,
          launchAgentPath: launchCfg.launchAgentPath,
          windowsTask: launchCfg.windowsTask,
          vbsPath: launchCfg.vbsPath,
          oldIdentity,
          wasRunning: Boolean(oldIdentity),
        });
        if (!restartRes.ok) {
          throw new Error(`daemon_restart_failed:${restartRes.mode}`);
        }
        executedOsServiceRestart = restartRes.mode !== 'noop_stopped';
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
      } else if (oldIdentity || executedOsServiceRestart) {
        waitForHealthyTargetDaemon({
          stateDir,
          expectedVersion: targetVer,
          oldIdentity,
          restartBeganAtMs,
          platform,
          timeoutMs: options.healthCheckTimeoutMs,
          settleMs: options.settleMs,
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
      if (launchBackup) {
        restoreServiceLaunchTarget(launchBackup);
        launchBackup = null;
      }
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
      } else if (oldIdentity || executedOsServiceRestart) {
        const prevRoot = restored.restoredTarget ?? writableResolution.activeRoot;
        const postRbIdentity = readVerifiedDaemonIdentity(stateDir, platform);
        try {
          restartDaemonService({
            platform,
            stateDir,
            nodePath: join(prevRoot, platform === 'win32' ? 'node.exe' : join('bin', 'node')),
            entryPath: join(prevRoot, 'package', 'dist', 'src', 'index.js'),
            systemdUnitPath: launchCfg.systemdUnitPath,
            systemdUnitName: launchCfg.systemdUnitName,
            launchAgentPath: launchCfg.launchAgentPath,
            windowsTask: launchCfg.windowsTask,
            vbsPath: launchCfg.vbsPath,
            oldIdentity: postRbIdentity ?? oldIdentity,
            wasRunning: Boolean(oldIdentity || executedOsServiceRestart),
          });
        } catch {
          // rollback pointer + launcher already restored
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

    writeUpgradeCooldownSentinel(stateDir, options.now?.() ?? Date.now());
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
    if (!lockHandedOff) {
      releaseRuntimeUpgradeLock(stateDir, lockHandle.ownerToken);
    }
  }
}
