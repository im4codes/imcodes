import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { AGY_CLI_FLAG } from '../../shared/agy-agent.js';
import { execFileOffMain, execFileOffMainIdempotent } from '../util/exec-helper.js';
import { readProcessStart } from '../util/process-start.js';

export interface AgyIncognitoEnv {
  readonly homeDir: string;
  readonly logFile: string;
  readonly env: Record<string, string>;
  readonly acpFlags: string[];
  /** Persist the spawned ACP process identity into `.imcodes-owner.json` so crash recovery reaps it before removing `homeDir`. Resolves once any async start-time lookup finishes. */
  registerChildProcess(childPid: number, ownsProcessGroup: boolean): Promise<void>;
  cleanup(): Promise<void>;
  cleanupSync(): void;
}

export interface CreateAgyIncognitoEnvOptions {
  /** Skip immediate orphan sweep when caller has already awaited `reclaimOrphanedAgyIncognitoHomes()`. */
  skipReclaim?: boolean;
}

const AUTH_RELATIVE_PATHS = [
  path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
  path.join('.gemini', 'oauth_creds.json'),
  path.join('.gemini', 'google_accounts.json'),
] as const;

const AGY_INCOGNITO_DIR_PREFIX = 'imcodes-agy-incog-';
const OWNER_META_FILENAME = '.imcodes-owner.json';
const PROCESS_REAP_GRACEFUL_MS = 250;
const PROCESS_REAP_POLL_MS = 25;
const PROCESS_KILL_SETTLE_MS = 500;
const PS_TIMEOUT_MS = 5_000;

interface AgyIncognitoOwnerMeta {
  version: 1;
  pid: number;
  startTicks?: string;
  processStart?: string;
  createdAt: number;
  childPid?: number;
  childStartTicks?: string;
  childProcessStart?: string;
  ownsProcessGroup?: boolean;
}

interface PsProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  isZombie: boolean;
}

type ProcessIdentityStatus = 'dead' | 'alive' | 'recycled' | 'inconclusive';

const activeIncognitoHomes = new Map<string, AgyIncognitoOwnerMeta>();
let exitHookRegistered = false;

function registerExitCleanupHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.on('exit', () => {
    for (const [dir, inMemoryMeta] of [...activeIncognitoHomes.entries()]) {
      const diskMeta = readOwnerMeta(dir);
      const meta = diskMeta?.childPid !== undefined ? diskMeta : (inMemoryMeta ?? diskMeta);
      if (meta?.childPid !== undefined && !reapVerifiedChildSync(meta)) {
        // Keep the directory and intact owner marker when child identity or
        // termination cannot be verified so cold reclaim can safely retry.
        preserveOwnerMetaIfDirSurvives(dir, meta);
        continue;
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort process-exit cleanup.
      }
      if (!existsSync(dir)) {
        activeIncognitoHomes.delete(dir);
      } else if (meta) {
        preserveOwnerMetaIfDirSurvives(dir, meta);
      }
    }
  });
}

function readLinuxProcessState(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rparen = stat.lastIndexOf(') ');
    if (rparen < 0) return undefined;
    const fields = stat.slice(rparen + 2).trim().split(/\s+/);
    return fields[0] || undefined;
  } catch {
    return undefined;
  }
}

function readLinuxProcessStartTicks(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rparen = stat.lastIndexOf(') ');
    if (rparen < 0) return undefined;
    const fields = stat.slice(rparen + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    return startTicks && /^\d+$/.test(startTicks) ? startTicks : undefined;
  } catch {
    return undefined;
  }
}

