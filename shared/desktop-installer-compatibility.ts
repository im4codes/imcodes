/**
 * Single source of truth for Desktop 3-in-1 Phase 3 installers:
 * - Default platform layout paths (system controlled-node, read-only daemon-runtime, user data, CLI wrapper)
 * - Phase A read-only probe schema & 5-scenario dual-path compatibility decision engine
 * - Stale `.tmp` classification, safety target-root guards, and rollback snapshot schema
 * - Cross-platform `imcodes` CLI thin forwarder resolution & script rendering
 */

export type DesktopInstallerPlatform = 'linux' | 'darwin' | 'win32';

export type DesktopInstallerScenario =
  | 'clean'
  | 'partial_preserve'
  | 'dev_symlink_exempt'
  | 'macos_launchagent_fda_preserve'
  | 'legacy_broken_takeover';

export interface DesktopInstallerPlatformPaths {
  controlledNodeRoot: string;
  daemonRuntimeRoot: string;
  daemonRuntimeCurrentDir: string;
  daemonRuntimeReleasesDir: string;
  cliWrapperPath: string;
  userAutostartDescription: string;
}

export const DESKTOP_INSTALLER_DEFAULT_PATHS: Readonly<
  Record<DesktopInstallerPlatform, DesktopInstallerPlatformPaths>
> = Object.freeze({
  linux: {
    controlledNodeRoot: '/var/lib/imcodes-node',
    daemonRuntimeRoot: '/opt/imcodes/daemon-runtime',
    daemonRuntimeCurrentDir: '/opt/imcodes/daemon-runtime/current',
    daemonRuntimeReleasesDir: '/opt/imcodes/daemon-runtime/releases',
    cliWrapperPath: '/usr/local/bin/imcodes',
    userAutostartDescription: '~/.config/systemd/user/imcodes.service',
  },
  darwin: {
    controlledNodeRoot: '/Library/Application Support/imcodes-node',
    daemonRuntimeRoot: '/Library/Application Support/imcodes/daemon-runtime',
    daemonRuntimeCurrentDir: '/Library/Application Support/imcodes/daemon-runtime/current',
    daemonRuntimeReleasesDir: '/Library/Application Support/imcodes/daemon-runtime/releases',
    cliWrapperPath: '/usr/local/bin/imcodes',
    userAutostartDescription: '~/Library/LaunchAgents/imcodes.daemon.plist',
  },
  win32: {
    controlledNodeRoot: 'C:\\ProgramData\\imcodes-node',
    daemonRuntimeRoot: 'C:\\Program Files\\IM.codes\\daemon-runtime',
    daemonRuntimeCurrentDir: 'C:\\Program Files\\IM.codes\\daemon-runtime\\current',
    daemonRuntimeReleasesDir: 'C:\\Program Files\\IM.codes\\daemon-runtime\\releases',
    cliWrapperPath: '%LocalAppData%\\imcodes\\bin\\imcodes.cmd',
    userAutostartDescription: 'Task Scheduler: imcodes-daemon',
  },
});

export const DEFAULT_INSTALLER_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DESKTOP_INSTALLER_SNAPSHOT_SCHEMA_VERSION = 1;

export interface ControlledNodeProbeState {
  stateRoot: string;
  hasCredentialJson: boolean;
  hasValidCredential: boolean;
  hasInstallIdentity: boolean;
  serviceRegistered: boolean;
  hasRemoteDesktopWorker: boolean;
  hasComputerUseHelper: boolean;
}

export interface UserDaemonProbeState {
  homeDir: string;
  stateDir: string;
  hasServerJson: boolean;
  hasValidServerJson: boolean;
  sqliteFiles: readonly string[];
  hasDaemonLock: boolean;
  daemonLockPid?: number;
  hasAutostart: boolean;
  autostartPath?: string;
  /** macOS LaunchAgent `ProgramArguments[0]` if present in plist. */
  launchAgentProgramArg0?: string;
  launchAgentPointsToBundledRuntime: boolean;
  /** Systemd ExecStart or LaunchAgent or Windows Startup command target. */
  autostartTarget?: string;
  servicePointsToDevCheckout: boolean;
  isLegacyOrBrokenNpm: boolean;
  legacyReason?: string;
  installedVersion?: string;
}

