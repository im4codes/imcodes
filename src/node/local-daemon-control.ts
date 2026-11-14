import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  REMOTE_DESKTOP_LOCAL_DAEMON_ACTION,
  REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART,
  REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE,
  REMOTE_DESKTOP_LOCAL_DAEMON_REASON,
  REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE,
  redactRemoteDesktopLocalSecrets,
  sanitizeRemoteDesktopLocalDaemonStatus,
  type RemoteDesktopLocalDaemonAction,
  type RemoteDesktopLocalDaemonAutostartState,
  type RemoteDesktopLocalDaemonLogs,
  type RemoteDesktopLocalDaemonRuntimeSource,
  type RemoteDesktopLocalDaemonStatus,
} from '../../shared/remote-desktop-local-management.js';
import { xmlEscapeText } from '../../shared/macos-daemon-launch.js';
import { parseDaemonRuntimeStatus, type DaemonRuntimeStatus } from '../util/daemon-status.js';
import { IMCODES_HOME_ENV, imcodesStateDir, imcodesStateDirForHome } from '../util/imcodes-state-dir.js';
import { resolvePosixDaemonServicePaths } from '../util/posix-daemon-service.js';
import { resolveActiveLinuxDesktopUser, resolveLinuxDesktopSessionEnv } from './linux-desktop-session.js';
import {
  MACOS_LAUNCHCTL_PATH,
  resolveMacosUserSession,
  runMacosUserSessionCommand,
  type MacosUserSession,
} from './user-session-launcher.js';
import { launchWindowsActiveUserCommand, quoteWindowsArgument } from './windows-user-session.js';

const execFileAsync = promisify(execFile);

export const CODING_DAEMON_LOG_MAX_BYTES = 64 * 1024;
const DEFAULT_STOP_WAIT_MS = 1_500;
const DEFAULT_BIND_TIMEOUT_MS = 15_000;
const DEFAULT_WINDOWS_LAUNCH_SETTLE_MS = 50;
const WINDOWS_TASK_NAME = 'IMCodes Daemon';
const WINDOWS_STARTUP_SCRIPT_NAME = 'imcodes-daemon.cmd';

export interface ActiveDesktopUser {
  platform: NodeJS.Platform;
  username: string;
  home: string;
  uid?: number;
  gid?: number;
  tempDir?: string;
}

export interface DiscoveredCodingDaemonRuntime {
  source: RemoteDesktopLocalDaemonRuntimeSource;
  version?: string;
  bundleDir?: string;
  executable: string;
  prefixArgs: readonly string[];
  foregroundArgs: readonly string[];
}

export interface LocalDaemonActionResult {
  ok: boolean;
  statusCode: number;
  error?: string;
  status?: RemoteDesktopLocalDaemonStatus;
}

export interface LocalDaemonControlDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  currentUid?: () => number;
  currentGid?: () => number;
  hostName?: () => string;
  bundleDirs?: readonly string[];
  cliCandidates?: readonly string[];
  activeUser?: ActiveDesktopUser | null | (() => Promise<ActiveDesktopUser | null>);
  isPidAlive?: (pid: number) => boolean;
  killProcess?: (pid: number, signal: NodeJS.Signals | number) => void;
  execText?: (
    file: string,
    args: readonly string[],
    opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv; uid?: number; gid?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  spawnDetached?: (
    file: string,
    args: readonly string[],
    opts: SpawnOptions,
  ) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** @deprecated Unused at runtime; ownership always binds to validated open fds via `fchown`. */
  chown?: (filePath: string, uid: number, gid: number) => void;
  fchown?: (fd: number, uid: number, gid: number) => void;
  /** Override `/proc` root for Linux PID verification (defaults to `'/proc'`). */
  procRoot?: string;
  bindTimeoutMs?: number;
  stopWaitMs?: number;
  windowsLaunchSettleMs?: number;
}

export interface LocalDaemonSetupBindingInfo {
  bound: boolean;
  workerUrl: string | null;
  serverId: string | null;
}

export interface LocalDaemonController {
  status(): Promise<RemoteDesktopLocalDaemonStatus>;
  logs(): Promise<RemoteDesktopLocalDaemonLogs>;
  readSetupBindingInfo?(): Promise<LocalDaemonSetupBindingInfo>;
  performAction(
    action: RemoteDesktopLocalDaemonAction,
    payload?: { bindUrl?: unknown; serverName?: unknown },
  ): Promise<LocalDaemonActionResult>;
}

interface StoredServerCredentials {
  serverId: string;
  serverHost: string;
  serverOrigin?: string;
  workerUrl: string;
  token?: string;
  serverName?: string;
}

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return false;
    if (platform === 'win32') return true;
    try {
      // fsConstants.X_OK verifies execute permission on POSIX
      return (st.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

function readPackageVersion(packageJsonPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: unknown; version?: unknown };
    if (typeof parsed.version === 'string' && /^[\w.+-]{1,64}$/u.test(parsed.version.trim())) {
      return parsed.version.trim();
    }
  } catch {
    // ignore malformed or missing package.json
  }
  return undefined;
}

function readManifestVersion(bundleDir: string): string | undefined {
  const candidates = [
    `${bundleDir}.manifest.json`,
    join(dirname(bundleDir), 'daemon-runtime.manifest.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { packageVersion?: unknown; version?: unknown };
      const raw = typeof parsed.packageVersion === 'string'
        ? parsed.packageVersion
        : (typeof parsed.version === 'string' ? parsed.version : undefined);
      if (raw && /^[\w.+-]{1,64}$/u.test(raw.trim())) return raw.trim();
    } catch {
      // ignore
    }
  }
  return undefined;
}

