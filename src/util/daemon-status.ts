import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

type ExecFileSyncLike = (
  file: string,
  args: string[],
  options: Record<string, unknown>,
) => string | Buffer;

const UTF8_STDIO_OPTIONS = {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
  windowsHide: true,
} as const;

const RUNTIME_STATUS_FILE = 'daemon-runtime.json';
export const DAEMON_SERVER_LINK_FRESH_MS = 30_000;
export const DAEMON_STORAGE_CRITICAL_FREE_BYTES = 512 * 1024 * 1024;
export const DAEMON_STORAGE_LOW_FREE_BYTES = 2 * 1024 * 1024 * 1024;

export interface DaemonResourceSnapshot {
  /** epoch ms when the snapshot was taken (for freshness display) */
  capturedAt: number;
  /** process.memoryUsage() fields, in bytes */
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

export interface DaemonRuntimeStatus {
  pid: number;
  startedAt: number;
  updatedAt: number;
  restartCount: number;
  version?: string;
  serverLink?: DaemonServerLinkRuntimeStatus;
  resources?: DaemonResourceSnapshot;
  diagnostics?: DaemonRuntimeDiagnosticsSnapshot;
}

export type DaemonServerLinkRuntimeState = 'connecting' | 'connected' | 'disconnected';

export interface DaemonServerLinkRuntimeStatus {
  state: DaemonServerLinkRuntimeState;
  updatedAt: number;
  serverId?: string;
  workerUrl?: string;
  lastConnectedAt?: number;
  lastDisconnectedAt?: number;
  lastHeartbeatAckAt?: number;
  lastHeartbeatSentAt?: number;
  lastSendFailedAt?: number;
  lastError?: string;
}

export interface DaemonServerLinkRuntimeUpdate {
  state: DaemonServerLinkRuntimeState;
  nowMs?: number;
  baseDir?: string;
  pid?: number;
  version?: string;
  serverId?: string;
  workerUrl?: string;
  lastConnectedAt?: number;
  lastDisconnectedAt?: number;
  lastHeartbeatAckAt?: number;
  lastHeartbeatSentAt?: number;
  lastSendFailedAt?: number;
  lastError?: string;
  clearError?: boolean;
}

export interface DaemonRuntimeDiagnosticsSnapshot {
  capturedAt: number;
  transportQueues?: DaemonTransportQueuesSnapshot;
  p2p?: DaemonP2pRuntimeSnapshot;
}

export interface DaemonTransportQueuesSnapshot {
  sessionCount: number;
  totalPendingCount: number;
  totalResendCount: number;
  totalActiveDispatchCount: number;
  sessions: DaemonTransportQueueSessionSnapshot[];
}

export interface DaemonTransportQueueSessionSnapshot {
  sessionName: string;
  agentType?: string;
  status?: string;
  sending?: boolean;
  pendingCount: number;
  pendingVersion?: number;
  activeDispatchCount?: number;
  stalePendingRecoveryActive?: boolean;
  providerSessionBound?: boolean;
  lastActivityAt?: number;
  lastActivityAgeMs?: number;
  resendCount: number;
  resendEntries?: Array<{
    commandId: string;
    queuedAt: number;
    ageMs: number;
    textPreview?: string;
  }>;
}

export interface DaemonP2pRuntimeSnapshot {
  activeCount: number;
  discussionWriteQueueCount?: number;
  discussionWritePendingBytes?: number;
  runs: DaemonP2pRunSnapshot[];
}

export interface DaemonP2pRunSnapshot {
  id: string;
  discussionId: string;
  status: string;
  runPhase?: string;
  activePhase?: string;
  currentRound?: number;
  totalRounds?: number;
  currentTargetSession?: string | null;
  currentTargetLabel?: string | null;
  hopStartedAt?: number | null;
  hopElapsedMs?: number | null;
  executionAttempt?: number | null;
  executionCycleCurrent?: number | null;
  executionCycleTotal?: number | null;
  executionMarkerPath?: string | null;
  error?: string | null;
}

let runtimeDiagnosticsProvider: (() => DaemonRuntimeDiagnosticsSnapshot | null | undefined) | null = null;

export function setDaemonRuntimeDiagnosticsProvider(
  provider: (() => DaemonRuntimeDiagnosticsSnapshot | null | undefined) | null,
): void {
  runtimeDiagnosticsProvider = provider;
}

export type DaemonServerLinkFreshness =
  | { status: 'unknown'; fresh: false; lastProofAt: null; staleMs: null }
  | { status: 'connected'; fresh: true; lastProofAt: number; staleMs: number }
  | { status: 'stale'; fresh: false; lastProofAt: number | null; staleMs: number | null }
  | { status: 'connecting' | 'disconnected'; fresh: false; lastProofAt: number | null; staleMs: number | null };

export interface DaemonFilesystemSpace {
  path: string;
  freeBytes: number;
  totalBytes: number;
  usedPercent: number;
  status: 'ok' | 'low' | 'critical';
}

export function parsePsElapsedSeconds(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
  }