export interface CliWrapperProbeState {
  path?: string;
  exists: boolean;
  isSymlink: boolean;
  resolvedPath?: string;
  isDevCheckout: boolean;
  isThinWrapper: boolean;
}

export interface InstallerTempArtifactsProbe {
  scannedRoots: readonly string[];
  expiredPaths: readonly string[];
  activePaths: readonly string[];
}

export interface DesktopInstallProbeResult {
  platform: DesktopInstallerPlatform;
  probedAt: number;
  controlledNode: ControlledNodeProbeState;
  userDaemon: UserDaemonProbeState;
  cli: CliWrapperProbeState;
  daemonRuntimeExists: boolean;
  daemonRuntimeCurrentExists: boolean;
  desktopEntryExists: boolean;
  tempArtifacts: InstallerTempArtifactsProbe;
}

export interface DesktopCompatibilityPlanOptions {
  /** Override Scenario 3 (developer symlink exemption) when explicitly requested. */
  forceTakeover?: boolean;
  /** Override Scenario 4 (macOS LaunchAgent ProgramArguments[0] FDA preservation). */
  confirmFdaSwitch?: boolean;
}

export interface DesktopInstallPlan {
  scenario: DesktopInstallerScenario;
  reasons: readonly string[];
  /** Preserved resources — installers must NEVER overwrite these when true. */
  preserveUserState: boolean;
  preserveDevCliLink: boolean;
  preserveUserDaemonAutostart: boolean;
  preserveLaunchAgentExecutable: boolean;
  skipNodeReEnroll: boolean;
  /** Install / update / cleanup actions. */
  installControlledNode: boolean;
  installRemoteDesktop: boolean;
  installComputerUse: boolean;
  installDaemonRuntime: boolean;
  installUserDaemonAutostart: boolean;
  installDesktopEntry: boolean;
  installCliWrapper: boolean;
  checkSingleInstanceLock: boolean;
  stopUserDaemonTask: boolean;
  switchToBundledRuntime: boolean;
  cleanExpiredTempArtifacts: boolean;
  createRollbackSnapshot: boolean;
  /** Newly installed clean node boots into Phase 2B `pending_setup`. */
  expectsPendingSetupWizard: boolean;
}

export interface DesktopInstallerSnapshotEntry {
  kind: 'file' | 'symlink' | 'dir_symlink' | 'dir' | 'absent';
  originalPath: string;
  backupRelPath?: string;
  symlinkTarget?: string;
  sha256?: string;
  mode?: number;
}

export interface DesktopInstallerPreservedChecksum {
  path: string;
  sha256: string;
  size: number;
}

export interface DesktopInstallerRollbackSnapshot {
  schemaVersion: typeof DESKTOP_INSTALLER_SNAPSHOT_SCHEMA_VERSION;
  createdAt: number;
  platform: DesktopInstallerPlatform;
  scenario: DesktopInstallerScenario;
  snapshotDir: string;
  entries: DesktopInstallerSnapshotEntry[];
  preservedChecksums: DesktopInstallerPreservedChecksum[];
}

function isNonBundledMacosExecutable(programArg0: string): boolean {
  const normalized = programArg0.replace(/\\/gu, '/').trim();
  if (!normalized) return false;
  return !normalized.startsWith('/Library/Application Support/imcodes/daemon-runtime');
}

/**
 * Pure Phase A dual-path compatibility decision engine implementing all 5 scenarios:
 * 1) clean
 * 2) partial_preserve
 * 3) dev_symlink_exempt
 * 4) macos_launchagent_fda_preserve
 * 5) legacy_broken_takeover
 */
