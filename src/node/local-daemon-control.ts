import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
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
  sanitizeRemoteDesktopLocalDaemonStatus,
  type RemoteDesktopLocalDaemonAction,
  type RemoteDesktopLocalDaemonAutostartState,
  type RemoteDesktopLocalDaemonLogs,
  type RemoteDesktopLocalDaemonRuntimeSource,
  type RemoteDesktopLocalDaemonStatus,
} from '../../shared/remote-desktop-local-management.js';
import { xmlEscapeText } from '../../shared/macos-daemon-launch.js';
import { readDaemonRuntimeStatus } from '../util/daemon-status.js';
import { imcodesStateDirForHome } from '../util/imcodes-state-dir.js';
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
}

export interface LocalDaemonController {
  status(): Promise<RemoteDesktopLocalDaemonStatus>;
  logs(): Promise<RemoteDesktopLocalDaemonLogs>;
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
    const nmPkgPath = join(dir, 'lib', 'node_modules', 'imcodes', 'package.json');
    if (existsSync(nmPkgPath)) {
      const v = readPackageVersion(nmPkgPath);
      if (v) return v;
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
      const appData = env.APPDATA || (options.userHome ? join(options.userHome, 'AppData', 'Roaming') : undefined);
      if (appData) cliCandidates.push(join(appData, 'npm', 'imcodes.cmd'));
      cliCandidates.push(join(env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'imcodes.cmd'));
    } else {
      if (platform === 'darwin') cliCandidates.push('/opt/homebrew/bin/imcodes');
      cliCandidates.push('/usr/local/bin/imcodes', '/usr/bin/imcodes');
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
      const siblingNode = join(cmdDir, 'node.exe');
      const programFilesNode = join(env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe');
      const resolvedNode = isExecutableFile(siblingNode, 'win32')
        ? siblingNode
        : (isExecutableFile(programFilesNode, 'win32') ? programFilesNode : undefined);
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
  // eslint-disable-next-line no-control-regex
  const withoutAnsi = input
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, '');
  // eslint-disable-next-line no-control-regex
  const cleanControls = withoutAnsi.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/gu, ' ');
  return cleanControls
    .replace(/(\/bind\/)[^\s"'`?#]+/giu, '$1[redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/giu, '$1[redacted]')
    .replace(/([?"&'\s,](?:token|api[_-]?key|secret)\s*[:=]\s*"?)[^\s"',&}]+/giu, '$1[redacted]')
    .replace(/^((?:token|api[_-]?key|secret)\s*[:=]\s*"?)[^\s"',&}]+/gimu, '$1[redacted]');
}

function defaultExecText(
  file: string,
  args: readonly string[],
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv; uid?: number; gid?: number },
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, [...args], {
    timeout: opts?.timeoutMs ?? 15_000,
    encoding: 'utf8',
    windowsHide: true,
    ...(opts?.env ? { env: opts.env } : {}),
    ...(typeof opts?.uid === 'number' ? { uid: opts.uid } : {}),
    ...(typeof opts?.gid === 'number' ? { gid: opts.gid } : {}),
  }).then((res) => ({ stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') }));
}

function defaultIsPidAlive(pid: number, platform: NodeJS.Platform): boolean {
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
      const statLine = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rparen = statLine.lastIndexOf(')');
      if (rparen !== -1) {
        const state = statLine.slice(rparen + 2, rparen + 3);
        if (state === 'Z') return false;
      }
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
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

function readServerCredentials(stateDir: string): StoredServerCredentials | null {
  const filePath = join(stateDir, 'server.json');
  try {
    if (!existsSync(filePath)) return null;
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as {
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
  const pidFile = join(stateDir, 'daemon.pid');
  try {
    if (!existsSync(pidFile)) return null;
    const parsed = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function ensureOwnedDir(dirPath: string, user: ActiveDesktopUser, currentUid: number, mode = 0o700): void {
  mkdirSync(dirPath, { recursive: true, mode });
  if (user.platform !== 'win32' && currentUid === 0 && typeof user.uid === 'number' && typeof user.gid === 'number') {
    try {
      chownSync(dirPath, user.uid, user.gid);
    } catch {
      // ignore if unsupported on virtual fs
    }
  }
}

function writeOwnedFile(
  filePath: string,
  content: string,
  user: ActiveDesktopUser,
  currentUid: number,
  mode: number,
): void {
  ensureOwnedDir(dirname(filePath), user, currentUid, mode === 0o600 ? 0o700 : 0o755);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, content, { encoding: 'utf8', mode });
  chmodSync(tmpPath, mode);
  if (user.platform !== 'win32' && currentUid === 0 && typeof user.uid === 'number' && typeof user.gid === 'number') {
    try {
      chownSync(tmpPath, user.uid, user.gid);
    } catch {
      // ignore
    }
  }
  renameSync(tmpPath, filePath);
}

function renderMacosDaemonPlist(
  runtime: DiscoveredCodingDaemonRuntime,
  user: ActiveDesktopUser,
  stateDir: string,
  autostart: boolean,
): string {
  const programArgs = [runtime.executable, ...runtime.foregroundArgs]
    .map((arg) => `    <string>${xmlEscapeText(arg)}</string>`)
    .join('\n');
  const logPath = join(stateDir, 'daemon.log');
  const pathEnv = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>imcodes.daemon</string>',
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

function renderLinuxSystemdUnit(
  runtime: DiscoveredCodingDaemonRuntime,
  user: ActiveDesktopUser,
  stateDir: string,
): string {
  const execStart = [runtime.executable, ...runtime.foregroundArgs].map(formatSystemdToken).join(' ');
  const logPath = join(stateDir, 'daemon.log');
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
    `Environment=HOME=${user.home}`,
    `Environment=IMCODES_HOME=${stateDir}`,
    `Environment=PATH=${join(user.home, '.local/bin')}:/usr/local/bin:/usr/bin:/bin`,
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

function posixServicePathsForUser(
  user: ActiveDesktopUser,
  env: NodeJS.ProcessEnv,
): { launchAgentLabel: string; launchAgentPath: string; systemdUnitName: string; systemdUnitPath: string; scoped: boolean } {
  const base = resolvePosixDaemonServicePaths({ ...env, HOME: user.home });
  return {
    scoped: base.scoped,
    launchAgentLabel: base.launchAgentLabel,
    launchAgentPath: join(user.home, 'Library', 'LaunchAgents', `${base.launchAgentLabel}.plist`),
    systemdUnitName: base.systemdUnitName,
    systemdUnitPath: join(user.home, '.config', 'systemd', 'user', base.systemdUnitName),
  };
}

function linuxUserServiceEnv(user: ActiveDesktopUser, baseEnv: NodeJS.ProcessEnv, stateDir: string): NodeJS.ProcessEnv {
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
  };
}

function readBoundedTailLog(stateDir: string): RemoteDesktopLocalDaemonLogs {
  const canonicalRoot = (() => {
    try {
      return existsSync(stateDir) ? realpathSync(stateDir) : resolve(stateDir);
    } catch {
      return resolve(stateDir);
    }
  })();

  const candidateFiles = [
    { path: join(stateDir, 'logs', 'daemon.log'), label: 'logs/daemon.log' },
    { path: join(stateDir, 'daemon.log'), label: 'daemon.log' },
  ];

  for (const candidate of candidateFiles) {
    try {
      const resolvedPath = resolve(candidate.path);
      if (resolvedPath !== canonicalRoot && !resolvedPath.startsWith(`${canonicalRoot}${sep}`)) continue;
      const lst = lstatSync(resolvedPath);
      if (lst.isSymbolicLink()) {
        const real = realpathSync(resolvedPath);
        if (!real.startsWith(`${canonicalRoot}${sep}`)) continue;
      } else if (!lst.isFile()) {
        continue;
      }

      const fd = openSync(resolvedPath, 'r');
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
      } finally {
        closeSync(fd);
      }
    } catch {
      // try next candidate
    }
  }

  return { text: '', truncated: false };
}

function validateBindUrl(rawUrl: unknown): { ok: true; workerUrl: string; apiKey: string } | { ok: false; error: string } {
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
  const isPidAlive = deps.isPidAlive ?? ((pid: number) => defaultIsPidAlive(pid, platform));
  const killProcess = deps.killProcess ?? ((pid: number, sig: NodeJS.Signals | number) => { process.kill(pid, sig); });
  const spawnDetached = deps.spawnDetached ?? ((file, args, opts) => {
    const child = spawn(file, [...args], opts);
    child.unref();
  });
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  async function resolveUser(): Promise<ActiveDesktopUser | null> {
    if (typeof deps.activeUser === 'function') return deps.activeUser();
    if (deps.activeUser !== undefined) return deps.activeUser;
    return resolveDefaultActiveUser(platform, env, currentUidFn(), currentGidFn(), execText);
  }

  function stateDirForUser(user: ActiveDesktopUser): string {
    return imcodesStateDirForHome(user.home, env);
  }

  async function detectAutostart(
    user: ActiveDesktopUser,
    stateDir: string,
    runtime: DiscoveredCodingDaemonRuntime | null,
  ): Promise<RemoteDesktopLocalDaemonAutostartState> {
    if (platform === 'darwin') {
      const paths = posixServicePathsForUser(user, env);
      if (paths.scoped) return REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.UNAVAILABLE;
      try {
        if (!existsSync(paths.launchAgentPath)) {
          return runtime ? REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.DISABLED : REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.UNAVAILABLE;
        }
        const plistText = readFileSync(paths.launchAgentPath, 'utf8');
        const runAtLoad = parsePlistRunAtLoad(plistText);
        if (runAtLoad === false) return REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.DISABLED;
        if (typeof user.uid === 'number') {
          try {
            const { stdout } = await execText(
              MACOS_LAUNCHCTL_PATH,
              ['print-disabled', `gui/${user.uid}`],
              { timeoutMs: 4_000, env },
            );
            if (/["']imcodes\.daemon["']\s*=>\s*disabled/iu.test(stdout)) {
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
      if (paths.scoped) return REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.UNAVAILABLE;
      const currentUid = currentUidFn();
      const userEnv = linuxUserServiceEnv(user, env, stateDir);
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
      const startupFile = join(
        user.home,
        'AppData',
        'Roaming',
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'Startup',
        WINDOWS_STARTUP_SCRIPT_NAME,
      );
      if (existsSync(startupFile)) return REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED;
      try {
        await execText('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME], { timeoutMs: 4_000, env });
        return REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED;
      } catch (err) {
        const msg = `${(err as { stderr?: string })?.stderr ?? ''}${(err as Error)?.message ?? ''}`;
        if (/cannot find|does not exist|not found/iu.test(msg)) {
          return runtime ? REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.DISABLED : REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.UNAVAILABLE;
        }
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
    const runtimeStatus = readDaemonRuntimeStatus(stateDir);
    const filePid = readPidFile(stateDir);
    const candidatePid = filePid ?? (runtimeStatus?.pid && runtimeStatus.pid > 0 ? runtimeStatus.pid : null);
    const running = candidatePid !== null && isPidAlive(candidatePid);

    let connectionState: RemoteDesktopLocalDaemonStatus['connectionState'] =
      REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.DISCONNECTED;
    if (!running) {
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

    return sanitizeRemoteDesktopLocalDaemonStatus({
      available: installed && bound,
      installed,
      bound,
      running,
      connectionState,
      autostart,
      runtimeSource: runtime?.source ?? REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.NONE,
      ...(version ? { version } : {}),
      ...(running && candidatePid ? { pid: candidatePid } : {}),
      ...(creds ? {
        serverId: creds.serverId,
        serverHost: creds.serverHost,
        ...(creds.serverOrigin ? { serverOrigin: creds.serverOrigin } : {}),
      } : {}),
      userName: user.username,
      ...(runtimeStatus?.serverLink?.lastError ? { lastError: redactDaemonSecrets(runtimeStatus.serverLink.lastError) } : {}),
      ...(hasReason ? { reason: hasReason } : {}),
      canControl: installed && bound ? true : running,
      canBind: installed,
      canViewLogs: installed || Boolean(logsMeta.text),
    })!;
  }

  async function stopUserDaemon(user: ActiveDesktopUser, stateDir: string): Promise<void> {
    const currentUid = currentUidFn();
    const pid = readPidFile(stateDir) ?? readDaemonRuntimeStatus(stateDir)?.pid ?? null;

    if (platform === 'darwin' && typeof user.uid === 'number') {
      await execText(MACOS_LAUNCHCTL_PATH, ['bootout', `gui/${user.uid}/imcodes.daemon`], {
        timeoutMs: 8_000,
        env,
      }).catch(() => undefined);
    } else if (platform === 'linux') {
      const userEnv = linuxUserServiceEnv(user, env, stateDir);
      await execText('systemctl', ['--user', 'stop', 'imcodes.service'], {
        timeoutMs: 8_000,
        env: userEnv,
        ...(currentUid === 0 && typeof user.uid === 'number' ? { uid: user.uid, gid: user.gid ?? user.uid } : {}),
      }).catch(() => undefined);
    } else if (platform === 'win32') {
      await execText('schtasks', ['/End', '/TN', WINDOWS_TASK_NAME], { timeoutMs: 5_000, env }).catch(() => undefined);
      if (pid && isPidAlive(pid)) {
        await execText('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 5_000, env }).catch(() => undefined);
      }
    }

    if (pid && isPidAlive(pid)) {
      try {
        if (platform === 'darwin' && currentUid === 0 && typeof user.uid === 'number') {
          const macUser: MacosUserSession = {
            uid: user.uid,
            gid: user.gid ?? user.uid,
            name: user.username,
            home: user.home,
            tempDir: user.tempDir || tmpdir(),
          };
          await runMacosUserSessionCommand(macUser, {
            executable: '/bin/kill',
            args: ['-TERM', String(pid)],
          }, 5_000, async (file, args, timeoutMs) => {
            const res = await execText(file, args, { timeoutMs, env });
            return res.stdout;
          }).catch(() => killProcess(pid, 'SIGTERM'));
        } else {
          killProcess(pid, 'SIGTERM');
        }
      } catch {
        // process may already have exited
      }

      const deadline = Date.now() + DEFAULT_STOP_WAIT_MS;
      while (Date.now() < deadline && isPidAlive(pid)) {
        await sleep(100);
      }
    }

    if (!pid || !isPidAlive(pid)) {
      rmSync(join(stateDir, 'daemon.pid'), { force: true });
    }
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
      const plist = renderMacosDaemonPlist(runtime, user, stateDir, currentAutostart);
      writeOwnedFile(paths.launchAgentPath, plist, user, currentUid, 0o644);
      ensureOwnedDir(stateDir, user, currentUid, 0o700);
      await execText(MACOS_LAUNCHCTL_PATH, ['bootout', `gui/${user.uid}/imcodes.daemon`], {
        timeoutMs: 5_000,
        env,
      }).catch(() => undefined);
      await execText(MACOS_LAUNCHCTL_PATH, ['bootstrap', `gui/${user.uid}`, paths.launchAgentPath], {
        timeoutMs: 8_000,
        env,
      });
      if (!currentAutostart) {
        await execText(MACOS_LAUNCHCTL_PATH, ['kickstart', '-k', `gui/${user.uid}/imcodes.daemon`], {
          timeoutMs: 8_000,
          env,
        });
      }
      return;
    }

    if (platform === 'linux') {
      ensureOwnedDir(stateDir, user, currentUid, 0o700);
      const userEnv = linuxUserServiceEnv(user, env, stateDir);
      const runOpts = currentUid === 0 && typeof user.uid === 'number'
        ? { timeoutMs: 8_000, env: userEnv, uid: user.uid, gid: user.gid ?? user.uid }
        : { timeoutMs: 8_000, env: userEnv };

      const systemdUsable = await execText('systemctl', ['--user', 'show-environment'], runOpts)
        .then(() => true)
        .catch(() => false);

      if (systemdUsable) {
        const paths = posixServicePathsForUser(user, env);
        const unit = renderLinuxSystemdUnit(runtime, user, stateDir);
        writeOwnedFile(paths.systemdUnitPath, unit, user, currentUid, 0o644);
        await execText('systemctl', ['--user', 'daemon-reload'], runOpts);
        await execText('systemctl', ['--user', 'start', 'imcodes.service'], runOpts);
        return;
      }

      // Container / headless / non-systemd fallback: spawn directly with target user's uid/gid, NEVER root.
      const logsDir = join(stateDir, 'logs');
      ensureOwnedDir(logsDir, user, currentUid, 0o700);
      const logPath = join(stateDir, 'daemon.log');
      const logFd = openSync(logPath, 'a', 0o600);
      if (currentUid === 0 && typeof user.uid === 'number' && typeof user.gid === 'number') {
        try { chownSync(logPath, user.uid, user.gid); } catch { /* ignore */ }
      }
      try {
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
      ensureOwnedDir(stateDir, user, currentUid, 0o700);
      const argsLine = runtime.foregroundArgs.map(quoteWindowsArgument).join(' ');
      const currentName = (() => {
        try { return userInfo().username; } catch { return env.USERNAME || ''; }
      })();
      if (isWindowsSystemProcess(env, currentName)) {
        await new Promise<void>((resolveLaunch, rejectLaunch) => {
          let failed = false;
          launchWindowsActiveUserCommand(
            runtime.executable,
            argsLine,
            undefined,
            false,
            false,
            false,
            (detail) => {
              failed = true;
              rejectLaunch(new Error(detail));
            },
          );
          if (!failed) resolveLaunch();
        });
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
      if (enabled) {
        if (!runtime) return { ok: false, statusCode: 409, error: 'not_installed' };
        const plist = renderMacosDaemonPlist(runtime, user, stateDir, true);
        writeOwnedFile(paths.launchAgentPath, plist, user, currentUid, 0o644);
        await execText(MACOS_LAUNCHCTL_PATH, ['enable', `gui/${user.uid}/imcodes.daemon`], { timeoutMs: 8_000, env })
          .catch(() => undefined);
        await execText(MACOS_LAUNCHCTL_PATH, ['bootstrap', `gui/${user.uid}`, paths.launchAgentPath], { timeoutMs: 8_000, env })
          .catch(() => undefined);
      } else {
        await execText(MACOS_LAUNCHCTL_PATH, ['disable', `gui/${user.uid}/imcodes.daemon`], { timeoutMs: 8_000, env })
          .catch(() => undefined);
        if (runtime) {
          const plist = renderMacosDaemonPlist(runtime, user, stateDir, false);
          writeOwnedFile(paths.launchAgentPath, plist, user, currentUid, 0o644);
        }
      }
      return { ok: true, statusCode: 200 };
    }

    if (platform === 'linux') {
      const userEnv = linuxUserServiceEnv(user, env, stateDir);
      const runOpts = currentUid === 0 && typeof user.uid === 'number'
        ? { timeoutMs: 8_000, env: userEnv, uid: user.uid, gid: user.gid ?? user.uid }
        : { timeoutMs: 8_000, env: userEnv };
      const paths = posixServicePathsForUser(user, env);
      if (enabled) {
        if (!runtime) return { ok: false, statusCode: 409, error: 'not_installed' };
        const unit = renderLinuxSystemdUnit(runtime, user, stateDir);
        writeOwnedFile(paths.systemdUnitPath, unit, user, currentUid, 0o644);
        try {
          await execText('systemctl', ['--user', 'daemon-reload'], runOpts);
          await execText('systemctl', ['--user', 'enable', 'imcodes.service'], runOpts);
        } catch {
          return { ok: false, statusCode: 409, error: 'autostart_unavailable' };
        }
      } else {
        await execText('systemctl', ['--user', 'disable', 'imcodes.service'], runOpts).catch(() => undefined);
      }
      return { ok: true, statusCode: 200 };
    }

    if (platform === 'win32') {
      const startupDir = join(user.home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
      const startupFile = join(startupDir, WINDOWS_STARTUP_SCRIPT_NAME);
      if (enabled) {
        if (!runtime) return { ok: false, statusCode: 409, error: 'not_installed' };
        const cmdArgs = runtime.foregroundArgs.map(quoteWindowsArgument).join(' ');
        const cmd = `@echo off\r\nstart "" /min ${quoteWindowsArgument(runtime.executable)} ${cmdArgs}\r\n`;
        writeOwnedFile(startupFile, cmd, user, currentUid, 0o644);
      } else {
        rmSync(startupFile, { force: true });
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

    if (existing && existing.workerUrl === workerUrl && existing.token) {
      const verifyRes = await fetchImpl(`${workerUrl}/api/bind/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: existing.serverId, token: existing.token }),
      }).catch(() => null);
      if (verifyRes?.ok) {
        const rebindRes = await fetchImpl(`${workerUrl}/api/bind/rebind`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ serverId: existing.serverId, serverName: deviceName }),
        });
        if (!rebindRes.ok) {
          return { ok: false, statusCode: 502, error: 'bind_failed' };
        }
        const rebindBody = await rebindRes.json() as { token?: unknown };
        if (typeof rebindBody.token !== 'string' || !rebindBody.token) {
          return { ok: false, statusCode: 502, error: 'bind_failed' };
        }
        serverId = existing.serverId;
        token = rebindBody.token;
      }
    }

    if (!serverId || !token) {
      const directRes = await fetchImpl(`${workerUrl}/api/bind/direct`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ serverName: deviceName }),
      });
      if (!directRes.ok) {
        return { ok: false, statusCode: 502, error: 'bind_failed' };
      }
      const directBody = await directRes.json() as { serverId?: unknown; token?: unknown };
      if (typeof directBody.serverId !== 'string' || !directBody.serverId || typeof directBody.token !== 'string' || !directBody.token) {
        return { ok: false, statusCode: 502, error: 'bind_failed' };
      }
      serverId = directBody.serverId;
      token = directBody.token;
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
    writeOwnedFile(join(stateDir, 'server.json'), credsPayload, user, currentUid, 0o600);

    await stopUserDaemon(user, stateDir).catch(() => undefined);
    await startUserDaemon(user, stateDir, runtime);
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

      if (action === REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND) {
        if (!runtime) return { ok: false, statusCode: 409, error: REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NOT_INSTALLED };
        return bindUserDaemon(user, stateDir, runtime, payload);
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
        await stopUserDaemon(user, stateDir);
        return { ok: true, statusCode: 200, status: await inspectStatus() };
      }

      if (action === REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START) {
        if (!runtime) return { ok: false, statusCode: 409, error: REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NOT_INSTALLED };
        if (!readServerCredentials(stateDir)) {
          return { ok: false, statusCode: 409, error: REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NOT_BOUND };
        }
        const pid = readPidFile(stateDir) ?? readDaemonRuntimeStatus(stateDir)?.pid ?? null;
        if (!pid || !isPidAlive(pid)) {
          await startUserDaemon(user, stateDir, runtime);
        }
        return { ok: true, statusCode: 200, status: await inspectStatus() };
      }

      if (action === REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.RESTART) {
        if (!runtime) return { ok: false, statusCode: 409, error: REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NOT_INSTALLED };
        if (!readServerCredentials(stateDir)) {
          return { ok: false, statusCode: 409, error: REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NOT_BOUND };
        }
        await stopUserDaemon(user, stateDir);
        await startUserDaemon(user, stateDir, runtime);
        return { ok: true, statusCode: 200, status: await inspectStatus() };
      }

      return { ok: false, statusCode: 400, error: 'invalid_action' };
    }),
  };
}