function readProcessStartSync(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === 'linux') {
    return readLinuxProcessStartTicks(pid);
  }
  try {
    if (process.platform === 'win32') {
      const script = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){ $p.StartTime.ToUniversalTime().Ticks.ToString() }`;
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout: 2_000,
        windowsHide: true,
      }).trim();
      return /^\d+$/.test(out) ? out : undefined;
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

function checkProcessIdentitySync(
  pid: number,
  expectedStartTicks: string | undefined,
  expectedProcessStart: string | undefined,
): ProcessIdentityStatus {
  if (!isPidAlive(pid)) return 'dead';
  if (expectedStartTicks && process.platform === 'linux') {
    const liveTicks = readLinuxProcessStartTicks(pid);
    if (!liveTicks) return 'inconclusive';
    return liveTicks === expectedStartTicks ? 'alive' : 'recycled';
  }
  if (expectedProcessStart) {
    const liveStart = readProcessStartSync(pid);
    if (!liveStart) return 'inconclusive';
    return liveStart === expectedProcessStart ? 'alive' : 'recycled';
  }
  return 'inconclusive';
}

async function checkProcessIdentityAsync(
  pid: number,
  expectedStartTicks: string | undefined,
  expectedProcessStart: string | undefined,
): Promise<ProcessIdentityStatus> {
  if (!isPidAlive(pid)) return 'dead';
  if (expectedStartTicks && process.platform === 'linux') {
    const liveTicks = readLinuxProcessStartTicks(pid);
    if (!liveTicks) return 'inconclusive';
    return liveTicks === expectedStartTicks ? 'alive' : 'recycled';
  }
  if (expectedProcessStart) {
    const liveStart = await readProcessStart(pid);
    if (!liveStart) return 'inconclusive';
    return liveStart === expectedProcessStart ? 'alive' : 'recycled';
  }
  return 'inconclusive';
}

function readOwnerMeta(dirPath: string): AgyIncognitoOwnerMeta | null {
  const metaPath = path.join(dirPath, OWNER_META_FILENAME);
  if (!existsSync(metaPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as Partial<AgyIncognitoOwnerMeta>;
    if (
      parsed
      && parsed.version === 1
      && typeof parsed.pid === 'number'
      && Number.isInteger(parsed.pid)
      && typeof parsed.createdAt === 'number'
    ) {
      return parsed as AgyIncognitoOwnerMeta;
    }
  } catch {
    // Malformed/unreadable owner metadata is treated as unowned rather than deleted blindly.
  }
  return null;
}

function writeOwnerMetaAtomic(dirPath: string, meta: AgyIncognitoOwnerMeta): void {
  const metaPath = path.join(dirPath, OWNER_META_FILENAME);
  const tempPath = `${metaPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
  try {
    renameSync(tempPath, metaPath);
  } catch (err) {
    try { rmSync(tempPath, { force: true }); } catch { /* noop */ }
    throw err;
  }
}

function preserveOwnerMetaIfDirSurvives(dirPath: string, meta: AgyIncognitoOwnerMeta | null): void {
  if (!meta) return;
  try {
    if (existsSync(dirPath) && !existsSync(path.join(dirPath, OWNER_META_FILENAME))) {
      writeOwnerMetaAtomic(dirPath, meta);
    }
  } catch {
    // Directory itself may be read-only; keep silent and let higher-level retry later.
  }
}

function parsePsProcessTable(stdout: string): PsProcessRow[] {
  const rows: PsProcessRow[] = [];
  for (const line of stdout.split('\n').slice(1)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    const isZombie = match[4].toUpperCase().startsWith('Z');
    if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)) {
      rows.push({ pid, ppid, pgid, isZombie });
    }
  }
  return rows;
}

function readPsTableSync(): PsProcessRow[] | null {
  try {
    const stdout = execFileSync('ps', ['-A', '-o', 'pid,ppid,pgid,stat'], {
      encoding: 'utf8',
      timeout: PS_TIMEOUT_MS,
    });
    return parsePsProcessTable(stdout);
  } catch {
    return null;
  }
}

async function readPsTableAsync(): Promise<PsProcessRow[] | null> {
  try {
    const { stdout } = await execFileOffMainIdempotent('ps', ['-A', '-o', 'pid,ppid,pgid,stat'], {
      timeout: PS_TIMEOUT_MS,
    });
    return parsePsProcessTable(stdout);
  } catch {
    return null;
  }
}