export function planDesktopInstallerCompatibility(
  probe: DesktopInstallProbeResult,
  options: DesktopCompatibilityPlanOptions = {},
): DesktopInstallPlan {
  const forceTakeover = options.forceTakeover === true;
  const confirmFdaSwitch = options.confirmFdaSwitch === true;
  const reasons: string[] = [];

  const hasControlledNodeState =
    probe.controlledNode.hasValidCredential ||
    probe.controlledNode.hasCredentialJson ||
    probe.controlledNode.hasInstallIdentity ||
    probe.controlledNode.serviceRegistered;
  const hasUserDaemonState =
    probe.userDaemon.hasServerJson ||
    probe.userDaemon.sqliteFiles.length > 0 ||
    probe.userDaemon.hasAutostart;

  const isDevSymlink =
    (probe.cli.isDevCheckout || probe.userDaemon.servicePointsToDevCheckout) && !forceTakeover;

  const isMacosFdaProtected =
    probe.platform === 'darwin' &&
    Boolean(probe.userDaemon.launchAgentProgramArg0) &&
    !probe.userDaemon.launchAgentPointsToBundledRuntime &&
    isNonBundledMacosExecutable(probe.userDaemon.launchAgentProgramArg0!) &&
    !confirmFdaSwitch;

  const hasExpiredTemps = probe.tempArtifacts.expiredPaths.length > 0;
  const needsLegacyBrokenTakeover =
    !isDevSymlink &&
    !isMacosFdaProtected &&
    (probe.userDaemon.isLegacyOrBrokenNpm || (hasExpiredTemps && !probe.daemonRuntimeCurrentExists));

  let scenario: DesktopInstallerScenario;
  if (isDevSymlink) {
    scenario = 'dev_symlink_exempt';
    reasons.push('developer_checkout_or_symlink_detected');
  } else if (isMacosFdaProtected) {
    scenario = 'macos_launchagent_fda_preserve';
    reasons.push('macos_launchagent_program_arg0_preserved_for_fda');
  } else if (needsLegacyBrokenTakeover) {
    scenario = 'legacy_broken_takeover';
    reasons.push(probe.userDaemon.legacyReason || 'legacy_or_broken_npm_runtime_detected');
  } else if (hasControlledNodeState || hasUserDaemonState) {
    scenario = 'partial_preserve';
    reasons.push('existing_component_state_preserved_in_place');
  } else {
    scenario = 'clean';
    reasons.push('clean_machine_full_install');
  }

  const skipNodeReEnroll = probe.controlledNode.hasValidCredential;
  if (skipNodeReEnroll) {
    reasons.push('controlled_node_credential_preserved');
  }
  const preserveUserState =
    hasUserDaemonState || scenario !== 'clean';

  const preserveDevCliLink = scenario === 'dev_symlink_exempt' && probe.cli.isDevCheckout;
  const preserveLaunchAgentExecutable = scenario === 'macos_launchagent_fda_preserve';
  const preserveUserDaemonAutostart =
    scenario === 'dev_symlink_exempt' ||
    scenario === 'macos_launchagent_fda_preserve' ||
    (scenario === 'partial_preserve' && probe.userDaemon.hasAutostart);

  const installControlledNode =
    !probe.controlledNode.serviceRegistered || !probe.controlledNode.hasValidCredential;
  const installRemoteDesktop = !probe.controlledNode.hasRemoteDesktopWorker;
  const installComputerUse = !probe.controlledNode.hasComputerUseHelper;
  const installDaemonRuntime = true;
  const installUserDaemonAutostart = !preserveUserDaemonAutostart;
  const installDesktopEntry = !probe.desktopEntryExists || scenario === 'clean';
  const installCliWrapper = !preserveDevCliLink;

  const checkSingleInstanceLock =
    scenario === 'legacy_broken_takeover' || probe.userDaemon.hasDaemonLock;
  const stopUserDaemonTask = scenario === 'legacy_broken_takeover' && probe.userDaemon.hasAutostart;
  const switchToBundledRuntime =
    scenario === 'clean' ||
    scenario === 'legacy_broken_takeover' ||
    (scenario === 'partial_preserve' && !probe.userDaemon.hasAutostart);
  const cleanExpiredTempArtifacts =
    hasExpiredTemps && (scenario === 'legacy_broken_takeover' || scenario === 'partial_preserve');

  const wouldMutateExistingTarget =
    (installCliWrapper && probe.cli.exists) ||
    (installUserDaemonAutostart && probe.userDaemon.hasAutostart) ||
    (installDaemonRuntime && (probe.daemonRuntimeExists || probe.daemonRuntimeCurrentExists)) ||
    scenario === 'legacy_broken_takeover';

  const expectsPendingSetupWizard = !skipNodeReEnroll;

  return {
    scenario,
    reasons,
    preserveUserState,
    preserveDevCliLink,
    preserveUserDaemonAutostart,
    preserveLaunchAgentExecutable,
    skipNodeReEnroll,
    installControlledNode,
    installRemoteDesktop,
    installComputerUse,
    installDaemonRuntime,
    installUserDaemonAutostart,
    installDesktopEntry,
    installCliWrapper,
    checkSingleInstanceLock,
    stopUserDaemonTask,
    switchToBundledRuntime,
    cleanExpiredTempArtifacts,
    createRollbackSnapshot: wouldMutateExistingTarget,
    expectsPendingSetupWizard,
  };
}