  const dayParts = value.split('-');
  if (dayParts.length > 2) return null;
  const days = dayParts.length === 2 ? Number(dayParts[0]) : 0;
  const timePart = dayParts.length === 2 ? dayParts[1] : dayParts[0];
  if (!Number.isSafeInteger(days) || days < 0 || !timePart) return null;

  const parts = timePart.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return null;

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    if (seconds >= 60) return null;
    return days * 86_400 + minutes * 60 + seconds;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    if (minutes >= 60 || seconds >= 60) return null;
    return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
  }
  return null;
}

export function formatDurationSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

export function parseWindowsWmicCreationDateEpochMs(raw: string): number | null {
  const match = raw.match(/CreationDate=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{1,6})([+-]\d{3})?/);
  if (!match) return null;

  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, fractionRaw, offsetRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const millisecond = Number(fractionRaw.padEnd(6, '0').slice(0, 3));
  if (
    !Number.isSafeInteger(year)
    || !Number.isSafeInteger(month)
    || !Number.isSafeInteger(day)
    || !Number.isSafeInteger(hour)
    || !Number.isSafeInteger(minute)
    || !Number.isSafeInteger(second)
    || !Number.isSafeInteger(millisecond)
    || month < 1
    || month > 12
    || day < 1
    || day > 31
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    return null;
  }

  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const normalized = new Date(utcMs);
  if (
    normalized.getUTCFullYear() !== year
    || normalized.getUTCMonth() !== month - 1
    || normalized.getUTCDate() !== day
    || normalized.getUTCHours() !== hour
    || normalized.getUTCMinutes() !== minute
    || normalized.getUTCSeconds() !== second
  ) {
    return null;
  }

  if (!offsetRaw) return utcMs;
  const offsetMinutes = Number(offsetRaw);
  if (!Number.isSafeInteger(offsetMinutes)) return null;
  return utcMs - offsetMinutes * 60_000;
}

export function readProcessUptimeSeconds(
  pid: number,
  runner: ExecFileSyncLike = execFileSync,
  platform: NodeJS.Platform = process.platform,
  nowMs: number = Date.now(),
): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (platform === 'win32') return readWindowsProcessUptimeSeconds(pid, runner, nowMs);

  try {
    const out = runner('ps', ['-p', String(pid), '-o', 'etimes='], UTF8_STDIO_OPTIONS);
    const parsed = parsePsElapsedSeconds(String(out));
    if (parsed !== null) return parsed;
  } catch {
    // BSD/macOS ps may not support etimes. Fall back to etime below.
  }

  try {
    const out = runner('ps', ['-p', String(pid), '-o', 'etime='], UTF8_STDIO_OPTIONS);
    return parsePsElapsedSeconds(String(out));
  } catch {
    return null;
  }
}

function readWindowsProcessUptimeSeconds(pid: number, runner: ExecFileSyncLike, nowMs: number): number | null {
  try {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
      'if ($null -eq $p -or $null -eq $p.CreationDate) { exit 1 }',
      '[int64][Math]::Floor(((Get-Date) - $p.CreationDate).TotalSeconds)',
    ].join('; ');
    const out = runner(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      UTF8_STDIO_OPTIONS,
    );
    const parsed = parsePsElapsedSeconds(String(out));
    if (parsed !== null) return parsed;
  } catch {
    // Fall back to wmic below for older Windows environments.
  }

  try {
    const out = runner(
      'wmic',
      ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'],
      UTF8_STDIO_OPTIONS,
    );
    const startedAt = parseWindowsWmicCreationDateEpochMs(String(out));
    if (startedAt === null) return null;
    return Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  } catch {
    return null;
  }
}

