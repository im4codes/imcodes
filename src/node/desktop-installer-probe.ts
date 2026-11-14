import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  assertSafeIsolatedTargetPath,
  DEFAULT_INSTALLER_TEMP_MAX_AGE_MS,
  DESKTOP_INSTALLER_DEFAULT_PATHS,
  DESKTOP_INSTALLER_SNAPSHOT_SCHEMA_VERSION,
  isSafeExpiredTempArtifactName,
  planDesktopInstallerCompatibility,
  type DesktopCompatibilityPlanOptions,
  type DesktopInstallPlan,
  type DesktopInstallProbeResult,
  type DesktopInstallerPlatform,
  type DesktopInstallerPreservedChecksum,
  type DesktopInstallerRollbackSnapshot,
  type DesktopInstallerSnapshotEntry,
} from '../../shared/desktop-installer-compatibility.js';

export interface ProbeDesktopInstallOptions {
  platform?: DesktopInstallerPlatform;
  isolatedRoot?: string;
  homeDir?: string;
  userStateDir?: string;
  controlledNodeRoot?: string;
  controlledNodeServicePath?: string;
  daemonRuntimeRoot?: string;
  cliPath?: string;
  desktopEntryPath?: string;
  autostartPath?: string;
  /** Optional explicit override for Windows scheduled task / autostart command detection. */
  windowsAutostartCommand?: string;
  /** Optional version threshold to treat older npm installs as legacy. */
  minimumRuntimeVersion?: string;
  /** Temp directories to scan for stale `.tmp` artifacts. */
  tempScanRoots?: readonly string[];
  tempMaxAgeMs?: number;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
}

function safeStat(targetPath: string) {
  try {
    return statSync(targetPath);
  } catch {
    return null;
  }
}

function safeLstat(targetPath: string) {
  try {
    return lstatSync(targetPath);
  } catch {
    return null;
  }
}

function safeReadJson(targetPath: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(targetPath, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function safeRealpath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    return resolve(targetPath);
  }
}

/**
 * Resolve the canonical path even if intermediate or leaf segments do not yet exist,
 * resolving symlinks on the nearest existing ancestor so symlink escapes cannot bypass guards.
 */
export function resolveCanonicalTargetPath(targetPath: string, depth = 0): string {
  if (depth > 32) {
    throw new Error(`canonical_path_symlink_loop: ${targetPath}`);
  }
  let cur = resolve(targetPath);
  const missingTail: string[] = [];
  while (!safeLstat(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    missingTail.unshift(basename(cur));
    cur = parent;
  }
  let canonicalAncestor: string;
  try {
    canonicalAncestor = realpathSync(cur);
  } catch {
    const lst = safeLstat(cur);
    if (lst?.isSymbolicLink()) {
      const linkTarget = readlinkSync(cur);
      const nextPath = resolve(dirname(cur), linkTarget);
      canonicalAncestor = resolveCanonicalTargetPath(nextPath, depth + 1);
    } else {
      canonicalAncestor = resolve(cur);
    }
  }
  return missingTail.length > 0 ? join(canonicalAncestor, ...missingTail) : canonicalAncestor;
}

export function assertSafeNodeIsolatedTargetPath(
  targetPath: string,
  platform: DesktopInstallerPlatform,
  realHomeDir?: string,
  isolatedRoot?: string,
  mode: 'container' | 'entry' = 'container',
): void {
  const lexical = resolve(targetPath);
  const canonical =
    mode === 'entry'
      ? join(resolveCanonicalTargetPath(dirname(lexical)), basename(lexical))
      : resolveCanonicalTargetPath(targetPath);
  const resolvedIso = isolatedRoot ? resolve(isolatedRoot) : undefined;
  const canonicalIso = isolatedRoot ? resolveCanonicalTargetPath(isolatedRoot) : undefined;
  const canonicalHome = realHomeDir ? resolveCanonicalTargetPath(realHomeDir) : undefined;
  assertSafeIsolatedTargetPath(lexical, platform, realHomeDir, resolvedIso);
  assertSafeIsolatedTargetPath(canonical, platform, canonicalHome, canonicalIso);
}

function sha256FileSync(targetPath: string): { sha256: string; size: number } {
  const buf = readFileSync(targetPath);
  return {
    sha256: createHash('sha256').update(buf).digest('hex'),
    size: buf.length,
  };
}

function looksLikeFilesystemPath(value: string): boolean {
  if (!value || value.startsWith('-')) return false;
  return (
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    /^[A-Za-z]:[/\\]/u.test(value) ||
    value.startsWith('\\\\')
  );
}

/** Return true when `targetPath` (or its resolved symlink target) resides inside a git checkout. */
export function isPathInsideGitCheckout(targetPath: string): boolean {
  if (!targetPath || !looksLikeFilesystemPath(targetPath)) return false;
  let dir = safeRealpath(targetPath);
  const st = safeStat(dir);
  if (!st || !st.isDirectory()) dir = dirname(dir);
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, '.git'))) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/** Parse `<key>ProgramArguments</key><array><string>...</string></array>` from a LaunchAgent plist. */
export function parseLaunchAgentProgramArgs(plistXml: string): string[] {
  const blockMatch = plistXml.match(
    /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/iu,
  );
  if (!blockMatch) return [];
  const args: string[] = [];
  for (const m of blockMatch[1].matchAll(/<string>([\s\S]*?)<\/string>/giu)) {
    const val = m[1]
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .trim();
    if (val) args.push(val);
  }
  return args;
}

