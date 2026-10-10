import {
  CONTROLLED_NODE_ABI_PROFILE_FIELD, CONTROLLED_NODE_ABI_MODERN, CONTROLLED_NODE_ABI_GLIBC217, CONTROLLED_NODE_RUNTIME_ABI_PROFILE,
  normalizeControlledNodeAbiProfile, isControlledNodeAbiTarget, type ControlledNodeAbiProfile,
} from '../../shared/controlled-node-abi.js';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, mkdtemp, open, opendir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { tmpdir, uptime } from 'node:os';
import { basename, dirname, join, resolve, win32 as pathWin32 } from 'node:path';
import { promisify } from 'node:util';
import {
  CONTROLLED_NODE_ARCH_X64,
  CONTROLLED_NODE_ARTIFACT_ARCH_UNIVERSAL,
  CONTROLLED_NODE_ARTIFACT_ASSETS,
  CONTROLLED_NODE_ARTIFACT_HEADERS,
  CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH,
  controlledNodeComputerUseHelperFilename,
  CONTROLLED_NODE_OS_LINUX,
  CONTROLLED_NODE_OS_MAC,
  CONTROLLED_NODE_OS_WIN,
  type AideskLocalUiArtifactAsset,
  type ControlledNodeArtifactArch,
  type ControlledNodeOs,
} from '../../shared/controlled-node-artifacts.js';
import { DAEMON_UPGRADE_TARGET_LATEST, normalizeDaemonUpgradeTargetVersion } from '../../shared/daemon-upgrade.js';
import { isTransientRequestFailure } from '../../shared/request-failure.js';
import { compareImcodesVersions } from '../../shared/imcodes-version.js';
import {
  CONTROLLED_NODE_UPGRADE_RESULT_FILE,
  CONTROLLED_NODE_UPGRADE_RESULT_STATUS,
  CONTROLLED_NODE_WINDOWS_RELEASE_TRUST_PREFLIGHT_FAILURE,
  CONTROLLED_NODE_WINDOWS_RELEASE_MANIFEST_PREFLIGHT_FAILURE,
  CONTROLLED_NODE_WINDOWS_UPGRADE_PREFLIGHT_FAILED,
  CONTROLLED_NODE_WINDOWS_UPGRADE_TASK_PREFIX,
  CONTROLLED_NODE_WINDOWS_UPGRADE_PRODUCT,
  CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_VERSION,
} from '../../shared/controlled-node-service.js';
import { REMOTE_DESKTOP_PROTOCOL_VERSION } from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_MACOS_COMPONENT_ORDER,
  REMOTE_DESKTOP_MACOS_COMPONENT_SET_MANIFEST_MAX_BYTES,
  REMOTE_DESKTOP_MACOS_COMPONENT_SET_MAX_BYTES,
  REMOTE_DESKTOP_MACOS_COMPONENT_SET_PREFIX_BYTES,
  REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
  REMOTE_DESKTOP_WORKER_FILENAME,
  REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME,
  REMOTE_DESKTOP_LINUX_WORKER_FILENAME,
  REMOTE_DESKTOP_LINUX_WORKER_PLATFORM_DIR,
  REMOTE_DESKTOP_WORKER_SIDECAR_DIR,
  decodeRemoteDesktopMacosComponentSetPrefix,
  remoteDesktopMacosComponentSetFilename,
  validateRemoteDesktopWorkerManifest,
  validateRemoteDesktopWorkerReleaseManifest,
  validateRemoteDesktopLinuxWorkerManifest,
  type RemoteDesktopMacosArchitecture,
} from '../../shared/remote-desktop-worker.js';
import {
  WINDOWS_POWERSHELL_SECURITY_MODULE_PREFLIGHT,
  WINDOWS_POWERSHELL_UTILITY_MODULE_PREFLIGHT,
} from '../../shared/windows-powershell-modules.js';
import {
  CONTROLLED_NODE_SERVICE,
  encodeWindowsScheduledTaskXml,
  windowsComputerUseHelperAclCommands,
  windowsCredentialAclCommands,
  windowsExecutableFileAclCommands,
  WINDOWS_UPGRADE_MARKER_NAME,
  windowsPowerShellExecutablePath,
} from './installer.js';
import { defaultCredentialPath, defaultStagedExecutablePath, type ControlledNodeCredential } from './enrollment.js';
import { buildPosixControlledNodeUpgradeScript } from './posix-upgrade-script.js';
import { windowsUpgradeHealthWaitScript } from './upgrade-health-script.js';
import { windowsManifestBackupScript, windowsManifestRestoreScript } from './upgrade-manifest-script.js';
import { readUpgradeResult, reconcilePreviousUpgrade, removeStalePosixUpgradeFiles, type PreviousUpgradeFailure } from './upgrade-result.js';
import { DAEMON_VERSION } from '../util/version.js';
import { loadInstallJournal, INSTALL_JOURNAL_VERSION } from './install-journal.js';
import { WINDOWS_COMPILED_RELEASE_SIGNER_SHA256 } from './windows-artifact-trust.js';
import { verifyRemoteDesktopWorkerArtifact } from './remote-desktop-worker-host.js';
import logger from '../util/logger.js';

export const CONTROLLED_NODE_UPGRADE_DIR_PREFIX = 'imcodes-node-upgrade-';
export const CONTROLLED_NODE_UPGRADE_OWNERSHIP_MARKER = '.imcodes-controlled-node-upgrade.json';
export const CONTROLLED_NODE_UPGRADE_PROGRESS_FILE = '.imcodes-controlled-node-upgrade.progress.jsonl';
export const CONTROLLED_NODE_UPGRADE_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
export const CONTROLLED_NODE_UPGRADE_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const CONTROLLED_NODE_UPGRADE_MIN_FREE_BYTES = 512 * 1024 * 1024;
export const CONTROLLED_NODE_UPGRADE_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
/**
 * A pass reads the NAMES of at most this many entries of the temporary root (a name is matched against the staging
 * pattern, nothing else: no stat, no read). It used to count every entry against a limit of 128 that the staging
 * directories themselves shared, and a /tmp with thousands of other entries (15,067 on a real node, 155 of them stale
 * staging directories) never got past its first 128 entries in directory order, so the backlog was never reached.
 * Expensive work -- lstat, marker reads, deletes -- keeps its own hard bounds below.
 */
const CONTROLLED_NODE_UPGRADE_MAX_SCAN = 200_000;
/** Matching staging names kept per pass (the rest wait for a later pass). */
const CONTROLLED_NODE_UPGRADE_MAX_LISTED = 8_192;
/** While a pass stopped on its I/O budget with candidates left, the next one follows after this delay (bounded chain). */
export const CONTROLLED_NODE_UPGRADE_BACKLOG_PASS_DELAY_MS = 60_000;
export const CONTROLLED_NODE_UPGRADE_BACKLOG_MAX_PASSES = 64;
/** Worst case of one candidate: lstat x4 (directory + marker, checked twice), marker read x2, one delete. */
const CONTROLLED_NODE_UPGRADE_CANDIDATE_LSTATS = 4;
const CONTROLLED_NODE_UPGRADE_CANDIDATE_MARKER_READS = 2;
const CONTROLLED_NODE_UPGRADE_MAX_LSTAT = 128;
const CONTROLLED_NODE_UPGRADE_MAX_MARKER_READ = 64;
const CONTROLLED_NODE_UPGRADE_MAX_DELETE = 32;
const CONTROLLED_NODE_ARTIFACT_IO_BUFFER_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);

/**
 * Rollback runs outside the node process, so the node reports the durable result
 * after it reconnects. See reconcilePreviousUpgrade for what each recorded state
 * amounts to (including an upgrade/rollback script that died without a terminal
 * state, and a stale record next to a node that is in fact running the target).
 * The record is the same on every platform: the Windows and the POSIX upgrade
 * scripts both write it.
 */
export async function readPreviousUpgradeFailure(
  journalPath: string,
  runningVersion: string = DAEMON_VERSION,
  now: number = Date.now(),
  executablePath: string = defaultStagedExecutablePath(),
): Promise<PreviousUpgradeFailure | null> {
  try {
    const recorded = process.platform === 'win32' ? null : await readUpgradeResult(journalPath);
    const failure = await reconcilePreviousUpgrade({ journalPath, runningVersion, now });
    // A finished upgrade (record `success` for the version this node runs) no longer needs the rollback
    // images a killed POSIX script may have left: each is a full copy of the previous executable.
    if (recorded?.status === CONTROLLED_NODE_UPGRADE_RESULT_STATUS.SUCCESS && recorded.targetVersion === runningVersion) {
      await removeStalePosixUpgradeFiles(executablePath, journalPath);
    }
    return failure;
  } catch {
    return null;
  }
}

const CONTROLLED_NODE_UPGRADE_PRODUCT = CONTROLLED_NODE_WINDOWS_UPGRADE_PRODUCT;
const CONTROLLED_NODE_UPGRADE_DIR_PATTERN = /^imcodes-node-upgrade-[A-Za-z0-9_-]{6,128}$/;
const CONTROLLED_NODE_UPGRADE_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const activeControlledNodeUpgradeDirs = new Set<string>();
const scheduledUpgradeSweeps = new Set<string>();
/** Test seam: the staging directories of upgrades running in this process (the scavenger never touches them). */
export const activeControlledNodeUpgradeDirsForTests = activeControlledNodeUpgradeDirs;
/** Per temporary root: the last staging directory a pass examined, so the next pass continues after it instead of re-reading the same head. */
const scavengeCursors = new Map<string, string>();
const sweepsInFlight = new Set<string>();

export interface ControlledNodeUpgradeCleanupDiagnostic {
  event: 'controlled_node_upgrade_cleanup';
  phase: 'pre_handoff' | 'stale_scavenge';
  outcome: 'removed' | 'failed' | 'skipped';
  code: string;
}

export interface ControlledNodeArtifactTarget {
  abiProfile?: ControlledNodeAbiProfile;
  os: ControlledNodeOs;
  arch: ControlledNodeArtifactArch;
}

export interface ControlledNodeSelfUpgradeDeps {
  abiProfile?: ControlledNodeAbiProfile;
  fetchImpl?: typeof fetch;
  spawnDetached?: (file: string, args: readonly string[], options: { windowsHide?: boolean }) => void;
  scheduleWindowsUpgrade?: (taskName: string, taskXmlPath: string) => void;
  scheduleLinuxUpgrade?: (unitName: string, scriptPath: string) => void;
  execPath?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  tmpdir?: () => string;
  now?: () => number;
  uptime?: () => number;
  journalPath?: string;
  writeUpgradeFile?: typeof writeFile;
  removeUpgradeDir?: (path: string) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  onCleanupDiagnostic?: (diagnostic: ControlledNodeUpgradeCleanupDiagnostic) => void;
  onStaleScavengeOperation?: (operation: 'enumerate' | 'lstat' | 'marker_read' | 'delete') => void;
  beforeStaleCandidateRevalidation?: (candidatePath: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  freeBytes?: (path: string) => Promise<number | null>;
}

export interface ControlledNodeSelfUpgradeResult {
  ok: boolean;
  reason?: string;
  targetVersion: string;
  artifactSha256?: string;
  scriptPath?: string;
}

export interface ControlledNodeRemoteDesktopWorkerRefreshResult {
  updated: boolean;
  installedVersion?: string;
  targetVersion?: string;
  artifactSha256?: string;
  reason?: string;
  /** True when the refresh helper also reloaded/started the worker under its commit fence. */
  activated?: boolean;
}

export interface ControlledNodeRemoteDesktopWorkerCommitFence {
  /** Must be synchronous: once acquired, no new worker session may be admitted. */
  acquire: () => (() => void) | null;
}

export interface ControlledNodeRemoteDesktopWorkerRefreshContext {
  commitFence: ControlledNodeRemoteDesktopWorkerCommitFence;
}

export interface ControlledNodeRemoteDesktopWorkerRefreshDeps {
  credential: ArtifactDownloadCredential;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  root?: string;
  fetchImpl?: typeof fetch;
  downloadWindowsWorker?: typeof downloadControlledNodeRemoteDesktopWorker;
  downloadLinuxWorker?: typeof downloadControlledNodeLinuxRemoteDesktopWorker;
  extractVirtualDisplay?: (archivePath: string, destination: string) => Promise<void>;
  /** Test seam for pausing the first atomic rename and exercising the fence. */
  rename?: typeof rename;
  /** Final safety fence immediately before the on-disk worker swap. */
  canCommit?: () => boolean | Promise<boolean>;
  /** Short-lived runtime fence held through swap and worker activation. */
  commitFence?: ControlledNodeRemoteDesktopWorkerCommitFence;
  /** Reload/start the new worker while the commit fence remains held. */
  afterCommit?: (targetVersion: string) => Promise<void> | void;
}

async function defaultFreeBytes(path: string): Promise<number | null> {
  try {
    const filesystem = await statfs(path);
    return Number(filesystem.bavail) * Number(filesystem.bsize);
  } catch {
    // A platform/filesystem that cannot report free space must not make an
    // upgrade permanently unavailable. The staging and sweep guards remain
    // authoritative on the filesystems that support statfs.
    return null;
  }
}

type ScavengeDeps = Pick<ControlledNodeSelfUpgradeDeps,
  | 'now'
  | 'uptime'
  | 'removeUpgradeDir'
  | 'isProcessAlive'
  | 'onCleanupDiagnostic'
  | 'onStaleScavengeOperation'
  | 'beforeStaleCandidateRevalidation'>;

/**
 * One scheduled sweep: a bounded pass, then -- while a pass stopped on its I/O budget with candidates still unexamined --
 * short follow-up passes (each as bounded as the first) until the backlog is drained or the chain limit is reached; the
 * hourly timer starts the next chain, whose cursor continues where this one stopped.
 */
async function sweepWithBacklog(root: string, deps: ScavengeDeps, passesLeft = CONTROLLED_NODE_UPGRADE_BACKLOG_MAX_PASSES): Promise<void> {
  if (sweepsInFlight.has(root)) return;
  sweepsInFlight.add(root);
  let more = false;
  try {
    more = (await scavengeStaleControlledNodeUpgradePass(root, deps)).moreWork;
  } catch {
    more = false;
  } finally {
    sweepsInFlight.delete(root);
  }
  if (more && passesLeft > 1) {
    const timer = setTimeout(() => { void sweepWithBacklog(root, deps, passesLeft - 1); }, CONTROLLED_NODE_UPGRADE_BACKLOG_PASS_DELAY_MS);
    timer.unref?.();
  }
}

function ensurePeriodicUpgradeSweep(tempRoot: string, deps: ScavengeDeps): void {
  const canonicalRoot = resolve(tempRoot);
  if (scheduledUpgradeSweeps.has(canonicalRoot)) return;
  scheduledUpgradeSweeps.add(canonicalRoot);
  const timer = setInterval(() => {
    void sweepWithBacklog(canonicalRoot, deps);
  }, CONTROLLED_NODE_UPGRADE_SWEEP_INTERVAL_MS);
  timer.unref?.();
}

/**
 * Arm crash-recovery scavenging for the controlled-node process itself. This
 * is intentionally fire-and-forget: startup must not be blocked by a hostile
 * or unavailable temporary filesystem, while the hourly sweep remains active
 * for the lifetime of the process.
 */
export function startControlledNodeUpgradeScavenger(
  tempRoot: string = tmpdir(),
  deps: Pick<ControlledNodeSelfUpgradeDeps,
    | 'now'
    | 'uptime'
    | 'removeUpgradeDir'
    | 'isProcessAlive'
    | 'onCleanupDiagnostic'
    | 'onStaleScavengeOperation'
    | 'beforeStaleCandidateRevalidation'
  > = {},
): void {
  void sweepWithBacklog(resolve(tempRoot), deps);
  ensurePeriodicUpgradeSweep(tempRoot, deps);
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

interface ControlledNodeUpgradeOwnershipMarker {
  schemaVersion: 1;
  product: typeof CONTROLLED_NODE_UPGRADE_PRODUCT;
  directoryName: string;
  ownerToken: string;
  createdAt: number;
  pid: number;
}

function cleanupErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
  return /^[A-Z0-9_]{1,48}$/.test(code) ? code : 'unknown';
}

function emitCleanupDiagnostic(
  diagnostic: ControlledNodeUpgradeCleanupDiagnostic,
  deps: Pick<ControlledNodeSelfUpgradeDeps, 'onCleanupDiagnostic'>,
): void {
  if (deps.onCleanupDiagnostic) {
    try { deps.onCleanupDiagnostic(diagnostic); } catch { /* diagnostics never affect upgrade authority */ }
    return;
  }
  try { logger.warn(diagnostic, 'controlled node self-upgrade cleanup'); } catch { /* ENOSPC-safe diagnostics */ }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!(error && typeof error === 'object' && 'code' in error && error.code !== 'ESRCH');
  }
}