export function readServiceRestartCount(
  platform: NodeJS.Platform = process.platform,
  runner: ExecFileSyncLike = execFileSync,
): number | null {
  if (platform !== 'linux') return null;
  try {
    const out = runner(
      'systemctl',
      ['--user', 'show', 'imcodes', '--property=NRestarts', '--value'],
      UTF8_STDIO_OPTIONS,
    ).toString().trim();
    const match = out.match(/\d+/);
    if (!match) return null;
    const count = Number(match[0]);
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

export function defaultDaemonRuntimeStatusDir(): string {
  return join(homedir(), '.imcodes');
}

export function readDaemonRuntimeStatus(baseDir: string = defaultDaemonRuntimeStatusDir()): DaemonRuntimeStatus | null {
  const filePath = join(baseDir, RUNTIME_STATUS_FILE);
  try {
    if (!existsSync(filePath)) return null;
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const pid = coerceNonNegativeSafeInteger(parsed.pid);
    const startedAt = coerceNonNegativeSafeInteger(parsed.startedAt);
    const updatedAt = coerceNonNegativeSafeInteger(parsed.updatedAt);
    const restartCount = coerceNonNegativeSafeInteger(parsed.restartCount);
    if (pid === null || startedAt === null || updatedAt === null || restartCount === null) return null;
    const serverLink = parseDaemonServerLinkRuntimeStatus(parsed.serverLink);
    const resources = parseDaemonResourceSnapshot(parsed.resources);
    const diagnostics = parseDaemonRuntimeDiagnosticsSnapshot(parsed.diagnostics);
    return {
      pid,
      startedAt,
      updatedAt,
      restartCount,
      ...(typeof parsed.version === 'string' && parsed.version ? { version: parsed.version } : {}),
      ...(serverLink ? { serverLink } : {}),
      ...(resources ? { resources } : {}),
      ...(diagnostics ? { diagnostics } : {}),
    };
  } catch {
    return null;
  }
}

export function recordDaemonStart(input: {
  pid?: number;
  nowMs?: number;
  baseDir?: string;
  version?: string;
} = {}): DaemonRuntimeStatus | null {
  const pid = input.pid ?? process.pid;
  const nowMs = input.nowMs ?? Date.now();
  const baseDir = input.baseDir ?? defaultDaemonRuntimeStatusDir();
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(nowMs) || nowMs < 0) return null;

  const previous = readDaemonRuntimeStatus(baseDir);
  const restartCount = previous && previous.pid !== pid
    ? previous.restartCount + 1
    : previous?.restartCount ?? 0;
  const next: DaemonRuntimeStatus = {
    pid,
    startedAt: nowMs,
    updatedAt: nowMs,
    restartCount,
    ...(input.version ? { version: input.version } : {}),
    // Heap can only be observed from inside the daemon process itself, so we
    // ride it along on writes that already happen (start + heartbeat) — no
    // dedicated polling timer / extra disk writes.
    resources: captureDaemonResourceSnapshot(nowMs),
    ...definedDiagnostics(),
  };

  return writeDaemonRuntimeStatus(next, baseDir, nowMs);
}

export function recordDaemonServerLinkStatus(input: DaemonServerLinkRuntimeUpdate): DaemonRuntimeStatus | null {
  const nowMs = input.nowMs ?? Date.now();
  const baseDir = input.baseDir ?? defaultDaemonRuntimeStatusDir();
  const pid = input.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(nowMs) || nowMs < 0) return null;

  const previous = readDaemonRuntimeStatus(baseDir);
  const samePid = previous?.pid === pid;
  const existingLink = samePid ? previous?.serverLink : undefined;
  const nextLink: DaemonServerLinkRuntimeStatus = {
    ...(existingLink ?? {}),
    state: input.state,
    updatedAt: nowMs,
    ...definedString('serverId', input.serverId),
    ...definedString('workerUrl', input.workerUrl),
    ...definedNonNegativeInteger('lastConnectedAt', input.lastConnectedAt),
    ...definedNonNegativeInteger('lastDisconnectedAt', input.lastDisconnectedAt),
    ...definedNonNegativeInteger('lastHeartbeatAckAt', input.lastHeartbeatAckAt),
    ...definedNonNegativeInteger('lastHeartbeatSentAt', input.lastHeartbeatSentAt),
    ...definedNonNegativeInteger('lastSendFailedAt', input.lastSendFailedAt),
    ...definedString('lastError', input.lastError),
  };
  if (input.clearError) delete nextLink.lastError;

  const next: DaemonRuntimeStatus = {
    pid,
    startedAt: samePid && previous ? previous.startedAt : nowMs,
    updatedAt: nowMs,
    restartCount: samePid && previous ? previous.restartCount : previous?.restartCount ?? 0,
    ...(input.version ?? previous?.version ? { version: input.version ?? previous?.version } : {}),
    // Capture a fresh heap snapshot on this heartbeat-driven write — heap is
    // only observable from inside the daemon, and this write happens anyway
    // (throttled to ~10s), so there is no extra disk I/O for it.
    resources: captureDaemonResourceSnapshot(nowMs),
    serverLink: nextLink,
    ...definedDiagnostics(),
  };
  return writeDaemonRuntimeStatus(next, baseDir, nowMs);
}