function collectDescendantsFromTable(rootPid: number, rows: readonly PsProcessRow[]): number[] {
  const byParent = new Map<number, number[]>();
  for (const row of rows) {
    const list = byParent.get(row.ppid);
    if (list) list.push(row.pid);
    else byParent.set(row.ppid, [row.pid]);
  }
  const out: number[] = [];
  const visited = new Set<number>();
  const walk = (pid: number): void => {
    if (visited.has(pid)) return;
    visited.add(pid);
    for (const child of byParent.get(pid) ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(rootPid);
  return out;
}

function countGroupMembersFromTable(pgid: number, rows: readonly PsProcessRow[]): number {
  let count = 0;
  for (const row of rows) {
    if (!row.isZombie && row.pgid === pgid) count += 1;
  }
  return count;
}

function signalPidSafe(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'ESRCH';
  }
}

type GroupSignalOutcome = 'ok' | 'eperm' | 'error';

function signalGroupSafe(pgid: number, signal: NodeJS.Signals): GroupSignalOutcome {
  try {
    process.kill(-pgid, signal);
    return 'ok';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return 'ok';
    // On macOS (XNU), kill(-pgid, sig) can throw EPERM if the group contains
    // zombie/exited processes. Keep EPERM distinguishable so callers can fall back
    // to per-PID signaling and ps verification instead of aborting prematurely.
    if (code === 'EPERM') return 'eperm';
    return 'error';
  }
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* bounded busy wait fallback */ }
  }
}

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function isLiveNonZombiePid(pid: number, rows: readonly PsProcessRow[]): boolean {
  if (!isPidAlive(pid)) return false;
  const row = rows.find((entry) => entry.pid === pid);
  if (row) return !row.isZombie;
  if (readLinuxProcessState(pid) === 'Z') return false;
  return isPidAlive(pid);
}

function allTargetsCleared(
  childPid: number,
  descendants: readonly number[],
  ownsGroup: boolean,
  rows: readonly PsProcessRow[] | null,
): boolean {
  if (rows === null) return false;
  if (isLiveNonZombiePid(childPid, rows)) return false;
  for (const pid of descendants) {
    if (isLiveNonZombiePid(pid, rows)) return false;
  }
  if (ownsGroup && countGroupMembersFromTable(childPid, rows) > 0) {
    return false;
  }
  return true;
}

function fetchTargetPsRowsSync(
  childPid: number,
  descendants: readonly number[],
  ownsGroup: boolean,
): PsProcessRow[] | null {
  if (!ownsGroup && !isPidAlive(childPid) && !descendants.some(isPidAlive)) {
    return [];
  }
  return readPsTableSync();
}

async function fetchTargetPsRowsAsync(
  childPid: number,
  descendants: readonly number[],
  ownsGroup: boolean,
): Promise<PsProcessRow[] | null> {
  if (!ownsGroup && !isPidAlive(childPid) && !descendants.some(isPidAlive)) {
    return [];
  }
  return await readPsTableAsync();
}

function issueTreeSignal(
  childPid: number,
  orderedDescendants: readonly number[],
  ownsGroup: boolean,
  leaderNeedsSignal: boolean,
  signal: NodeJS.Signals,
  fallbackRows?: readonly PsProcessRow[],
): boolean {
  let ok = true;
  const targetedPids = new Set<number>(orderedDescendants);
  if (leaderNeedsSignal) targetedPids.add(childPid);

  if (ownsGroup) {
    const groupOutcome = signalGroupSafe(childPid, signal);
    if (groupOutcome === 'eperm') {
      if (fallbackRows) {
        for (const row of fallbackRows) {
          if (!row.isZombie && row.pgid === childPid && !targetedPids.has(row.pid) && isPidAlive(row.pid)) {
            ok = signalPidSafe(row.pid, signal) && ok;
          }
        }
      }
    } else if (groupOutcome === 'error') {
      ok = false;
    }
  }
  for (const pid of orderedDescendants) {
    if (!isPidAlive(pid)) continue;
    ok = signalPidSafe(pid, signal) && ok;
  }
  if (leaderNeedsSignal && isPidAlive(childPid)) {
    ok = signalPidSafe(childPid, signal) && ok;
  }
  return ok;
}