const PROTECTED_PERSISTENT_NAMES = new Set([
  'server.json',
  'credential.json',
  'install-identity.json',
  'daemon.lock.json',
  'daemon.pid',
]);

/**
 * Return true only for expired installer/upgrade temp artifacts (`.tmp`, `.staging-*`, `.partial-*`).
 * Never matches active lockfiles, credentials, server.json, or SQLite DB/WAL/SHM files.
 */
export function isSafeExpiredTempArtifactName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (!lower || PROTECTED_PERSISTENT_NAMES.has(lower)) return false;
  if (lower.includes('.sqlite') || lower.endsWith('.db') || lower.endsWith('-wal') || lower.endsWith('-shm')) {
    return false;
  }
  return (
    lower.endsWith('.tmp') ||
    lower.includes('.tmp.') ||
    lower.startsWith('.staging-') ||
    lower.startsWith('.partial-') ||
    lower.endsWith('.partial')
  );
}

function resolveLexicalPosixPath(raw: string): string {
  const isAbs = raw.startsWith('/');
  const parts = raw.split('/');
  const stack: string[] = [];
  for (const seg of parts) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!isAbs) {
        stack.push('..');
      }
      continue;
    }
    stack.push(seg);
  }
  return `${isAbs ? '/' : ''}${stack.join('/')}` || (isAbs ? '/' : '.');
}

function resolveLexicalWin32Path(raw: string): string {
  const unified = raw.replace(/\//gu, '\\');
  let prefix = '';
  let rest = unified;
  const uncMatch = unified.match(/^(\\\\[^\\]+\\[^\\]+)(?:\\(.*))?$/u);
  const driveMatch = unified.match(/^([a-zA-Z]:)(?:\\(.*))?$/u);
  if (uncMatch) {
    prefix = uncMatch[1].toLowerCase();
    rest = uncMatch[2] ?? '';
  } else if (driveMatch) {
    prefix = driveMatch[1].toLowerCase();
    rest = driveMatch[2] ?? '';
  } else if (unified.startsWith('\\')) {
    prefix = '';
    rest = unified.replace(/^\\+/u, '');
  }
  const parts = rest.split('\\');
  const stack: string[] = [];
  for (const seg of parts) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (stack.length > 0) {
        stack.pop();
      }
      continue;
    }
    stack.push(seg.toLowerCase());
  }
  if (prefix) {
    return stack.length > 0 ? `${prefix}\\${stack.join('\\')}` : `${prefix}\\`;
  }
  if (unified.startsWith('\\')) {
    return `\\${stack.join('\\')}`;
  }
  return stack.join('\\') || '.';
}

function isSameOrChildComparable(candidate: string, parent: string, platform: DesktopInstallerPlatform): boolean {
  if (!parent) return false;
  if (candidate === parent) return true;
  const sep = platform === 'win32' ? '\\' : '/';
  if (parent === sep || (platform === 'win32' && /^[a-z]:\\$/u.test(parent))) {
    return candidate.startsWith(parent);
  }
  return candidate.startsWith(`${parent}${sep}`);
}