function definedDiagnostics(): { diagnostics?: DaemonRuntimeDiagnosticsSnapshot } {
  if (!runtimeDiagnosticsProvider) return {};
  try {
    const diagnostics = runtimeDiagnosticsProvider();
    return diagnostics ? { diagnostics } : {};
  } catch {
    return {};
  }
}

/** Capture a memory snapshot of the CURRENT process (the daemon). */
function captureDaemonResourceSnapshot(nowMs: number): DaemonResourceSnapshot {
  const m = process.memoryUsage();
  return {
    capturedAt: nowMs,
    rssBytes: m.rss,
    heapTotalBytes: m.heapTotal,
    heapUsedBytes: m.heapUsed,
    externalBytes: m.external,
    arrayBuffersBytes: m.arrayBuffers ?? 0,
  };
}

/**
 * Read another process's resident set size (RSS) live, on demand — used by
 * `imcodes status` so RSS is accurate at view time rather than as-of the last
 * daemon write. (Heap is NOT obtainable this way: a process's V8 heap is only
 * visible from inside that process, hence the self-reported snapshot above.)
 */
export function readProcessRssBytes(
  pid: number,
  runner: ExecFileSyncLike = execFileSync,
  platform: NodeJS.Platform = process.platform,
): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'win32') {
      const script = `$p = Get-Process -Id ${pid} -ErrorAction Stop; [int64]$p.WorkingSet64`;
      const out = runner(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        UTF8_STDIO_OPTIONS,
      );
      const bytes = Number(String(out).trim());
      return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
    }
    // Unix `ps` reports RSS in kilobytes.
    const out = runner('ps', ['-p', String(pid), '-o', 'rss='], UTF8_STDIO_OPTIONS);
    const kb = Number(String(out).trim());
    return Number.isSafeInteger(kb) && kb >= 0 ? kb * 1024 : null;
  } catch {
    return null;
  }
}

export function getDaemonServerLinkFreshness(
  status: DaemonRuntimeStatus | null,
  nowMs: number = Date.now(),
  freshMs: number = DAEMON_SERVER_LINK_FRESH_MS,
): DaemonServerLinkFreshness {
  const link = status?.serverLink;
  if (!link) return { status: 'unknown', fresh: false, lastProofAt: null, staleMs: null };
  const lastProofAt = Math.max(link.lastHeartbeatAckAt ?? 0, link.lastConnectedAt ?? 0) || null;
  const staleMs = lastProofAt === null ? null : Math.max(0, nowMs - lastProofAt);
  if (link.state === 'connected') {
    if (lastProofAt !== null && staleMs !== null && staleMs <= freshMs) {
      return { status: 'connected', fresh: true, lastProofAt, staleMs };
    }
    return { status: 'stale', fresh: false, lastProofAt, staleMs };
  }
  return { status: link.state, fresh: false, lastProofAt, staleMs };
}