function findImcodesVersionFromPath(entryPath: string): string | undefined {
  let current: string;
  try {
    current = realpathSync(entryPath);
  } catch {
    current = resolve(entryPath);
  }
  let dir = statSyncSafeIsDir(current) ? current : dirname(current);
  for (let i = 0; i < 4; i += 1) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown; version?: unknown };
        if (parsed.name === 'imcodes' && typeof parsed.version === 'string' && /^[\w.+-]{1,64}$/u.test(parsed.version.trim())) {
          return parsed.version.trim();
        }
      } catch {
        // ignore
      }
    }
    const nmPkgPaths = [
      join(dir, 'lib', 'node_modules', 'imcodes', 'package.json'),
      join(dir, 'node_modules', 'imcodes', 'package.json'),
    ];
    for (const nmPkgPath of nmPkgPaths) {
      if (existsSync(nmPkgPath)) {
        const v = readPackageVersion(nmPkgPath);
        if (v) return v;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function statSyncSafeIsDir(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function uniquePaths(items: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item?.trim();
    if (!trimmed) continue;
    const resolved = resolve(trimmed);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

/**
 * Discover the installed Coding Daemon runtime.
 * Priority: Phase 1 bundled `daemon-runtime` first, then legacy `imcodes` CLI installs.
 */
export function discoverCodingDaemonRuntime(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  userHome?: string;
  bundleDirs?: readonly string[];
  cliCandidates?: readonly string[];
} = {}): DiscoveredCodingDaemonRuntime | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const execDir = dirname(execPath);

  const defaultBundleDirs: Array<string | undefined> = options.bundleDirs !== undefined
    ? [...options.bundleDirs]
    : [
      env.IMCODES_DAEMON_RUNTIME_DIR,
      join(execDir, 'daemon-runtime'),
      join(execDir, '..', 'daemon-runtime'),
      join(execDir, '..', '..', 'daemon-runtime'),
      ...(platform === 'darwin' ? ['/Library/Application Support/imcodes/daemon-runtime'] : []),
      ...(platform === 'linux' ? ['/opt/imcodes/daemon-runtime'] : []),
      ...(platform === 'win32' ? [join(env.ProgramFiles || 'C:\\Program Files', 'IM.codes', 'daemon-runtime')] : []),
    ];

  for (const bundleDir of uniquePaths(defaultBundleDirs)) {
    const nodeBin = join(bundleDir, platform === 'win32' ? 'node.exe' : join('bin', 'node'));
    const entry = join(bundleDir, 'package', 'dist', 'src', 'index.js');
    if (isExecutableFile(nodeBin, platform) && existsSync(entry)) {
      const version = readPackageVersion(join(bundleDir, 'package', 'package.json')) ?? readManifestVersion(bundleDir);
      return {
        source: REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.BUNDLE,
        ...(version ? { version } : {}),
        bundleDir,
        executable: nodeBin,
        prefixArgs: [entry],
        foregroundArgs: [entry, 'start', '--foreground'],
      };
    }
  }

  const cliCandidates: Array<string | undefined> = options.cliCandidates !== undefined ? [...options.cliCandidates] : [];
  if (options.cliCandidates === undefined) {
    if (platform === 'win32') {
      if (options.userHome) {
        const userAppData = join(options.userHome, 'AppData', 'Roaming');
        cliCandidates.push(
          join(userAppData, 'npm', 'imcodes.exe'),
          join(userAppData, 'npm', 'imcodes.cmd'),
          join(options.userHome, 'AppData', 'Local', 'Programs', 'nodejs', 'imcodes.cmd'),
        );
      }
      if (env.APPDATA && !env.APPDATA.toLowerCase().includes('\\systemprofile\\')) {
        cliCandidates.push(
          join(env.APPDATA, 'npm', 'imcodes.exe'),
          join(env.APPDATA, 'npm', 'imcodes.cmd'),
        );
      }
      cliCandidates.push(
        join(env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'imcodes.exe'),
        join(env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'imcodes.cmd'),
      );
    } else {
      if (options.userHome) {
        cliCandidates.push(
          join(options.userHome, '.local', 'bin', 'imcodes'),
          join(options.userHome, '.npm-global', 'bin', 'imcodes'),
          join(options.userHome, 'bin', 'imcodes'),
        );
        const nvmDir = join(options.userHome, '.nvm', 'versions', 'node');
        try {
          if (existsSync(nvmDir)) {
            const versions = readdirSync(nvmDir).sort().reverse();
            for (const ver of versions) {
              cliCandidates.push(join(nvmDir, ver, 'bin', 'imcodes'));
            }
          }
        } catch {
          // ignore unreadable nvm directory
        }
      }
      if (platform === 'darwin') cliCandidates.push('/opt/homebrew/bin/imcodes');
      cliCandidates.push('/usr/local/bin/imcodes', '/usr/bin/imcodes');
    }

    const pathVar = env.PATH ?? '';
    const pathSep = platform === 'win32' ? ';' : ':';
    for (const dir of pathVar.split(pathSep)) {
      const trimmed = dir.trim();
      if (!trimmed) continue;
      if (platform === 'win32') {
        cliCandidates.push(join(trimmed, 'imcodes.exe'), join(trimmed, 'imcodes.cmd'), join(trimmed, 'imcodes'));
      } else {
        cliCandidates.push(join(trimmed, 'imcodes'));
      }
    }
  }

  for (const candidate of uniquePaths(cliCandidates)) {
    if (!isExecutableFile(candidate, platform)) continue;
    const version = findImcodesVersionFromPath(candidate);
    if (platform === 'win32' && /\.(?:cmd|bat)$/iu.test(candidate)) {
      const cmdDir = dirname(candidate);
      const distEntry = join(cmdDir, 'node_modules', 'imcodes', 'dist', 'src', 'index.js');
      const nodeCandidates: Array<string | undefined> = [
        join(cmdDir, 'node.exe'),
        options.userHome ? join(options.userHome, 'AppData', 'Local', 'Programs', 'nodejs', 'node.exe') : undefined,
        join(env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
        ...(env.PATH ?? '').split(';').filter(Boolean).map((dir) => join(dir.trim(), 'node.exe')),
      ];
      const resolvedNode = uniquePaths(nodeCandidates).find((nodeCandidate) => isExecutableFile(nodeCandidate, 'win32'));
      if (resolvedNode && existsSync(distEntry)) {
        return {
          source: REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.CLI,
          ...(version ? { version } : {}),
          executable: resolvedNode,
          prefixArgs: [distEntry],
          foregroundArgs: [distEntry, 'start', '--foreground'],
        };
      }
      return {
        source: REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.CLI,
        ...(version ? { version } : {}),
        executable: 'cmd.exe',
        prefixArgs: ['/d', '/s', '/c', candidate],
        foregroundArgs: ['/d', '/s', '/c', candidate, 'start', '--foreground'],
      };
    }

    return {
      source: REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.CLI,
      ...(version ? { version } : {}),
      executable: candidate,
      prefixArgs: [],
      foregroundArgs: ['start', '--foreground'],
    };
  }

  return null;
}

/** Redact tokens, bearer headers, and bind URLs before displaying daemon errors or logs. */
export function redactDaemonSecrets(input: string): string {
  return redactRemoteDesktopLocalSecrets(input, { preserveNewlines: true });
}

function isRealServiceControlBlockedInTest(): boolean {
  return Boolean(process.env.VITEST) && process.env.IMCODES_ALLOW_REAL_SERVICE_CONTROL !== '1';
}

function defaultExecText(
  file: string,
  args: readonly string[],
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv; uid?: number; gid?: number },
): Promise<{ stdout: string; stderr: string }> {
  if (isRealServiceControlBlockedInTest()) {
    return Promise.reject(new Error(`refused_real_exec_in_vitest: ${file} ${args.join(' ')}`));
  }
  return execFileAsync(file, [...args], {
    timeout: opts?.timeoutMs ?? 15_000,
    encoding: 'utf8',
    windowsHide: true,
    ...(opts?.env ? { env: opts.env } : {}),
    ...(typeof opts?.uid === 'number' ? { uid: opts.uid } : {}),
    ...(typeof opts?.gid === 'number' ? { gid: opts.gid } : {}),
  }).then((res) => ({ stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') }));
}

function defaultIsPidAlive(pid: number, platform: NodeJS.Platform, procRoot = '/proc'): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return false;
    if (code !== 'EPERM') return false;
  }

  if (platform === 'linux') {
    try {
      const statLine = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
      const rparen = statLine.lastIndexOf(')');
      if (rparen !== -1) {
        const state = statLine.slice(rparen + 2, rparen + 3);
        if (state === 'Z') return false;
      }
      const cmdline = readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      if (cmdline && !/(?:imcodes|dist\/src\/index\.js|src\/index\.ts)/iu.test(cmdline)) {
        return false;
      }
    } catch {
      // /proc may be unavailable or restricted across users
    }
  }
  return true;
}

function isWindowsSystemProcess(env: NodeJS.ProcessEnv, username: string): boolean {
  const upperUser = username.trim().toUpperCase();
  const profile = (env.USERPROFILE ?? '').toLowerCase();
  if (upperUser === 'SYSTEM' || upperUser === 'LOCAL SERVICE' || upperUser === 'NETWORK SERVICE') return true;
  if (upperUser.endsWith('$')) return true;
  if (profile.endsWith('\\systemprofile')) return true;
  return false;
}

async function resolveWindowsInteractiveUser(
  env: NodeJS.ProcessEnv,
  execText: NonNullable<LocalDaemonControlDeps['execText']>,
): Promise<ActiveDesktopUser | null> {
  const current = (() => {
    try {
      return userInfo();
    } catch {
      return { username: env.USERNAME || '', homedir: env.USERPROFILE || homedir() };
    }
  })();

  if (current.username && !isWindowsSystemProcess(env, current.username) && (current.homedir || env.USERPROFILE)) {
    return {
      platform: 'win32',
      username: current.username,
      home: current.homedir || env.USERPROFILE || homedir(),
    };
  }

  // Running elevated / Session 0 SYSTEM: query active interactive WTS user + ProfileImagePath.
  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    "$cs = Get-CimInstance Win32_ComputerSystem | Select-Object -ExpandProperty UserName -ErrorAction SilentlyContinue",
    "if (-not $cs) { exit 2 }",
    "$leaf = ($cs -split '\\\\')[-1]",
    "$prof = Get-CimInstance Win32_UserProfile | Where-Object { -not $_.Special -and $_.LocalPath -and (($_.LocalPath | Split-Path -Leaf) -ieq $leaf -or $_.Loaded) } | Select-Object -First 1",
    "if (-not $prof) { exit 3 }",
    "Write-Output ($cs + '|' + $prof.LocalPath)",
  ].join('; ');

  try {
    const { stdout } = await execText(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { timeoutMs: 8_000, env },
    );
    const line = stdout.trim().split(/\r?\n/u)[0]?.trim();
    if (!line) return null;
    const sepIdx = line.indexOf('|');
    if (sepIdx <= 0) return null;
    const username = line.slice(0, sepIdx).trim();
    const home = line.slice(sepIdx + 1).trim();
    if (!username || !home || home.toLowerCase().endsWith('\\systemprofile')) return null;
    return { platform: 'win32', username, home };
  } catch {
    return null;
  }
}

async function resolveDefaultActiveUser(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  currentUid: number,
  currentGid: number,
  execText: NonNullable<LocalDaemonControlDeps['execText']>,
): Promise<ActiveDesktopUser | null> {
  if (platform === 'win32') {
    return resolveWindowsInteractiveUser(env, execText);
  }

  if (platform === 'darwin') {
    if (currentUid > 0) {
      const info = userInfo();
      return {
        platform: 'darwin',
        uid: currentUid,
        gid: currentGid > 0 ? currentGid : currentUid,
        username: info.username || env.USER || 'user',
        home: env.HOME || info.homedir || homedir(),
        tempDir: env.TMPDIR || tmpdir(),
      };
    }
    const macUser: MacosUserSession | null = await resolveMacosUserSession({
      execFileText: async (file, args, timeoutMs) => {
        const res = await execText(file, args, { timeoutMs, env });
        return res.stdout;
      },
    }).catch(() => null);
    if (!macUser) return null;
    return {
      platform: 'darwin',
      uid: macUser.uid,
      gid: macUser.gid,
      username: macUser.name,
      home: macUser.home,
      tempDir: macUser.tempDir,
    };
  }

  if (platform === 'linux') {
    const linuxUser = resolveActiveLinuxDesktopUser({ currentUid, currentGid });
    if (!linuxUser) return null;
    return {
      platform: 'linux',
      uid: linuxUser.uid,
      gid: linuxUser.gid,
      username: linuxUser.username,
      home: linuxUser.home,
    };
  }

  return null;
}

function assertCleanRelativeParts(relativeParts: readonly string[]): void {
  if (relativeParts.length === 0) throw new Error('unsafe_path');
  for (const part of relativeParts) {
    if (!part || part === '.' || part === '..' || part.includes('/') || part.includes('\\')) {
      throw new Error('unsafe_path');
    }
  }
}

function isWithinCanonicalRoot(candidateRealPath: string, canonicalRoot: string): boolean {
  return candidateRealPath === canonicalRoot || candidateRealPath.startsWith(`${canonicalRoot}${sep}`);
}

function applyFdOwnership(
  fd: number,
  user: ActiveDesktopUser,
  currentUid: number,
  fchownOverride?: (fd: number, uid: number, gid: number) => void,
): void {
  if (user.platform === 'win32' || currentUid !== 0) return;
  if (typeof user.uid !== 'number' || typeof user.gid !== 'number') {
    throw new Error('missing_target_user_ids');
  }
  const fchownFn = fchownOverride ?? fchownSync;
  const realUid = typeof process.getuid === 'function' ? process.getuid() : -1;
  try {
    fchownFn(fd, user.uid, user.gid);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (!fchownOverride && realUid !== 0 && code === 'EPERM') {
      return;
    }
    throw err;
  }
}

function openSafeDirFd(dirPath: string): number {
  const dirFlags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
  const fd = openSync(dirPath, dirFlags);
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory()) {
      throw new Error('unsafe_path');
    }
    return fd;
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
    throw err;
  }
}