/**
 * Guard helper used by isolated tests & rollback verification to guarantee an isolated
 * target path never points inside a default OS system root or the current user's real `~/.imcodes`,
 * and (when `isolatedRoot` is specified) stays strictly within `isolatedRoot`.
 */
export function assertSafeIsolatedTargetPath(
  targetPath: string,
  platform: DesktopInstallerPlatform,
  realHomeDir?: string,
  isolatedRoot?: string,
): void {
  const normalized = normalizeComparablePath(targetPath, platform);
  const defaults = DESKTOP_INSTALLER_DEFAULT_PATHS[platform];
  const forbiddenRoots = [
    defaults.controlledNodeRoot,
    defaults.daemonRuntimeRoot,
    '/var/lib/imcodes-node',
    '/opt/imcodes',
    '/Library/Application Support/imcodes-node',
    '/Library/Application Support/imcodes',
    '/etc/systemd/system',
    '/Library/LaunchDaemons',
    '/Applications/aiDesk.to by IM.codes.app',
    '/usr/local/bin/imcodes',
    'C:\\ProgramData\\imcodes-node',
    'C:\\Program Files\\IM.codes',
  ].map((p) => normalizeComparablePath(p, platform));

  if (realHomeDir) {
    const homeNorm = normalizeComparablePath(realHomeDir, platform);
    if (normalized === homeNorm) {
      throw new Error(`unsafe_installer_target_inside_system_root: ${targetPath}`);
    }
    const protectedHomeSubdirs =
      platform === 'win32'
        ? [
            `${homeNorm}\\.imcodes`,
            `${homeNorm}\\appdata\\local\\imcodes`,
            `${homeNorm}\\appdata\\roaming\\microsoft\\windows\\start menu`,
            `${homeNorm}\\desktop`,
          ]
        : [
            `${homeNorm}/.imcodes`,
            `${homeNorm}/.config/systemd`,
            `${homeNorm}/.local/share/applications`,
            `${homeNorm}/Library/LaunchAgents`,
          ];
    for (const sub of protectedHomeSubdirs) {
      const subNorm = normalizeComparablePath(sub, platform);
      if (isSameOrChildComparable(normalized, subNorm, platform)) {
        throw new Error(`unsafe_installer_target_inside_system_root: ${targetPath}`);
      }
    }
  }

  for (const forbidden of forbiddenRoots) {
    if (isSameOrChildComparable(normalized, forbidden, platform)) {
      throw new Error(`unsafe_installer_target_inside_system_root: ${targetPath}`);
    }
  }

  if (isolatedRoot) {
    const isolatedNorm = normalizeComparablePath(isolatedRoot, platform);
    if (!isSameOrChildComparable(normalized, isolatedNorm, platform)) {
      throw new Error(`unsafe_installer_target_outside_isolated_root: ${targetPath}`);
    }
  }
}

export function normalizeComparablePath(targetPath: string, platform: DesktopInstallerPlatform): string {
  if (platform === 'win32') {
    return resolveLexicalWin32Path(targetPath).replace(/\\+$/u, '').replace(/^([a-z]:)$/u, '$1\\');
  }
  const resolved = resolveLexicalPosixPath(targetPath);
  return resolved.length > 1 ? resolved.replace(/\/+$/u, '') : resolved;
}

export interface ImcodesCliResolutionInput {
  platform: DesktopInstallerPlatform;
  devEntryPath?: string;
  devOverrideExists?: boolean;
  selfIsDevSymlink?: boolean;
  selfRealEntryPath?: string;
  bundledCurrent?: { exists: boolean; nodePath: string; entryPath: string };
  bundledDirect?: { exists: boolean; nodePath: string; entryPath: string };
  npmFallback?: { exists: boolean; entryPath?: string; executablePath: string; isSelfPath?: boolean };
}

export interface ResolvedImcodesCliTarget {
  source: 'dev_override' | 'dev_symlink' | 'daemon_runtime_current' | 'daemon_runtime_direct' | 'npm_fallback';
  executable: string;
  prefixArgs: readonly string[];
}