function reapVerifiedPosixChildSync(childPid: number, ownsGroup: boolean, leaderAlive: boolean): boolean {
  const initialRows = readPsTableSync();
  if (initialRows === null) return false;
  const descendants = leaderAlive ? collectDescendantsFromTable(childPid, initialRows) : [];
  if (allTargetsCleared(childPid, descendants, ownsGroup, initialRows)) return true;

  const orderedDescendants = [...descendants].reverse();
  if (!issueTreeSignal(childPid, orderedDescendants, ownsGroup, leaderAlive, 'SIGTERM', initialRows)) {
    return false;
  }

  let latestRows: PsProcessRow[] | null = initialRows;
  const graceDeadline = Date.now() + PROCESS_REAP_GRACEFUL_MS;
  while (Date.now() < graceDeadline) {
    sleepSync(PROCESS_REAP_POLL_MS);
    latestRows = fetchTargetPsRowsSync(childPid, descendants, ownsGroup);
    if (allTargetsCleared(childPid, descendants, ownsGroup, latestRows)) return true;
  }

  if (!issueTreeSignal(childPid, orderedDescendants, ownsGroup, true, 'SIGKILL', latestRows ?? undefined)) {
    return false;
  }

  const killDeadline = Date.now() + PROCESS_KILL_SETTLE_MS;
  while (Date.now() < killDeadline) {
    const rows = fetchTargetPsRowsSync(childPid, descendants, ownsGroup);
    if (allTargetsCleared(childPid, descendants, ownsGroup, rows)) return true;
    sleepSync(PROCESS_REAP_POLL_MS);
  }
  const finalRows = fetchTargetPsRowsSync(childPid, descendants, ownsGroup);
  return allTargetsCleared(childPid, descendants, ownsGroup, finalRows);
}

async function reapVerifiedPosixChildAsync(childPid: number, ownsGroup: boolean, leaderAlive: boolean): Promise<boolean> {
  const initialRows = await readPsTableAsync();
  if (initialRows === null) return false;
  const descendants = leaderAlive ? collectDescendantsFromTable(childPid, initialRows) : [];
  if (allTargetsCleared(childPid, descendants, ownsGroup, initialRows)) return true;

  const orderedDescendants = [...descendants].reverse();
  if (!issueTreeSignal(childPid, orderedDescendants, ownsGroup, leaderAlive, 'SIGTERM', initialRows)) {
    return false;
  }

  let latestRows: PsProcessRow[] | null = initialRows;
  const graceDeadline = Date.now() + PROCESS_REAP_GRACEFUL_MS;
  while (Date.now() < graceDeadline) {
    await sleepAsync(PROCESS_REAP_POLL_MS);
    latestRows = await fetchTargetPsRowsAsync(childPid, descendants, ownsGroup);
    if (allTargetsCleared(childPid, descendants, ownsGroup, latestRows)) return true;
  }

  if (!issueTreeSignal(childPid, orderedDescendants, ownsGroup, true, 'SIGKILL', latestRows ?? undefined)) {
    return false;
  }

  const killDeadline = Date.now() + PROCESS_KILL_SETTLE_MS;
  while (Date.now() < killDeadline) {
    const rows = await fetchTargetPsRowsAsync(childPid, descendants, ownsGroup);
    if (allTargetsCleared(childPid, descendants, ownsGroup, rows)) return true;
    await sleepAsync(PROCESS_REAP_POLL_MS);
  }
  const finalRows = await fetchTargetPsRowsAsync(childPid, descendants, ownsGroup);
  return allTargetsCleared(childPid, descendants, ownsGroup, finalRows);
}

