/**
 * Display formatting for daemon status numbers.
 *
 * Every helper takes `unknown`-ish input and answers with a placeholder for a
 * missing or non-finite value, so a partial frame can never render "NaN".
 */
import { isFiniteStat } from '@shared/daemon-stats.js';

export const DAEMON_STAT_PLACEHOLDER = '—';

export function formatStatNumber(value: number | null | undefined, fractionDigits?: number): string {
  if (!isFiniteStat(value)) return DAEMON_STAT_PLACEHOLDER;
  return fractionDigits === undefined ? String(value) : value.toFixed(fractionDigits);
}

export function formatCpuPercent(value: number | null | undefined): string {
  return isFiniteStat(value) ? `${value}%` : DAEMON_STAT_PLACEHOLDER;
}

/** cpu colour class input: undefined when there is no number to judge. */
export function cpuSeverity(value: number | null | undefined): 'danger' | 'warn' | 'ok' | undefined {
  if (!isFiniteStat(value)) return undefined;
  return value > 80 ? 'danger' : value > 50 ? 'warn' : 'ok';
}

export function formatLoadTriple(a?: number | null, b?: number | null, c?: number | null): string {
  return `${formatStatNumber(a)} / ${formatStatNumber(b)} / ${formatStatNumber(c)}`;
}

/** "1.5G" / "512M" -- compact, for the sidebar rows. */
export function formatMemoryCompact(bytes: number | null | undefined): string {
  if (!isFiniteStat(bytes)) return DAEMON_STAT_PLACEHOLDER;
  const gb = bytes / (1024 ** 3);
  return gb >= 1 ? `${gb.toFixed(1)}G` : `${(bytes / (1024 ** 2)).toFixed(0)}M`;
}

/** "1.5 / 8.0 GB" -- detail card. Placeholder unless both numbers are usable. */
export function formatMemoryPair(usedBytes: number | null | undefined, totalBytes: number | null | undefined): string {
  if (!isFiniteStat(usedBytes) || !isFiniteStat(totalBytes)) return DAEMON_STAT_PLACEHOLDER;
  const totalGb = totalBytes / (1024 ** 3);
  if (totalGb >= 1) {
    return `${(usedBytes / (1024 ** 3)).toFixed(1)} / ${totalGb.toFixed(1)} GB`;
  }
  return `${(usedBytes / (1024 ** 2)).toFixed(0)} / ${(totalBytes / (1024 ** 2)).toFixed(0)} MB`;
}

export function formatUptime(seconds: number | null | undefined): string {
  if (!isFiniteStat(seconds)) return DAEMON_STAT_PLACEHOLDER;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}