function parseUpgradeOwnershipMarker(value: string): ControlledNodeUpgradeOwnershipMarker | null {
  try {
    // Windows PowerShell 5.1's `Set-Content -Encoding utf8` writes a BOM. The
    // helper atomically refreshes pid ownership with that command, so recovery
    // must accept that one encoding difference without weakening the schema.
    const marker = JSON.parse(value.charCodeAt(0) === 0xfeff ? value.slice(1) : value) as Partial<ControlledNodeUpgradeOwnershipMarker>;
    if (marker.schemaVersion !== 1
      || marker.product !== CONTROLLED_NODE_UPGRADE_PRODUCT
      || typeof marker.directoryName !== 'string'
      || !CONTROLLED_NODE_UPGRADE_DIR_PATTERN.test(marker.directoryName)
      || typeof marker.ownerToken !== 'string'
      || !CONTROLLED_NODE_UPGRADE_TOKEN_PATTERN.test(marker.ownerToken)
      || typeof marker.createdAt !== 'number'
      || !Number.isSafeInteger(marker.createdAt)
      || marker.createdAt <= 0
      || typeof marker.pid !== 'number'
      || !Number.isSafeInteger(marker.pid)
      || marker.pid <= 0) return null;
    return marker as ControlledNodeUpgradeOwnershipMarker;
  } catch {
    return null;
  }
}

async function removeUpgradeDirBestEffort(
  path: string,
  phase: ControlledNodeUpgradeCleanupDiagnostic['phase'],
  deps: Pick<ControlledNodeSelfUpgradeDeps, 'removeUpgradeDir' | 'onCleanupDiagnostic'>,
): Promise<boolean> {
  try {
    const removeUpgradeDir = deps.removeUpgradeDir ?? (async (ownedPath: string) => {
      await rm(ownedPath, { recursive: true, force: true });
    });
    await removeUpgradeDir(path);
    emitCleanupDiagnostic({ event: 'controlled_node_upgrade_cleanup', phase, outcome: 'removed', code: 'ok' }, deps);
    return true;
  } catch (error) {
    emitCleanupDiagnostic({
      event: 'controlled_node_upgrade_cleanup',
      phase,
      outcome: 'failed',
      code: cleanupErrorCode(error),
    }, deps);
    return false;
  }
}

/**
 * Conservatively remove only old, directly-owned upgrade staging directories.
 * Every refusal is fail-open: an upgrade may continue, but unknown Temp content
 * is never traversed or deleted.
 */
export async function scavengeStaleControlledNodeUpgradePass(
  tempRoot: string,
  deps: ScavengeDeps = {},
): Promise<{ removed: number; moreWork: boolean }> {
  const now = deps.now?.() ?? Date.now();
  const cutoff = now - CONTROLLED_NODE_UPGRADE_STALE_AFTER_MS;
  const absoluteCutoff = now - CONTROLLED_NODE_UPGRADE_ABSOLUTE_TTL_MS;
  let bootedAt: number | null = null;
  try {
    const uptimeSeconds = deps.uptime?.() ?? uptime();
    if (Number.isFinite(uptimeSeconds) && uptimeSeconds >= 0) bootedAt = now - (uptimeSeconds * 1_000);
  } catch {
    // Missing boot-time evidence must not weaken the normal liveness guard.
  }
  const canonicalRoot = resolve(tempRoot);
  let removed = 0;
  let deleteAttempts = 0;
  let scanned = 0;
  let moreWork = false;
  let lstatOperations = 0;
  let markerReads = 0;
  let budgetDiagnosticEmitted = false;
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const emitSkipped = (code: 'pid_alive' | 'marker_missing' | 'budget_exhausted'): void => {
    emitCleanupDiagnostic({
      event: 'controlled_node_upgrade_cleanup',
      phase: 'stale_scavenge',
      outcome: 'skipped',
      code,
    }, deps);
  };
  const emitBudgetExhausted = (): void => {
    if (budgetDiagnosticEmitted) return;
    budgetDiagnosticEmitted = true;
    emitSkipped('budget_exhausted');
  };
  const markerOutlivedOwner = (marker: ControlledNodeUpgradeOwnershipMarker): boolean => (
    marker.createdAt <= absoluteCutoff
    || (bootedAt !== null && marker.createdAt < bootedAt)
  );
  const recordOperation = (operation: 'enumerate' | 'lstat' | 'marker_read' | 'delete'): void => {
    try { deps.onStaleScavengeOperation?.(operation); } catch { /* test/telemetry seam is non-authoritative */ }
  };
  const boundedLstat = async (path: string) => {
    if (lstatOperations >= CONTROLLED_NODE_UPGRADE_MAX_LSTAT) {
      emitBudgetExhausted();
      return null;
    }
    lstatOperations += 1;
    recordOperation('lstat');
    return lstat(path);
  };
  const boundedMarkerRead = async (path: string): Promise<string | null> => {
    if (markerReads >= CONTROLLED_NODE_UPGRADE_MAX_MARKER_READ) {
      emitBudgetExhausted();
      return null;
    }
    markerReads += 1;
    recordOperation('marker_read');
    return readFile(path, 'utf8');
  };
  const sameIdentity = (left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean => (
    left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs
    && left.ctimeMs === right.ctimeMs
  );

  try {
    // Phase 1: names only. Every entry of the root costs one pattern match (no stat, no read), up to a generous cap, so a
    // crowded root cannot hide the staging directories behind its first entries in directory order.
    const listed: string[] = [];
    const directory = await opendir(canonicalRoot);
    for await (const entry of directory) {
      if (scanned >= CONTROLLED_NODE_UPGRADE_MAX_SCAN) {
        emitBudgetExhausted();
        break;
      }
      scanned += 1;
      recordOperation('enumerate');
      if (!CONTROLLED_NODE_UPGRADE_DIR_PATTERN.test(entry.name)) continue;
      if (listed.length >= CONTROLLED_NODE_UPGRADE_MAX_LISTED) {
        emitBudgetExhausted();
        moreWork = true;
        break;
      }
      listed.push(entry.name);
    }
    // Phase 2: examine the staging directories, in a stable order that continues after the last one the previous pass
    // examined (wrapping), within the hard I/O budgets. Young or live directories at the front cannot starve the rest.
    listed.sort();
    const cursor = scavengeCursors.get(canonicalRoot);
    let startAt = 0;
    if (cursor !== undefined) {
      const after = listed.findIndex((name) => name > cursor);
      startAt = after < 0 ? 0 : after;
    }
    const order = [...listed.slice(startAt), ...listed.slice(0, startAt)];
    let lastExamined: string | undefined;
    let examinedAll = true;
    for (const name of order) {
      if (deleteAttempts >= CONTROLLED_NODE_UPGRADE_MAX_DELETE
        || lstatOperations + CONTROLLED_NODE_UPGRADE_CANDIDATE_LSTATS > CONTROLLED_NODE_UPGRADE_MAX_LSTAT
        || markerReads + CONTROLLED_NODE_UPGRADE_CANDIDATE_MARKER_READS > CONTROLLED_NODE_UPGRADE_MAX_MARKER_READ) {
        emitBudgetExhausted();
        examinedAll = false;
        break;
      }
      lastExamined = name;
      const entry = { name };
      const candidate = resolve(canonicalRoot, entry.name);
      // The candidate is accepted only as the exact direct child returned by
      // this directory iterator. No user-controlled traversal is canonicalized.
      if (dirname(candidate) !== canonicalRoot || basename(candidate) !== entry.name
        || activeControlledNodeUpgradeDirs.has(candidate)) continue;
      try {
        const directoryStat = await boundedLstat(candidate);
        if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()
          || directoryStat.mtimeMs > cutoff) continue;
        const markerPath = resolve(candidate, CONTROLLED_NODE_UPGRADE_OWNERSHIP_MARKER);
        if (dirname(markerPath) !== candidate) continue;
        let markerStat: Awaited<ReturnType<typeof lstat>> | null;
        try {
          markerStat = await boundedLstat(markerPath);
        } catch (error) {
          if (cleanupErrorCode(error) === 'ENOENT') emitSkipped('marker_missing');
          continue;
        }
        if (!markerStat || !markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.mtimeMs > cutoff) continue;
        const markerText = await boundedMarkerRead(markerPath);
        if (markerText === null) continue;
        const marker = parseUpgradeOwnershipMarker(markerText);
        if (!marker || marker.directoryName !== entry.name || marker.createdAt > cutoff) continue;
        if (!markerOutlivedOwner(marker)) {
          let alive = true;
          try { alive = isProcessAlive(marker.pid); } catch { alive = true; }
          if (alive) {
            emitSkipped('pid_alive');
            continue;
          }
        }

        await deps.beforeStaleCandidateRevalidation?.(candidate);

        // Final adjacent revalidation repeats every admission fact. Identity
        // equality binds the final lstat results to the same directory/marker
        // initially inspected. Node's rm unlinks a replacement root symlink;
        // it does not traverse it, while any detectable replacement is refused.
        if (resolve(canonicalRoot, entry.name) !== candidate
          || dirname(candidate) !== canonicalRoot
          || basename(candidate) !== entry.name
          || activeControlledNodeUpgradeDirs.has(candidate)) continue;
        const currentDirectoryStat = await boundedLstat(candidate);
        if (!currentDirectoryStat
          || !currentDirectoryStat.isDirectory() || currentDirectoryStat.isSymbolicLink()
          || !sameIdentity(directoryStat, currentDirectoryStat)
          || currentDirectoryStat.mtimeMs > cutoff) continue;
        let currentMarkerStat: Awaited<ReturnType<typeof lstat>> | null;
        try {
          currentMarkerStat = await boundedLstat(markerPath);
        } catch (error) {
          if (cleanupErrorCode(error) === 'ENOENT') emitSkipped('marker_missing');
          continue;
        }
        if (!currentMarkerStat
          || !currentMarkerStat.isFile() || currentMarkerStat.isSymbolicLink()
          || !sameIdentity(markerStat, currentMarkerStat)
          || currentMarkerStat.mtimeMs > cutoff) continue;
        const currentMarkerText = await boundedMarkerRead(markerPath);
        const currentMarker = currentMarkerText === null ? null : parseUpgradeOwnershipMarker(currentMarkerText);
        if (!currentMarker
          || currentMarkerText !== markerText
          || currentMarker.ownerToken !== marker.ownerToken
          || currentMarker.directoryName !== entry.name
          || currentMarker.createdAt > cutoff) continue;
        if (!markerOutlivedOwner(currentMarker)) {
          let alive = true;
          try { alive = isProcessAlive(currentMarker.pid); } catch { alive = true; }
          if (alive) {
            emitSkipped('pid_alive');
            continue;
          }
        }
        if (activeControlledNodeUpgradeDirs.has(candidate)) continue;
        // Consume the budget before calling an authority-external remover.
        // Failed/throwing attempts count just like successful removals, so a
        // full or hostile filesystem cannot turn fail-open cleanup into an
        // unbounded retry loop.
        deleteAttempts += 1;
        recordOperation('delete');
        if (await removeUpgradeDirBestEffort(candidate, 'stale_scavenge', deps)) removed += 1;
      } catch {
        // A racing, malformed, unreadable, or unowned entry is a refusal, not a
        // cleanup failure. Do not surface paths or recurse into it.
      }
    }
    if (examinedAll) scavengeCursors.delete(canonicalRoot);
    else if (lastExamined !== undefined) scavengeCursors.set(canonicalRoot, lastExamined);
    if (!examinedAll) moreWork = true;
  } catch (error) {
    emitCleanupDiagnostic({
      event: 'controlled_node_upgrade_cleanup',
      phase: 'stale_scavenge',
      outcome: 'failed',
      code: cleanupErrorCode(error),
    }, deps);
  }
  return { removed, moreWork };
}

/** One bounded pass; the number of staging directories it removed. */
export async function scavengeStaleControlledNodeUpgradeDirs(
  tempRoot: string,
  deps: ScavengeDeps = {},
): Promise<number> {
  return (await scavengeStaleControlledNodeUpgradePass(tempRoot, deps)).removed;
}

export function controlledNodeArtifactTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  abiProfile: ControlledNodeAbiProfile = CONTROLLED_NODE_RUNTIME_ABI_PROFILE,
): ControlledNodeArtifactTarget | null {
  if (abiProfile === CONTROLLED_NODE_ABI_GLIBC217) {
    return platform === 'linux' && arch === 'x64'
      ? { os: CONTROLLED_NODE_OS_LINUX, arch: CONTROLLED_NODE_ARCH_X64, abiProfile } : null;
  }
  if (abiProfile !== CONTROLLED_NODE_ABI_MODERN) return null;
  if (platform === 'win32' && arch === 'x64') return { os: CONTROLLED_NODE_OS_WIN, arch: CONTROLLED_NODE_ARCH_X64 };
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return { os: CONTROLLED_NODE_OS_MAC, arch: CONTROLLED_NODE_ARTIFACT_ARCH_UNIVERSAL };
  }
  if (platform === 'linux' && arch === 'x64') return { os: CONTROLLED_NODE_OS_LINUX, arch: CONTROLLED_NODE_ARCH_X64 };
  return null;
}

export function controlledNodeArtifactUpgradeUrl(
  credential: Pick<ControlledNodeCredential, 'serverUrl' | 'serverId'>,
  target: ControlledNodeArtifactTarget,
  asset: typeof CONTROLLED_NODE_ARTIFACT_ASSETS[keyof typeof CONTROLLED_NODE_ARTIFACT_ASSETS] = CONTROLLED_NODE_ARTIFACT_ASSETS.NODE,
): string {
  const url = new URL(CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH, credential.serverUrl);
  url.searchParams.set('serverId', credential.serverId);
  url.searchParams.set('os', target.os);
  url.searchParams.set('arch', target.arch);
  if (target.abiProfile !== undefined && target.abiProfile !== CONTROLLED_NODE_ABI_MODERN) url.searchParams.set(CONTROLLED_NODE_ABI_PROFILE_FIELD, target.abiProfile);
  if (asset !== CONTROLLED_NODE_ARTIFACT_ASSETS.NODE) url.searchParams.set('asset', asset);
  return url.toString();
}

function readHeader(headers: Headers, name: string): string | null {
  return headers.get(name) ?? headers.get(name.toLowerCase()) ?? headers.get(name.toUpperCase());
}