export function readDaemonFilesystemSpace(path: string = defaultDaemonRuntimeStatusDir()): DaemonFilesystemSpace | null {
  try {
    const stats = statfsSync(path);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    const usedPercent = Math.max(0, Math.min(100, Math.round(((totalBytes - freeBytes) / totalBytes) * 100)));
    const status: DaemonFilesystemSpace['status'] = freeBytes < DAEMON_STORAGE_CRITICAL_FREE_BYTES || usedPercent >= 98
      ? 'critical'
      : freeBytes < DAEMON_STORAGE_LOW_FREE_BYTES || usedPercent >= 95
        ? 'low'
        : 'ok';
    return { path, freeBytes, totalBytes, usedPercent, status };
  } catch {
    return null;
  }
}

export function readPersistedDaemonUptimeSeconds(
  pid: number,
  nowMs: number = Date.now(),
  baseDir: string = defaultDaemonRuntimeStatusDir(),
): number | null {
  const status = readDaemonRuntimeStatus(baseDir);
  if (!status || status.pid !== pid || status.startedAt > nowMs) return null;
  return Math.max(0, Math.floor((nowMs - status.startedAt) / 1000));
}

export function readDaemonRestartCount(
  platform: NodeJS.Platform = process.platform,
  runner: ExecFileSyncLike = execFileSync,
  baseDir: string = defaultDaemonRuntimeStatusDir(),
): number | null {
  const serviceRestartCount = readServiceRestartCount(platform, runner);
  if (serviceRestartCount !== null) return serviceRestartCount;
  return readDaemonRuntimeStatus(baseDir)?.restartCount ?? null;
}

function coerceNonNegativeSafeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function writeDaemonRuntimeStatus(status: DaemonRuntimeStatus, baseDir: string, nowMs: number): DaemonRuntimeStatus | null {
  try {
    mkdirSync(baseDir, { recursive: true });
    const filePath = join(baseDir, RUNTIME_STATUS_FILE);
    const tempPath = join(dirname(filePath), `${RUNTIME_STATUS_FILE}.${status.pid}.${nowMs}.${process.pid}.tmp`);
    writeFileSync(tempPath, JSON.stringify(status, null, 2), 'utf8');
    renameSync(tempPath, filePath);
    return status;
  } catch {
    return null;
  }
}

function parseDaemonServerLinkRuntimeStatus(value: unknown): DaemonServerLinkRuntimeStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const state = raw.state;
  if (state !== 'connecting' && state !== 'connected' && state !== 'disconnected') return null;
  const updatedAt = coerceNonNegativeSafeInteger(raw.updatedAt);
  if (updatedAt === null) return null;
  return {
    state,
    updatedAt,
    ...definedString('serverId', raw.serverId),
    ...definedString('workerUrl', raw.workerUrl),
    ...definedNonNegativeInteger('lastConnectedAt', raw.lastConnectedAt),
    ...definedNonNegativeInteger('lastDisconnectedAt', raw.lastDisconnectedAt),
    ...definedNonNegativeInteger('lastHeartbeatAckAt', raw.lastHeartbeatAckAt),
    ...definedNonNegativeInteger('lastHeartbeatSentAt', raw.lastHeartbeatSentAt),
    ...definedNonNegativeInteger('lastSendFailedAt', raw.lastSendFailedAt),
    ...definedString('lastError', raw.lastError),
  };
}

function parseDaemonResourceSnapshot(value: unknown): DaemonResourceSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const capturedAt = coerceNonNegativeSafeInteger(raw.capturedAt);
  const rssBytes = coerceNonNegativeSafeInteger(raw.rssBytes);
  const heapTotalBytes = coerceNonNegativeSafeInteger(raw.heapTotalBytes);
  const heapUsedBytes = coerceNonNegativeSafeInteger(raw.heapUsedBytes);
  const externalBytes = coerceNonNegativeSafeInteger(raw.externalBytes);
  if (capturedAt === null || rssBytes === null || heapTotalBytes === null || heapUsedBytes === null || externalBytes === null) {
    return null;
  }
  return {
    capturedAt,
    rssBytes,
    heapTotalBytes,
    heapUsedBytes,
    externalBytes,
    arrayBuffersBytes: coerceNonNegativeSafeInteger(raw.arrayBuffersBytes) ?? 0,
  };
}

