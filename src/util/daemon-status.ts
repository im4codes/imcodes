import { execFileSync } from 'node:child_process';

type ExecFileSyncLike = (
  file: string,
  args: string[],
  options: Record<string, unknown>,
) => string | Buffer;

const UTF8_STDIO_OPTIONS = {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
} as const;

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

export function readProcessUptimeSeconds(pid: number, runner: ExecFileSyncLike = execFileSync): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;

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