async function streamResponseBodyToFile(input: {
  response: Response;
  path: string;
  mode: number;
  expectedSize: number | null;
  onFirstChunk?: () => Promise<void>;
}): Promise<{ sha256: string; sizeBytes: number }> {
  if (!input.response.body) throw new Error('download_missing_body');
  const reader = input.response.body.getReader();
  const file = await open(input.path, 'wx', input.mode);
  const hash = createHash('sha256');
  let sizeBytes = 0;
  let firstChunkRecorded = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('download_invalid_body');
      if (!firstChunkRecorded && value.byteLength > 0) {
        await input.onFirstChunk?.();
        firstChunkRecorded = true;
      }
      sizeBytes += value.byteLength;
      if (!Number.isSafeInteger(sizeBytes)
        || (input.expectedSize !== null && sizeBytes > input.expectedSize)) {
        throw new Error('artifact_size_mismatch');
      }
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(value.subarray(offset));
        if (bytesWritten <= 0) throw new Error('artifact_write_failed');
        offset += bytesWritten;
      }
    }
    await file.sync();
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
    await file.close();
  }
  if (input.expectedSize !== null && sizeBytes !== input.expectedSize) {
    throw new Error('artifact_size_mismatch');
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

async function sha256File(path: string): Promise<string> {
  const file = await open(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(CONTROLLED_NODE_ARTIFACT_IO_BUFFER_BYTES);
  try {
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
  return hash.digest('hex');
}

const CONTROLLED_NODE_ARTIFACT_DOWNLOAD_RETRY_ATTEMPTS = 4;
const CONTROLLED_NODE_ARTIFACT_DOWNLOAD_RETRY_BASE_MS = 3_000;
const CONTROLLED_NODE_ARTIFACT_DOWNLOAD_RETRY_MAX_MS = 20_000;

/**
 * A transient connection failure partway through an ~80MB artifact download
 * (the observed real-world failure on a poor office link) must not fail the
 * whole upgrade attempt outright -- the outer server-driven retry cycle is a
 * full new handshake, tens of seconds slower per round trip than simply
 * re-requesting the same download. Only failures `isTransientRequestFailure`
 * recognizes are retried here; a real integrity, auth or version mismatch
 * (or the final attempt) still surfaces immediately.
 */
export async function withArtifactDownloadRetries<T>(
  attempt: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = options.attempts ?? CONTROLLED_NODE_ARTIFACT_DOWNLOAD_RETRY_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? CONTROLLED_NODE_ARTIFACT_DOWNLOAD_RETRY_BASE_MS;
  const maxDelayMs = options.maxDelayMs ?? CONTROLLED_NODE_ARTIFACT_DOWNLOAD_RETRY_MAX_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  let lastError: unknown;
  for (let n = 1; n <= attempts; n++) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (n === attempts || !isTransientRequestFailure(error)) throw error;
      await sleep(Math.min(maxDelayMs, baseDelayMs * (2 ** (n - 1))));
    }
  }
  throw lastError;
}

async function downloadArtifact(input: {
  credential: ArtifactDownloadCredential;
  target: ControlledNodeArtifactTarget;
  dir: string;
  fetchImpl: typeof fetch;
  asset?: typeof CONTROLLED_NODE_ARTIFACT_ASSETS[keyof typeof CONTROLLED_NODE_ARTIFACT_ASSETS];
  expectedFileName?: string;
  expectedVersion?: string;
  fileMode?: number;
  /** Upper bound for the declared size: a response without a size, or a larger one, is refused before a byte is written. */
  maxBytes?: number;
  /** Default true: the generic `<file>.manifest.json` record beside the download. Assets that have their own manifest turn it off. */
  writeManifest?: boolean;
  onProgress?: (phase: ControlledNodeArtifactDownloadPhase) => Promise<void>;
}): Promise<{ artifactPath: string; manifestPath: string; sha256: string; sizeBytes: number; filename: string; version?: string }> {
  const asset = input.asset ?? CONTROLLED_NODE_ARTIFACT_ASSETS.NODE;
  await input.onProgress?.('artifact_request_started');
  const response = await input.fetchImpl(controlledNodeArtifactUpgradeUrl(input.credential, input.target, asset), {
    headers: {
      Authorization: `Bearer ${input.credential.token}`,
      'X-Server-Id': input.credential.serverId,
      [CONTROLLED_NODE_ARTIFACT_HEADERS.REMOTE_DESKTOP_PROTOCOL_VERSION]: String(REMOTE_DESKTOP_PROTOCOL_VERSION),
    },
  });
  if (!response.ok) throw new Error(`download_failed_${response.status}`);
  const abiProfile = normalizeControlledNodeAbiProfile(input.target.abiProfile);
  if (!abiProfile || !isControlledNodeAbiTarget(input.target.os, input.target.arch, abiProfile)) throw new Error('invalid_artifact_abi_profile');
  if (asset === CONTROLLED_NODE_ARTIFACT_ASSETS.NODE) {
    const responseProfile = readHeader(response.headers, CONTROLLED_NODE_ARTIFACT_HEADERS.ABI_PROFILE);
    if (normalizeControlledNodeAbiProfile(responseProfile === null ? undefined : responseProfile) !== abiProfile) {
      await response.body?.cancel().catch(() => {});
      throw new Error('artifact_abi_profile_mismatch');
    }
  }
  const expectedSha = readHeader(response.headers, CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256);
  const filename = readHeader(response.headers, CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME) || basename(defaultStagedExecutablePath());
  if (input.expectedFileName && basename(filename) !== input.expectedFileName) throw new Error('artifact_filename_mismatch');
  const sizeHeader = readHeader(response.headers, CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES);
  const versionHeader = readHeader(response.headers, CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION)?.trim();
  const authenticodeSignerSha256 = readHeader(
    response.headers,
    CONTROLLED_NODE_ARTIFACT_HEADERS.AUTHENTICODE_SIGNER_SHA256,
  )?.trim().toLowerCase();
  if (!expectedSha || !/^[0-9a-f]{64}$/i.test(expectedSha)) throw new Error('missing_artifact_sha256');
  const expectedSize = sizeHeader && /^\d+$/.test(sizeHeader) ? Number(sizeHeader) : null;
  if (expectedSize !== null && !Number.isSafeInteger(expectedSize)) throw new Error('artifact_size_mismatch');
  if (input.maxBytes !== undefined && (expectedSize === null || expectedSize > input.maxBytes)) throw new Error('artifact_too_large');
  const artifactPath = join(input.dir, basename(filename));
  const partialArtifactPath = `${artifactPath}.download-${randomUUID()}`;
  const manifestPath = `${artifactPath}.manifest.json`;
  const fileMode = input.fileMode ?? 0o755;
  let downloaded: { sha256: string; sizeBytes: number } | null = null;
  try {
    await input.onProgress?.('artifact_response_open');
    downloaded = await streamResponseBodyToFile({
      response,
      path: partialArtifactPath,
      mode: fileMode,
      expectedSize,
      onFirstChunk: async () => input.onProgress?.('artifact_first_chunk'),
    });
    await input.onProgress?.('artifact_body_complete');
    if (downloaded.sha256 !== expectedSha.toLowerCase()) throw new Error('artifact_sha256_mismatch');
    if (input.expectedVersion && versionHeader !== input.expectedVersion) throw new Error('artifact_version_mismatch');
    if (input.target.os === CONTROLLED_NODE_OS_WIN && asset === CONTROLLED_NODE_ARTIFACT_ASSETS.NODE
      && (!authenticodeSignerSha256 || !/^[0-9a-f]{64}$/.test(authenticodeSignerSha256))) {
      throw new Error('missing_artifact_authenticode_signer_sha256');
    }
    if (process.platform !== 'win32') await chmod(partialArtifactPath, fileMode).catch(() => {});
    // Re-read what actually LANDED with the same fixed-size buffer. The first
    // digest proves the response stream, not the file; neither pass may retain
    // an entire native executable in a memory-constrained node process.
    const landedSha = await sha256File(partialArtifactPath);
    if (landedSha !== downloaded.sha256) throw new Error('artifact_write_sha256_mismatch');
    await input.onProgress?.('artifact_verified');
    await rename(partialArtifactPath, artifactPath);
    await input.onProgress?.('artifact_published');
  } catch (error) {
    await rm(partialArtifactPath, { force: true }).catch(() => {});
    throw error;
  }
  if (input.writeManifest === false) {
    return {
      artifactPath,
      manifestPath,
      sha256: downloaded.sha256,
      sizeBytes: downloaded.sizeBytes,
      filename: basename(filename),
      ...(versionHeader ? { version: versionHeader } : {}),
    };
  }
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    artifact: {
      fileName: basename(filename),
      os: input.target.os === CONTROLLED_NODE_OS_MAC ? 'darwin' : input.target.os === CONTROLLED_NODE_OS_WIN ? 'win32' : input.target.os,
      arch: input.target.arch,
      ...(abiProfile !== CONTROLLED_NODE_ABI_MODERN ? { abiProfile } : {}),
      size: downloaded.sizeBytes,
      sha256: downloaded.sha256,
      ...(authenticodeSignerSha256 ? { authenticodeSignerSha256 } : {}),
    },
    build: {
      source: 'controlled-node-self-upgrade',
      ...(versionHeader ? { version: versionHeader } : {}),
    },
  }, null, 2)}\n`, { mode: 0o644 });
  return {
    artifactPath,
    manifestPath,
    sha256: downloaded.sha256,
    sizeBytes: downloaded.sizeBytes,
    filename: basename(filename),
    ...(versionHeader ? { version: versionHeader } : {}),
  };
}

type ControlledNodeArtifactDownloadPhase =
  | 'artifact_request_started'
  | 'artifact_response_open'
  | 'artifact_first_chunk'
  | 'artifact_body_complete'
  | 'artifact_verified'
  | 'artifact_published';

function controlledNodePlatformArchKey(target: ControlledNodeArtifactTarget): string {
  const platform = target.os === CONTROLLED_NODE_OS_WIN
    ? 'win32'
    : target.os === CONTROLLED_NODE_OS_MAC
      ? 'darwin'
      : 'linux';
  return `${platform}-${target.arch}`;
}

/**
 * Download the signed runtime executable.
 *
 * A normal daemon uses this to obtain the carrier for its elevated
 * remote-desktop helper: its own code lives in a user-writable npm directory,
 * and nothing user-writable may be what a LocalSystem service executes.
 * Integrity comes from the server's pinned digest, and authenticity from the
 * publisher Windows names in the UAC prompt that installs it.
 */
export async function downloadControlledNodeExecutable(input: {
  credential: ArtifactDownloadCredential;
  target: ControlledNodeArtifactTarget;
  dir: string;
  fetchImpl: typeof fetch;
}): Promise<{ artifactPath: string; sha256: string; sizeBytes: number } | undefined> {
  await mkdir(input.dir, { recursive: true });
  try {
    const downloaded = await downloadArtifact({
      credential: input.credential,
      target: input.target,
      dir: input.dir,
      fetchImpl: input.fetchImpl,
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.NODE,
    });
    return {
      artifactPath: downloaded.artifactPath,
      sha256: downloaded.sha256,
      sizeBytes: downloaded.sizeBytes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^download_failed_(403|404|503)$/.test(message)) return undefined;
    throw error;
  }
}

/**
 * One file of the Windows panel window host sidecar (executable, manifest or third-party notices) into `dir`, under its fixed name.
 * `undefined` means "not published": the server has none (404/503) or this target has none -- the caller skips, it is not an error.
 */
export async function downloadControlledNodeAideskLocalUiFile(input: {
  credential: ArtifactDownloadCredential;
  dir: string;
  fetchImpl: typeof fetch;
  asset: AideskLocalUiArtifactAsset;
  expectedFileName: string;
  maxBytes: number;
}): Promise<{ artifactPath: string; sha256: string; sizeBytes: number } | undefined> {
  await mkdir(input.dir, { recursive: true });
  try {
    const downloaded = await downloadArtifact({
      credential: input.credential,
      target: { os: CONTROLLED_NODE_OS_WIN, arch: CONTROLLED_NODE_ARCH_X64 },
      dir: input.dir,
      fetchImpl: input.fetchImpl,
      asset: input.asset,
      expectedFileName: input.expectedFileName,
      maxBytes: input.maxBytes,
      writeManifest: false,
      fileMode: 0o644,
    });
    return { artifactPath: downloaded.artifactPath, sha256: downloaded.sha256, sizeBytes: downloaded.sizeBytes };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 400 = a server that does not know this asset yet (older than this node); 404/503 = not published here.
    if (/^download_failed_(400|404|503)$/.test(message)) return undefined;
    throw error;
  }
}

export async function downloadControlledNodeComputerUseHelper(input: {
  credential: ControlledNodeCredential;
  target: ControlledNodeArtifactTarget;
  dir: string;
  fetchImpl: typeof fetch;
}): Promise<{ helperDir: string; artifactPath: string; sha256: string; sizeBytes: number } | undefined> {
  const helperDir = join(input.dir, 'computer-use-helper', controlledNodePlatformArchKey(input.target));
  await mkdir(helperDir, { recursive: true });
  try {
    const downloaded = await downloadArtifact({
      credential: input.credential,
      target: input.target,
      dir: helperDir,
      fetchImpl: input.fetchImpl,
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.COMPUTER_USE_HELPER,
      expectedFileName: controlledNodeComputerUseHelperFilename(input.target.os),
      fileMode: input.target.os === CONTROLLED_NODE_OS_MAC ? 0o644 : 0o755,
    });
    return {
      helperDir,
      artifactPath: downloaded.artifactPath,
      sha256: downloaded.sha256,
      sizeBytes: downloaded.sizeBytes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^download_failed_(404|503)$/.test(message) || message === 'artifact_filename_mismatch') return undefined;
    throw error;
  }
}

/**
 * The credential fields an artifact download actually needs. A normal daemon
 * holds these too, and downloads the remote-desktop worker with them — it just
 * has no controlled-node role to claim.
 */
export type ArtifactDownloadCredential = Pick<ControlledNodeCredential, 'serverId' | 'token' | 'serverUrl'>;

/**
 * Fetch and unpack the macOS remote-desktop component set.
 *
 * The macOS components ship as ONE asset rather than four, because they are
 * only ever valid together: the manifest binds every component's digest, and a
 * set assembled from two releases would satisfy each file's own check while
 * pairing a worker with a launch agent that never spoke to it. The wire format
 * is `[magic][manifest length][manifest][components in canonical order]`, and
 * the same `shared/` helpers that wrote it read it back here.
 *
 * The unpacked directory is left containing EXACTLY the manifest and the
 * components it names -- the downloader's own sidecar and the archive itself
 * are removed -- because that is what the artifact store admits. Anything else
 * beside signed artifacts is a file nothing describes or verifies.
 *
 * Verification is deliberately NOT done here. This function produces a staging
 * directory; `verifyMacosRemoteDesktopArtifact` is what decides whether it may
 * be promoted, and it runs the same Apple checks the daemon runs on a user's
 * Mac.
 */
export async function downloadControlledNodeMacosRemoteDesktopComponentSet(input: {
  credential: ArtifactDownloadCredential;
  target: ControlledNodeArtifactTarget;
  dir: string;
  fetchImpl: typeof fetch;
  expectedVersion?: string;
  onProgress?: (phase: ControlledNodeArtifactDownloadPhase) => Promise<void>;
}): Promise<{ componentDirectory: string; manifestPath: string; artifactSha256: string } | undefined> {
  if (input.target.os !== CONTROLLED_NODE_OS_MAC) return undefined;
  const arch = input.target.arch;
  if (arch !== 'arm64' && arch !== 'x64') return undefined;
  const componentDirectory = join(input.dir, 'remote-desktop-worker', `darwin-${arch}`);
  await mkdir(componentDirectory, { recursive: true });
  const setFilename = remoteDesktopMacosComponentSetFilename(arch as RemoteDesktopMacosArchitecture);
  const download = await downloadArtifact({
    credential: input.credential,
    target: input.target,
    dir: componentDirectory,
    fetchImpl: input.fetchImpl,
    asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_MACOS_COMPONENT_SET,
    expectedFileName: setFilename,
    expectedVersion: input.expectedVersion,
    fileMode: 0o644,
    onProgress: input.onProgress,
  });
  const handle = await open(download.artifactPath, 'r');
  try {
    if (download.sizeBytes > REMOTE_DESKTOP_MACOS_COMPONENT_SET_MAX_BYTES) {
      throw new Error('remote_desktop_macos_component_set_too_large');
    }
    const prefix = Buffer.alloc(REMOTE_DESKTOP_MACOS_COMPONENT_SET_PREFIX_BYTES);
    const prefixRead = await handle.read(prefix, 0, prefix.length, 0);
    if (prefixRead.bytesRead !== prefix.length) {
      throw new Error('remote_desktop_macos_component_set_truncated');
    }
    const decoded = decodeRemoteDesktopMacosComponentSetPrefix(
      new Uint8Array(prefix.buffer, prefix.byteOffset, prefix.byteLength),
    );
    if (!decoded) throw new Error('remote_desktop_macos_component_set_prefix_invalid');
    const manifestBytes = Buffer.alloc(decoded.manifestSize);
    const manifestRead = await handle.read(
      manifestBytes, 0, manifestBytes.length, REMOTE_DESKTOP_MACOS_COMPONENT_SET_PREFIX_BYTES,
    );
    if (manifestRead.bytesRead !== manifestBytes.length
      || manifestBytes.length > REMOTE_DESKTOP_MACOS_COMPONENT_SET_MANIFEST_MAX_BYTES) {
      throw new Error('remote_desktop_macos_component_set_truncated');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      throw new Error('remote_desktop_macos_component_set_manifest_invalid');
    }
    // Validated WITHOUT the expected target, then compared explicitly. Passing
    // the target in makes the validator reject a mismatched architecture
    // itself, which collapses "this archive is corrupt" and "the server sent
    // the wrong slice" into one answer -- and the second is the one worth
    // naming, because it is not the node's fault and not fixable by retrying.
    const manifest = validateRemoteDesktopWorkerReleaseManifest(parsed);
    // Named, not a bare "invalid". A manifest this size has dozens of ways to
    // be wrong and the difference between "the server sent another
    // architecture" and "the archive is corrupt" decides what to do next.
    if (!manifest) throw new Error('remote_desktop_macos_component_set_manifest_rejected');
    if (manifest.os !== 'darwin' || manifest.arch !== arch) {
      throw new Error(`remote_desktop_macos_component_set_target_mismatch_${manifest.os}_${manifest.arch}`);
    }
    if (input.expectedVersion !== undefined && manifest.workerVersion !== input.expectedVersion) {
      throw new Error('remote_desktop_macos_component_set_version_mismatch');
    }
    // Sizes are taken from the manifest, and the total must account for the
    // whole file. A short last component would otherwise be written happily
    // and only fail later, as a digest mismatch that names the component
    // rather than the transfer.
    let offset = REMOTE_DESKTOP_MACOS_COMPONENT_SET_PREFIX_BYTES + manifestBytes.length;
    for (const kind of REMOTE_DESKTOP_MACOS_COMPONENT_ORDER) {
      const descriptor = manifest.components[kind];
      const target = join(componentDirectory, descriptor.fileName);
      // Copied through a fixed buffer rather than read whole: the worker alone
      // is tens of megabytes and this runs in a memory-constrained node.
      const out = await open(target, 'w', 0o755);
      try {
        const buffer = Buffer.alloc(Math.min(1024 * 1024, descriptor.size));
        let copied = 0;
        while (copied < descriptor.size) {
          const want = Math.min(buffer.length, descriptor.size - copied);
          const read = await handle.read(buffer, 0, want, offset + copied);
          if (read.bytesRead !== want) {
            throw new Error('remote_desktop_macos_component_set_truncated');
          }
          await out.write(buffer, 0, want);
          copied += want;
        }
      } finally {
        await out.close();
      }
      offset += descriptor.size;
    }
    if (offset !== download.sizeBytes) {
      throw new Error('remote_desktop_macos_component_set_size_mismatch');
    }
    const manifestPath = join(componentDirectory, REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME);
    await writeFile(manifestPath, manifestBytes, { mode: 0o644 });
    return { componentDirectory, manifestPath, artifactSha256: download.sha256 };
  } finally {
    await handle.close().catch(() => {});
    // The archive and the downloader's sidecar are not part of the set the
    // store admits, and a release directory that contains anything but the
    // manifest and its components is refused outright.
    await rm(download.artifactPath, { force: true }).catch(() => {});
    await rm(download.manifestPath, { force: true }).catch(() => {});
  }
}

export async function downloadControlledNodeRemoteDesktopWorker(input: {
  credential: ArtifactDownloadCredential;
  target: ControlledNodeArtifactTarget;
  dir: string;
  fetchImpl: typeof fetch;
  expectedVersion?: string;
}): Promise<{ workerDir: string; artifactPath: string; manifestPath: string; sha256: string } | undefined> {
  if (input.target.os !== CONTROLLED_NODE_OS_WIN || input.target.arch !== CONTROLLED_NODE_ARCH_X64) return undefined;
  const workerDir = join(input.dir, 'remote-desktop-worker', 'win32-x64');
  await mkdir(workerDir, { recursive: true });
  try {
    const executable = await downloadArtifact({
      credential: input.credential,
      target: input.target,
      dir: workerDir,
      fetchImpl: input.fetchImpl,
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER,
      expectedFileName: REMOTE_DESKTOP_WORKER_FILENAME,
      expectedVersion: input.expectedVersion,
      fileMode: 0o755,
    });
    const manifestFilename = `${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`;
    const manifestDownload = await downloadArtifact({
      credential: input.credential,
      target: input.target,
      dir: workerDir,
      fetchImpl: input.fetchImpl,
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST,
      expectedFileName: manifestFilename,
      expectedVersion: input.expectedVersion,
      fileMode: 0o644,
    });
    const manifest = validateRemoteDesktopWorkerManifest(
      JSON.parse(await readFile(manifestDownload.artifactPath, 'utf8')),
    );
    if (!manifest
      || (input.expectedVersion !== undefined && manifest.workerVersion !== input.expectedVersion)
      || manifest.sha256 !== executable.sha256
      || manifest.size !== executable.sizeBytes
      || manifest.fileName !== executable.filename) {
      throw new Error('remote_desktop_worker_manifest_mismatch');
    }
    const virtualDisplay = await downloadArtifact({
      credential: input.credential,
      target: input.target,
      dir: workerDir,
      fetchImpl: input.fetchImpl,
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_VIRTUAL_DISPLAY,
      expectedFileName: REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
      expectedVersion: input.expectedVersion,
      fileMode: 0o644,
    });
    if (virtualDisplay.sha256 !== manifest.virtualDisplay.sha256
      || virtualDisplay.sizeBytes !== manifest.virtualDisplay.size
      || virtualDisplay.filename !== manifest.virtualDisplay.archiveFileName) {
      throw new Error('remote_desktop_virtual_display_manifest_mismatch');
    }
    // downloadArtifact writes transport metadata next to every downloaded
    // asset. The virtual-display release manifest lives inside the signed ZIP,
    // so this generated sidecar is not part of the exact platform allowlist
    // consumed by the Windows upgrade script. Leaving it behind makes every
    // real downloaded upgrade fail closed before publication even though
    // hand-assembled qualification directories pass.
    await rm(virtualDisplay.manifestPath, { force: true });
    await rm(manifestDownload.manifestPath, { force: true });
    return {
      workerDir,
      artifactPath: executable.artifactPath,
      manifestPath: manifestDownload.artifactPath,
      sha256: executable.sha256,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An on-demand npm-daemon install has no runtime upgrade to publish and may
    // report an absent optional capability. A controlled-node self-upgrade
    // always supplies expectedVersion, making the same failures fatal before
    // its main executable can be scheduled.
    if (input.expectedVersion === undefined
      && (/^download_failed_(404|409|503)$/.test(message) || message === 'artifact_filename_mismatch')) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The Linux equivalent of downloadControlledNodeRemoteDesktopWorker above,
 * much smaller because there is no code-signing authority to pin, no
 * virtual-display sidecar, and no legacy v1 upgrade path to serve --
 * RemoteDesktopLinuxWorkerManifest (shared/remote-desktop-worker.ts) is
 * deliberately a two-field schema. Exists because bundling the worker
 * directly into the controlled-node build (build-node-exe.yml) only gets it
 * onto a FRESH install: self-upgrade replaces just the main executable's own
 * artifact, never a sidecar it does not own, so a node that was already
 * running before the worker existed -- or before a fixed build of it shipped
 * -- would otherwise never receive one.
 */
export async function downloadControlledNodeLinuxRemoteDesktopWorker(input: {
  credential: ArtifactDownloadCredential;
  target: ControlledNodeArtifactTarget;
  dir: string;
  fetchImpl: typeof fetch;
  expectedVersion?: string;
}): Promise<{ workerDir: string; artifactPath: string; manifestPath: string; sha256: string } | undefined> {
  if (input.target.os !== CONTROLLED_NODE_OS_LINUX || input.target.arch !== CONTROLLED_NODE_ARCH_X64) return undefined;
  const workerDir = join(input.dir, REMOTE_DESKTOP_WORKER_SIDECAR_DIR, REMOTE_DESKTOP_LINUX_WORKER_PLATFORM_DIR);
  await mkdir(workerDir, { recursive: true });
  try {
    const executable = await downloadArtifact({
      credential: input.credential,
      target: input.target,
      dir: workerDir,
      fetchImpl: input.fetchImpl,
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER,
      expectedFileName: REMOTE_DESKTOP_LINUX_WORKER_FILENAME,
      expectedVersion: input.expectedVersion,
      fileMode: 0o755,
    });
    const manifestFilename = `${REMOTE_DESKTOP_LINUX_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`;
    const manifestDownload = await downloadArtifact({
      credential: input.credential,
      target: input.target,
      dir: workerDir,
      fetchImpl: input.fetchImpl,
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST,
      expectedFileName: manifestFilename,
      expectedVersion: input.expectedVersion,
      fileMode: 0o644,
    });
    const manifest = validateRemoteDesktopLinuxWorkerManifest(
      JSON.parse(await readFile(manifestDownload.artifactPath, 'utf8')),
    );
    if (!manifest
      || (input.expectedVersion !== undefined && manifest.build.version !== input.expectedVersion)
      || manifest.artifact.sha256 !== executable.sha256
      || manifest.artifact.size !== executable.sizeBytes
      || manifest.artifact.fileName !== executable.filename) {
      throw new Error('remote_desktop_worker_manifest_mismatch');
    }
    await rm(manifestDownload.manifestPath, { force: true });
    return {
      workerDir,
      artifactPath: executable.artifactPath,
      manifestPath: manifestDownload.artifactPath,
      sha256: executable.sha256,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (input.expectedVersion === undefined
      && (/^download_failed_(404|409|503)$/.test(message) || message === 'artifact_filename_mismatch')) {
      return undefined;
    }
    throw error;
  }
}

export function buildWindowsControlledNodeUpgradeScript(input: {
  stagedArtifactPath: string;
  stagedManifestPath: string;
  targetVersion?: string;
  artifactSha256?: string;
  stagedComputerUseHelperDir?: string;
  stagedRemoteDesktopWorkerDir?: string;
  stagedJournalPath?: string;
  destinationPath: string;
  destinationManifestPath: string;
  destinationJournalPath?: string;
  upgradeTaskName?: string;
  stagingOwnership?: {
    directoryPath: string;
    markerPath: string;
    ownerToken: string;
  };
}): string {
  const checkedAclCommand = (entry: readonly string[], optional: boolean): string => {
    const [target, ...args] = entry;
    const invoke = `& (Join-Path $env:WINDIR 'System32\\icacls.exe') ${psQuote(target!)} ${args.map(psQuote).join(' ')}; $aclExitCode = $LASTEXITCODE; if ($aclExitCode -ne 0) { throw 'Windows ACL hardening failed' }`;
    return optional ? `if (Test-Path ${psQuote(target!)}) { ${invoke} }` : invoke;
  };
  const helperDir = pathWin32.join(
    pathWin32.dirname(input.destinationPath),
    'computer-use-helper',
  );
  const exeAcl = windowsExecutableFileAclCommands(input.destinationPath)
    .map((entry) => checkedAclCommand(entry, false))
    .join('\r\n');
  const helperAcl = windowsComputerUseHelperAclCommands(helperDir)
    .map((entry) => checkedAclCommand(entry, true))
    .join('\r\n');
  const remoteDesktopWorkerDir = pathWin32.join(
    pathWin32.dirname(input.destinationPath),
    'remote-desktop-worker',
  );
  const remoteDesktopWorkerExe = pathWin32.join(
    remoteDesktopWorkerDir,
    'win32-x64',
    REMOTE_DESKTOP_WORKER_FILENAME,
  );
  const remoteDesktopWorkerManifest = `${remoteDesktopWorkerExe}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`;
  const remoteDesktopWorkerAcl = [
    ...windowsExecutableFileAclCommands(remoteDesktopWorkerExe),
    ...windowsExecutableFileAclCommands(remoteDesktopWorkerManifest),
  ].map((entry) => checkedAclCommand(entry, true))
    .join('\r\n');
  const pendingRemoteDesktopAcl = windowsCredentialAclCommands(`${remoteDesktopWorkerDir}.new`)
    .map((entry) => checkedAclCommand(entry, false))
    .join('\r\n');
  const upgradeTaskCleanup = input.upgradeTaskName
    ? `try { Unregister-ScheduledTask -TaskName ${psQuote(input.upgradeTaskName)} -Confirm:$false -ErrorAction Stop } catch { Write-Warning 'IMCODES_UPGRADE_CLEANUP_FAILED phase=helper_finally code=task_unregister_failed' }\r\n`
    : '';
  const stagingCleanup = input.stagingOwnership
    ? `try {\r\n`
      + `  $stagingItem = Get-Item -LiteralPath $stagingDir -Force -ErrorAction Stop\r\n`
      + `  $stagingMarkerItem = Get-Item -LiteralPath $stagingOwnershipMarker -Force -ErrorAction Stop\r\n`
      + `  $stagingMarker = Get-Content -LiteralPath $stagingOwnershipMarker -Raw -ErrorAction Stop | ConvertFrom-Json\r\n`
      + `  if (-not $stagingItem.PSIsContainer -or ($stagingItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $stagingMarkerItem.PSIsContainer -or ($stagingMarkerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $stagingItem.Name -cnotmatch '^imcodes-node-upgrade-[A-Za-z0-9_-]{6,128}$' -or [int]$stagingMarker.schemaVersion -ne 1 -or [string]$stagingMarker.product -cne ${psQuote(CONTROLLED_NODE_UPGRADE_PRODUCT)} -or [string]$stagingMarker.directoryName -cne $stagingItem.Name -or [string]$stagingMarker.ownerToken -cne $stagingOwnerToken) { throw 'staging ownership refused' }\r\n`
      + `  Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction Stop\r\n`
      + `} catch { Write-Warning 'IMCODES_UPGRADE_CLEANUP_FAILED phase=helper_finally code=cleanup_refused_or_failed' }\r\n`
    : '';
  const stagingActivation = input.stagingOwnership
    ? `$stagingItem = Get-Item -LiteralPath $stagingDir -Force -ErrorAction Stop\r\n`
      + `$stagingMarkerItem = Get-Item -LiteralPath $stagingOwnershipMarker -Force -ErrorAction Stop\r\n`
      + `$stagingMarkerState = Get-Content -LiteralPath $stagingOwnershipMarker -Raw -ErrorAction Stop | ConvertFrom-Json\r\n`
      + `if (-not $stagingItem.PSIsContainer -or ($stagingItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $stagingMarkerItem.PSIsContainer -or ($stagingMarkerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $stagingItem.Name -cnotmatch '^imcodes-node-upgrade-[A-Za-z0-9_-]{6,128}$' -or [int]$stagingMarkerState.schemaVersion -ne 1 -or [string]$stagingMarkerState.product -cne ${psQuote(CONTROLLED_NODE_UPGRADE_PRODUCT)} -or [string]$stagingMarkerState.directoryName -cne $stagingItem.Name -or [string]$stagingMarkerState.ownerToken -cne $stagingOwnerToken) { throw 'staging ownership activation refused' }\r\n`
      + `$stagingMarkerState.pid = $PID\r\n`
      + `$stagingMarkerTemp = "$stagingOwnershipMarker.active-$PID"\r\n`
      + `try { $stagingMarkerState | ConvertTo-Json -Compress | Set-Content -LiteralPath $stagingMarkerTemp -Encoding utf8 -ErrorAction Stop; Move-Item -LiteralPath $stagingMarkerTemp -Destination $stagingOwnershipMarker -Force -ErrorAction Stop } finally { Remove-Item -LiteralPath $stagingMarkerTemp -Force -ErrorAction SilentlyContinue }\r\n`
    : '';
  const powershellModulePreflight = WINDOWS_POWERSHELL_SECURITY_MODULE_PREFLIGHT
    + WINDOWS_POWERSHELL_UTILITY_MODULE_PREFLIGHT;
  const releaseArtifactPreflight = `$trustedReleaseSigner = ${psQuote(WINDOWS_COMPILED_RELEASE_SIGNER_SHA256)}\r\n`
    + `if ($trustedReleaseSigner -cnotmatch '^[a-f0-9]{64}$') { throw 'controlled node build has no Windows release trust anchor' }\r\n`
    + `$verifyReleaseArtifact = { param([string]$path)\r\n`
    + `  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'signed Windows release artifact is missing' }\r\n`
    + `  $signature = Get-AuthenticodeSignature -LiteralPath $path; if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) { throw 'Windows release artifact Authenticode verification failed' }\r\n`
    + `  $sha256 = [System.Security.Cryptography.SHA256]::Create(); try { $signer = [BitConverter]::ToString($sha256.ComputeHash($signature.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant() } finally { $sha256.Dispose() }; if ($signer -cne $trustedReleaseSigner) { throw 'Windows release artifact signer mismatch' }\r\n`
    + `}\r\n`
    + `& $verifyReleaseArtifact $src\r\n`
    + `if (-not (Test-Path -LiteralPath $srcManifest -PathType Leaf)) { throw 'controlled node release manifest is missing' }\r\n`
    + `$srcNodeManifest = Get-Content -LiteralPath $srcManifest -Raw | ConvertFrom-Json\r\n`
    + `$srcHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $src).Hash.ToLowerInvariant()\r\n`
    + `if ([int]$srcNodeManifest.schemaVersion -ne 1 -or [string]$srcNodeManifest.artifact.fileName -cne 'imcodes-node.exe' -or [string]$srcNodeManifest.artifact.os -cne 'win32' -or [string]$srcNodeManifest.artifact.arch -cne 'x64' -or [int64]$srcNodeManifest.artifact.size -ne (Get-Item -LiteralPath $src).Length -or [string]$srcNodeManifest.artifact.sha256 -cne $srcHash -or [string]$srcNodeManifest.artifact.authenticodeSignerSha256 -cne $trustedReleaseSigner) { throw ${psQuote(CONTROLLED_NODE_WINDOWS_RELEASE_MANIFEST_PREFLIGHT_FAILURE)} }\r\n`
    + `if (${psQuote(input.artifactSha256 ?? '')} -and $srcHash -cne ${psQuote(input.artifactSha256 ?? '')}) { throw 'controlled node staged artifact hash differs from upgrade authority' }\r\n`
    + `$srcManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $srcManifest).Hash.ToLowerInvariant()\r\n`
    + `$mainArtifactVerified = $true\r\n`
    + (input.stagedComputerUseHelperDir
      ? `$srcHelper = ${psQuote(input.stagedComputerUseHelperDir)}\r\n`
        + `$srcHelperExe = Join-Path $srcHelper 'open-computer-use.exe'\r\n`
        + `& $verifyReleaseArtifact $srcHelperExe\r\n`
        + `$helperArtifactVerified = $true\r\n`
      : '');
  const remoteDesktopPreflight = input.stagedRemoteDesktopWorkerDir
    ? `$srcRemoteDesktop = ${psQuote(input.stagedRemoteDesktopWorkerDir)}\r\n`
      + `$srcRemoteDesktopPlatform = Join-Path $srcRemoteDesktop 'win32-x64'\r\n`
      + `$srcRemoteDesktopExe = Join-Path $srcRemoteDesktopPlatform ${psQuote(REMOTE_DESKTOP_WORKER_FILENAME)}\r\n`
      + `$srcRemoteDesktopManifestPath = "$srcRemoteDesktopExe${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}"\r\n`
      + `if (-not (Test-Path -LiteralPath $srcRemoteDesktopExe) -or -not (Test-Path -LiteralPath $srcRemoteDesktopManifestPath)) { throw 'remote desktop worker artifact set is incomplete' }\r\n`
      + `$srcRemoteDesktopManifest = Get-Content -LiteralPath $srcRemoteDesktopManifestPath -Raw | ConvertFrom-Json\r\n`
      + `if ([int]$srcRemoteDesktopManifest.manifestVersion -ne 2 -or $srcRemoteDesktopManifest.fileName -ne ${psQuote(REMOTE_DESKTOP_WORKER_FILENAME)} -or [int64]$srcRemoteDesktopManifest.size -ne (Get-Item -LiteralPath $srcRemoteDesktopExe).Length) { throw 'remote desktop worker manifest identity mismatch' }\r\n`
      + `$srcRemoteDesktopHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $srcRemoteDesktopExe).Hash.ToLowerInvariant()\r\n`
      + `if ($srcRemoteDesktopHash -ne [string]$srcRemoteDesktopManifest.sha256) { throw 'remote desktop worker hash verification failed' }\r\n`
      + `$srcRemoteDesktopSignature = Get-AuthenticodeSignature -LiteralPath $srcRemoteDesktopExe\r\n`
      + `if ($srcRemoteDesktopSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $srcRemoteDesktopSignature.SignerCertificate) { throw ${psQuote(CONTROLLED_NODE_WINDOWS_RELEASE_TRUST_PREFLIGHT_FAILURE)} }\r\n`
      + `$srcRemoteDesktopSha256Algorithm = [System.Security.Cryptography.SHA256]::Create()\r\n`
      + `try { $srcRemoteDesktopSignerSha256 = [BitConverter]::ToString($srcRemoteDesktopSha256Algorithm.ComputeHash($srcRemoteDesktopSignature.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant() } finally { $srcRemoteDesktopSha256Algorithm.Dispose() }\r\n`
      + `if ($srcRemoteDesktopSignerSha256 -ne [string]$srcRemoteDesktopManifest.authenticodeSignerSha256) { throw 'remote desktop worker signer mismatch' }\r\n`
      + `if ($srcRemoteDesktopSignerSha256 -cne ${psQuote(WINDOWS_COMPILED_RELEASE_SIGNER_SHA256)}) { throw 'remote desktop worker signer is not trusted by this controlled node build' }\r\n`
      + `$srcVirtualDisplayArchive = Join-Path $srcRemoteDesktopPlatform ${psQuote(REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME)}\r\n`
      + `if (-not (Test-Path -LiteralPath $srcVirtualDisplayArchive) -or [int64]$srcRemoteDesktopManifest.virtualDisplay.size -ne (Get-Item -LiteralPath $srcVirtualDisplayArchive).Length) { throw 'virtual display archive identity mismatch' }\r\n`
      + `$srcVirtualDisplayHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $srcVirtualDisplayArchive).Hash.ToLowerInvariant()\r\n`
      + `if ($srcVirtualDisplayHash -ne [string]$srcRemoteDesktopManifest.virtualDisplay.sha256) { throw 'virtual display archive hash verification failed' }\r\n`
      + `$srcVirtualDisplay = Join-Path $srcRemoteDesktopPlatform 'virtual-display'\r\n`
      + `Remove-Item -Recurse -Force $srcVirtualDisplay -ErrorAction SilentlyContinue\r\n`
      + `Expand-Archive -LiteralPath $srcVirtualDisplayArchive -DestinationPath $srcVirtualDisplay -Force\r\n`
      + `$srcVirtualDisplayManifestPath = Join-Path $srcVirtualDisplay ${psQuote(REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME)}\r\n`
      + `if (-not (Test-Path -LiteralPath $srcVirtualDisplayManifestPath)) { throw 'virtual display package manifest missing' }\r\n`
      + `$srcVirtualDisplayManifest = Get-Content -LiteralPath $srcVirtualDisplayManifestPath -Raw | ConvertFrom-Json\r\n`
      + `if ([int]$srcVirtualDisplayManifest.manifestVersion -ne 1 -or [string]$srcVirtualDisplayManifest.hardwareId -ne 'ImcodesVirtualDisplay') { throw 'virtual display package identity mismatch' }\r\n`
      + `$expectedVirtualDisplayFiles = @('imcodes-virtual-display.dll','imcodes-virtual-display.inf','imcodes-virtual-display.cat','LICENSE.microsoft.txt','THIRD_PARTY_NOTICES.webrtc.md')\r\n`
      + `if (@($srcVirtualDisplayManifest.files).Count -ne $expectedVirtualDisplayFiles.Count) { throw 'virtual display package file count mismatch' }\r\n`
      + `foreach ($expectedVirtualDisplayFile in $expectedVirtualDisplayFiles) { $entry = @($srcVirtualDisplayManifest.files | Where-Object { [string]$_.name -ceq $expectedVirtualDisplayFile }); if ($entry.Count -ne 1) { throw 'virtual display package file identity mismatch' }; $path = Join-Path $srcVirtualDisplay $expectedVirtualDisplayFile; if (-not (Test-Path -LiteralPath $path) -or [int64]$entry[0].size -ne (Get-Item -LiteralPath $path).Length -or [string]$entry[0].sha256 -cne (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()) { throw 'virtual display package file verification failed' } }\r\n`
      + `foreach ($signedVirtualDisplayFile in @('imcodes-virtual-display.dll','imcodes-virtual-display.cat')) { $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $srcVirtualDisplay $signedVirtualDisplayFile); if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) { throw 'virtual display Authenticode verification failed' }; $sha256Algorithm = [System.Security.Cryptography.SHA256]::Create(); try { $signerSha256 = [BitConverter]::ToString($sha256Algorithm.ComputeHash($signature.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant() } finally { $sha256Algorithm.Dispose() }; if ($signerSha256 -ne $srcRemoteDesktopSignerSha256) { throw 'virtual display signer mismatch' } }\r\n`
      + `$srcRemoteDesktopManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $srcRemoteDesktopManifestPath).Hash.ToLowerInvariant()\r\n`
      + `$verifyRemoteDesktopArtifactSet = { param([string]$root,[string]$workerHash,[string]$manifestHash,[string]$archiveHash,[string]$trustedSigner)\r\n`
      + `  $rootEntries = @(Get-ChildItem -LiteralPath $root -Force); if ($rootEntries.Count -ne 1 -or $rootEntries[0].Name -cne 'win32-x64' -or -not $rootEntries[0].PSIsContainer -or ($rootEntries[0].Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'remote desktop artifact root contains unexpected entries' }\r\n`
      + `  $platform = Join-Path $root 'win32-x64'; $exe = Join-Path $platform ${psQuote(REMOTE_DESKTOP_WORKER_FILENAME)}; $manifestPath = "$exe${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}"; $archive = Join-Path $platform ${psQuote(REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME)}; $virtualDisplay = Join-Path $platform 'virtual-display'\r\n`
      + `  $platformEntries = @(Get-ChildItem -LiteralPath $platform -Force); $expectedPlatformEntries = @(${psQuote(REMOTE_DESKTOP_WORKER_FILENAME)},${psQuote(`${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`)},${psQuote(REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME)},'virtual-display'); if ($platformEntries.Count -ne $expectedPlatformEntries.Count) { throw 'remote desktop platform directory contains unexpected entries' }; foreach ($expected in $expectedPlatformEntries) { if (@($platformEntries | Where-Object { $_.Name -ceq $expected }).Count -ne 1) { throw 'remote desktop platform entry mismatch' } }\r\n`
      + `  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant() -cne $workerHash -or (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant() -cne $manifestHash -or (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -cne $archiveHash) { throw 'remote desktop copied artifact hash mismatch' }\r\n`
      + `  $workerSignature = Get-AuthenticodeSignature -LiteralPath $exe; if ($workerSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $workerSignature.SignerCertificate) { throw 'remote desktop copied worker Authenticode verification failed' }; $workerSha256 = [System.Security.Cryptography.SHA256]::Create(); try { $workerSigner = [BitConverter]::ToString($workerSha256.ComputeHash($workerSignature.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant() } finally { $workerSha256.Dispose() }; if ($workerSigner -cne $trustedSigner) { throw 'remote desktop copied worker signer mismatch' }\r\n`
      + `  $packageManifestPath = Join-Path $virtualDisplay ${psQuote(REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME)}; $packageManifest = Get-Content -LiteralPath $packageManifestPath -Raw | ConvertFrom-Json; if ([int]$packageManifest.manifestVersion -ne 1 -or [string]$packageManifest.hardwareId -cne 'ImcodesVirtualDisplay') { throw 'virtual display copied package identity mismatch' }; $expectedFiles = @('imcodes-virtual-display.dll','imcodes-virtual-display.inf','imcodes-virtual-display.cat','LICENSE.microsoft.txt','THIRD_PARTY_NOTICES.webrtc.md'); if (@($packageManifest.files).Count -ne $expectedFiles.Count) { throw 'virtual display copied package manifest count mismatch' }; $packageEntries = @(Get-ChildItem -LiteralPath $virtualDisplay -Force); if ($packageEntries.Count -ne ($expectedFiles.Count + 1)) { throw 'virtual display package contains unexpected entries' }; foreach ($expected in @($expectedFiles + ${psQuote(REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME)})) { $actual = @($packageEntries | Where-Object { $_.Name -ceq $expected }); if ($actual.Count -ne 1 -or $actual[0].PSIsContainer -or ($actual[0].Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'virtual display copied package entry mismatch' } }\r\n`
      + `  foreach ($expected in $expectedFiles) { $entry = @($packageManifest.files | Where-Object { [string]$_.name -ceq $expected }); $path = Join-Path $virtualDisplay $expected; if ($entry.Count -ne 1 -or [int64]$entry[0].size -ne (Get-Item -LiteralPath $path).Length -or [string]$entry[0].sha256 -cne (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()) { throw 'virtual display copied package file verification failed' } }\r\n`
      + `  foreach ($signed in @('imcodes-virtual-display.dll','imcodes-virtual-display.cat')) { $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $virtualDisplay $signed); if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) { throw 'virtual display copied Authenticode verification failed' }; $sha256 = [System.Security.Cryptography.SHA256]::Create(); try { $signer = [BitConverter]::ToString($sha256.ComputeHash($signature.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant() } finally { $sha256.Dispose() }; if ($signer -cne $trustedSigner) { throw 'virtual display copied signer mismatch' } }\r\n`
      + `}\r\n`
      + `& $verifyRemoteDesktopArtifactSet $srcRemoteDesktop $srcRemoteDesktopHash $srcRemoteDesktopManifestHash $srcVirtualDisplayHash $srcRemoteDesktopSignerSha256\r\n`
      + `$remoteDesktopArtifactVerified = $true\r\n`
    : '';
  const helperVariables = input.stagedComputerUseHelperDir
    ? `$dstHelper = ${psQuote(helperDir)}\r\n`
      + `$pendingHelper = "$dstHelper.new"\r\n`
      + `$backupHelper = "$dstHelper.upgrade-old"\r\n`
      + `$dstHelperExe = Join-Path $dstHelper 'open-computer-use.exe'\r\n`
      + `$dstHelperManifest = "$dstHelperExe.manifest.json"\r\n`
      + `$currentHelperHash = ''\r\n`
      + `$currentHelperManifestHash = ''\r\n`
    : '';
  const verifyRollbackHelper = input.stagedComputerUseHelperDir
    ? `if ((Get-FileHash -Algorithm SHA256 -LiteralPath $dstHelperExe).Hash.ToLowerInvariant() -cne $currentHelperHash) { throw 'computer-use helper rollback hash mismatch' }; if ($currentHelperManifestHash -and (Get-FileHash -Algorithm SHA256 -LiteralPath $dstHelperManifest).Hash.ToLowerInvariant() -cne $currentHelperManifestHash) { throw 'computer-use helper manifest rollback hash mismatch' }`
    : '';
  const helperSwap = input.stagedComputerUseHelperDir
    ? `Remove-Item -Recurse -Force $pendingHelper,$backupHelper -ErrorAction SilentlyContinue\r\n`
      + `New-Item -ItemType Directory -Force $pendingHelper | Out-Null\r\n`
      + `Copy-Item -Recurse -Force -Path (Join-Path $srcHelper '*') -Destination $pendingHelper\r\n`
      + `& $verifyReleaseArtifact (Join-Path $pendingHelper 'open-computer-use.exe')\r\n`
      + `if (Test-Path $dstHelper) { ${verifyRollbackHelper}; Move-Item -Force $dstHelper $backupHelper; $dstHelperExe = Join-Path $backupHelper 'open-computer-use.exe'; $dstHelperManifest = "$dstHelperExe.manifest.json"; ${verifyRollbackHelper}; $dstHelperExe = Join-Path $dstHelper 'open-computer-use.exe'; $dstHelperManifest = "$dstHelperExe.manifest.json"; $helperBackedUp = $true }\r\n`
      + `Move-Item -Force $pendingHelper $dstHelper\r\n`
      + `$helperPublished = $true\r\n`
      + `& $verifyReleaseArtifact (Join-Path $dstHelper 'open-computer-use.exe')\r\n`
    : '';
  const helperRollback = input.stagedComputerUseHelperDir
    ? `if ($helperPublished -and (Test-Path $dstHelper)) { Remove-Item -Recurse -Force $dstHelper }\r\n`
      + `if ($helperBackedUp -and (Test-Path $backupHelper)) { $dstHelperExe = Join-Path $backupHelper 'open-computer-use.exe'; $dstHelperManifest = "$dstHelperExe.manifest.json"; ${verifyRollbackHelper}; Move-Item -Force $backupHelper $dstHelper; $dstHelperExe = Join-Path $dstHelper 'open-computer-use.exe'; $dstHelperManifest = "$dstHelperExe.manifest.json"; ${verifyRollbackHelper} }\r\n`
      + `Remove-Item -Recurse -Force $pendingHelper -ErrorAction SilentlyContinue\r\n`
    : '';
  const helperCleanup = input.stagedComputerUseHelperDir
    ? `Remove-Item -Recurse -Force $backupHelper,$pendingHelper -ErrorAction SilentlyContinue\r\n`
    : '';
  const remoteDesktopVariables = input.stagedRemoteDesktopWorkerDir
    ? `$dstRemoteDesktop = ${psQuote(remoteDesktopWorkerDir)}\r\n`
      + `$pendingRemoteDesktop = "$dstRemoteDesktop.new"\r\n`
      + `$backupRemoteDesktop = "$dstRemoteDesktop.upgrade-old"\r\n`
      + `$rollbackRemoteDesktopWorkerHash = ''\r\n`
      + `$rollbackRemoteDesktopManifestHash = ''\r\n`
      + `$rollbackRemoteDesktopArchiveHash = ''\r\n`
    : '';
  const remoteDesktopSwap = input.stagedRemoteDesktopWorkerDir
    ? `Remove-Item -Recurse -Force $pendingRemoteDesktop,$backupRemoteDesktop -ErrorAction SilentlyContinue\r\n`
      + `New-Item -ItemType Directory -Force $pendingRemoteDesktop | Out-Null\r\n`
      + pendingRemoteDesktopAcl + `\r\n`
      + `Copy-Item -Recurse -Force -Path (Join-Path $srcRemoteDesktop '*') -Destination $pendingRemoteDesktop\r\n`
      + `& $verifyRemoteDesktopArtifactSet $pendingRemoteDesktop $srcRemoteDesktopHash $srcRemoteDesktopManifestHash $srcVirtualDisplayHash $srcRemoteDesktopSignerSha256\r\n`
      + `if (Test-Path $dstRemoteDesktop) { & $verifyRemoteDesktopArtifactSet $dstRemoteDesktop $rollbackRemoteDesktopWorkerHash $rollbackRemoteDesktopManifestHash $rollbackRemoteDesktopArchiveHash $trustedReleaseSigner; Move-Item -Force $dstRemoteDesktop $backupRemoteDesktop; & $verifyRemoteDesktopArtifactSet $backupRemoteDesktop $rollbackRemoteDesktopWorkerHash $rollbackRemoteDesktopManifestHash $rollbackRemoteDesktopArchiveHash $trustedReleaseSigner; $remoteDesktopBackedUp = $true }\r\n`
      + `Move-Item -Force $pendingRemoteDesktop $dstRemoteDesktop\r\n`
      + `$remoteDesktopPublished = $true\r\n`
    : '';
  const remoteDesktopRollback = input.stagedRemoteDesktopWorkerDir
    ? `if ($remoteDesktopPublished -and (Test-Path $dstRemoteDesktop)) { Remove-Item -Recurse -Force $dstRemoteDesktop }\r\n`
      + `if ($remoteDesktopBackedUp -and (Test-Path $backupRemoteDesktop)) { & $verifyRemoteDesktopArtifactSet $backupRemoteDesktop $rollbackRemoteDesktopWorkerHash $rollbackRemoteDesktopManifestHash $rollbackRemoteDesktopArchiveHash $trustedReleaseSigner; Move-Item -Force $backupRemoteDesktop $dstRemoteDesktop; & $verifyRemoteDesktopArtifactSet $dstRemoteDesktop $rollbackRemoteDesktopWorkerHash $rollbackRemoteDesktopManifestHash $rollbackRemoteDesktopArchiveHash $trustedReleaseSigner }\r\n`
      + `Remove-Item -Recurse -Force $pendingRemoteDesktop -ErrorAction SilentlyContinue\r\n`
    : '';
  const remoteDesktopCleanup = input.stagedRemoteDesktopWorkerDir
    ? `Remove-Item -Recurse -Force $backupRemoteDesktop,$pendingRemoteDesktop -ErrorAction SilentlyContinue\r\n`
    : '';
  const virtualDisplayDriverInventory = input.stagedRemoteDesktopWorkerDir
    ? `$driverInventoryAvailable = $false\r\n`
      + `$previousVirtualDisplayDrivers = @()\r\n`
      + `$newVirtualDisplayDrivers = @()\r\n`
      + `try { $previousVirtualDisplayDrivers = @(Get-WindowsDriver -Online -All | Where-Object { [IO.Path]::GetFileName([string]$_.OriginalFileName) -ceq 'imcodes-virtual-display.inf' -and [string]$_.ProviderName -ceq 'IM.codes' -and [string]$_.ClassName -ceq 'Display' }); $driverInventoryAvailable = $true } catch { $driverInventoryAvailable = $false }\r\n`
    : '';
  const installedArtifactPreflight = `$currentMainHash = ''\r\n`
    + `$currentManifestHash = ''\r\n`
    + `if (-not (Test-Path -LiteralPath $dst -PathType Leaf)) { throw 'installed controlled node executable is missing' }\r\n`
    + `$currentMainHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dst).Hash.ToLowerInvariant()\r\n`
    + `if (Test-Path -LiteralPath $dstManifest) { $currentManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dstManifest).Hash.ToLowerInvariant() }\r\n`
    + (input.stagedComputerUseHelperDir
      ? `if ((Test-Path -LiteralPath $dstHelper) -and -not (Test-Path -LiteralPath $dstHelperExe -PathType Leaf)) { throw 'installed computer-use helper directory is incomplete' }; if (Test-Path -LiteralPath $dstHelperExe) { $currentHelperHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dstHelperExe).Hash.ToLowerInvariant(); if (Test-Path -LiteralPath $dstHelperManifest) { $currentHelperManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dstHelperManifest).Hash.ToLowerInvariant() } }\r\n`
      : '')
    + (input.stagedRemoteDesktopWorkerDir
      ? `if (Test-Path -LiteralPath $dstRemoteDesktop) { $rollbackRemoteDesktopPlatform = Join-Path $dstRemoteDesktop 'win32-x64'; $rollbackRemoteDesktopExe = Join-Path $rollbackRemoteDesktopPlatform ${psQuote(REMOTE_DESKTOP_WORKER_FILENAME)}; $rollbackRemoteDesktopManifest = "$rollbackRemoteDesktopExe${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}"; $rollbackRemoteDesktopArchive = Join-Path $rollbackRemoteDesktopPlatform ${psQuote(REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME)}; $rollbackRemoteDesktopWorkerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $rollbackRemoteDesktopExe).Hash.ToLowerInvariant(); $rollbackRemoteDesktopManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $rollbackRemoteDesktopManifest).Hash.ToLowerInvariant(); $rollbackRemoteDesktopArchiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $rollbackRemoteDesktopArchive).Hash.ToLowerInvariant(); & $verifyRemoteDesktopArtifactSet $dstRemoteDesktop $rollbackRemoteDesktopWorkerHash $rollbackRemoteDesktopManifestHash $rollbackRemoteDesktopArchiveHash $trustedReleaseSigner }\r\n`
      : '');
  const releasePreflightGuard = `try {\r\n`
      + stagingActivation
      + powershellModulePreflight
      + releaseArtifactPreflight
      + remoteDesktopPreflight
      + installedArtifactPreflight
      + virtualDisplayDriverInventory
      + `} catch {\r\n`
      + `$failureMessage = [string]$_.Exception.Message\r\n`
      + `if ($failureMessage.Length -gt 240) { $failureMessage = $failureMessage.Substring(0, 240) }\r\n`
      + `$upgradeResultPersisted = $false\r\n`
      + `try { $upgradeResultPersisted = [bool](& $writeUpgradeResult @{ status = ${psQuote(CONTROLLED_NODE_WINDOWS_UPGRADE_PREFLIGHT_FAILED)}; phase = 'preflight'; error = $failureMessage; reason = $failureMessage; completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }) } catch { Write-Warning 'IMCODES_UPGRADE_RESULT_PERSIST_FAILED phase=preflight' }\r\n`
      + upgradeTaskCleanup
      + stagingCleanup
      + `throw\r\n`
      + `}\r\n`
  ;
  const journalVariables = input.stagedJournalPath && input.destinationJournalPath
    ? `$dstJournal = ${psQuote(input.destinationJournalPath)}\r\n`
      + `$srcJournal = ${psQuote(input.stagedJournalPath)}\r\n`
      + `$backupJournal = "$dstJournal.upgrade-old"\r\n`
    : '';
  const journalPublish = input.stagedJournalPath && input.destinationJournalPath
    ? `if ((Test-Path $dstJournal) -and -not (Test-Path $backupJournal)) { Copy-Item -Force $dstJournal $backupJournal; $journalBackedUp = $true } elseif (Test-Path $backupJournal) { $journalBackedUp = $true }\r\n`
      + `if (Test-Path $srcJournal) { $pendingJournal = "$dstJournal.pending-$PID"; $journalSwapBackup = "$dstJournal.swap-old-$PID"; Remove-Item -Force $journalSwapBackup -ErrorAction SilentlyContinue; Copy-Item -Force $srcJournal $pendingJournal; if (Test-Path $dstJournal) { [IO.File]::Replace($pendingJournal, $dstJournal, $journalSwapBackup, $true); Remove-Item -Force $journalSwapBackup -ErrorAction SilentlyContinue } else { Move-Item -LiteralPath $pendingJournal -Destination $dstJournal }; $journalPublished = $true }\r\n`
    : '';
  const journalRollback = input.stagedJournalPath && input.destinationJournalPath
    ? `if ($journalBackedUp -and (Test-Path $backupJournal)) { Copy-Item -Force $backupJournal $dstJournal } elseif ($journalPublished) { Remove-Item -Force $dstJournal -ErrorAction SilentlyContinue }\r\n`
    : '';
  const journalCleanup = input.stagedJournalPath && input.destinationJournalPath
    ? `Remove-Item -Force $backupJournal -ErrorAction SilentlyContinue\r\n`
    : '';
  const transactionIntent = input.stagedJournalPath && input.destinationJournalPath && input.upgradeTaskName
    ? `$transactionMarkerTemp = "$upgradeMarker.pending-$PID"\r\n`
      + `if (-not (Test-Path -LiteralPath $upgradeMarker)) {\r\n`
      + `  $previousJournal = Get-Content -LiteralPath $dstJournal -Raw | ConvertFrom-Json\r\n`
      + `  $targetJournal = Get-Content -LiteralPath $srcJournal -Raw | ConvertFrom-Json\r\n`
      + `  $transaction = [ordered]@{ version = ${CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_VERSION}; product = ${psQuote(CONTROLLED_NODE_WINDOWS_UPGRADE_PRODUCT)}; startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); targetVersion = ${psQuote(input.targetVersion ?? '')}; taskName = ${psQuote(input.upgradeTaskName)}; executablePath = $dst; backupExecutablePath = $backupDst; journalPath = $dstJournal; backupJournalPath = $backupJournal; previousReceipt = $previousJournal.stagedReceipt; targetReceipt = $targetJournal.stagedReceipt }\r\n`
      + `  [IO.File]::WriteAllText($transactionMarkerTemp, ($transaction | ConvertTo-Json -Compress -Depth 8), [Text.UTF8Encoding]::new($false))\r\n`
      + `  Move-Item -Force -LiteralPath $transactionMarkerTemp -Destination $upgradeMarker\r\n`
      + `}\r\n`
    : `@{ version = 1; startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress | Set-Content -LiteralPath $upgradeMarker -Encoding utf8\r\n`;
  return `$ErrorActionPreference = 'Stop'\r\n`
    + `Start-Sleep -Seconds 3\r\n`
    + `$task = ${psQuote(CONTROLLED_NODE_SERVICE.WINDOWS_TASK)}\r\n`
    + `$dst = ${psQuote(input.destinationPath)}\r\n`
    + `$src = ${psQuote(input.stagedArtifactPath)}\r\n`
    + `$dstManifest = ${psQuote(input.destinationManifestPath)}\r\n`
    + `$srcManifest = ${psQuote(input.stagedManifestPath)}\r\n`
    + (input.stagingOwnership
      ? `$stagingDir = ${psQuote(input.stagingOwnership.directoryPath)}\r\n`
        + `$stagingOwnershipMarker = ${psQuote(input.stagingOwnership.markerPath)}\r\n`
        + `$stagingOwnerToken = ${psQuote(input.stagingOwnership.ownerToken)}\r\n`
      : '')
    + `$upgradeResult = "$src.upgrade-result.json"\r\n`
    + `Remove-Item -Force $upgradeResult -ErrorAction SilentlyContinue\r\n`
    + `$persistentUpgradeResult = Join-Path (Split-Path -Parent $dst) '${CONTROLLED_NODE_UPGRADE_RESULT_FILE}'\r\n`
    + `$upgradeResultPersisted = $false\r\n`
    + `$mainArtifactVerified = $false\r\n`
    + `$helperArtifactVerified = $false\r\n`
    + `$remoteDesktopArtifactVerified = $false\r\n`
    + `$writeUpgradeResult = { param([hashtable]$record)\r\n`
    + `  $record.schemaVersion = 1\r\n`
    + `  if (-not $record.ContainsKey('recordedAt')) { $record.recordedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }\r\n`
    + `  $record.targetVersion = ${psQuote(input.targetVersion ?? '')}\r\n`
    + `  $record.artifactSha256 = ${psQuote(input.artifactSha256 ?? '')}\r\n`
    + `  $record.mainArtifactVerified = [bool]$mainArtifactVerified\r\n`
    + `  $record.helperArtifactVerified = [bool]$helperArtifactVerified\r\n`
    + `  $record.remoteDesktopArtifactVerified = [bool]$remoteDesktopArtifactVerified\r\n`
    + `  $resultJson = $record | ConvertTo-Json -Compress -Depth 4\r\n`
    + `  try { [IO.File]::WriteAllText($upgradeResult, $resultJson, [Text.UTF8Encoding]::new($false)) } catch { Write-Warning 'IMCODES_UPGRADE_RESULT_STAGE_WRITE_FAILED' }\r\n`
    + `  $persistentUpgradeResultTemp = "$persistentUpgradeResult.pending-$PID"\r\n`
    + `  try {\r\n`
    + `    [IO.File]::WriteAllText($persistentUpgradeResultTemp, $resultJson, [Text.UTF8Encoding]::new($false))\r\n`
    + `    Move-Item -Force -LiteralPath $persistentUpgradeResultTemp -Destination $persistentUpgradeResult\r\n`
    + `    return $true\r\n`
    + `  } finally { Remove-Item -Force -LiteralPath $persistentUpgradeResultTemp -ErrorAction SilentlyContinue }\r\n`
    + `}\r\n`
    + windowsUpgradeHealthWaitScript()
    + `$upgradePhase = 'preflight'\r\n`
    + `$healthLease = Join-Path (Split-Path -Parent $dst) 'health-lease.json'\r\n`
    + `$upgradeMarker = Join-Path (Split-Path -Parent $dst) ${psQuote(WINDOWS_UPGRADE_MARKER_NAME)}\r\n`
    + `$backupDst = "$dst.upgrade-old"\r\n`
    + `$backupManifest = "$dstManifest.upgrade-old"\r\n`
    + `$mainBackedUp = $false\r\n`
    + `$mainPublished = $false\r\n`
    + `$manifestBackedUp = $false\r\n`
    + `$rollbackManifestHash = ''\r\n`
    + `$manifestPublished = $false\r\n`
    + `$helperBackedUp = $false\r\n`
    + `$helperPublished = $false\r\n`
    + `$remoteDesktopBackedUp = $false\r\n`
    + `$remoteDesktopPublished = $false\r\n`
    + `$virtualDisplayDriverInstalled = $false\r\n`
    + `$journalBackedUp = $false\r\n`
    + `$journalPublished = $false\r\n`
    + `$healthy = $false\r\n`
    + `$transactionTerminal = $false\r\n`
    + helperVariables
    + remoteDesktopVariables
    + journalVariables
    + `$recoveryFailures = [System.Collections.Generic.List[string]]::new()\r\n`
    + `$rollbackProgress = [System.Collections.Generic.List[string]]::new()\r\n`
    + `$runRecovery = { param([string]$label,[scriptblock]$action) try { & $action; [void]$rollbackProgress.Add($label); try { [void](& $writeUpgradeResult @{ status = '${CONTROLLED_NODE_UPGRADE_RESULT_STATUS.ROLLBACK_STARTED}'; phase = 'rollback'; failedPhase = $upgradePhase; error = $failureMessage; reason = $failureMessage; rollbackProgress = @($rollbackProgress) }) } catch { } } catch { $recoveryFailure = ('{0}: {1}' -f $label, [string]$_.Exception.Message); if ($recoveryFailure.Length -gt 240) { $recoveryFailure = $recoveryFailure.Substring(0, 240) }; [void]$recoveryFailures.Add($recoveryFailure) } }\r\n`
    + `$waitForNodeExecutableRelease = { param([int]$timeoutMs = 30000)\r\n`
    + `  $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $timeoutMs\r\n`
    + `  $passes = 0\r\n`
    + `  do {\r\n`
    + `    $passes++\r\n`
    // Get-Process, not WMI: a single WMI query took 3 minutes on a loaded real node, blowing the whole
    // deadline in one pass and failing a stop that had in fact succeeded.
    + `    $matchingProcesses = @(Get-Process -Name imcodes-node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [string]::Equals($_.Path, $dst, [StringComparison]::OrdinalIgnoreCase) })\r\n`
    + `    foreach ($matchingProcess in $matchingProcesses) { Stop-Process -Id $matchingProcess.Id -Force -ErrorAction SilentlyContinue }\r\n`
    + `    $exclusiveHandle = $null\r\n`
    + `    try {\r\n`
    + `      if (Test-Path -LiteralPath $dst) { $exclusiveHandle = [IO.File]::Open($dst, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }\r\n`
    + `      if ($matchingProcesses.Count -eq 0) { return }\r\n`
    + `    } catch [IO.IOException] { } finally { if ($exclusiveHandle) { $exclusiveHandle.Dispose() } }\r\n`
    + `    [Threading.Thread]::Sleep(250)\r\n`
    // Always one verification pass AFTER the kill, however slow the first pass was.
    + `  } while ($passes -lt 2 -or [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline)\r\n`
    + `  throw 'controlled node executable remained locked after stop'\r\n`
    + `}\r\n`
    + releasePreflightGuard
    + `$upgradePhase = 'install'\r\n`
    + `try {\r\n`
    + transactionIntent
    // The previous attempt's outcome is replaced the moment this one begins: a
    // stale rolled_back/rollback_started record must never outlive a transaction
    // that has since succeeded, and `in_progress` is what a killed script leaves.
    + `try { [void](& $writeUpgradeResult @{ status = '${CONTROLLED_NODE_UPGRADE_RESULT_STATUS.IN_PROGRESS}'; phase = 'install' }) } catch { Write-Warning 'IMCODES_UPGRADE_RESULT_PERSIST_FAILED phase=in_progress' }\r\n`
    + `$rollbackMainHash = $currentMainHash\r\n`
    + `try { $durableTransaction = Get-Content -LiteralPath $upgradeMarker -Raw | ConvertFrom-Json; if ([int]$durableTransaction.version -eq ${CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_VERSION} -and [string]$durableTransaction.previousReceipt.sha256 -cmatch '^[a-f0-9]{64}$') { $rollbackMainHash = [string]$durableTransaction.previousReceipt.sha256 } } catch { }\r\n`
    + `Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue\r\n`
    + `& $waitForNodeExecutableRelease\r\n`
    + `$publishAtomic = { param([string]$source,[string]$destination,[string]$backup) $pending = "$destination.pending-$PID"; Remove-Item -Force -LiteralPath $pending -ErrorAction SilentlyContinue; Copy-Item -Force -LiteralPath $source -Destination $pending; if (Test-Path -LiteralPath $destination) { [IO.File]::Replace($pending, $destination, $backup, $true) } else { Move-Item -LiteralPath $pending -Destination $destination }; }\r\n`
    + `$currentPublishedHash = if (Test-Path -LiteralPath $dst) { (Get-FileHash -Algorithm SHA256 -LiteralPath $dst).Hash.ToLowerInvariant() } else { '' }\r\n`
    + `if ($currentPublishedHash -cne $srcHash) {\r\n`
    + `  if ($currentPublishedHash -cne $rollbackMainHash -and (Test-Path -LiteralPath $backupDst) -and (Get-FileHash -Algorithm SHA256 -LiteralPath $backupDst).Hash.ToLowerInvariant() -eq $rollbackMainHash) { & $publishAtomic $backupDst $dst "$dst.recovery-discard"; Remove-Item -Force "$dst.recovery-discard" -ErrorAction SilentlyContinue }\r\n`
    + `  if ((Test-Path -LiteralPath $dst) -and (Get-FileHash -Algorithm SHA256 -LiteralPath $dst).Hash.ToLowerInvariant() -cne $rollbackMainHash) { throw 'controlled node interrupted upgrade has no trusted publication base' }\r\n`
    + `  Remove-Item -Force $backupDst -ErrorAction SilentlyContinue\r\n`
    + `  & $publishAtomic $src $dst $backupDst\r\n`
    + `}\r\n`
    + `$mainBackedUp = Test-Path -LiteralPath $backupDst\r\n`
    + `$mainPublished = $true\r\n`
    + `& $verifyReleaseArtifact $dst\r\n`
    + windowsManifestBackupScript()
    + `$pendingManifest = "$dstManifest.pending-$PID"; $manifestSwapBackup = "$dstManifest.swap-old-$PID"; Remove-Item -Force $manifestSwapBackup -ErrorAction SilentlyContinue; Copy-Item -Force -LiteralPath $srcManifest -Destination $pendingManifest; if (Test-Path -LiteralPath $dstManifest) { [IO.File]::Replace($pendingManifest, $dstManifest, $manifestSwapBackup, $true); Remove-Item -Force $manifestSwapBackup -ErrorAction SilentlyContinue } else { Move-Item -LiteralPath $pendingManifest -Destination $dstManifest }\r\n`
    + `if ((Get-FileHash -Algorithm SHA256 -LiteralPath $dstManifest).Hash.ToLowerInvariant() -cne $srcManifestHash) { throw 'controlled node published manifest hash mismatch' }\r\n`
    + `$manifestPublished = $true\r\n`
    + helperSwap
    + remoteDesktopSwap
    + journalPublish
    + exeAcl + `\r\n`
    + helperAcl + `\r\n`
    + remoteDesktopWorkerAcl + `\r\n`
    + (input.stagedRemoteDesktopWorkerDir
      ? `& $verifyRemoteDesktopArtifactSet $dstRemoteDesktop $srcRemoteDesktopHash $srcRemoteDesktopManifestHash $srcVirtualDisplayHash $srcRemoteDesktopSignerSha256\r\n`
        + `$virtualDisplayInf = Join-Path (Join-Path (Join-Path $dstRemoteDesktop 'win32-x64') 'virtual-display') 'imcodes-virtual-display.inf'\r\n`
        + `& (Join-Path $env:WINDIR 'System32\\pnputil.exe') /add-driver $virtualDisplayInf /install\r\n`
        + `$driverInstallExitCode = $LASTEXITCODE\r\n`
        + `if ($driverInstallExitCode -ne 0 -and $driverInstallExitCode -ne 3010) { throw 'virtual display driver installation failed' }\r\n`
        + `if ($driverInventoryAvailable) { try { $currentVirtualDisplayDrivers = @(Get-WindowsDriver -Online -All | Where-Object { [IO.Path]::GetFileName([string]$_.OriginalFileName) -ceq 'imcodes-virtual-display.inf' -and [string]$_.ProviderName -ceq 'IM.codes' -and [string]$_.ClassName -ceq 'Display' }); $newVirtualDisplayDrivers = @($currentVirtualDisplayDrivers | Where-Object { $previousVirtualDisplayDrivers.Driver -cnotcontains $_.Driver }); if ($newVirtualDisplayDrivers.Count -gt 1) { $newVirtualDisplayDrivers = @(); $driverInventoryAvailable = $false } } catch { $newVirtualDisplayDrivers = @(); $driverInventoryAvailable = $false } }\r\n`
        + `$virtualDisplayDriverInstalled = $newVirtualDisplayDrivers.Count -eq 1\r\n`
      : '')
    + `Remove-Item -Force $healthLease -ErrorAction SilentlyContinue\r\n`
    + `$upgradeStartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()\r\n`
    + `$upgradePhase = 'restart_health'\r\n`
    + `Start-ScheduledTask -TaskName $task\r\n`
    + `$healthResult = Wait-IMCodesNodeHealthy -LeasePath $healthLease -NodePath $dst -StartedAtMs $upgradeStartedAt\r\n`
    + `$healthy = [bool]$healthResult.Healthy\r\n`
    + `if (-not $healthy) { throw ('controlled node upgrade failed authenticated health verification (' + [string]$healthResult.Verdict + ' after ' + [int]([int64]$healthResult.ElapsedMs / 1000) + 's)') }\r\n`
    + `$transactionTerminal = $true\r\n`
    + `Remove-Item -Force $backupDst,$backupManifest -ErrorAction SilentlyContinue\r\n`
    + helperCleanup
    + remoteDesktopCleanup
    + journalCleanup
    + `$upgradeResultPersisted = $false\r\n`
    + `try { $upgradeResultPersisted = [bool](& $writeUpgradeResult @{ status = 'success'; phase = 'complete'; completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }) } catch { Write-Warning 'IMCODES_UPGRADE_RESULT_PERSIST_FAILED phase=complete' }\r\n`
    + `} catch {\r\n`
    + `$failureMessage = [string]$_.Exception.Message\r\n`
    + `if ($failureMessage.Length -gt 240) { $failureMessage = $failureMessage.Substring(0, 240) }\r\n`
    + `$upgradeResultPersisted = $false\r\n`
    + `try { $upgradeResultPersisted = [bool](& $writeUpgradeResult @{ status = 'rollback_started'; phase = 'rollback'; failedPhase = $upgradePhase; error = $failureMessage; reason = $failureMessage; recordedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }) } catch { Write-Warning 'IMCODES_UPGRADE_RESULT_PERSIST_FAILED phase=rollback_started' }\r\n`
    + `$rollbackExecutableReleased = [bool](& $runRecovery 'stop_new_node' { Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue; & $waitForNodeExecutableRelease; return $true })\r\n`
    + `if ($rollbackExecutableReleased) {\r\n`
    + `& $runRecovery 'restore_main' { if ($mainBackedUp -and (Test-Path $backupDst)) { if ((Get-FileHash -Algorithm SHA256 -LiteralPath $backupDst).Hash.ToLowerInvariant() -cne $rollbackMainHash) { throw 'controlled node rollback source hash mismatch' }; Copy-Item -Force $backupDst $dst; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $dst).Hash.ToLowerInvariant() -cne $rollbackMainHash) { throw 'controlled node restored hash mismatch' } } elseif ($mainPublished) { Remove-Item -Force $dst -ErrorAction Stop } }\r\n`
    + windowsManifestRestoreScript()
    + (helperRollback ? `& $runRecovery 'restore_helper' { ${helperRollback.replaceAll('\r\n', '; ')} }\r\n` : '')
    + (remoteDesktopRollback ? `& $runRecovery 'restore_remote_desktop' { ${remoteDesktopRollback.replaceAll('\r\n', '; ')} }\r\n` : '')
    + (input.stagedRemoteDesktopWorkerDir
      ? `& $runRecovery 'remove_new_driver' { if ($virtualDisplayDriverInstalled) { foreach ($newVirtualDisplayDriver in $newVirtualDisplayDrivers) { if ([string]$newVirtualDisplayDriver.Driver -cmatch '^oem[0-9]+\\.inf$') { & (Join-Path $env:WINDIR 'System32\\pnputil.exe') /delete-driver ([string]$newVirtualDisplayDriver.Driver) /uninstall /force | Out-Null; $driverRemoveExitCode = $LASTEXITCODE; if ($driverRemoveExitCode -ne 0 -and $driverRemoveExitCode -ne 3010) { throw 'virtual display driver rollback removal failed' } } } } }\r\n`
        + `& $runRecovery 'restore_driver' { if ($remoteDesktopBackedUp -and (Test-Path -LiteralPath $dstRemoteDesktop)) { & $verifyRemoteDesktopArtifactSet $dstRemoteDesktop $rollbackRemoteDesktopWorkerHash $rollbackRemoteDesktopManifestHash $rollbackRemoteDesktopArchiveHash $trustedReleaseSigner; $rollbackVirtualDisplayInf = Join-Path (Join-Path (Join-Path $dstRemoteDesktop 'win32-x64') 'virtual-display') 'imcodes-virtual-display.inf'; & (Join-Path $env:WINDIR 'System32\\pnputil.exe') /add-driver $rollbackVirtualDisplayInf /install | Out-Null; $driverRollbackExitCode = $LASTEXITCODE; if ($driverRollbackExitCode -ne 0 -and $driverRollbackExitCode -ne 3010) { throw 'virtual display driver rollback installation failed' } } }\r\n`
      : '')
    + (journalRollback ? `& $runRecovery 'restore_journal' { ${journalRollback.replaceAll('\r\n', '; ')} }\r\n` : '')
    + `} else {\r\n`
    + `[void]$recoveryFailures.Add('restore_artifacts: skipped because the controlled node executable release fence failed')\r\n`
    + `}\r\n`
    + `$rollbackStatus = if ($recoveryFailures.Count -eq 0) { 'rolled_back' } else { 'rollback_failed' }\r\n`
    + `if ($rollbackStatus -eq 'rolled_back') { $transactionTerminal = $true }\r\n`
    + `$upgradeResultPersisted = $false\r\n`
    + `try { $upgradeResultPersisted = [bool](& $writeUpgradeResult @{ status = $rollbackStatus; phase = 'rollback'; failedPhase = $upgradePhase; error = $failureMessage; reason = $failureMessage; recoveryFailures = @($recoveryFailures); completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }) } catch { Write-Warning 'IMCODES_UPGRADE_RESULT_PERSIST_FAILED phase=rollback' }\r\n`
    + `throw\r\n`
    + `} finally {\r\n`
    + `if ($transactionTerminal) { Remove-Item -Force -LiteralPath $upgradeMarker -ErrorAction SilentlyContinue }\r\n`
    + `Start-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue\r\n`
    + upgradeTaskCleanup.split('\r\n').filter(Boolean).map((line) => `  ${line}\r\n`).join('')
    + stagingCleanup.split('\r\n').filter(Boolean).map((line) => `  ${line}\r\n`).join('')
    + `}\r\n`;
}

function escapeXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Run the replacement from a separate Task Scheduler job. A child PowerShell
 * spawned by the main scheduled task remains in that task's Windows job and is
 * killed when it stops the parent task, before it can replace the locked EXE.
 */
export function windowsControlledNodeUpgradeTaskXml(scriptPath: string): string {
  const argumentsText = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`;
  const powershellPath = windowsPowerShellExecutablePath();
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>IM.codes controlled node one-shot upgrade</Description></RegistrationInfo>
  <Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>
  <Principals><Principal id="System"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="System"><Exec><Command>${escapeXmlText(powershellPath)}</Command><Arguments>${escapeXmlText(argumentsText)}</Arguments></Exec></Actions>
</Task>
`;
}

export { buildPosixControlledNodeUpgradeScript } from './posix-upgrade-script.js';

async function prepareUpgradeJournal(input: {
  currentJournalPath: string;
  outputJournalPath: string;
  destinationPath: string;
  stagedArtifactPath: string;
  artifactSha256: string;
  artifactSizeBytes: number;
  now: number;
}): Promise<string | undefined> {
  const journal = await loadInstallJournal(input.currentJournalPath);
  if (journal.phase === 'uninstalled') return undefined;
  const staged = await stat(input.stagedArtifactPath);
  const identity = {
    size: staged.size,
    mtimeMs: staged.mtimeMs,
    ctimeMs: staged.ctimeMs,
  };
  const next = {
    ...journal,
    version: INSTALL_JOURNAL_VERSION,
    updatedAt: input.now,
    stagedExePath: input.destinationPath,
    stagedReceipt: {
      path: input.destinationPath,
      size: input.artifactSizeBytes,
      sha256: input.artifactSha256,
      sourceIdentity: identity,
      stagedIdentity: identity,
    },
  };
  await writeFile(input.outputJournalPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return input.outputJournalPath;
}

function defaultSpawnDetached(file: string, args: readonly string[], options: { windowsHide?: boolean }): void {
  const child = spawn(file, [...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: options.windowsHide,
  });
  child.unref();
}

export function scheduleWindowsControlledNodeUpgrade(
  taskName: string,
  taskXmlPath: string,
  runCommand: (file: string, args: readonly string[]) => void = (file, args) => {
    execFileSync(file, [...args], { windowsHide: true, stdio: 'ignore' });
  },
  onCleanupFailure?: (error: unknown) => void,
): void {
  runCommand('schtasks.exe', ['/Create', '/TN', taskName, '/XML', taskXmlPath, '/F']);
  try {
    runCommand('schtasks.exe', ['/Run', '/TN', taskName]);
  } catch (error) {
    try {
      runCommand('schtasks.exe', ['/Delete', '/TN', taskName, '/F']);
    } catch (cleanupError) {
      // Preserve the authoritative /Run failure; the triggerless task is inert.
      try { onCleanupFailure?.(cleanupError); } catch { /* diagnostics never replace /Run authority */ }
    }
    throw error;
  }
}

export async function extractWindowsRemoteDesktopVirtualDisplay(
  archivePath: string,
  destination: string,
): Promise<void> {
  await execFileAsync(
    join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      'Expand-Archive -LiteralPath $env:IMCODES_RD_ARCHIVE -DestinationPath $env:IMCODES_RD_DEST -Force',
    ],
    {
      windowsHide: true,
      env: { ...process.env, IMCODES_RD_ARCHIVE: archivePath, IMCODES_RD_DEST: destination },
    },
  );
}

/**
 * Refresh only the independently released remote-desktop worker sidecar.
 * Unlike startControlledNodeSelfUpgrade this never downloads or replaces the
 * controlled-node executable, so a daemon whose own version is unchanged can
 * still receive a newer worker at an authenticated idle/reconnect boundary.
 */
export async function refreshControlledNodeRemoteDesktopWorker(
  input: ControlledNodeRemoteDesktopWorkerRefreshDeps,
): Promise<ControlledNodeRemoteDesktopWorkerRefreshResult> {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  if (arch !== 'x64' || (platform !== 'win32' && platform !== 'linux')) {
    return { updated: false, reason: 'unsupported_platform' };
  }
  const root = input.root ?? dirname(process.execPath);
  const finalRoot = join(root, 'remote-desktop-worker');
  const finalPlatformRoot = join(finalRoot, platform === 'win32' ? 'win32-x64' : REMOTE_DESKTOP_LINUX_WORKER_PLATFORM_DIR);
  const manifestPath = join(
    finalPlatformRoot,
    platform === 'win32'
      ? `${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`
      : `${REMOTE_DESKTOP_LINUX_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`,
  );
  let installedVersion: string | undefined;
  let installedSigner: string | undefined;
  try {
    const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    if (platform === 'win32') {
      const manifest = validateRemoteDesktopWorkerManifest(raw);
      if (!manifest) return { updated: false, reason: 'installed_manifest_invalid' };
      installedVersion = manifest.workerVersion;
      installedSigner = manifest.authenticodeSignerSha256;
    } else {
      const manifest = validateRemoteDesktopLinuxWorkerManifest(raw);
      if (!manifest) return { updated: false, reason: 'installed_manifest_invalid' };
      installedVersion = manifest.build.version;
    }
  } catch {
    return { updated: false, reason: 'installed_manifest_missing' };
  }

  const stagingRoot = await mkdtemp(join(root, '.remote-desktop-worker-refresh-'));
  const cleanup = async (): Promise<void> => {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  };
  try {
    const target = platform === 'win32'
      ? { os: CONTROLLED_NODE_OS_WIN, arch: CONTROLLED_NODE_ARCH_X64 }
      : { os: CONTROLLED_NODE_OS_LINUX, arch: CONTROLLED_NODE_ARCH_X64 };
    const downloaded = platform === 'win32'
      ? await (input.downloadWindowsWorker ?? downloadControlledNodeRemoteDesktopWorker)({
        credential: input.credential,
        target,
        dir: stagingRoot,
        fetchImpl: input.fetchImpl ?? fetch,
      })
      : await (input.downloadLinuxWorker ?? downloadControlledNodeLinuxRemoteDesktopWorker)({
        credential: input.credential,
        target,
        dir: stagingRoot,
        fetchImpl: input.fetchImpl ?? fetch,
      });
    if (!downloaded) return { updated: false, installedVersion, reason: 'worker_not_available' };
    const targetManifest = JSON.parse(await readFile(downloaded.manifestPath, 'utf8')) as Record<string, unknown>;
    const targetVersion = platform === 'win32'
      ? validateRemoteDesktopWorkerManifest(targetManifest)?.workerVersion
      : validateRemoteDesktopLinuxWorkerManifest(targetManifest)?.build.version;
    if (!targetVersion || !installedVersion) return { updated: false, reason: 'worker_version_missing' };
    const releaseOrder = compareImcodesVersions(installedVersion, targetVersion);
    if (releaseOrder === null) {
      return { updated: false, installedVersion, targetVersion, artifactSha256: downloaded.sha256, reason: 'worker_version_unparseable' };
    }
    if (releaseOrder >= 0) {
      return { updated: false, installedVersion, targetVersion, artifactSha256: downloaded.sha256, reason: releaseOrder === 0 ? 'worker_current' : 'worker_downgrade_rejected' };
    }
    if (platform === 'win32') {
      const target = validateRemoteDesktopWorkerManifest(targetManifest);
      if (!target || !installedSigner || target.authenticodeSignerSha256 !== installedSigner) {
        return { updated: false, installedVersion, targetVersion, artifactSha256: downloaded.sha256, reason: 'worker_signer_mismatch' };
      }
      await (input.extractVirtualDisplay ?? extractWindowsRemoteDesktopVirtualDisplay)(
        join(downloaded.workerDir, REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME),
        join(downloaded.workerDir, 'virtual-display'),
      );
      if (!verifyRemoteDesktopWorkerArtifact(
        join(downloaded.workerDir, REMOTE_DESKTOP_WORKER_FILENAME),
        installedSigner,
      )) return { updated: false, installedVersion, targetVersion, artifactSha256: downloaded.sha256, reason: 'worker_verification_failed' };
    }
    // Acquire synchronously before the final admission check. Once held,
    // runtime PREPARE handlers wait, so no session can appear between the
    // check and the first atomic rename.
    const releaseCommit = input.commitFence?.acquire() ?? null;
    if (input.commitFence && !releaseCommit) {
      return { updated: false, installedVersion, targetVersion, artifactSha256: downloaded.sha256, reason: 'worker_busy' };
    }
    try {
      if (input.canCommit && !(await input.canCommit())) {
        return { updated: false, installedVersion, targetVersion, artifactSha256: downloaded.sha256, reason: 'worker_busy' };
      }
      const backupRoot = `${finalRoot}.previous`;
      await rm(backupRoot, { recursive: true, force: true });
      const renameImpl = input.rename ?? rename;
      await renameImpl(finalRoot, backupRoot);
      try {
        await renameImpl(join(stagingRoot, 'remote-desktop-worker'), finalRoot);
      } catch (error) {
        await renameImpl(backupRoot, finalRoot).catch(() => {});
        throw error;
      }
      if (input.afterCommit) await input.afterCommit(targetVersion);
      await rm(backupRoot, { recursive: true, force: true });
      return {
        updated: true,
        installedVersion: targetVersion,
        targetVersion,
        artifactSha256: downloaded.sha256,
        ...(input.afterCommit ? { activated: true } : {}),
      };
    } finally {
      releaseCommit?.();
    }
  } catch (error) {
    logger.warn({ err: error }, 'controlled-node remote-desktop worker refresh failed');
    return { updated: false, installedVersion, reason: 'worker_refresh_failed' };
  } finally {
    await cleanup();
  }
}

export { scheduleLinuxControlledNodeUpgrade } from './linux-upgrade-scheduler.js';
import { scheduleLinuxControlledNodeUpgrade } from './linux-upgrade-scheduler.js';

export async function startControlledNodeSelfUpgrade(
  credential: ControlledNodeCredential,
  rawTargetVersion: unknown,
  deps: ControlledNodeSelfUpgradeDeps = {},
): Promise<ControlledNodeSelfUpgradeResult> {
  const targetVersion = normalizeDaemonUpgradeTargetVersion(rawTargetVersion);
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const abiProfile = deps.abiProfile ?? CONTROLLED_NODE_RUNTIME_ABI_PROFILE;
  if (normalizeControlledNodeAbiProfile(credential.abiProfile) !== abiProfile) {
    return { ok: false, targetVersion, reason: 'credential_abi_profile_mismatch' };
  }
  const target = controlledNodeArtifactTarget(platform, arch, abiProfile);
  if (!target) return { ok: false, targetVersion, reason: 'unsupported_platform' };
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (!fetchImpl) return { ok: false, targetVersion, reason: 'fetch_unavailable' };

  const tempRoot = deps.tmpdir?.() ?? tmpdir();
  // Crash recovery is deliberately best-effort. It runs before allocating a
  // new directory and can only inspect bounded, direct, owned children. Run it
  // on every supported platform: a killed POSIX helper is just as capable of
  // stranding its downloaded artifact as the Windows task.
  await scavengeStaleControlledNodeUpgradeDirs(tempRoot, deps);
  ensurePeriodicUpgradeSweep(tempRoot, deps);
  const freeBytes = await (deps.freeBytes ?? defaultFreeBytes)(tempRoot);
  if (freeBytes !== null && freeBytes < CONTROLLED_NODE_UPGRADE_MIN_FREE_BYTES) {
    return { ok: false, targetVersion, reason: 'insufficient_disk_space' };
  }

  let updateDir: string | undefined;
  try {
    updateDir = resolve(await mkdtemp(join(tempRoot, CONTROLLED_NODE_UPGRADE_DIR_PREFIX)));
    activeControlledNodeUpgradeDirs.add(updateDir);
    const ownership: ControlledNodeUpgradeOwnershipMarker = {
      schemaVersion: 1,
      product: CONTROLLED_NODE_UPGRADE_PRODUCT,
      directoryName: basename(updateDir),
      ownerToken: randomUUID(),
      createdAt: deps.now?.() ?? Date.now(),
      pid: process.pid,
    };
    const ownershipMarkerPath = join(updateDir, CONTROLLED_NODE_UPGRADE_OWNERSHIP_MARKER);
    const writeUpgradeFile = deps.writeUpgradeFile ?? writeFile;
    await writeUpgradeFile(ownershipMarkerPath, `${JSON.stringify(ownership)}\n`, { mode: 0o600 });
    const progressPath = join(updateDir, CONTROLLED_NODE_UPGRADE_PROGRESS_FILE);
    const recordProgress = async (phase: 'staging_created' | 'handoff_ready' | ControlledNodeArtifactDownloadPhase): Promise<void> => {
      try {
        await appendFile(progressPath, `${JSON.stringify({
          schemaVersion: 1,
          product: CONTROLLED_NODE_UPGRADE_PRODUCT,
          ownerToken: ownership.ownerToken,
          targetVersion,
          phase,
          recordedAt: deps.now?.() ?? Date.now(),
          pid: process.pid,
        })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
      } catch (error) {
        logger.warn({
          event: 'controlled_node_upgrade_progress_write_failed',
          phase,
          code: cleanupErrorCode(error),
        }, 'controlled node upgrade progress write failed');
      }
    };
    await recordProgress('staging_created');

    // Captured as a `const` so the retry closures below see a stable `string`:
    // TypeScript cannot narrow a closed-over `let` across a generic callback
    // boundary the way it does at this direct call site.
    const stagingDir: string = updateDir;
    const downloaded = await withArtifactDownloadRetries(() => downloadArtifact({
      credential,
      target,
      dir: stagingDir,
      fetchImpl,
      ...(targetVersion === DAEMON_UPGRADE_TARGET_LATEST ? {} : { expectedVersion: targetVersion }),
      onProgress: recordProgress,
    }), { sleep: deps.sleep });
    if (!downloaded.version) throw new Error('missing_artifact_version');
    const helper = abiProfile === CONTROLLED_NODE_ABI_GLIBC217 ? undefined : await withArtifactDownloadRetries(
      () => downloadControlledNodeComputerUseHelper({ credential, target, dir: stagingDir, fetchImpl }),
      { sleep: deps.sleep },
    );
    // A Windows/Linux release is one publication unit. Installing the runtime
    // without its same-version worker bundle strands the node after its
    // runtime version converges, because version-based auto-upgrade will no
    // longer retry. Both download functions gate on target.os internally and
    // return undefined immediately for the wrong platform, so calling both
    // unconditionally (macOS gets neither -- its own bootstrap coordinator
    // fetches its component set independently) is cheap and simpler than
    // branching on platform here too.
    const remoteDesktopWorker = abiProfile === CONTROLLED_NODE_ABI_GLIBC217 ? undefined : (await withArtifactDownloadRetries(() => downloadControlledNodeRemoteDesktopWorker({
      credential,
      target,
      dir: stagingDir,
      fetchImpl,
      expectedVersion: downloaded.version,
    }), { sleep: deps.sleep })) ?? (await withArtifactDownloadRetries(() => downloadControlledNodeLinuxRemoteDesktopWorker({
      credential,
      target,
      dir: stagingDir,
      fetchImpl,
      expectedVersion: downloaded.version,
    }), { sleep: deps.sleep }));
    const destinationPath = deps.execPath ?? defaultStagedExecutablePath(platform);
    const destinationManifestPath = `${destinationPath}.manifest.json`;
    const destinationJournalPath = deps.journalPath ?? join(dirname(defaultCredentialPath(platform)), 'install-journal.json');
    const stagedJournalPath = await prepareUpgradeJournal({
      currentJournalPath: destinationJournalPath,
      outputJournalPath: join(updateDir, 'install-journal.json'),
      destinationPath,
      stagedArtifactPath: downloaded.artifactPath,
      artifactSha256: downloaded.sha256,
      artifactSizeBytes: downloaded.sizeBytes,
      now: deps.now?.() ?? Date.now(),
    });
    const scriptPath = platform === 'win32'
      ? join(updateDir, 'upgrade.ps1')
      : join(updateDir, 'upgrade.sh');
    const windowsUpgradeTaskName = platform === 'win32'
      ? `${CONTROLLED_NODE_WINDOWS_UPGRADE_TASK_PREFIX}${randomUUID()}`
      : undefined;
    const script = platform === 'win32'
      ? buildWindowsControlledNodeUpgradeScript({
        stagedArtifactPath: downloaded.artifactPath,
        stagedManifestPath: downloaded.manifestPath,
        targetVersion: downloaded.version,
        artifactSha256: downloaded.sha256,
        stagedComputerUseHelperDir: helper?.helperDir,
        // Swap the platform-root as one directory so the installed layout stays
        // remote-desktop-worker/win32-x64/<worker+manifest>, matching both the
        // packaged dist layout and the worker resolver.
        stagedRemoteDesktopWorkerDir: remoteDesktopWorker
          ? dirname(remoteDesktopWorker.workerDir)
          : undefined,
        stagedJournalPath,
        destinationPath,
        destinationManifestPath,
        destinationJournalPath,
        upgradeTaskName: windowsUpgradeTaskName,
        stagingOwnership: {
          directoryPath: updateDir,
          markerPath: ownershipMarkerPath,
          ownerToken: ownership.ownerToken,
        },
      })
      : buildPosixControlledNodeUpgradeScript({
        platform: platform === 'darwin' ? 'darwin' : 'linux',
        stagedArtifactPath: downloaded.artifactPath,
        stagedManifestPath: downloaded.manifestPath,
        stagedComputerUseHelperDir: helper?.helperDir,
        // Undefined on darwin: remoteDesktopWorker is always undefined there
        // (see the comment above where it is downloaded), so this only ever
        // carries a value on linux.
        stagedRemoteDesktopWorkerDir: remoteDesktopWorker
          ? dirname(remoteDesktopWorker.workerDir)
          : undefined,
        stagedJournalPath,
        destinationPath,
        destinationManifestPath,
        destinationJournalPath,
        targetVersion: downloaded.version,
        artifactSha256: downloaded.sha256,
        stagingOwnership: {
          directoryPath: updateDir,
          markerPath: ownershipMarkerPath,
          ownerToken: ownership.ownerToken,
        },
      });
    await writeUpgradeFile(scriptPath, script, { mode: 0o700 });
    if (platform !== 'win32') await chmod(scriptPath, 0o700).catch(() => {});
    if (platform === 'win32') {
      const taskXmlPath = join(updateDir, 'upgrade-task.xml');
      await writeUpgradeFile(taskXmlPath, encodeWindowsScheduledTaskXml(windowsControlledNodeUpgradeTaskXml(scriptPath)));
      await recordProgress('handoff_ready');
      const scheduleWindowsUpgrade = deps.scheduleWindowsUpgrade ?? ((taskName: string, taskXmlPath: string) => {
        scheduleWindowsControlledNodeUpgrade(taskName, taskXmlPath, undefined, (error) => {
          emitCleanupDiagnostic({
            event: 'controlled_node_upgrade_cleanup',
            phase: 'pre_handoff',
            outcome: 'failed',
            code: cleanupErrorCode(error),
          }, deps);
        });
      });
      scheduleWindowsUpgrade(windowsUpgradeTaskName!, taskXmlPath);
    } else if (platform === 'linux') {
      const scheduleLinuxUpgrade = deps.scheduleLinuxUpgrade ?? scheduleLinuxControlledNodeUpgrade;
      await recordProgress('handoff_ready');
      scheduleLinuxUpgrade(`${CONTROLLED_NODE_SERVICE.LINUX_UNIT.replace(/\.service$/, '')}-upgrade-${randomUUID()}`, scriptPath);
    } else {
      const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached;
      await recordProgress('handoff_ready');
      spawnDetached('/bin/sh', [scriptPath], {});
    }
    return {
      ok: true,
      targetVersion: targetVersion || DAEMON_UPGRADE_TARGET_LATEST,
      artifactSha256: downloaded.sha256,
      scriptPath,
    };
  } catch (error) {
    if (updateDir) await removeUpgradeDirBestEffort(updateDir, 'pre_handoff', deps);
    throw error;
  } finally {
    if (updateDir) activeControlledNodeUpgradeDirs.delete(updateDir);
  }
}