function parseDaemonRuntimeDiagnosticsSnapshot(value: unknown): DaemonRuntimeDiagnosticsSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const capturedAt = coerceNonNegativeSafeInteger(raw.capturedAt);
  if (capturedAt === null) return null;
  const transportQueues = parseDaemonTransportQueuesSnapshot(raw.transportQueues);
  const p2p = parseDaemonP2pRuntimeSnapshot(raw.p2p);
  return {
    capturedAt,
    ...(transportQueues ? { transportQueues } : {}),
    ...(p2p ? { p2p } : {}),
  };
}

function parseDaemonTransportQueuesSnapshot(value: unknown): DaemonTransportQueuesSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const sessionCount = coerceNonNegativeSafeInteger(raw.sessionCount);
  const totalPendingCount = coerceNonNegativeSafeInteger(raw.totalPendingCount);
  const totalResendCount = coerceNonNegativeSafeInteger(raw.totalResendCount);
  const totalActiveDispatchCount = coerceNonNegativeSafeInteger(raw.totalActiveDispatchCount);
  if (
    sessionCount === null
    || totalPendingCount === null
    || totalResendCount === null
    || totalActiveDispatchCount === null
  ) {
    return null;
  }
  const sessions = Array.isArray(raw.sessions)
    ? raw.sessions.map(parseDaemonTransportQueueSessionSnapshot).filter((item): item is DaemonTransportQueueSessionSnapshot => !!item)
    : [];
  return { sessionCount, totalPendingCount, totalResendCount, totalActiveDispatchCount, sessions };
}

function parseDaemonTransportQueueSessionSnapshot(value: unknown): DaemonTransportQueueSessionSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const sessionName = typeof raw.sessionName === 'string' && raw.sessionName.trim() ? raw.sessionName : null;
  const pendingCount = coerceNonNegativeSafeInteger(raw.pendingCount);
  const resendCount = coerceNonNegativeSafeInteger(raw.resendCount);
  if (!sessionName || pendingCount === null || resendCount === null) return null;
  const pendingVersion = coerceNonNegativeSafeInteger(raw.pendingVersion);
  const activeDispatchCount = coerceNonNegativeSafeInteger(raw.activeDispatchCount);
  const lastActivityAt = coerceNonNegativeSafeInteger(raw.lastActivityAt);
  const lastActivityAgeMs = coerceNonNegativeSafeInteger(raw.lastActivityAgeMs);
  const resendEntries = Array.isArray(raw.resendEntries)
    ? raw.resendEntries.map(parseDaemonTransportResendEntrySnapshot).filter((item): item is NonNullable<DaemonTransportQueueSessionSnapshot['resendEntries']>[number] => !!item)
    : undefined;
  return {
    sessionName,
    ...definedString('agentType', raw.agentType),
    ...definedString('status', raw.status),
    ...(typeof raw.sending === 'boolean' ? { sending: raw.sending } : {}),
    pendingCount,
    ...(pendingVersion !== null ? { pendingVersion } : {}),
    ...(activeDispatchCount !== null ? { activeDispatchCount } : {}),
    ...(typeof raw.stalePendingRecoveryActive === 'boolean' ? { stalePendingRecoveryActive: raw.stalePendingRecoveryActive } : {}),
    ...(typeof raw.providerSessionBound === 'boolean' ? { providerSessionBound: raw.providerSessionBound } : {}),
    ...(lastActivityAt !== null ? { lastActivityAt } : {}),
    ...(lastActivityAgeMs !== null ? { lastActivityAgeMs } : {}),
    resendCount,
    ...(resendEntries && resendEntries.length ? { resendEntries } : {}),
  };
}