function reapVerifiedChildSync(meta: AgyIncognitoOwnerMeta): boolean {
  if (meta.childPid === undefined) return true;
  if (!Number.isInteger(meta.childPid) || meta.childPid <= 1) return false;

  const status = checkProcessIdentitySync(meta.childPid, meta.childStartTicks, meta.childProcessStart);
  if (status === 'inconclusive') return false;
  if (status === 'recycled') return true;

  const leaderAlive = status === 'alive';
  if (process.platform === 'win32') {
    if (!leaderAlive) return true;
    try {
      execFileSync('taskkill', ['/pid', String(meta.childPid), '/T', '/F'], {
        timeout: PS_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch {
      // May have exited concurrently; verify liveness below.
    }
    return !isPidAlive(meta.childPid);
  }

  const ownsGroup = meta.ownsProcessGroup === true;
  if (!leaderAlive && !ownsGroup) return true;
  return reapVerifiedPosixChildSync(meta.childPid, ownsGroup, leaderAlive);
}

async function reapVerifiedChildAsync(meta: AgyIncognitoOwnerMeta): Promise<boolean> {
  if (meta.childPid === undefined) return true;
  if (!Number.isInteger(meta.childPid) || meta.childPid <= 1) return false;

  const status = await checkProcessIdentityAsync(meta.childPid, meta.childStartTicks, meta.childProcessStart);
  if (status === 'inconclusive') return false;
  if (status === 'recycled') return true;

  const leaderAlive = status === 'alive';
  if (process.platform === 'win32') {
    if (!leaderAlive) return true;
    try {
      await execFileOffMain('taskkill', ['/pid', String(meta.childPid), '/T', '/F'], {
        timeout: PS_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch {
      // May have exited concurrently; verify liveness below.
    }
    return !isPidAlive(meta.childPid);
  }

  const ownsGroup = meta.ownsProcessGroup === true;
  if (!leaderAlive && !ownsGroup) return true;
  return await reapVerifiedPosixChildAsync(meta.childPid, ownsGroup, leaderAlive);
}

function listCandidateOrphanDirs(baseTempDir: string): string[] {
  let entries;
  try {
    entries = readdirSync(baseTempDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!entry.name.startsWith(AGY_INCOGNITO_DIR_PREFIX)) continue;
    const dirPath = path.join(baseTempDir, entry.name);
    if (activeIncognitoHomes.has(path.resolve(dirPath))) continue;
    dirs.push(dirPath);
  }
  return dirs;
}

/**
 * Reclaim orphaned ephemeral AG incognito directories whose owning daemon/process
 * has died (e.g., SIGKILL crash recovery). Always verifies and terminates any
 * owned ACP child process tree/group before deleting `dirPath`, and preserves
 * live-owner directories, active siblings, and unowned directories.
 */
export async function reclaimOrphanedAgyIncognitoHomes(baseTempDir = tmpdir()): Promise<number> {
  let reclaimed = 0;
  for (const dirPath of listCandidateOrphanDirs(baseTempDir)) {
    const meta = readOwnerMeta(dirPath);
    if (!meta) continue;
    const ownerStatus = await checkProcessIdentityAsync(meta.pid, meta.startTicks, meta.processStart);
    if (ownerStatus === 'alive' || ownerStatus === 'inconclusive') continue;
    if (!await reapVerifiedChildAsync(meta)) continue;
    try {
      await rm(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Best-effort orphan reclamation; retries on next sweep.
    }
    if (!existsSync(dirPath)) {
      reclaimed += 1;
    } else {
      preserveOwnerMetaIfDirSurvives(dirPath, meta);
    }
  }
  return reclaimed;
}

/**
 * Synchronous variant of {@link reclaimOrphanedAgyIncognitoHomes} for sync
 * provisioning and test callers. Same ownership and process-group reaping rules apply.
 */
export function reclaimOrphanedAgyIncognitoHomesSync(baseTempDir = tmpdir()): number {
  let reclaimed = 0;
  for (const dirPath of listCandidateOrphanDirs(baseTempDir)) {
    const meta = readOwnerMeta(dirPath);
    if (!meta) continue;
    const ownerStatus = checkProcessIdentitySync(meta.pid, meta.startTicks, meta.processStart);
    if (ownerStatus === 'alive' || ownerStatus === 'inconclusive') continue;
    if (!reapVerifiedChildSync(meta)) continue;
    try {
      rmSync(dirPath, { recursive: true, force: true });
    } catch {
      // Best-effort orphan reclamation; retries on next sweep.
    }
    if (!existsSync(dirPath)) {
      reclaimed += 1;
    } else {
      preserveOwnerMetaIfDirSurvives(dirPath, meta);
    }
  }
  return reclaimed;
}

/**
 * Resolve the non-incognito home directory from caller envs, falling back to
 * OS homedir, while skipping any directory already created for AG incognito.
 */
export function resolveAgySourceHome(...envs: Array<Record<string, string | undefined> | undefined>): string {
  for (const env of envs) {
    for (const key of ['HOME', 'USERPROFILE'] as const) {
      const candidate = env?.[key]?.trim();
      if (candidate && !activeIncognitoHomes.has(path.resolve(candidate))) {
        return candidate;
      }
    }
  }
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

/**
 * Provision an isolated ephemeral `HOME` / `GEMINI_CLI_HOME` directory for an
 * Antigravity incognito session. Copies only minimal standalone auth token
 * files (no symlinks, no `brain/`, no `conversations/`, no DBs, no `settings.json`)
 * and writes an empty `.gemini/config/mcp_config.json` so `imcodes-memory` and
 * user MCPs are disabled. Rolls back any partially created files/directories if
 * setup throws.
 */
export function createAgyIncognitoEnvSync(
  sourceHome?: string,
  options?: CreateAgyIncognitoEnvOptions,
): AgyIncognitoEnv {
  const baseTempDir = tmpdir();
  if (!options?.skipReclaim) {
    reclaimOrphanedAgyIncognitoHomesSync(baseTempDir);
  }

  const homeDir = mkdtempSync(path.join(baseTempDir, AGY_INCOGNITO_DIR_PREFIX));
  const resolvedHomeDir = path.resolve(homeDir);
  const daemonTicks = readLinuxProcessStartTicks(process.pid);
  const daemonStart = daemonTicks ? undefined : readProcessStartSync(process.pid);
  let currentMeta: AgyIncognitoOwnerMeta = {
    version: 1,
    pid: process.pid,
    ...(daemonTicks ? { startTicks: daemonTicks } : {}),
    ...(daemonStart ? { processStart: daemonStart } : {}),
    createdAt: Date.now(),
  };
  activeIncognitoHomes.set(resolvedHomeDir, currentMeta);
  registerExitCleanupHook();

  let cleaned = false;
  let cleaningOrDisposed = false;
  let inFlightCleanup: Promise<void> | null = null;
  let pendingMetaWrite: Promise<void> | null = null;

  const finalizeCleanupState = (): void => {
    if (!existsSync(homeDir)) {
      cleaned = true;
      activeIncognitoHomes.delete(resolvedHomeDir);
    } else {
      cleaned = false;
      preserveOwnerMetaIfDirSurvives(homeDir, currentMeta);
    }
  };

  const cleanupSync = (): void => {
    cleaningOrDisposed = true;
    if (cleaned && !existsSync(homeDir)) return;
    const diskMeta = readOwnerMeta(homeDir);
    const meta = diskMeta?.childPid !== undefined ? diskMeta : currentMeta;
    if (meta.childPid !== undefined && !reapVerifiedChildSync(meta)) {
      finalizeCleanupState();
      return;
    }
    try {
      rmSync(homeDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; failed removal keeps cleaned=false for subsequent retry.
    }
    finalizeCleanupState();
  };

  const cleanup = async (): Promise<void> => {
    cleaningOrDisposed = true;
    if (cleaned && !existsSync(homeDir)) return;
    if (pendingMetaWrite) {
      await pendingMetaWrite.catch(() => {});
    }
    if (inFlightCleanup) {
      await inFlightCleanup;
      if (cleaned && !existsSync(homeDir)) return;
    }
    inFlightCleanup = (async () => {
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
      finalizeCleanupState();
    })();
    try {
      await inFlightCleanup;
    } finally {
      inFlightCleanup = null;
    }
  };

  const registerChildProcess = (childPid: number, ownsProcessGroup: boolean): Promise<void> => {
    if (cleaningOrDisposed || !Number.isInteger(childPid) || childPid <= 1) return Promise.resolve();
    const childTicks = readLinuxProcessStartTicks(childPid);
    currentMeta = {
      ...currentMeta,
      childPid,
      ownsProcessGroup,
      ...(childTicks ? { childStartTicks: childTicks } : {}),
    };
    activeIncognitoHomes.set(resolvedHomeDir, currentMeta);
    try {
      if (existsSync(homeDir)) {
        writeOwnerMetaAtomic(homeDir, currentMeta);
      }
    } catch {
      // Directory may have been concurrently removed; in-memory cleanup still handles active child.
    }
    if (!childTicks) {
      const update = readProcessStart(childPid)
        .then((childStart) => {
          if (!childStart || cleaningOrDisposed || !existsSync(homeDir)) return;
          currentMeta = { ...currentMeta, childProcessStart: childStart };
          activeIncognitoHomes.set(resolvedHomeDir, currentMeta);
          writeOwnerMetaAtomic(homeDir, currentMeta);
        })
        .catch(() => {})
        .finally(() => {
          if (pendingMetaWrite === update) pendingMetaWrite = null;
        });
      pendingMetaWrite = update;
      return update;
    }
    return Promise.resolve();
  };

  try {
    try { chmodSync(homeDir, 0o700); } catch { /* non-POSIX */ }
    writeOwnerMetaAtomic(homeDir, currentMeta);

    const geminiDir = path.join(homeDir, '.gemini');
    const agyCliDir = path.join(geminiDir, 'antigravity-cli');
    const configDir = path.join(geminiDir, 'config');
    mkdirSync(agyCliDir, { recursive: true, mode: 0o700 });
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(configDir, 'mcp_config.json'), `${JSON.stringify({ mcpServers: {} })}\n`, { mode: 0o600 });

    const resolvedSource = sourceHome?.trim() ? path.resolve(sourceHome.trim()) : undefined;
    if (resolvedSource && resolvedSource !== resolvedHomeDir) {
      for (const rel of AUTH_RELATIVE_PATHS) {
        const src = path.join(resolvedSource, rel);
        if (!existsSync(src)) continue;
        const dst = path.join(homeDir, rel);
        mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
        copyFileSync(src, dst);
        try { chmodSync(dst, 0o600); } catch { /* non-POSIX */ }
      }
    }
  } catch (err) {
    cleanupSync();
    throw err;
  }

  const logFile = path.join(homeDir, 'agy.log');
  const env: Record<string, string> = {
    HOME: homeDir,
    USERPROFILE: homeDir,
    GEMINI_CLI_HOME: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    XDG_CACHE_HOME: path.join(homeDir, '.cache'),
    XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
    XDG_STATE_HOME: path.join(homeDir, '.local', 'state'),
  };
  const acpFlags = [AGY_CLI_FLAG.DISABLE_TELEMETRY, AGY_CLI_FLAG.LOG_FILE, logFile];

  return { homeDir, logFile, env, acpFlags, registerChildProcess, cleanup, cleanupSync };
}