function assertSafeDirRoot(
  rootDir: string,
  options: {
    createIfMissing?: boolean;
    dirMode?: number;
    user?: ActiveDesktopUser;
    currentUid?: number;
    ownExisting?: boolean;
    fchownOverride?: (fd: number, uid: number, gid: number) => void;
  } = {},
): string | null {
  let exists = false;
  try {
    const st = lstatSync(rootDir);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    exists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return null;
  }
  if (!exists) {
    if (!options.createIfMissing) return null;
    mkdirSync(rootDir, { recursive: true, mode: options.dirMode ?? 0o700 });
    const createdLst = lstatSync(rootDir);
    if (createdLst.isSymbolicLink() || !createdLst.isDirectory()) {
      throw new Error('unsafe_path');
    }
  }
  const shouldOwn = Boolean(
    options.user
    && options.user.platform !== 'win32'
    && typeof options.currentUid === 'number'
    && options.currentUid === 0
    && (!exists || options.ownExisting),
  );
  if (shouldOwn && options.user && typeof options.currentUid === 'number') {
    const dirFd = openSafeDirFd(rootDir);
    try {
      applyFdOwnership(dirFd, options.user, options.currentUid, options.fchownOverride);
      return realpathSync(rootDir);
    } finally {
      closeSync(dirFd);
    }
  }
  try {
    return realpathSync(rootDir);
  } catch {
    return null;
  }
}

function openSafeContainedReadFd(rootDir: string, relativeParts: readonly string[]): number | null {
  try {
    assertCleanRelativeParts(relativeParts);
  } catch {
    return null;
  }
  const canonicalRoot = assertSafeDirRoot(rootDir);
  if (!canonicalRoot) return null;

  let curDir = rootDir;
  for (const part of relativeParts.slice(0, -1)) {
    curDir = join(curDir, part);
    try {
      const lst = lstatSync(curDir);
      if (lst.isSymbolicLink() || !lst.isDirectory()) return null;
      const realDir = realpathSync(curDir);
      if (!isWithinCanonicalRoot(realDir, canonicalRoot)) return null;
    } catch {
      return null;
    }
  }

  const targetPath = join(curDir, relativeParts[relativeParts.length - 1]!);
  try {
    const lst = lstatSync(targetPath);
    if (lst.isSymbolicLink() || !lst.isFile()) return null;
    const fd = openSync(targetPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) {
        closeSync(fd);
        return null;
      }
      const realParent = realpathSync(curDir);
      if (!isWithinCanonicalRoot(realParent, canonicalRoot)) {
        closeSync(fd);
        return null;
      }
      return fd;
    } catch {
      closeSync(fd);
      return null;
    }
  } catch {
    return null;
  }
}