/**
 * Pure priority contract for the `imcodes` CLI thin forwarder:
 * 1) Dev override / dev repo symlink
 * 2) `daemon-runtime/current/` (`node` + `package/dist/src/index.js`)
 * 3) Direct `daemon-runtime/` (`node` + `package/dist/src/index.js`)
 * 4) Existing global `npm` `imcodes` install (excluding self to avoid recursion)
 */
export function resolveImcodesCliTarget(
  input: ImcodesCliResolutionInput,
): ResolvedImcodesCliTarget | null {
  const defaultNode = input.platform === 'win32' ? 'node.exe' : 'node';
  if (input.devOverrideExists && input.devEntryPath) {
    return {
      source: 'dev_override',
      executable: defaultNode,
      prefixArgs: [input.devEntryPath],
    };
  }
  if (input.selfIsDevSymlink && input.selfRealEntryPath) {
    return {
      source: 'dev_symlink',
      executable: defaultNode,
      prefixArgs: [input.selfRealEntryPath],
    };
  }
  if (input.bundledCurrent?.exists) {
    return {
      source: 'daemon_runtime_current',
      executable: input.bundledCurrent.nodePath,
      prefixArgs: [input.bundledCurrent.entryPath],
    };
  }
  if (input.bundledDirect?.exists) {
    return {
      source: 'daemon_runtime_direct',
      executable: input.bundledDirect.nodePath,
      prefixArgs: [input.bundledDirect.entryPath],
    };
  }
  if (input.npmFallback?.exists && !input.npmFallback.isSelfPath) {
    return {
      source: 'npm_fallback',
      executable: input.npmFallback.executablePath,
      prefixArgs: input.npmFallback.entryPath ? [input.npmFallback.entryPath] : [],
    };
  }
  return null;
}

export interface RenderCliWrapperOptions {
  platform: 'linux' | 'darwin';
  /** Primary daemon-runtime root baked into wrapper as first bundled candidate. */
  runtimeRoot?: string;
  /** Optional relative runtime root from wrapper parent dir (for isolated/relocated installs). */
  relativeRuntimeSubpath?: string;
}

/**
 * Render the POSIX `imcodes` CLI thin forwarder (`#!/bin/sh`).
 * Works under an empty `PATH` because `bin/node` and `package/dist/src/index.js` use explicit paths.
 */