function parseDaemonTransportResendEntrySnapshot(value: unknown): NonNullable<DaemonTransportQueueSessionSnapshot['resendEntries']>[number] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const commandId = typeof raw.commandId === 'string' && raw.commandId.trim() ? raw.commandId : null;
  const queuedAt = coerceNonNegativeSafeInteger(raw.queuedAt);
  const ageMs = coerceNonNegativeSafeInteger(raw.ageMs);
  if (!commandId || queuedAt === null || ageMs === null) return null;
  return {
    commandId,
    queuedAt,
    ageMs,
    ...definedString('textPreview', raw.textPreview),
  };
}

function parseDaemonP2pRuntimeSnapshot(value: unknown): DaemonP2pRuntimeSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const activeCount = coerceNonNegativeSafeInteger(raw.activeCount);
  if (activeCount === null) return null;
  const discussionWriteQueueCount = coerceNonNegativeSafeInteger(raw.discussionWriteQueueCount);
  const discussionWritePendingBytes = coerceNonNegativeSafeInteger(raw.discussionWritePendingBytes);
  const runs = Array.isArray(raw.runs)
    ? raw.runs.map(parseDaemonP2pRunSnapshot).filter((item): item is DaemonP2pRunSnapshot => !!item)
    : [];
  return {
    activeCount,
    ...(discussionWriteQueueCount !== null ? { discussionWriteQueueCount } : {}),
    ...(discussionWritePendingBytes !== null ? { discussionWritePendingBytes } : {}),
    runs,
  };
}

function parseDaemonP2pRunSnapshot(value: unknown): DaemonP2pRunSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : null;
  const discussionId = typeof raw.discussionId === 'string' && raw.discussionId.trim() ? raw.discussionId : null;
  const status = typeof raw.status === 'string' && raw.status.trim() ? raw.status : null;
  if (!id || !discussionId || !status) return null;
  const currentRound = coerceNonNegativeSafeInteger(raw.currentRound);
  const totalRounds = coerceNonNegativeSafeInteger(raw.totalRounds);
  const hopStartedAt = coerceNonNegativeSafeInteger(raw.hopStartedAt);
  const hopElapsedMs = coerceNonNegativeSafeInteger(raw.hopElapsedMs);
  const executionAttempt = coerceNonNegativeSafeInteger(raw.executionAttempt);
  const executionCycleCurrent = coerceNonNegativeSafeInteger(raw.executionCycleCurrent);
  const executionCycleTotal = coerceNonNegativeSafeInteger(raw.executionCycleTotal);
  return {
    id,
    discussionId,
    status,
    ...definedString('runPhase', raw.runPhase),
    ...definedString('activePhase', raw.activePhase),
    ...(currentRound !== null ? { currentRound } : {}),
    ...(totalRounds !== null ? { totalRounds } : {}),
    ...(typeof raw.currentTargetSession === 'string' || raw.currentTargetSession === null ? { currentTargetSession: raw.currentTargetSession } : {}),
    ...(typeof raw.currentTargetLabel === 'string' || raw.currentTargetLabel === null ? { currentTargetLabel: raw.currentTargetLabel } : {}),
    ...(hopStartedAt !== null ? { hopStartedAt } : {}),
    ...(hopElapsedMs !== null ? { hopElapsedMs } : {}),
    ...(executionAttempt !== null ? { executionAttempt } : {}),
    ...(executionCycleCurrent !== null ? { executionCycleCurrent } : {}),
    ...(executionCycleTotal !== null ? { executionCycleTotal } : {}),
    ...(typeof raw.executionMarkerPath === 'string' || raw.executionMarkerPath === null ? { executionMarkerPath: raw.executionMarkerPath } : {}),
    ...(typeof raw.error === 'string' || raw.error === null ? { error: raw.error } : {}),
  };
}

function definedString<K extends string>(key: K, value: unknown): { [P in K]?: string } {
  return typeof value === 'string' && value ? { [key]: value } as { [P in K]?: string } : {};
}

function definedNonNegativeInteger<K extends string>(key: K, value: unknown): { [P in K]?: number } {
  const parsed = coerceNonNegativeSafeInteger(value);
  return parsed === null ? {} : { [key]: parsed } as { [P in K]?: number };
}
