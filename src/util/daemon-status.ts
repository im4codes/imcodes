import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

export interface DaemonRuntimeStatus {
  pid: number;
  startedAt: number;
  updatedAt: number;
  restartCount: number;
  version?: string;
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
    return {
      pid,
      startedAt,
      updatedAt,
      restartCount,
      ...(typeof parsed.version === 'string' && parsed.version ? { version: parsed.version } : {}),
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
  };

  try {
    mkdirSync(baseDir, { recursive: true });
    const filePath = join(baseDir, RUNTIME_STATUS_FILE);
    const tempPath = join(dirname(filePath), `${RUNTIME_STATUS_FILE}.${pid}.${nowMs}.tmp`);
    writeFileSync(tempPath, JSON.stringify(next, null, 2), 'utf8');
    renameSync(tempPath, filePath);
    return next;
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