export function renderPosixImcodesCliWrapper(options: RenderCliWrapperOptions): string {
  const defaultRuntimeRoot =
    options.runtimeRoot ?? DESKTOP_INSTALLER_DEFAULT_PATHS[options.platform].daemonRuntimeRoot;
  const relSubpath = options.relativeRuntimeSubpath ?? '../daemon-runtime';
  return `#!/bin/sh
set -eu

case "$0" in
  */*) SELF_DIR="$(CDPATH= cd -- "\${0%/*}" 2>/dev/null && pwd)" ;;
  *) SELF_DIR="$PWD" ;;
esac
SELF_NAME="\${0##*/}"
SELF_PATH="$SELF_DIR/$SELF_NAME"

resolve_node_for_dev() {
  if [ -n "\${IMCODES_NODE_BIN:-}" ] && [ -x "$IMCODES_NODE_BIN" ]; then
    printf '%s\\n' "$IMCODES_NODE_BIN"
    return 0
  fi
  for cand in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$cand" ]; then
      printf '%s\\n' "$cand"
      return 0
    fi
  done
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  return 1
}

SELECTED_NODE=""
SELECTED_ENTRY=""

select_runtime_root() {
  root="$1"
  [ -n "$root" ] || return 1
  for layout in "$root/current" "$root"; do
    node_bin="$layout/bin/node"
    entry="$layout/package/dist/src/index.js"
    if [ -x "$node_bin" ] && [ -f "$entry" ]; then
      SELECTED_NODE="$node_bin"
      SELECTED_ENTRY="$entry"
      return 0
    fi
  done
  return 1
}

# 1. Explicit developer override
if [ -n "\${IMCODES_CLI_DEV_ENTRY:-}" ] && [ -f "$IMCODES_CLI_DEV_ENTRY" ]; then
  if NODE_BIN="$(resolve_node_for_dev)"; then
    exec "$NODE_BIN" "$IMCODES_CLI_DEV_ENTRY" "$@"
  fi
fi

# 2. Bundled daemon-runtime (env -> relative -> system default): current/ first, then direct
if [ -n "\${IMCODES_DAEMON_RUNTIME_DIR:-}" ] && select_runtime_root "$IMCODES_DAEMON_RUNTIME_DIR"; then
  exec "$SELECTED_NODE" "$SELECTED_ENTRY" "$@"
fi
if select_runtime_root "$SELF_DIR/${relSubpath}"; then
  exec "$SELECTED_NODE" "$SELECTED_ENTRY" "$@"
fi
if select_runtime_root "${defaultRuntimeRoot}"; then
  exec "$SELECTED_NODE" "$SELECTED_ENTRY" "$@"
fi

# 3. Fallback to global npm imcodes install (skipping self to prevent recursion)
for npm_entry in \\
  "\${IMCODES_NPM_FALLBACK_ENTRY:-}" \\
  "\${HOME:-}/.npm-global/lib/node_modules/imcodes/dist/src/index.js" \\
  "\${HOME:-}/.local/lib/node_modules/imcodes/dist/src/index.js" \\
  "/opt/homebrew/lib/node_modules/imcodes/dist/src/index.js" \\
  "/usr/local/lib/node_modules/imcodes/dist/src/index.js" \\
  "/usr/lib/node_modules/imcodes/dist/src/index.js"; do
  [ -n "$npm_entry" ] || continue
  if [ -f "$npm_entry" ]; then
    if NODE_BIN="$(resolve_node_for_dev)"; then
      exec "$NODE_BIN" "$npm_entry" "$@"
    fi
  fi
done

for npm_bin in \\
  "\${HOME:-}/.npm-global/bin/imcodes" \\
  "\${HOME:-}/.local/bin/imcodes" \\
  "/opt/homebrew/bin/imcodes" \\
  "/usr/local/bin/imcodes"; do
  [ -x "$npm_bin" ] || continue
  if [ "$npm_bin" != "$SELF_PATH" ]; then
    exec "$npm_bin" "$@"
  fi
done

echo "imcodes: no runnable daemon-runtime or global imcodes installation found" >&2
exit 127
`;
}

export interface RenderWindowsCliWrapperOptions {
  runtimeRoot?: string;
  relativeRuntimeSubpath?: string;
}

/**
 * Render the Windows `imcodes.cmd` thin forwarder.
 * Priority: IMCODES_CLI_DEV_ENTRY -> IMCODES_DAEMON_RUNTIME_DIR -> relative -> Program Files -> npm fallback.
 */