/** Parse the first token / executable path from a systemd `ExecStart=` line. */
export function parseSystemdExecStart(unitText: string): string[] {
  const match = unitText.match(/^\s*ExecStart\s*=\s*(.+)$/mu);
  if (!match) return [];
  const raw = match[1].trim();
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let escaped = false;
  for (const ch of raw) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/u.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function compareSimpleVersions(a: string, b: string): number {
  const pa = a.replace(/^v/u, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/u, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function findPackageVersionNearPath(entryPath: string): string | undefined {
  let dir = safeRealpath(entryPath);
  const st = safeStat(dir);
  if (!st || !st.isDirectory()) dir = dirname(dir);
  for (let i = 0; i < 6; i += 1) {
    const pkgPath = join(dir, 'package.json');
    const pkg = safeReadJson(pkgPath);
    if (pkg && pkg.name === 'imcodes' && typeof pkg.version === 'string') {
      return pkg.version.trim();
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function collectSqliteFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 2 || !existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSqliteFiles(full, depth + 1, out);
    } else if (entry.isFile() && /\.(?:sqlite|sqlite3|db)$/iu.test(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

function extractCliToken(commandOrPath: string): string {
  const trimmed = commandOrPath.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end > 1 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  const space = trimmed.search(/\s/u);
  return space > 0 ? trimmed.slice(0, space) : trimmed;
}

function findImcodesOnPath(env: NodeJS.ProcessEnv, platform: DesktopInstallerPlatform): string | undefined {
  const pathEnv = env.PATH ?? env.Path ?? '';
  const sep = platform === 'win32' ? ';' : ':';
  const names = platform === 'win32' ? ['imcodes.cmd', 'imcodes.exe', 'imcodes.bat'] : ['imcodes'];
  for (const dir of pathEnv.split(sep)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of names) {
      const candidate = join(trimmed, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function hasExecutableRuntimeAt(dir: string, platform: DesktopInstallerPlatform): boolean {
  const nodeBin = join(dir, platform === 'win32' ? 'node.exe' : join('bin', 'node'));
  const entry = join(dir, 'package', 'dist', 'src', 'index.js');
  return existsSync(nodeBin) && existsSync(entry);
}

/**
 * Strictly read-only Phase A environment probe. Never creates, modifies, or deletes files.
 */
export function probeDesktopInstallEnvironment(
  options: ProbeDesktopInstallOptions = {},
): DesktopInstallProbeResult {
  const platform: DesktopInstallerPlatform =
    options.platform ??
    (process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux');
  const defaults = DESKTOP_INSTALLER_DEFAULT_PATHS[platform];
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  const tempMaxAgeMs = options.tempMaxAgeMs ?? DEFAULT_INSTALLER_TEMP_MAX_AGE_MS;
  const isolatedBase = options.isolatedRoot ? resolve(options.isolatedRoot) : undefined;

  const homeDir = resolve(
    options.homeDir ?? (isolatedBase ? join(isolatedBase, 'home') : env.HOME ?? env.USERPROFILE ?? homedir()),
  );
  const userStateDir = resolve(options.userStateDir ?? join(homeDir, '.imcodes'));
  const controlledNodeRoot = resolve(
    options.controlledNodeRoot ?? (isolatedBase ? join(isolatedBase, 'controlled-node') : defaults.controlledNodeRoot),
  );
  const daemonRuntimeRoot = resolve(
    options.daemonRuntimeRoot ?? (isolatedBase ? join(isolatedBase, 'daemon-runtime') : defaults.daemonRuntimeRoot),
  );

  // 1. Controlled node state (read-only)
  const credentialPath = join(controlledNodeRoot, 'credential.json');
  const installIdentityPath = join(controlledNodeRoot, 'install-identity.json');
  const hasCredentialJson = existsSync(credentialPath);
  const credentialObj = hasCredentialJson ? safeReadJson(credentialPath) : null;
  const hasValidCredential = Boolean(
    credentialObj &&
      typeof credentialObj.nodeId === 'string' &&
      credentialObj.nodeId.trim() &&
      typeof credentialObj.token === 'string' &&
      credentialObj.token.trim(),
  );
  const hasInstallIdentity = existsSync(installIdentityPath);
  const isolatedNodeRootOverride =
    Boolean(isolatedBase) ||
    (options.controlledNodeRoot !== undefined &&
      controlledNodeRoot !== resolve(defaults.controlledNodeRoot));
  const controlledNodeServicePath =
    options.controlledNodeServicePath ??
    (isolatedNodeRootOverride
      ? join(
          controlledNodeRoot,
          platform === 'linux'
            ? 'imcodes-node.service'
            : platform === 'darwin'
              ? 'cc.imcodes.node.plist'
              : 'service-registered.json',
        )
      : platform === 'linux'
        ? '/etc/systemd/system/imcodes-node.service'
        : platform === 'darwin'
          ? '/Library/LaunchDaemons/cc.imcodes.node.plist'
          : join(controlledNodeRoot, 'service-registered.json'));
  const serviceRegistered = existsSync(controlledNodeServicePath);
  const hasRemoteDesktopWorker = existsSync(join(controlledNodeRoot, 'remote-desktop-worker'));
  const hasComputerUseHelper = existsSync(join(controlledNodeRoot, 'computer-use-helper'));

  // 2. CLI probe (read-only)
  const defaultCliPath = isolatedBase
    ? join(isolatedBase, 'bin', platform === 'win32' ? 'imcodes.cmd' : 'imcodes')
    : platform === 'win32'
      ? join(homeDir, 'AppData', 'Local', 'imcodes', 'bin', 'imcodes.cmd')
      : defaults.cliWrapperPath;
  const resolvedCliCandidate =
    options.cliPath ??
    (isolatedBase
      ? defaultCliPath
      : (existsSync(defaultCliPath) ? defaultCliPath : findImcodesOnPath(env, platform)) ??
        defaultCliPath);
  const cliLstat = safeLstat(resolvedCliCandidate);
  const cliExists = cliLstat !== null;
  const cliIsSymlink = Boolean(cliLstat?.isSymbolicLink());
  const cliResolvedPath = cliExists ? safeRealpath(resolvedCliCandidate) : undefined;
  let cliIsThinWrapper = false;
  let cliIsDevCheckout = false;
  if (cliExists) {
    if (cliResolvedPath && isPathInsideGitCheckout(cliResolvedPath)) {
      cliIsDevCheckout = true;
    }
    try {
      const content = readFileSync(resolvedCliCandidate, 'utf8');
      if (content.includes('IMCODES_DAEMON_RUNTIME_DIR') || content.includes('daemon-runtime')) {
        cliIsThinWrapper = true;
      }
      if (!cliIsDevCheckout) {
        const refMatch = content.match(/([/\\][^\s"']+dist[/\\]src[/\\]index\.js)/u);
        if (refMatch && isPathInsideGitCheckout(refMatch[1])) {
          cliIsDevCheckout = true;
        }
      }
    } catch {
      // binary or unreadable
    }
  }

  // 3. User Coding Daemon state (read-only)
  const serverJsonPath = join(userStateDir, 'server.json');
  const hasServerJson = existsSync(serverJsonPath);
  const serverObj = hasServerJson ? safeReadJson(serverJsonPath) : null;
  const hasValidServerJson = Boolean(
    serverObj &&
      typeof serverObj.serverId === 'string' &&
      serverObj.serverId.trim() &&
      typeof serverObj.workerUrl === 'string' &&
      serverObj.workerUrl.trim() &&
      typeof serverObj.token === 'string' &&
      serverObj.token.trim(),
  );
  const sqliteFiles = collectSqliteFiles(userStateDir);
  const lockPath = join(userStateDir, 'daemon.lock.json');
  const hasDaemonLock = existsSync(lockPath);
  const lockObj = hasDaemonLock ? safeReadJson(lockPath) : null;
  const daemonLockPid = typeof lockObj?.pid === 'number' ? lockObj.pid : undefined;

  const autostartPath =
    options.autostartPath ??
    (platform === 'darwin'
      ? join(homeDir, 'Library', 'LaunchAgents', 'imcodes.daemon.plist')
      : platform === 'linux'
        ? join(homeDir, '.config', 'systemd', 'user', 'imcodes.service')
        : join(
            homeDir,
            'AppData',
            'Roaming',
            'Microsoft',
            'Windows',
            'Start Menu',
            'Programs',
            'Startup',
            'imcodes-daemon.cmd',
          ));
  const autostartExists = existsSync(autostartPath);
  let hasAutostart = autostartExists || Boolean(options.windowsAutostartCommand);
  let launchAgentProgramArg0: string | undefined;
  let launchAgentPointsToBundledRuntime = false;
  let autostartTarget: string | undefined;
  let servicePointsToDevCheckout = false;
  let isLegacyOrBrokenNpm = false;
  let legacyReason: string | undefined;
  let installedVersion: string | undefined;

  if (autostartExists) {
    try {
      const text = readFileSync(autostartPath, 'utf8');
      if (platform === 'darwin') {
        const args = parseLaunchAgentProgramArgs(text);
        if (args.length > 0) {
          launchAgentProgramArg0 = args[0];
          const normArg0 = args[0].replace(/\\/gu, '/');
          const normBundle = daemonRuntimeRoot.replace(/\\/gu, '/');
          launchAgentPointsToBundledRuntime =
            normArg0.startsWith('/Library/Application Support/imcodes/daemon-runtime') ||
            normArg0.startsWith(normBundle);
          autostartTarget = args[1] ?? args[0];
          if (args.some((arg) => isPathInsideGitCheckout(arg))) {
            servicePointsToDevCheckout = true;
          }
          if (!existsSync(args[0])) {
            isLegacyOrBrokenNpm = true;
            legacyReason = 'launch_agent_program_missing';
          }
        }
      } else if (platform === 'linux') {
        const tokens = parseSystemdExecStart(text);
        if (tokens.length > 0) {
          autostartTarget = tokens[1] && tokens[1].endsWith('.js') ? tokens[1] : tokens[0];
          if (tokens.some((tok) => isPathInsideGitCheckout(tok))) {
            servicePointsToDevCheckout = true;
          }
          const normExec = tokens[0].replace(/\\/gu, '/');
          const pointsBundled =
            normExec.startsWith('/opt/imcodes/daemon-runtime') ||
            normExec.startsWith(daemonRuntimeRoot.replace(/\\/gu, '/'));
          if (!pointsBundled && !existsSync(tokens[0])) {
            isLegacyOrBrokenNpm = true;
            legacyReason = 'systemd_execstart_missing';
          } else if (!pointsBundled && !servicePointsToDevCheckout && autostartTarget) {
            installedVersion = findPackageVersionNearPath(autostartTarget);
            if (!existsSync(autostartTarget)) {
              isLegacyOrBrokenNpm = true;
              legacyReason = 'systemd_npm_entry_missing';
            }
          }
        }
      } else {
        autostartTarget = text.trim();
      }
    } catch {
      isLegacyOrBrokenNpm = true;
      legacyReason = 'autostart_unreadable';
    }
  } else if (options.windowsAutostartCommand) {
    autostartTarget = options.windowsAutostartCommand;
    hasAutostart = true;
  }

  if (platform === 'win32' && autostartTarget) {
    const targetToken = extractCliToken(autostartTarget);
    if (targetToken && isPathInsideGitCheckout(targetToken)) {
      servicePointsToDevCheckout = true;
    }
    const lowerTarget = autostartTarget.toLowerCase();
    const isBundled =
      lowerTarget.includes('daemon-runtime\\current') ||
      lowerTarget.includes(daemonRuntimeRoot.toLowerCase());
    if (!isBundled && !servicePointsToDevCheckout) {
      if (lowerTarget.includes('-2147020576') || lowerTarget.includes('broken')) {
        isLegacyOrBrokenNpm = true;
        legacyReason = 'windows_legacy_broken_exit_signature';
      } else if (targetToken && (targetToken.includes(':\\') || targetToken.startsWith('/')) && !existsSync(targetToken)) {
        isLegacyOrBrokenNpm = true;
        legacyReason = 'windows_autostart_target_missing';
      } else if (targetToken && existsSync(targetToken)) {
        installedVersion = findPackageVersionNearPath(targetToken);
      }
    }
  }

  // Check upgrade error signature or stale npm version against minimumRuntimeVersion
  const upgradeErrorMarker = join(userStateDir, 'last-upgrade-error.json');
  if (!servicePointsToDevCheckout && existsSync(upgradeErrorMarker)) {
    const errInfo = safeReadJson(upgradeErrorMarker);
    const code = errInfo?.exitCode ?? errInfo?.code;
    if (code === -2147020576 || String(errInfo?.message ?? '').includes('-2147020576')) {
      isLegacyOrBrokenNpm = true;
      legacyReason = 'legacy_npm_upgrade_exit_-2147020576';
    }
  }

  if (!installedVersion && cliResolvedPath && !cliIsThinWrapper && !cliIsDevCheckout) {
    installedVersion = findPackageVersionNearPath(cliResolvedPath);
  }
  if (
    !isLegacyOrBrokenNpm &&
    !servicePointsToDevCheckout &&
    !cliIsDevCheckout &&
    installedVersion &&
    options.minimumRuntimeVersion &&
    compareSimpleVersions(installedVersion, options.minimumRuntimeVersion) < 0
  ) {
    isLegacyOrBrokenNpm = true;
    legacyReason = `stale_npm_version_${installedVersion}`;
  }

  // 4. Bundled runtime & desktop entry probe
  const daemonRuntimeCurrentExists = hasExecutableRuntimeAt(join(daemonRuntimeRoot, 'current'), platform);
  const daemonRuntimeExists = daemonRuntimeCurrentExists || hasExecutableRuntimeAt(daemonRuntimeRoot, platform);
  const defaultDesktopEntryPath =
    options.desktopEntryPath ??
    (platform === 'linux'
      ? join(homeDir, '.local', 'share', 'applications', 'aidesk.desktop')
      : platform === 'darwin'
        ? isolatedNodeRootOverride
          ? join(controlledNodeRoot, 'aiDesk.to by IM.codes.app')
          : '/Applications/aiDesk.to by IM.codes.app'
        : join(
            homeDir,
            'AppData',
            'Roaming',
            'Microsoft',
            'Windows',
            'Start Menu',
            'Programs',
            'aiDesk.to by IM.codes.lnk',
          ));
  const desktopEntryExists = existsSync(defaultDesktopEntryPath);

  // 5. Stale `.tmp` artifacts scan (read-only)
  const scannedRoots = (options.tempScanRoots ?? [userStateDir, controlledNodeRoot, daemonRuntimeRoot]).map((r) =>
    resolve(r),
  );
  const expiredPaths: string[] = [];
  const activePaths: string[] = [];
  for (const root of scannedRoots) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!isSafeExpiredTempArtifactName(entry.name)) continue;
      const full = join(root, entry.name);
      const st = safeLstat(full);
      if (!st) continue;
      if (nowMs - st.mtimeMs >= tempMaxAgeMs) {
        expiredPaths.push(full);
      } else {
        activePaths.push(full);
      }
    }
  }

  return {
    platform,
    probedAt: nowMs,
    controlledNode: {
      stateRoot: controlledNodeRoot,
      hasCredentialJson,
      hasValidCredential,
      hasInstallIdentity,
      serviceRegistered,
      hasRemoteDesktopWorker,
      hasComputerUseHelper,
    },
    userDaemon: {
      homeDir,
      stateDir: userStateDir,
      hasServerJson,
      hasValidServerJson,
      sqliteFiles,
      hasDaemonLock,
      daemonLockPid,
      hasAutostart,
      autostartPath: autostartExists ? autostartPath : undefined,
      launchAgentProgramArg0,
      launchAgentPointsToBundledRuntime,
      autostartTarget,
      servicePointsToDevCheckout,
      isLegacyOrBrokenNpm,
      legacyReason,
      installedVersion,
    },
    cli: {
      path: resolvedCliCandidate,
      exists: cliExists,
      isSymlink: cliIsSymlink,
      resolvedPath: cliResolvedPath,
      isDevCheckout: cliIsDevCheckout,
      isThinWrapper: cliIsThinWrapper,
    },
    daemonRuntimeExists,
    daemonRuntimeCurrentExists,
    desktopEntryExists,
    tempArtifacts: {
      scannedRoots,
      expiredPaths: expiredPaths.sort(),
      activePaths: activePaths.sort(),
    },
  };
}

export interface CreateRollbackSnapshotOptions {
  platform: DesktopInstallerPlatform;
  scenario: DesktopInstallPlan['scenario'];
  snapshotDir: string;
  trackedPaths: readonly string[];
  preservedPaths?: readonly string[];
  allowSystemRoot?: boolean;
  isolatedRoot?: string;
  realHomeDir?: string;
}

/**
 * Snapshot pre-existing config, autostart, CLI wrapper, and runtime targets (including
 * symlinks and non-symlink directories) before mutation, plus SHA-256 of preserved state files.
 */
export function createRollbackSnapshot(
  options: CreateRollbackSnapshotOptions,
): DesktopInstallerRollbackSnapshot {
  if (options.isolatedRoot && options.allowSystemRoot) {
    throw new Error('unsafe_allow_system_root_with_isolated_root');
  }
  const snapshotDir = resolve(options.snapshotDir);
  if (!options.allowSystemRoot || options.isolatedRoot) {
    assertSafeNodeIsolatedTargetPath(snapshotDir, options.platform, options.realHomeDir, options.isolatedRoot);
  }
  const filesDir = join(snapshotDir, 'files');
  mkdirSync(filesDir, { recursive: true });

  const entries: DesktopInstallerSnapshotEntry[] = [];
  let index = 0;
  for (const rawPath of options.trackedPaths) {
    const targetPath = resolve(rawPath);
    if (!options.allowSystemRoot || options.isolatedRoot) {
      assertSafeNodeIsolatedTargetPath(targetPath, options.platform, options.realHomeDir, options.isolatedRoot, 'entry');
    }
    const lst = safeLstat(targetPath);
    if (!lst) {
      entries.push({ kind: 'absent', originalPath: targetPath });
      continue;
    }
    if (lst.isSymbolicLink()) {
      const symlinkTarget = readlinkSync(targetPath);
      const st = safeStat(targetPath);
      entries.push({
        kind: st?.isDirectory() ? 'dir_symlink' : 'symlink',
        originalPath: targetPath,
        symlinkTarget,
      });
      continue;
    }
    if (lst.isDirectory()) {
      index += 1;
      const backupRelPath = join('files', `${index}-${basename(targetPath)}`);
      const backupAbsPath = join(snapshotDir, backupRelPath);
      cpSync(targetPath, backupAbsPath, { recursive: true, verbatimSymlinks: true });
      entries.push({
        kind: 'dir',
        originalPath: targetPath,
        backupRelPath,
        mode: lst.mode & 0o777,
      });
      continue;
    }
    if (lst.isFile()) {
      index += 1;
      const backupRelPath = join('files', `${index}-${basename(targetPath)}`);
      const backupAbsPath = join(snapshotDir, backupRelPath);
      copyFileSync(targetPath, backupAbsPath);
      const digest = sha256FileSync(targetPath);
      entries.push({
        kind: 'file',
        originalPath: targetPath,
        backupRelPath,
        sha256: digest.sha256,
        mode: lst.mode & 0o777,
      });
    }
  }

  const preservedChecksums: DesktopInstallerPreservedChecksum[] = [];
  for (const rawPreserved of options.preservedPaths ?? []) {
    const preservedPath = resolve(rawPreserved);
    if (!existsSync(preservedPath)) continue;
    const st = safeStat(preservedPath);
    if (!st?.isFile()) continue;
    const digest = sha256FileSync(preservedPath);
    preservedChecksums.push({ path: preservedPath, sha256: digest.sha256, size: digest.size });
  }

  const snapshot: DesktopInstallerRollbackSnapshot = {
    schemaVersion: DESKTOP_INSTALLER_SNAPSHOT_SCHEMA_VERSION,
    createdAt: Date.now(),
    platform: options.platform,
    scenario: options.scenario,
    snapshotDir,
    entries,
    preservedChecksums,
  };
  const manifestPath = join(snapshotDir, 'snapshot.json');
  const tmpPath = join(snapshotDir, `.snapshot-${process.pid}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, manifestPath);
  return snapshot;
}

export interface RestoreRollbackOptions {
  allowSystemRoot?: boolean;
  isolatedRoot?: string;
  realHomeDir?: string;
}

export interface RestoreRollbackResult {
  restoredCount: number;
  removedCount: number;
  verifiedPreservedCount: number;
}

/**
 * Restore tracked targets from a rollback snapshot and verify preserved user/node state is intact.
 */
export function restoreRollbackSnapshot(
  snapshotPathOrDir: string,
  options: RestoreRollbackOptions = {},
): RestoreRollbackResult {
  if (options.isolatedRoot && options.allowSystemRoot) {
    throw new Error('unsafe_allow_system_root_with_isolated_root');
  }
  const manifestPath = snapshotPathOrDir.endsWith('.json')
    ? resolve(snapshotPathOrDir)
    : resolve(snapshotPathOrDir, 'snapshot.json');
  const snapshot = JSON.parse(readFileSync(manifestPath, 'utf8')) as DesktopInstallerRollbackSnapshot;
  if (snapshot.schemaVersion !== DESKTOP_INSTALLER_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`unsupported rollback snapshot schemaVersion: ${String(snapshot.schemaVersion)}`);
  }

  let restoredCount = 0;
  let removedCount = 0;
  for (const entry of snapshot.entries) {
    if (!options.allowSystemRoot || options.isolatedRoot) {
      assertSafeNodeIsolatedTargetPath(
        entry.originalPath,
        snapshot.platform,
        options.realHomeDir,
        options.isolatedRoot,
        'entry',
      );
    }
    if (entry.kind === 'absent') {
      if (safeLstat(entry.originalPath)) {
        rmSync(entry.originalPath, { recursive: true, force: true });
        removedCount += 1;
      }
      continue;
    }
    mkdirSync(dirname(entry.originalPath), { recursive: true });
    if (safeLstat(entry.originalPath)) {
      rmSync(entry.originalPath, { recursive: true, force: true });
    }
    if (entry.kind === 'symlink' || entry.kind === 'dir_symlink') {
      if (!entry.symlinkTarget) throw new Error(`missing symlinkTarget for ${entry.originalPath}`);
      symlinkSync(
        entry.symlinkTarget,
        entry.originalPath,
        entry.kind === 'dir_symlink' && snapshot.platform === 'win32' ? 'junction' : undefined,
      );
      restoredCount += 1;
      continue;
    }
    if (!entry.backupRelPath) throw new Error(`missing backupRelPath for ${entry.originalPath}`);
    const backupAbs = join(snapshot.snapshotDir, entry.backupRelPath);
    if (entry.kind === 'dir') {
      cpSync(backupAbs, entry.originalPath, { recursive: true, verbatimSymlinks: true });
      if (typeof entry.mode === 'number' && snapshot.platform !== 'win32') {
        chmodSync(entry.originalPath, entry.mode);
      }
      restoredCount += 1;
      continue;
    }
    copyFileSync(backupAbs, entry.originalPath);
    if (typeof entry.mode === 'number' && snapshot.platform !== 'win32') {
      chmodSync(entry.originalPath, entry.mode);
    }
    restoredCount += 1;
  }

  let verifiedPreservedCount = 0;
  for (const check of snapshot.preservedChecksums) {
    if (!existsSync(check.path)) {
      throw new Error(`preserved_state_missing_during_rollback: ${check.path}`);
    }
    const actual = sha256FileSync(check.path);
    if (actual.sha256 !== check.sha256) {
      throw new Error(`preserved_state_checksum_mismatch: ${check.path}`);
    }
    verifiedPreservedCount += 1;
  }

  return { restoredCount, removedCount, verifiedPreservedCount };
}

export interface CleanupExpiredTempOptions {
  platform: DesktopInstallerPlatform;
  scanRoots: readonly string[];
  maxAgeMs?: number;
  nowMs?: number;
  allowSystemRoot?: boolean;
  isolatedRoot?: string;
  realHomeDir?: string;
}

/**
 * Remove only expired `.tmp` / `.staging-*` / `.partial-*` artifacts inside `scanRoots`.
 * Never removes lockfiles, SQLite DBs, credentials, or `server.json`.
 */
export function cleanupExpiredTempArtifacts(options: CleanupExpiredTempOptions): string[] {
  if (options.isolatedRoot && options.allowSystemRoot) {
    throw new Error('unsafe_allow_system_root_with_isolated_root');
  }
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_INSTALLER_TEMP_MAX_AGE_MS;
  const nowMs = options.nowMs ?? Date.now();
  const removed: string[] = [];

  for (const rawRoot of options.scanRoots) {
    const root = resolve(rawRoot);
    if (!options.allowSystemRoot || options.isolatedRoot) {
      assertSafeNodeIsolatedTargetPath(root, options.platform, options.realHomeDir, options.isolatedRoot);
    }
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!isSafeExpiredTempArtifactName(entry.name)) continue;
      const full = join(root, entry.name);
      const st = safeLstat(full);
      if (!st) continue;
      if (nowMs - st.mtimeMs < maxAgeMs) continue;
      rmSync(full, { recursive: true, force: true });
      removed.push(full);
    }
  }
  return removed.sort();
}

/**
 * Create/update `<runtimeRoot>/current` pointing to `releaseDir`.
 */
export function installDaemonRuntimeCurrentLink(
  runtimeRoot: string,
  releaseDir: string,
  platform: DesktopInstallerPlatform = process.platform === 'win32'
    ? 'win32'
    : process.platform === 'darwin'
      ? 'darwin'
      : 'linux',
): string {
  const resolvedRoot = resolve(runtimeRoot);
  const resolvedRelease = resolve(releaseDir);
  const currentPath = join(resolvedRoot, 'current');
  mkdirSync(resolvedRoot, { recursive: true });
  if (safeLstat(currentPath)) {
    rmSync(currentPath, { recursive: true, force: true });
  }
  symlinkSync(resolvedRelease, currentPath, platform === 'win32' ? 'junction' : 'dir');
  return currentPath;
}

function parseCliFlags(argv: readonly string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > 2) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function runProbeCli(argv: readonly string[]): void {
  const [subcommand = 'plan', ...rest] = argv;
  const flags = parseCliFlags(rest);
  const platform =
    typeof flags.platform === 'string' &&
    (flags.platform === 'linux' || flags.platform === 'darwin' || flags.platform === 'win32')
      ? flags.platform
      : undefined;

  const isolatedRoot =
    typeof flags['isolated-root'] === 'string'
      ? flags['isolated-root']
      : process.env.IMCODES_ISOLATED_ROOT?.trim() || undefined;

  if (subcommand === 'probe' || subcommand === 'plan') {
    const probe = probeDesktopInstallEnvironment({
      platform,
      isolatedRoot,
      homeDir: typeof flags.home === 'string' ? flags.home : undefined,
      userStateDir: typeof flags['user-state-dir'] === 'string' ? flags['user-state-dir'] : undefined,
      controlledNodeRoot: typeof flags['node-root'] === 'string' ? flags['node-root'] : undefined,
      controlledNodeServicePath: typeof flags['node-service'] === 'string' ? flags['node-service'] : undefined,
      daemonRuntimeRoot: typeof flags['runtime-root'] === 'string' ? flags['runtime-root'] : undefined,
      cliPath: typeof flags['cli-path'] === 'string' ? flags['cli-path'] : undefined,
      desktopEntryPath: typeof flags['desktop-entry'] === 'string' ? flags['desktop-entry'] : undefined,
      autostartPath: typeof flags['autostart-path'] === 'string' ? flags['autostart-path'] : undefined,
      minimumRuntimeVersion: typeof flags['min-version'] === 'string' ? flags['min-version'] : undefined,
    });
    if (subcommand === 'probe') {
      process.stdout.write(`${JSON.stringify(probe, null, 2)}\n`);
      return;
    }
    const planOptions: DesktopCompatibilityPlanOptions = {
      forceTakeover: flags['force-takeover'] === true,
      confirmFdaSwitch: flags['confirm-fda-switch'] === true,
    };
    const plan: DesktopInstallPlan = planDesktopInstallerCompatibility(probe, planOptions);
    process.stdout.write(`${JSON.stringify({ probe, plan }, null, 2)}\n`);
    return;
  }

  if (subcommand === 'rollback') {
    const snapshot = typeof flags.snapshot === 'string' ? flags.snapshot : '';
    if (!snapshot) throw new Error('--snapshot <path> is required');
    const res = restoreRollbackSnapshot(snapshot, {
      allowSystemRoot: flags['allow-system-root'] === true,
      isolatedRoot,
      realHomeDir: typeof flags['real-home'] === 'string' ? flags['real-home'] : homedir(),
    });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (subcommand === 'cleanup-tmp') {
    const roots = typeof flags.roots === 'string' ? flags.roots.split(',').filter(Boolean) : [];
    const effectivePlatform =
      platform ?? (process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux');
    const removed = cleanupExpiredTempArtifacts({
      platform: effectivePlatform,
      scanRoots: roots,
      allowSystemRoot: flags['allow-system-root'] === true,
      isolatedRoot,
      realHomeDir: typeof flags['real-home'] === 'string' ? flags['real-home'] : homedir(),
    });
    process.stdout.write(`${JSON.stringify({ removed }, null, 2)}\n`);
    return;
  }

  throw new Error(`unknown desktop-installer-probe subcommand: ${subcommand}`);
}

const isDirectEntry = Boolean(process.argv[1]) && (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();

if (isDirectEntry) {
  try {
    runProbeCli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