function readSafeSmallUtf8(rootDir: string, relativeParts: readonly string[], maxBytes = 64 * 1024): string | null {
  const fd = openSafeContainedReadFd(rootDir, relativeParts);
  if (fd === null) return null;
  try {
    const st = fstatSync(fd);
    if (st.size <= 0 || st.size > maxBytes) return st.size === 0 ? '' : null;
    const buffer = Buffer.allocUnsafe(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = readSync(fd, buffer, offset, st.size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    return buffer.subarray(0, offset).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function removeSafeContainedFile(rootDir: string, relativeParts: readonly string[]): void {
  try {
    assertCleanRelativeParts(relativeParts);
  } catch {
    return;
  }
  const canonicalRoot = assertSafeDirRoot(rootDir);
  if (!canonicalRoot) return;
  let curDir = rootDir;
  for (const part of relativeParts.slice(0, -1)) {
    curDir = join(curDir, part);
    try {
      const lst = lstatSync(curDir);
      if (lst.isSymbolicLink() || !lst.isDirectory()) return;
      if (!isWithinCanonicalRoot(realpathSync(curDir), canonicalRoot)) return;
    } catch {
      return;
    }
  }
  const targetPath = join(curDir, relativeParts[relativeParts.length - 1]!);
  try {
    const targetLst = lstatSync(targetPath);
    if (targetLst.isDirectory()) return;
    unlinkSync(targetPath);
  } catch {
    // ENOENT or inaccessible target
  }
}

function readServerCredentials(stateDir: string): StoredServerCredentials | null {
  try {
    const rawText = readSafeSmallUtf8(stateDir, ['server.json']);
    if (!rawText) return null;
    const raw = JSON.parse(rawText) as {
      serverId?: unknown;
      workerUrl?: unknown;
      token?: unknown;
      serverName?: unknown;
    };
    if (typeof raw.serverId !== 'string' || !raw.serverId.trim()) return null;
    if (typeof raw.workerUrl !== 'string' || !raw.workerUrl.trim()) return null;
    const parsedUrl = new URL(raw.workerUrl.trim());
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;
    if (!parsedUrl.host) return null;
    return {
      serverId: raw.serverId.trim(),
      workerUrl: raw.workerUrl.trim(),
      serverHost: parsedUrl.host,
      serverOrigin: parsedUrl.origin,
      ...(typeof raw.token === 'string' && raw.token ? { token: raw.token } : {}),
      ...(typeof raw.serverName === 'string' && raw.serverName ? { serverName: raw.serverName } : {}),
    };
  } catch {
    return null;
  }
}

function readPidFile(stateDir: string): number | null {
  try {
    const rawText = readSafeSmallUtf8(stateDir, ['daemon.pid'], 1024);
    if (!rawText) return null;
    const parsed = Number.parseInt(rawText.trim(), 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function readSafeDaemonRuntimeStatus(stateDir: string): DaemonRuntimeStatus | null {
  const rawText = readSafeSmallUtf8(stateDir, ['daemon-runtime.json'], 512 * 1024);
  if (!rawText) return null;
  return parseDaemonRuntimeStatus(rawText);
}

function ensureOwnedDir(
  rootDir: string,
  relativeParts: readonly string[],
  user: ActiveDesktopUser,
  currentUid: number,
  mode = 0o700,
  ownExistingRoot = true,
  fchownOverride?: (fd: number, uid: number, gid: number) => void,
): string {
  const canonicalRoot = assertSafeDirRoot(rootDir, {
    createIfMissing: true,
    dirMode: mode,
    user,
    currentUid,
    ownExisting: ownExistingRoot,
    fchownOverride,
  });
  if (!canonicalRoot) throw new Error('unsafe_path');

  let curDir = rootDir;
  for (const part of relativeParts) {
    if (!part || part === '.' || part === '..' || part.includes('/') || part.includes('\\')) {
      throw new Error('unsafe_path');
    }
    curDir = join(curDir, part);
    let existed = false;
    try {
      const lst = lstatSync(curDir);
      if (lst.isSymbolicLink() || !lst.isDirectory()) throw new Error('unsafe_path');
      existed = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
    if (!existed) {
      mkdirSync(curDir, { mode });
    }
    if (user.platform !== 'win32') {
      const dirFd = openSafeDirFd(curDir);
      try {
        const realCur = realpathSync(curDir);
        if (!isWithinCanonicalRoot(realCur, canonicalRoot)) throw new Error('unsafe_path');
        applyFdOwnership(dirFd, user, currentUid, fchownOverride);
      } finally {
        closeSync(dirFd);
      }
    } else {
      const realCur = realpathSync(curDir);
      if (!isWithinCanonicalRoot(realCur, canonicalRoot)) throw new Error('unsafe_path');
    }
  }
  return curDir;
}

function writeOwnedFile(
  rootDir: string,
  relativeParts: readonly string[],
  content: string,
  user: ActiveDesktopUser,
  currentUid: number,
  mode: number,
  ownExistingRoot: boolean,
  fchownOverride?: (fd: number, uid: number, gid: number) => void,
): void {
  assertCleanRelativeParts(relativeParts);
  const dirMode = mode === 0o600 ? 0o700 : 0o755;
  const parentDir = ensureOwnedDir(
    rootDir,
    relativeParts.slice(0, -1),
    user,
    currentUid,
    dirMode,
    ownExistingRoot,
    fchownOverride,
  );
  const canonicalRoot = realpathSync(rootDir);
  const leafName = relativeParts[relativeParts.length - 1]!;
  const filePath = join(parentDir, leafName);

  try {
    const existing = lstatSync(filePath);
    if (existing.isSymbolicLink() || existing.isDirectory()) throw new Error('unsafe_path');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }

  const tmpPath = join(parentDir, `${leafName}.${randomBytes(8).toString('hex')}.tmp`);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  const fd = openSync(tmpPath, flags, mode);
  let fdClosed = false;
  const closeOnce = () => {
    if (!fdClosed) {
      fdClosed = true;
      closeSync(fd);
    }
  };
  try {
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile()) throw new Error('unsafe_path');
    const buf = Buffer.from(content, 'utf8');
    let written = 0;
    while (written < buf.length) {
      written += writeSync(fd, buf, written, buf.length - written);
    }
    if (user.platform !== 'win32') {
      fchmodSync(fd, mode);
      applyFdOwnership(fd, user, currentUid, fchownOverride);
    } else {
      chmodSync(tmpPath, mode);
    }
    if (!isWithinCanonicalRoot(realpathSync(parentDir), canonicalRoot)) {
      throw new Error('unsafe_path');
    }
    const tmpLst = lstatSync(tmpPath);
    if (tmpLst.isSymbolicLink() || !tmpLst.isFile() || tmpLst.dev !== fdStat.dev || tmpLst.ino !== fdStat.ino) {
      throw new Error('unsafe_path');
    }
    try {
      const targetLst = lstatSync(filePath);
      if (targetLst.isSymbolicLink() || targetLst.isDirectory()) throw new Error('unsafe_path');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
    if (user.platform === 'win32') {
      closeOnce();
    }
    renameSync(tmpPath, filePath);
    closeOnce();
  } catch (err) {
    closeOnce();
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore missing/already moved temp file
    }
    throw err;
  }
}

function buildUserServicePath(
  runtime: DiscoveredCodingDaemonRuntime | null,
  user: ActiveDesktopUser,
  platform: NodeJS.Platform,
  existingPath?: string,
): string {
  if (platform === 'win32') return existingPath ?? '';
  const dirs: Array<string | undefined> = [];
  if (runtime) {
    dirs.push(dirname(runtime.executable));
    try {
      dirs.push(dirname(realpathSync(runtime.executable)));
    } catch {
      // ignore unresolvable executable symlink
    }
  }
  dirs.push(
    join(user.home, '.local', 'bin'),
    join(user.home, '.npm-global', 'bin'),
    join(user.home, 'bin'),
  );
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin');
  dirs.push('/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  if (existingPath) {
    for (const seg of existingPath.split(':')) {
      if (seg.trim()) dirs.push(seg.trim());
    }
  }
  return uniquePaths(dirs).join(':');
}

function renderMacosDaemonPlist(
  label: string,
  runtime: DiscoveredCodingDaemonRuntime,
  user: ActiveDesktopUser,
  stateDir: string,
  autostart: boolean,
  baseEnvPath?: string,
): string {
  const programArgs = [runtime.executable, ...runtime.foregroundArgs]
    .map((arg) => `    <string>${xmlEscapeText(arg)}</string>`)
    .join('\n');
  const logPath = join(stateDir, 'daemon.log');
  const pathEnv = buildUserServicePath(runtime, user, 'darwin', baseEnvPath);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlEscapeText(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    programArgs,
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    `    <string>${xmlEscapeText(pathEnv)}</string>`,
    '    <key>HOME</key>',
    `    <string>${xmlEscapeText(user.home)}</string>`,
    '    <key>IMCODES_HOME</key>',
    `    <string>${xmlEscapeText(stateDir)}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    autostart ? '  <true/>' : '  <false/>',
    '  <key>KeepAlive</key>',
    autostart ? '  <true/>' : '  <false/>',
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscapeText(logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscapeText(logPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function formatSystemdToken(arg: string): string {
  if (/^[A-Za-z0-9_./:-]+$/u.test(arg)) return arg;
  return `"${arg.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

function formatSystemdEnvAssignment(key: string, value: string): string {
  const raw = `${key}=${value}`;
  if (/^[A-Za-z0-9_./:=+-]+$/u.test(raw)) return raw;
  return `"${raw.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

function renderLinuxSystemdUnit(
  runtime: DiscoveredCodingDaemonRuntime,
  user: ActiveDesktopUser,
  stateDir: string,
  baseEnvPath?: string,
): string {
  const execStart = [runtime.executable, ...runtime.foregroundArgs].map(formatSystemdToken).join(' ');
  const logPath = join(stateDir, 'daemon.log');
  const pathEnv = buildUserServicePath(runtime, user, 'linux', baseEnvPath);
  return [
    '[Unit]',
    'Description=IM.codes Coding Daemon',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execStart}`,
    'Restart=always',
    'RestartSec=5',
    `Environment=${formatSystemdEnvAssignment('HOME', user.home)}`,
    `Environment=${formatSystemdEnvAssignment('IMCODES_HOME', stateDir)}`,
    `Environment=${formatSystemdEnvAssignment('PATH', pathEnv)}`,
    `StandardOutput=append:${logPath}`,
    `StandardError=append:${logPath}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function parsePlistRunAtLoad(plistText: string): boolean | null {
  const match = plistText.match(/<key>RunAtLoad<\/key>\s*<(true|false)\s*\/>/iu);
  if (!match) return null;
  return match[1].toLowerCase() === 'true';
}

function setPlistAutostartFlags(plistText: string, enabled: boolean): string {
  const flag = enabled ? '<true/>' : '<false/>';
  return plistText
    .replace(/(<key>RunAtLoad<\/key>\s*)<(?:true|false)\s*\/>/iu, `$1${flag}`)
    .replace(/(<key>KeepAlive<\/key>\s*)<(?:true|false)\s*\/>/iu, `$1${flag}`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function posixServicePathsForUser(
  user: ActiveDesktopUser,
  env: NodeJS.ProcessEnv,
): {
  launchAgentLabel: string;
  launchAgentPath: string;
  launchAgentRelParts: readonly string[];
  systemdUnitName: string;
  systemdUnitPath: string;
  systemdUnitRelParts: readonly string[];
  scoped: boolean;
} {
  const base = resolvePosixDaemonServicePaths({ ...env, HOME: user.home });
  const launchAgentRelParts = ['Library', 'LaunchAgents', `${base.launchAgentLabel}.plist`] as const;
  const systemdUnitRelParts = ['.config', 'systemd', 'user', base.systemdUnitName] as const;
  return {
    scoped: base.scoped,
    launchAgentLabel: base.launchAgentLabel,
    launchAgentPath: join(user.home, ...launchAgentRelParts),
    launchAgentRelParts,
    systemdUnitName: base.systemdUnitName,
    systemdUnitPath: join(user.home, ...systemdUnitRelParts),
    systemdUnitRelParts,
  };
}

function linuxUserServiceEnv(
  user: ActiveDesktopUser,
  baseEnv: NodeJS.ProcessEnv,
  stateDir: string,
  runtime: DiscoveredCodingDaemonRuntime | null = null,
): NodeJS.ProcessEnv {
  const uid = user.uid ?? 1000;
  const sessionEnv = resolveLinuxDesktopSessionEnv(baseEnv, {
    user: {
      uid,
      gid: user.gid ?? uid,
      username: user.username,
      home: user.home,
    },
  });
  return {
    ...sessionEnv,
    XDG_RUNTIME_DIR: sessionEnv.XDG_RUNTIME_DIR || `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: sessionEnv.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`,
    HOME: user.home,
    IMCODES_HOME: stateDir,
    PATH: buildUserServicePath(runtime, user, 'linux', sessionEnv.PATH),
  };
}

function readBoundedTailLog(stateDir: string): RemoteDesktopLocalDaemonLogs {
  const candidates: Array<{ parts: readonly string[]; label: string }> = [
    { parts: ['logs', 'daemon.log'], label: 'logs/daemon.log' },
    { parts: ['daemon.log'], label: 'daemon.log' },
  ];

  for (const candidate of candidates) {
    const fd = openSafeContainedReadFd(stateDir, candidate.parts);
    if (fd === null) continue;
    try {
      const st = fstatSync(fd);
      const totalBytes = st.size;
      if (totalBytes <= 0) {
        return { text: '', truncated: false, source: candidate.label };
      }
      const truncated = totalBytes > CODING_DAEMON_LOG_MAX_BYTES;
      const readBytes = Math.min(totalBytes, CODING_DAEMON_LOG_MAX_BYTES);
      const startOffset = Math.max(0, totalBytes - readBytes);
      const buffer = Buffer.allocUnsafe(readBytes);
      let offset = 0;
      while (offset < readBytes) {
        const n = readSync(fd, buffer, offset, readBytes - offset, startOffset + offset);
        if (n <= 0) break;
        offset += n;
      }
      let text = buffer.subarray(0, offset).toString('utf8');
      if (truncated) {
        const firstNewline = text.indexOf('\n');
        if (firstNewline >= 0 && firstNewline < text.length - 1) {
          text = text.slice(firstNewline + 1);
        }
      }
      return {
        text: redactDaemonSecrets(text),
        truncated,
        source: candidate.label,
      };
    } catch {
      // try next candidate
    } finally {
      closeSync(fd);
    }
  }

  return { text: '', truncated: false };
}

export function validateBindUrl(rawUrl: unknown): { ok: true; workerUrl: string; apiKey: string } | { ok: false; error: string } {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, error: 'invalid_bind_url' };
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length > 2048) {
    return { ok: false, error: 'invalid_bind_url' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'invalid_bind_url' };
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.host || parsed.username || parsed.password) {
    return { ok: false, error: 'invalid_bind_url' };
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== 'bind' || !parts[1] || !/^[A-Za-z0-9._~-]{4,512}$/u.test(parts[1])) {
    return { ok: false, error: 'invalid_bind_url' };
  }
  return { ok: true, workerUrl: parsed.origin, apiKey: parts[1] };
}

/**
 * Create the local Coding Daemon discovery & user-session lifecycle controller.
 * All privileged hosts MUST manage Coding Daemon inside the signed-in interactive user session, never as root/SYSTEM.
 */
export function createLocalDaemonController(deps: LocalDaemonControlDeps = {}): LocalDaemonController {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const execPath = deps.execPath ?? process.execPath;
  const currentUidFn = deps.currentUid ?? (() => (typeof process.getuid === 'function' ? process.getuid() : -1));
  const currentGidFn = deps.currentGid ?? (() => (typeof process.getgid === 'function' ? process.getgid() : -1));
  const hostNameFn = deps.hostName ?? hostname;
  const execText = deps.execText ?? defaultExecText;
  const procRoot = deps.procRoot ?? '/proc';
  const isPidAlive = deps.isPidAlive ?? ((pid: number) => defaultIsPidAlive(pid, platform, procRoot));
  const killProcess = deps.killProcess ?? ((pid: number, sig: NodeJS.Signals | number) => {
    if (isRealServiceControlBlockedInTest()) {
      throw new Error(`refused_real_kill_in_vitest: ${pid} ${String(sig)}`);
    }
    process.kill(pid, sig);
  });
  const spawnDetached = deps.spawnDetached ?? ((file, args, opts) => {
    if (isRealServiceControlBlockedInTest()) {
      throw new Error(`refused_real_spawn_in_vitest: ${file}`);
    }
    const child = spawn(file, [...args], opts);
    child.unref();
  });
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const bindTimeoutMs = deps.bindTimeoutMs ?? DEFAULT_BIND_TIMEOUT_MS;
  const stopWaitMs = deps.stopWaitMs ?? DEFAULT_STOP_WAIT_MS;
  const windowsLaunchSettleMs = deps.windowsLaunchSettleMs ?? DEFAULT_WINDOWS_LAUNCH_SETTLE_MS;

  function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('bind_timeout'));
    }
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const onAbort = () => {
        rejectPromise(signal.reason instanceof Error ? signal.reason : new Error('bind_timeout'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolvePromise(value);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          rejectPromise(err);
        },
      );
    });
  }

  async function resolveUser(): Promise<ActiveDesktopUser | null> {
    if (typeof deps.activeUser === 'function') return deps.activeUser();
    if (deps.activeUser !== undefined) return deps.activeUser;
    return resolveDefaultActiveUser(platform, env, currentUidFn(), currentGidFn(), execText);
  }

  function stateDirForUser(user: ActiveDesktopUser): string {
    if (env[IMCODES_HOME_ENV]?.trim()) {
      return imcodesStateDir(env);
    }
    return imcodesStateDirForHome(user.home, env);
  }

  async function runWindowsUserLaunch(executable: string, argsLine: string): Promise<void> {
    await new Promise<void>((resolveLaunch, rejectLaunch) => {
      let settled = false;
      let spawnCalled = false;
      let settleTimer: NodeJS.Timeout | undefined;
      const finishResolve = () => {
        if (settled) return;
        settled = true;
        if (settleTimer) clearTimeout(settleTimer);
        resolveLaunch();
      };
      const finishReject = (detail: string) => {
        if (settled) return;
        settled = true;
        if (settleTimer) clearTimeout(settleTimer);
        rejectLaunch(new Error(detail || 'windows_user_launch_failed'));
      };
      const wrappedSpawn: typeof spawn = ((...spawnArgs: Parameters<typeof spawn>) => {
        spawnCalled = true;
        const child = spawn(...spawnArgs);
        child.once('error', (err) => finishReject(err instanceof Error ? err.message : String(err)));
        child.once('exit', (code) => {
          if (code === 0) {
            queueMicrotask(finishResolve);
          } else {
            finishReject(`powershell exit ${code ?? 'unknown'}`);
          }
        });
        return child;
      }) as typeof spawn;

      try {
        launchWindowsActiveUserCommand(
          executable,
          argsLine,
          wrappedSpawn,
          false,
          false,
          false,
          (detail) => {
            finishReject(detail);
          },
        );
      } catch (err) {
        finishReject(err instanceof Error ? err.message : String(err));
        return;
      }

      if (!spawnCalled) {
        settleTimer = setTimeout(finishResolve, windowsLaunchSettleMs);
      } else {
        settleTimer = setTimeout(() => finishReject('windows_user_launch_timeout'), 15_000);
        settleTimer.unref?.();
      }
    });
  }

  async function verifyDaemonPidForUser(pid: number, user: ActiveDesktopUser): Promise<'match' | 'mismatch' | 'unknown'> {
    if (platform === 'linux') {
      const procDir = `${procRoot}/${pid}`;
      if (existsSync(procDir)) {
        try {
          const st = statSync(procDir);
          if (typeof user.uid === 'number' && st.uid !== user.uid) {
            return 'mismatch';
          }
          const cmdline = readFileSync(`${procDir}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
          if (!cmdline) return 'unknown';
          if (!/(?:imcodes|dist\/src\/index\.js|src\/index\.ts|daemon-runtime)/iu.test(cmdline)) {
            return 'mismatch';
          }
          return 'match';
        } catch {
          return 'unknown';
        }
      }
      return 'unknown';
    }

    if (platform === 'darwin') {
      try {
        const { stdout } = await execText('ps', ['-p', String(pid), '-o', 'uid=,command='], { timeoutMs: 2_000, env });
        const line = stdout.trim();
        if (!line) return 'unknown';
        const match = line.match(/^(\d+)\s+(.+)$/u);
        if (!match) return 'unknown';
        const procUid = Number.parseInt(match[1]!, 10);
        const cmd = match[2]!;
        if (typeof user.uid === 'number' && procUid !== user.uid) return 'mismatch';
        if (!/(?:imcodes|dist\/src\/index\.js|src\/index\.ts|daemon-runtime)/iu.test(cmd)) return 'mismatch';
        return 'match';
      } catch {
        return 'unknown';
      }
    }

    if (platform === 'win32') {
      const psScript = [
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue`,
        'if (-not $p) { exit 0 }',
        '$o = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction SilentlyContinue',
        'Write-Output (($o.User -as [string]) + "|" + ($p.CommandLine -as [string]))',
      ].join('; ');
      try {
        const { stdout } = await execText(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
          { timeoutMs: 3_000, env },
        );
        const line = stdout.trim();
        if (!line || !line.includes('|')) return 'unknown';
        const sepIdx = line.indexOf('|');
        const owner = line.slice(0, sepIdx).trim().split('\\').pop()?.toLowerCase() ?? '';
        const cmd = line.slice(sepIdx + 1).trim();
        const expectedUser = user.username.trim().split('\\').pop()?.toLowerCase() ?? '';
        if (owner && expectedUser && owner !== expectedUser) return 'mismatch';
        if (!cmd) return 'unknown';
        if (!/(?:imcodes|dist[\\/]src[\\/]index\.js|src[\\/]index\.ts|daemon-runtime)/iu.test(cmd)) return 'mismatch';
        return 'match';
      } catch {
        return 'unknown';
      }
    }

    return 'unknown';
  }

  type ResolvedDaemonProcess =
    | { state: 'not_running'; pid: null; filePid: number | null; runtimeStatus: DaemonRuntimeStatus | null }
    | { state: 'running'; pid: number; filePid: number | null; runtimeStatus: DaemonRuntimeStatus | null }
    | { state: 'mismatch'; pid: null; mismatchedFilePid: number | null; filePid: number | null; runtimeStatus: DaemonRuntimeStatus | null }
    | { state: 'unknown'; pid: number; filePid: number | null; runtimeStatus: DaemonRuntimeStatus | null };

  async function resolveDaemonProcess(stateDir: string, user: ActiveDesktopUser): Promise<ResolvedDaemonProcess> {
    const runtimeStatus = readSafeDaemonRuntimeStatus(stateDir);
    const filePid = readPidFile(stateDir);
    const runtimePid = runtimeStatus?.pid && runtimeStatus.pid > 0 ? runtimeStatus.pid : null;
    const candidates: number[] = [];
    if (filePid !== null) candidates.push(filePid);
    if (runtimePid !== null && runtimePid !== filePid) candidates.push(runtimePid);

    let sawMismatch = false;
    let mismatchedFilePid: number | null = null;
    let unknownPid: number | null = null;

    for (const pid of candidates) {
      if (!isPidAlive(pid)) continue;
      const verdict = await verifyDaemonPidForUser(pid, user);
      if (verdict === 'match') {
        return { state: 'running', pid, filePid, runtimeStatus };
      }
      if (verdict === 'mismatch') {
        sawMismatch = true;
        if (pid === filePid) mismatchedFilePid = pid;
      } else if (unknownPid === null) {
        unknownPid = pid;
      }
    }

    if (unknownPid !== null) {
      return { state: 'unknown', pid: unknownPid, filePid, runtimeStatus };
    }
    if (sawMismatch) {
      return { state: 'mismatch', pid: null, mismatchedFilePid, filePid, runtimeStatus };
    }
    return { state: 'not_running', pid: null, filePid, runtimeStatus };
  }

  async function detectAutostart(
    user: ActiveDesktopUser,
    stateDir: string,
    runtime: DiscoveredCodingDaemonRuntime | null,
  ): Promise<RemoteDesktopLocalDaemonAutostartState> {
    if (platform === 'darwin') {
      const paths = posixServicePathsForUser(user, env);
      try {
        const plistText = readSafeSmallUtf8(user.home, paths.launchAgentRelParts);
        if (plistText === null) {
          return runtime ? REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.DISABLED : REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.UNAVAILABLE;
        }
        const runAtLoad = parsePlistRunAtLoad(plistText);
        if (runAtLoad === false) return REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.DISABLED;
        if (typeof user.uid === 'number') {
          try {
            const { stdout } = await execText(
              MACOS_LAUNCHCTL_PATH,
              ['print-disabled', `gui/${user.uid}`],
              { timeoutMs: 4_000, env },
            );
            const disabledRe = new RegExp(`["']${escapeRegExp(paths.launchAgentLabel)}["']\\s*=>\\s*disabled`, 'iu');
            if (disabledRe.test(stdout)) {
              return REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.DISABLED;
            }
          } catch {
            // launchctl print-disabled unavailable outside active GUI session
          }
        }
        return REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED;
      } catch {
        return REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.UNAVAILABLE;
      }
    }

    if (platform === 'linux') {
      const paths = posixServicePathsForUser(user, env);
      const currentUid = currentUidFn();
      const userEnv = linuxUserServiceEnv(user, env, stateDir, runtime);
      try {
        const { stdout } = await execText('systemctl', ['--user', 'is-enabled', paths.systemdUnitName], {
          timeoutMs: 4_000,
          env: userEnv,
          ...(currentUid === 0 && typeof user.uid === 'number' ? { uid: user.uid, gid: user.gid ?? user.uid } : {}),
        });
        return stdout.trim() === 'enabled'
          ? REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED
          : REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.DISABLED;
      } catch (err) {
        const combined = `${(err as { stdout?: string })?.stdout ?? ''}${(err as { stderr?: string })?.stderr ?? ''}${(err as Error)?.message ?? ''}`;
        if (/disabled|masked|static|not-found|no such file/iu.test(combined)) {
          return REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.DISABLED;
        }
        return REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.UNAVAILABLE;
      }
    }

    if (platform === 'win32') {
      const startupFd = openSafeContainedReadFd(user.home, [
        'AppData',
        'Roaming',
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'Startup',
        WINDOWS_STARTUP_SCRIPT_NAME,
      ]);
      if (startupFd !== null) {
        closeSync(startupFd);
        return REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED;
      }
      try {
        await execText('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME], { timeoutMs: 4_000, env });
        return REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED;
      } catch {
        return runtime ? REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.DISABLED : REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.UNAVAILABLE;
      }
    }

    return REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.UNAVAILABLE;
  }

  async function inspectStatus(): Promise<RemoteDesktopLocalDaemonStatus> {
    const user = await resolveUser();
    const runtime = discoverCodingDaemonRuntime({
      platform,
      env,
      execPath,
      userHome: user?.home,
      bundleDirs: deps.bundleDirs,
      cliCandidates: deps.cliCandidates,
    });

    if (!user) {
      return sanitizeRemoteDesktopLocalDaemonStatus({
        available: false,
        installed: Boolean(runtime),
        bound: false,
        running: false,
        connectionState: REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.UNKNOWN,
        autostart: REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.UNAVAILABLE,
        runtimeSource: runtime?.source ?? REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.NONE,
        ...(runtime?.version ? { version: runtime.version } : {}),
        reason: REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NO_ACTIVE_USER,
        canControl: false,
        canBind: false,
        canViewLogs: false,
      })!;
    }

    const stateDir = stateDirForUser(user);
    const creds = readServerCredentials(stateDir);
    const bound = Boolean(creds);
    const resolvedProc = await resolveDaemonProcess(stateDir, user);
    const runtimeStatus = resolvedProc.runtimeStatus;
    const running = resolvedProc.state === 'running';
    const verifiedPid = resolvedProc.state === 'running' ? resolvedProc.pid : null;

    let connectionState: RemoteDesktopLocalDaemonStatus['connectionState'] =
      REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.DISCONNECTED;
    if (resolvedProc.state === 'unknown') {
      connectionState = REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.UNKNOWN;
    } else if (!running) {
      connectionState = REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.DISCONNECTED;
    } else if (runtimeStatus?.serverLink?.state) {
      connectionState = runtimeStatus.serverLink.state;
    } else {
      connectionState = REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.UNKNOWN;
    }

    const autostart = await detectAutostart(user, stateDir, runtime);
    const version = runtime?.version ?? runtimeStatus?.version;
    const logsMeta = readBoundedTailLog(stateDir);
    const installed = Boolean(runtime);
    const hasReason = !installed
      ? REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NOT_INSTALLED
      : (!bound ? REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NOT_BOUND : undefined);
    const rawLastError = resolvedProc.state === 'unknown'
      ? (runtimeStatus?.serverLink?.lastError
        ? `${runtimeStatus.serverLink.lastError} (daemon_pid_unverified)`
        : 'daemon_pid_unverified')
      : runtimeStatus?.serverLink?.lastError;

    return sanitizeRemoteDesktopLocalDaemonStatus({
      available: installed && bound,
      installed,
      bound,
      running,
      connectionState,
      autostart,
      runtimeSource: runtime?.source ?? REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.NONE,
      ...(version ? { version } : {}),
      ...(running && verifiedPid ? { pid: verifiedPid } : {}),
      ...(creds ? {
        serverId: creds.serverId,
        serverHost: creds.serverHost,
        ...(creds.serverOrigin ? { serverOrigin: creds.serverOrigin } : {}),
      } : {}),
      userName: user.username,
      ...(rawLastError ? { lastError: redactDaemonSecrets(rawLastError) } : {}),
      ...(hasReason ? { reason: hasReason } : {}),
      canControl: installed && bound ? true : running,
      canBind: installed,
      canViewLogs: installed || Boolean(logsMeta.text),
    })!;
  }

  async function stopUserDaemon(user: ActiveDesktopUser, stateDir: string): Promise<{ ok: boolean; error?: string }> {
    const currentUid = currentUidFn();
    const resolved = await resolveDaemonProcess(stateDir, user);
    const targetPid = resolved.state === 'running' ? resolved.pid : null;
    const unverifiedPid = resolved.state === 'unknown' ? resolved.pid : null;

    if (platform === 'darwin' && typeof user.uid === 'number') {
      const paths = posixServicePathsForUser(user, env);
      await execText(MACOS_LAUNCHCTL_PATH, ['bootout', `gui/${user.uid}/${paths.launchAgentLabel}`], {
        timeoutMs: 8_000,
        env,
      }).catch(() => undefined);
    } else if (platform === 'linux') {
      const paths = posixServicePathsForUser(user, env);
      const userEnv = linuxUserServiceEnv(user, env, stateDir);
      await execText('systemctl', ['--user', 'stop', paths.systemdUnitName], {
        timeoutMs: 8_000,
        env: userEnv,
        ...(currentUid === 0 && typeof user.uid === 'number' ? { uid: user.uid, gid: user.gid ?? user.uid } : {}),
      }).catch(() => undefined);
    } else if (platform === 'win32') {
      const currentName = (() => {
        try { return userInfo().username; } catch { return env.USERNAME || ''; }
      })();
      if (!isWindowsSystemProcess(env, currentName)) {
        await execText('schtasks', ['/End', '/TN', WINDOWS_TASK_NAME], { timeoutMs: 5_000, env }).catch(() => undefined);
        if (targetPid && isPidAlive(targetPid)) {
          await execText('taskkill', ['/PID', String(targetPid), '/T', '/F'], { timeoutMs: 5_000, env }).catch(() => undefined);
        }
      } else if (targetPid && isPidAlive(targetPid)) {
        await runWindowsUserLaunch('taskkill.exe', `/PID ${targetPid} /T /F`).catch(() => undefined);
      }
    }

    if (resolved.state === 'not_running') {
      if (resolved.filePid !== null && !isPidAlive(resolved.filePid)) {
        removeSafeContainedFile(stateDir, ['daemon.pid']);
      }
      return { ok: true };
    }

    if (resolved.state === 'mismatch') {
      // Never signal an unrelated live process; clear confirmed-stale daemon.pid so START/RESTART/BIND can proceed.
      if (resolved.mismatchedFilePid !== null && resolved.mismatchedFilePid === resolved.filePid) {
        removeSafeContainedFile(stateDir, ['daemon.pid']);
      }
      return { ok: true };
    }

    if (resolved.state === 'unknown') {
      // Never kill an unverified live PID; succeed only if the named service stop itself terminated it.
      if (unverifiedPid !== null && isPidAlive(unverifiedPid)) {
        return { ok: false, error: 'stop_failed' };
      }
      removeSafeContainedFile(stateDir, ['daemon.pid']);
      return { ok: true };
    }

    if (targetPid && isPidAlive(targetPid)) {
      try {
        if (platform === 'darwin') {
          if (currentUid === 0) {
            if (typeof user.uid === 'number') {
              const macUser: MacosUserSession = {
                uid: user.uid,
                gid: user.gid ?? user.uid,
                name: user.username,
                home: user.home,
                tempDir: user.tempDir || tmpdir(),
              };
              await runMacosUserSessionCommand(macUser, {
                executable: '/bin/kill',
                args: ['-TERM', String(targetPid)],
              }, 5_000, async (file, args, timeoutMs) => {
                const res = await execText(file, args, { timeoutMs, env });
                return res.stdout;
              });
            }
          } else if (typeof user.uid !== 'number' || user.uid === currentUid) {
            killProcess(targetPid, 'SIGTERM');
          }
        } else if (platform === 'linux') {
          if (currentUid === 0) {
            if (typeof user.uid === 'number') {
              const killBin = existsSync('/bin/kill') ? '/bin/kill' : 'kill';
              await execText(killBin, ['-TERM', String(targetPid)], {
                timeoutMs: 5_000,
                env: linuxUserServiceEnv(user, env, stateDir),
                uid: user.uid,
                gid: user.gid ?? user.uid,
              });
            }
          } else if (typeof user.uid !== 'number' || user.uid === currentUid) {
            killProcess(targetPid, 'SIGTERM');
          }
        }
      } catch {
        // never escalate to host root/SYSTEM when user-session kill fails
      }

      const deadline = Date.now() + stopWaitMs;
      while (Date.now() < deadline && isPidAlive(targetPid)) {
        await sleep(100);
      }
    }

    const stillAlive = targetPid !== null && isPidAlive(targetPid);
    if (!stillAlive) {
      removeSafeContainedFile(stateDir, ['daemon.pid']);
      return { ok: true };
    }
    return { ok: false, error: 'stop_failed' };
  }

  async function startUserDaemon(
    user: ActiveDesktopUser,
    stateDir: string,
    runtime: DiscoveredCodingDaemonRuntime,
  ): Promise<void> {
    const currentUid = currentUidFn();
    if (platform !== 'win32' && currentUid > 0 && typeof user.uid === 'number' && user.uid !== currentUid) {
      throw new Error('active_user_uid_mismatch');
    }

    if (platform === 'darwin') {
      if (typeof user.uid !== 'number') throw new Error('missing_macos_uid');
      const paths = posixServicePathsForUser(user, env);
      const currentAutostart = (await detectAutostart(user, stateDir, runtime)) === REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED;
      const plist = renderMacosDaemonPlist(paths.launchAgentLabel, runtime, user, stateDir, currentAutostart, env.PATH);
      writeOwnedFile(user.home, paths.launchAgentRelParts, plist, user, currentUid, 0o644, false, deps.fchown);
      ensureOwnedDir(stateDir, [], user, currentUid, 0o700, true, deps.fchown);
      const serviceTarget = `gui/${user.uid}/${paths.launchAgentLabel}`;
      await execText(MACOS_LAUNCHCTL_PATH, ['bootout', serviceTarget], {
        timeoutMs: 5_000,
        env,
      }).catch(() => undefined);
      await execText(MACOS_LAUNCHCTL_PATH, ['enable', serviceTarget], {
        timeoutMs: 5_000,
        env,
      }).catch(() => undefined);
      await execText(MACOS_LAUNCHCTL_PATH, ['bootstrap', `gui/${user.uid}`, paths.launchAgentPath], {
        timeoutMs: 8_000,
        env,
      });
      if (!currentAutostart) {
        await execText(MACOS_LAUNCHCTL_PATH, ['kickstart', '-k', serviceTarget], {
          timeoutMs: 8_000,
          env,
        });
      }
      return;
    }

    if (platform === 'linux') {
      ensureOwnedDir(stateDir, [], user, currentUid, 0o700, true, deps.fchown);
      const userEnv = linuxUserServiceEnv(user, env, stateDir, runtime);
      const runOpts = currentUid === 0 && typeof user.uid === 'number'
        ? { timeoutMs: 8_000, env: userEnv, uid: user.uid, gid: user.gid ?? user.uid }
        : { timeoutMs: 8_000, env: userEnv };

      const systemdUsable = await execText('systemctl', ['--user', 'show-environment'], runOpts)
        .then(() => true)
        .catch(() => false);

      if (systemdUsable) {
        const paths = posixServicePathsForUser(user, env);
        const unit = renderLinuxSystemdUnit(runtime, user, stateDir, userEnv.PATH);
        writeOwnedFile(user.home, paths.systemdUnitRelParts, unit, user, currentUid, 0o644, false, deps.fchown);
        await execText('systemctl', ['--user', 'daemon-reload'], runOpts);
        await execText('systemctl', ['--user', 'start', paths.systemdUnitName], runOpts);
        return;
      }

      // Container / headless / non-systemd fallback: spawn directly with target user's uid/gid, NEVER root.
      ensureOwnedDir(stateDir, ['logs'], user, currentUid, 0o700, true, deps.fchown);
      const logPath = join(stateDir, 'daemon.log');
      try {
        const lst = lstatSync(logPath);
        if (lst.isSymbolicLink() || lst.isDirectory()) throw new Error('unsafe_path');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      }
      const logFd = openSync(
        logPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        const logSt = fstatSync(logFd);
        if (!logSt.isFile()) throw new Error('unsafe_path');
        fchmodSync(logFd, 0o600);
        applyFdOwnership(logFd, user, currentUid, deps.fchown);
        spawnDetached(runtime.executable, runtime.foregroundArgs, {
          detached: true,
          cwd: user.home,
          stdio: ['ignore', logFd, logFd],
          env: userEnv,
          ...(currentUid === 0 && typeof user.uid === 'number' ? { uid: user.uid, gid: user.gid ?? user.uid } : {}),
        });
      } finally {
        closeSync(logFd);
      }
      return;
    }

    if (platform === 'win32') {
      ensureOwnedDir(stateDir, [], user, currentUid, 0o700, true, deps.fchown);
      const argsLine = runtime.foregroundArgs.map(quoteWindowsArgument).join(' ');
      const currentName = (() => {
        try { return userInfo().username; } catch { return env.USERNAME || ''; }
      })();
      if (isWindowsSystemProcess(env, currentName)) {
        await runWindowsUserLaunch(runtime.executable, argsLine);
        return;
      }
      spawnDetached(runtime.executable, runtime.foregroundArgs, {
        detached: true,
        cwd: user.home,
        windowsHide: true,
        stdio: 'ignore',
        env: { ...env, USERPROFILE: user.home, IMCODES_HOME: stateDir },
      });
      return;
    }

    throw new Error('unsupported_platform');
  }

  async function setAutostart(
    user: ActiveDesktopUser,
    stateDir: string,
    runtime: DiscoveredCodingDaemonRuntime | null,
    enabled: boolean,
  ): Promise<{ ok: boolean; statusCode: number; error?: string }> {
    const currentUid = currentUidFn();

    if (platform === 'darwin') {
      if (typeof user.uid !== 'number') return { ok: false, statusCode: 409, error: 'no_active_user' };
      const paths = posixServicePathsForUser(user, env);
      const serviceTarget = `gui/${user.uid}/${paths.launchAgentLabel}`;
      if (enabled) {
        if (!runtime) return { ok: false, statusCode: 409, error: 'not_installed' };
        const plist = renderMacosDaemonPlist(paths.launchAgentLabel, runtime, user, stateDir, true, env.PATH);
        writeOwnedFile(user.home, paths.launchAgentRelParts, plist, user, currentUid, 0o644, false, deps.fchown);
        await execText(MACOS_LAUNCHCTL_PATH, ['enable', serviceTarget], { timeoutMs: 8_000, env })
          .catch(() => undefined);
        await execText(MACOS_LAUNCHCTL_PATH, ['bootstrap', `gui/${user.uid}`, paths.launchAgentPath], { timeoutMs: 8_000, env })
          .catch(() => undefined);
      } else {
        // Clear RunAtLoad/KeepAlive without calling `launchctl disable`, keeping manual START/RESTART operable.
        if (runtime) {
          const plist = renderMacosDaemonPlist(paths.launchAgentLabel, runtime, user, stateDir, false, env.PATH);
          writeOwnedFile(user.home, paths.launchAgentRelParts, plist, user, currentUid, 0o644, false, deps.fchown);
        } else {
          const existing = readSafeSmallUtf8(user.home, paths.launchAgentRelParts);
          if (existing !== null) {
            writeOwnedFile(
              user.home,
              paths.launchAgentRelParts,
              setPlistAutostartFlags(existing, false),
              user,
              currentUid,
              0o644,
              false,
              deps.fchown,
            );
          }
        }
      }
      return { ok: true, statusCode: 200 };
    }

    if (platform === 'linux') {
      const userEnv = linuxUserServiceEnv(user, env, stateDir, runtime);
      const runOpts = currentUid === 0 && typeof user.uid === 'number'
        ? { timeoutMs: 8_000, env: userEnv, uid: user.uid, gid: user.gid ?? user.uid }
        : { timeoutMs: 8_000, env: userEnv };
      const paths = posixServicePathsForUser(user, env);
      if (enabled) {
        if (!runtime) return { ok: false, statusCode: 409, error: 'not_installed' };
        const unit = renderLinuxSystemdUnit(runtime, user, stateDir, userEnv.PATH);
        writeOwnedFile(user.home, paths.systemdUnitRelParts, unit, user, currentUid, 0o644, false, deps.fchown);
        try {
          await execText('systemctl', ['--user', 'daemon-reload'], runOpts);
          await execText('systemctl', ['--user', 'enable', paths.systemdUnitName], runOpts);
        } catch {
          return { ok: false, statusCode: 409, error: 'autostart_unavailable' };
        }
      } else {
        await execText('systemctl', ['--user', 'disable', paths.systemdUnitName], runOpts).catch(() => undefined);
      }
      return { ok: true, statusCode: 200 };
    }

    if (platform === 'win32') {
      const startupRelParts = [
        'AppData',
        'Roaming',
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'Startup',
        WINDOWS_STARTUP_SCRIPT_NAME,
      ] as const;
      if (enabled) {
        if (!runtime) return { ok: false, statusCode: 409, error: 'not_installed' };
        const cmdArgs = runtime.foregroundArgs.map(quoteWindowsArgument).join(' ');
        const cmd = `@echo off\r\nstart "" /min ${quoteWindowsArgument(runtime.executable)} ${cmdArgs}\r\n`;
        writeOwnedFile(user.home, startupRelParts, cmd, user, currentUid, 0o644, false, deps.fchown);
      } else {
        removeSafeContainedFile(user.home, startupRelParts);
        await execText('schtasks', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F'], { timeoutMs: 5_000, env }).catch(() => undefined);
      }
      return { ok: true, statusCode: 200 };
    }

    return { ok: false, statusCode: 409, error: 'autostart_unavailable' };
  }

  async function bindUserDaemon(
    user: ActiveDesktopUser,
    stateDir: string,
    runtime: DiscoveredCodingDaemonRuntime,
    payload: { bindUrl?: unknown; serverName?: unknown },
  ): Promise<LocalDaemonActionResult> {
    const validated = validateBindUrl(payload.bindUrl);
    if (!validated.ok) {
      return { ok: false, statusCode: 400, error: validated.error };
    }
    const currentUid = currentUidFn();
    const deviceName = typeof payload.serverName === 'string' && payload.serverName.trim()
      ? payload.serverName.trim().slice(0, 128)
      : hostNameFn();

    const { workerUrl, apiKey } = validated;
    const existing = readServerCredentials(stateDir);
    let serverId: string | undefined;
    let token: string | undefined;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('bind_timeout')), bindTimeoutMs);

    try {
      if (existing && existing.workerUrl === workerUrl && existing.token) {
        const verifyRes = await withAbort(
          fetchImpl(`${workerUrl}/api/bind/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serverId: existing.serverId, token: existing.token }),
            signal: ac.signal,
          }),
          ac.signal,
        ).catch((err) => {
          if (ac.signal.aborted) throw err;
          return null;
        });
        if (verifyRes?.ok) {
          const rebindRes = await withAbort(
            fetchImpl(`${workerUrl}/api/bind/rebind`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({ serverId: existing.serverId, serverName: deviceName }),
              signal: ac.signal,
            }),
            ac.signal,
          );
          if (!rebindRes.ok) {
            return { ok: false, statusCode: 502, error: 'bind_failed' };
          }
          const rebindBody = await withAbort(
            rebindRes.json() as Promise<{ token?: unknown }>,
            ac.signal,
          );
          if (typeof rebindBody.token !== 'string' || !rebindBody.token) {
            return { ok: false, statusCode: 502, error: 'bind_failed' };
          }
          serverId = existing.serverId;
          token = rebindBody.token;
        }
      }

      if (!serverId || !token) {
        const directRes = await withAbort(
          fetchImpl(`${workerUrl}/api/bind/direct`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ serverName: deviceName }),
            signal: ac.signal,
          }),
          ac.signal,
        );
        if (!directRes.ok) {
          return { ok: false, statusCode: 502, error: 'bind_failed' };
        }
        const directBody = await withAbort(
          directRes.json() as Promise<{ serverId?: unknown; token?: unknown }>,
          ac.signal,
        );
        if (typeof directBody.serverId !== 'string' || !directBody.serverId || typeof directBody.token !== 'string' || !directBody.token) {
          return { ok: false, statusCode: 502, error: 'bind_failed' };
        }
        serverId = directBody.serverId;
        token = directBody.token;
      }

      if (ac.signal.aborted) {
        return { ok: false, statusCode: 504, error: 'bind_timeout' };
      }

      const credsPayload = JSON.stringify(
        {
          serverId,
          token,
          workerUrl,
          serverName: deviceName,
          boundAt: Date.now(),
        },
        null,
        2,
      );
      writeOwnedFile(stateDir, ['server.json'], credsPayload, user, currentUid, 0o600, true, deps.fchown);
    } catch {
      if (ac.signal.aborted) {
        return { ok: false, statusCode: 504, error: 'bind_timeout' };
      }
      return { ok: false, statusCode: 502, error: 'bind_failed' };
    } finally {
      clearTimeout(timer);
    }

    const stopped = await stopUserDaemon(user, stateDir);
    if (!stopped.ok) {
      return { ok: false, statusCode: 500, error: stopped.error ?? 'stop_failed', status: await inspectStatus() };
    }
    try {
      await startUserDaemon(user, stateDir, runtime);
    } catch {
      return { ok: false, statusCode: 500, error: 'start_failed', status: await inspectStatus() };
    }
    return { ok: true, statusCode: 200, status: await inspectStatus() };
  }

  let mutex: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = mutex.then(fn, fn);
    mutex = next.catch(() => undefined);
    return next;
  }

  return {
    status: () => inspectStatus(),
    readSetupBindingInfo: async (): Promise<LocalDaemonSetupBindingInfo> => {
      const user = await resolveUser();
      if (!user) return { bound: false, workerUrl: null, serverId: null };
      const stateDir = stateDirForUser(user);
      const creds = readServerCredentials(stateDir);
      if (!creds) return { bound: false, workerUrl: null, serverId: null };
      let normalizedWorkerUrl: string | null = creds.workerUrl ?? null;
      if (normalizedWorkerUrl) {
        try {
          normalizedWorkerUrl = new URL(normalizedWorkerUrl).origin;
        } catch {
          // keep original if not parseable
        }
      }
      return {
        bound: true,
        workerUrl: normalizedWorkerUrl,
        serverId: creds.serverId || null,
      };
    },
    logs: async () => {
      const user = await resolveUser();
      if (!user) return { text: '', truncated: false };
      return readBoundedTailLog(stateDirForUser(user));
    },
    performAction: (action, payload = {}) => serialized(async (): Promise<LocalDaemonActionResult> => {
      const user = await resolveUser();
      if (!user) {
        return { ok: false, statusCode: 409, error: REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NO_ACTIVE_USER };
      }
      const stateDir = stateDirForUser(user);
      const runtime = discoverCodingDaemonRuntime({
        platform,
        env,
        execPath,
        userHome: user.home,
        bundleDirs: deps.bundleDirs,
        cliCandidates: deps.cliCandidates,
      });

      try {
        if (action === REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND) {
          if (!runtime) return { ok: false, statusCode: 409, error: REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NOT_INSTALLED };
          return await bindUserDaemon(user, stateDir, runtime, payload);
        }

        if (action === REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.ENABLE_AUTOSTART) {
          const res = await setAutostart(user, stateDir, runtime, true);
          return res.ok ? { ok: true, statusCode: 200, status: await inspectStatus() } : res;
        }

        if (action === REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.DISABLE_AUTOSTART) {
          const res = await setAutostart(user, stateDir, runtime, false);
          return res.ok ? { ok: true, statusCode: 200, status: await inspectStatus() } : res;
        }

        if (action === REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.STOP) {
          const stopped = await stopUserDaemon(user, stateDir);
          if (!stopped.ok) {
            return { ok: false, statusCode: 500, error: stopped.error ?? 'stop_failed', status: await inspectStatus() };
          }
          return { ok: true, statusCode: 200, status: await inspectStatus() };
        }

        if (action === REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START) {
          if (!runtime) return { ok: false, statusCode: 409, error: REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NOT_INSTALLED };
          if (!readServerCredentials(stateDir)) {
            return { ok: false, statusCode: 409, error: REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NOT_BOUND };
          }
          const resolved = await resolveDaemonProcess(stateDir, user);
          if (resolved.state === 'unknown') {
            return { ok: false, statusCode: 409, error: 'daemon_pid_unverified', status: await inspectStatus() };
          }
          if (resolved.state !== 'running') {
            if (resolved.state === 'mismatch' && resolved.mismatchedFilePid !== null && resolved.mismatchedFilePid === resolved.filePid) {
              removeSafeContainedFile(stateDir, ['daemon.pid']);
            } else if (resolved.state === 'not_running' && resolved.filePid !== null) {
              removeSafeContainedFile(stateDir, ['daemon.pid']);
            }
            await startUserDaemon(user, stateDir, runtime);
          }
          return { ok: true, statusCode: 200, status: await inspectStatus() };
        }

        if (action === REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.RESTART) {
          if (!runtime) return { ok: false, statusCode: 409, error: REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NOT_INSTALLED };
          if (!readServerCredentials(stateDir)) {
            return { ok: false, statusCode: 409, error: REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NOT_BOUND };
          }
          const stopped = await stopUserDaemon(user, stateDir);
          if (!stopped.ok) {
            return { ok: false, statusCode: 500, error: stopped.error ?? 'stop_failed', status: await inspectStatus() };
          }
          await startUserDaemon(user, stateDir, runtime);
          return { ok: true, statusCode: 200, status: await inspectStatus() };
        }

        return { ok: false, statusCode: 400, error: 'invalid_action' };
      } catch {
        return { ok: false, statusCode: 500, error: 'action_failed', status: await inspectStatus() };
      }
    }),
  };
}