export function renderWindowsImcodesCliWrapper(options: RenderWindowsCliWrapperOptions = {}): string {
  const defaultRuntimeRoot =
    options.runtimeRoot ?? DESKTOP_INSTALLER_DEFAULT_PATHS.win32.daemonRuntimeRoot;
  const relSubpath = options.relativeRuntimeSubpath ?? '..\\daemon-runtime';
  const lines = [
    '@echo off',
    'setlocal EnableExtensions',
    'set "SELF_DIR=%~dp0"',
    'if "%SELF_DIR:~-1%"=="\\" set "SELF_DIR=%SELF_DIR:~0,-1%"',
    '',
    'REM 1. Developer override',
    'if not defined IMCODES_CLI_DEV_ENTRY goto :check_bundled',
    'if not exist "%IMCODES_CLI_DEV_ENTRY%" goto :check_bundled',
    'call :resolve_node',
    'if not defined RESOLVED_NODE goto :check_bundled',
    '"%RESOLVED_NODE%" "%IMCODES_CLI_DEV_ENTRY%" %*',
    'set "IMCODES_EXIT=%ERRORLEVEL%"',
    'exit /b %IMCODES_EXIT%',
    '',
    ':check_bundled',
    'REM 2. Bundled daemon-runtime (current\\ first, then direct)',
    'set "SELECTED_NODE="',
    'set "SELECTED_ENTRY="',
    'if defined IMCODES_DAEMON_RUNTIME_DIR call :select_runtime "%IMCODES_DAEMON_RUNTIME_DIR%"',
    `if not defined SELECTED_NODE call :select_runtime "%SELF_DIR%\\${relSubpath}"`,
    `if not defined SELECTED_NODE call :select_runtime "${defaultRuntimeRoot}"`,
    'if not defined SELECTED_NODE goto :check_npm',
    '"%SELECTED_NODE%" "%SELECTED_ENTRY%" %*',
    'set "IMCODES_EXIT=%ERRORLEVEL%"',
    'exit /b %IMCODES_EXIT%',
    '',
    ':check_npm',
    'REM 3. Global npm imcodes fallback',
    'if not defined IMCODES_NPM_FALLBACK_ENTRY goto :check_appdata_npm_js',
    'if not exist "%IMCODES_NPM_FALLBACK_ENTRY%" goto :check_appdata_npm_js',
    'call :resolve_node',
    'if not defined RESOLVED_NODE goto :check_appdata_npm_js',
    '"%RESOLVED_NODE%" "%IMCODES_NPM_FALLBACK_ENTRY%" %*',
    'set "IMCODES_EXIT=%ERRORLEVEL%"',
    'exit /b %IMCODES_EXIT%',
    '',
    ':check_appdata_npm_js',
    'if not exist "%APPDATA%\\npm\\node_modules\\imcodes\\dist\\src\\index.js" goto :check_appdata_npm_cmd',
    'call :resolve_node',
    'if not defined RESOLVED_NODE goto :check_appdata_npm_cmd',
    '"%RESOLVED_NODE%" "%APPDATA%\\npm\\node_modules\\imcodes\\dist\\src\\index.js" %*',
    'set "IMCODES_EXIT=%ERRORLEVEL%"',
    'exit /b %IMCODES_EXIT%',
    '',
    ':check_appdata_npm_cmd',
    'if not exist "%APPDATA%\\npm\\imcodes.cmd" goto :not_found',
    'if /I "%APPDATA%\\npm\\imcodes.cmd"=="%~f0" goto :not_found',
    'call "%APPDATA%\\npm\\imcodes.cmd" %*',
    'set "IMCODES_EXIT=%ERRORLEVEL%"',
    'exit /b %IMCODES_EXIT%',
    '',
    ':not_found',
    'echo imcodes: no runnable daemon-runtime or global imcodes installation found 1>&2',
    'exit /b 127',
    '',
    ':select_runtime',
    'set "RT_ROOT=%~1"',
    'if not exist "%RT_ROOT%\\current\\node.exe" goto :select_runtime_direct',
    'if not exist "%RT_ROOT%\\current\\package\\dist\\src\\index.js" goto :select_runtime_direct',
    'set "SELECTED_NODE=%RT_ROOT%\\current\\node.exe"',
    'set "SELECTED_ENTRY=%RT_ROOT%\\current\\package\\dist\\src\\index.js"',
    'exit /b 0',
    ':select_runtime_direct',
    'if not exist "%RT_ROOT%\\node.exe" exit /b 0',
    'if not exist "%RT_ROOT%\\package\\dist\\src\\index.js" exit /b 0',
    'set "SELECTED_NODE=%RT_ROOT%\\node.exe"',
    'set "SELECTED_ENTRY=%RT_ROOT%\\package\\dist\\src\\index.js"',
    'exit /b 0',
    '',
    ':resolve_node',
    'set "RESOLVED_NODE="',
    'if not defined IMCODES_NODE_BIN goto :resolve_node_path',
    'if not exist "%IMCODES_NODE_BIN%" goto :resolve_node_path',
    'set "RESOLVED_NODE=%IMCODES_NODE_BIN%"',
    'exit /b 0',
    ':resolve_node_path',
    'for %%N in (node.exe) do set "RESOLVED_NODE=%%~$PATH:N"',
    'if defined RESOLVED_NODE exit /b 0',
    'if not exist "%ProgramFiles%\\nodejs\\node.exe" exit /b 1',
    'set "RESOLVED_NODE=%ProgramFiles%\\nodejs\\node.exe"',
    'exit /b 0',
  ];
  return `${lines.join('\r\n')}\r\n`;
}
