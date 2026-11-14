export declare const DAEMON_RUNTIME_STAGING_PREFIX: '.staging-';
export declare const DAEMON_RUNTIME_PREVIOUS_STATE_FILE: '.previous-target.json';
export declare const DAEMON_RUNTIME_SWITCH_STATE_FILE: '.switch-state.json';
export declare const DAEMON_RUNTIME_LOCK_DIR_NAME: 'daemon-runtime-upgrade.lock.d';
export declare const DAEMON_RUNTIME_LOCK_OWNER_FILE: 'owner.json';
export declare const UPGRADE_COOLDOWN_SENTINEL_FILE: 'last-upgrade-at';
export declare const WINDOWS_TRANSIENT_UPGRADE_LOCK_FILE: 'upgrade.lock';

export type DaemonRuntimePlatform = 'linux' | 'darwin' | 'win32';

export interface RuntimeUpgradeLockHandle {
  lockDir: string;
  ownerPath: string;
  ownerToken: string;
}

export interface RuntimeUpgradeLockOwnerRecord {
  ownerToken: string;
  pid: number;
  startToken: string | null;
  acquiredAt: number;
  updatedAt: number;
  mode: string;
  handoffPending: boolean;
  handoffDeadlineAt?: number;
}

export interface VerifiedDaemonIdentity {
  pid: number;
  startToken: string | null;
  source: 'instance_lock' | 'daemon_pid';
  version: string | null;
  startedAt: number | null;
}

export interface CurrentPointerTarget {
  targetPath?: string;
  version?: string;
  isSymbolicLink?: boolean;
  isDirectory?: boolean;
}

export type ServiceLaunchTargetSpec =
  | { kind: 'none' }
  | {
      kind: 'systemd';
      filePath: string;
      execStart: string;
      createIfMissing?: boolean;
      defaultUnitContent?: string;
    }
  | {
      kind: 'launchd';
      filePath: string;
      programArguments: string[];
      createIfMissing?: boolean;
      defaultPlistContent?: string;
    }
  | {
      kind: 'windows_watchdog';
      filePath: string;
      watchdogContent: string;
      createIfMissing?: boolean;
    };

export interface ServiceLaunchBackup {
  kind: 'systemd' | 'launchd' | 'windows_watchdog';
  filePath: string;
  existed: boolean;
  previousBytesBase64: string | null;
}

export interface RestartDaemonServiceSpec {
  platform?: DaemonRuntimePlatform;
  stateDir: string;
  nodePath?: string;
  entryPath?: string;
  systemdUnitPath?: string;
  systemdUnitName?: string;
  launchAgentPath?: string;
  windowsTask?: string;
  vbsPath?: string;
  restartCommand?: string;
  oldIdentity?: VerifiedDaemonIdentity | null;
  wasRunning?: boolean;
  log?: (msg: string) => void;
}

export interface DetachedSwitchConfig {
  platform: DaemonRuntimePlatform;
  runtimeRoot: string;
  stagedReleaseDir: string;
  previousTarget: string | null;
  targetVersion: string;
  stateDir: string;
  keepTargets: string[];
  lockOwnerToken?: string | null;
  targetNodePath?: string;
  targetEntryPath?: string;
  previousNodePath?: string;
  previousEntryPath?: string;
  systemdUnitPath?: string;
  systemdUnitName?: string;
  launchAgentPath?: string;
  windowsTask?: string;
  vbsPath?: string;
  restartCommand?: string;
  rollbackRestartCommand?: string;
  launchTargetSpec?: ServiceLaunchTargetSpec;
  healthCheckTimeoutMs?: number;
  settleMs?: number;
  logFile?: string;
}

export declare function sleepSync(ms: number): void;
export declare function isProcessAlive(pid: number): boolean;
export declare function probeProcessStartToken(pid: number, platform?: NodeJS.Platform): string | null;
export declare function readPackageVersionSync(layoutDir: string): string | undefined;

export declare function acquireRuntimeUpgradeLock(
  stateDir: string,
  options?: { waitMs?: number; staleMs?: number; mode?: string },
): RuntimeUpgradeLockHandle;
export declare function transferRuntimeUpgradeLock(
  stateDir: string,
  expectedOwnerToken: string,
  patch?: Record<string, unknown>,
): RuntimeUpgradeLockOwnerRecord;
export declare function claimHandoffRuntimeUpgradeLock(
  stateDir: string,
  expectedOwnerToken: string,
  patch?: Record<string, unknown>,
): RuntimeUpgradeLockOwnerRecord;
export declare function releaseRuntimeUpgradeLock(stateDir: string, expectedOwnerToken: string | null | undefined): boolean;

export declare function writeUpgradeCooldownSentinel(stateDir: string, nowMs?: number): string;
export declare function readVerifiedDaemonIdentity(stateDir: string, platform?: NodeJS.Platform): VerifiedDaemonIdentity | null;
export declare function stopVerifiedDaemon(
  identity: VerifiedDaemonIdentity | null | undefined,
  options?: { platform?: NodeJS.Platform; graceMs?: number },
): boolean;

export declare function readCurrentPointerTarget(runtimeRoot: string): CurrentPointerTarget;
export declare function switchDaemonRuntimeCurrentPointer(
  runtimeRoot: string,
  releaseDir: string,
  platform: DaemonRuntimePlatform,
  nowMs?: number,
): {
  currentLink: string;
  previousTarget?: string;
  previousVersion?: string;
  previousWasRealDir?: boolean;
};
export declare function rollbackDaemonRuntimeCurrentPointer(
  runtimeRoot: string,
  previousTarget: string | undefined,
  platform: DaemonRuntimePlatform,
  nowMs?: number,
): { restoredTarget?: string };
export declare function pruneOldDaemonRuntimeReleases(
  runtimeRoot: string,
  keepTargets?: readonly (string | undefined)[],
): string[];

export declare function updateSystemdExecStartContent(existingContent: string, newExecStart: string): string;
export declare function updateLaunchdProgramArgsPlist(existingXml: string, programArgs: readonly string[]): string;
export declare function prepareServiceLaunchTarget(spec: ServiceLaunchTargetSpec | null | undefined): ServiceLaunchBackup | null;
export declare function restoreServiceLaunchTarget(backup: ServiceLaunchBackup | null | undefined): boolean;
export declare function restartDaemonService(spec: RestartDaemonServiceSpec): {
  ok: boolean;
  mode: string;
  spawnedPid?: number | null;
};
export declare function waitForHealthyTargetDaemon(spec: {
  stateDir: string;
  expectedVersion: string;
  oldIdentity: VerifiedDaemonIdentity | null | undefined;
  restartBeganAtMs: number;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  settleMs?: number;
}): { pid: number; version: string; startToken: string | null };
export declare function runDetachedSwitchTransaction(cfg: DetachedSwitchConfig): boolean;
