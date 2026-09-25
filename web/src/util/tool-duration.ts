/**
 * Compact duration rendering for the Simple-view tool activity chip.
 *
 * Separate from the `formatElapsed` helpers in TaskCard / OpenSpecAutoDeliver:
 * those render a task timer (`1h 2m 3s`, `01:02:03`) with room to breathe. This
 * one shares a 26px chip with the counters and the progress rail, so it trades
 * precision for width as the number grows — sub-second detail matters when a
 * tool returns instantly, and is noise once it has been running for a minute.
 */

/** Sub-second tools are the common case; below this, show one decimal. */
const SUBSECOND_LIMIT_MS = 10_000;

export function formatToolDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < SUBSECOND_LIMIT_MS) {
    // 0.4s / 9.8s — a fast tool reads as fast, not as a flat "0s".
    return `${(safe / 1000).toFixed(1)}s`;
  }
  const totalSeconds = Math.floor(safe / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

export interface ElapsedDurationUnits {
  day: string;
  hour: string;
  minute: string;
  second: string;
  separator?: string;
}

/**
 * Format a whole-second elapsed duration for compact status displays.
 * Leading zero units are omitted. Precision decreases as the duration grows:
 * seconds, then minutes+seconds, hours+minutes, and days+hours.
 */
export function formatElapsedDuration(seconds: number, units: ElapsedDurationUnits): string {
  const totalSeconds = Math.max(0, Number.isFinite(seconds) ? Math.floor(seconds) : 0);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = totalSeconds % 60;
  const separator = units.separator ?? ' ';
  if (days > 0) return [`${days}${units.day}`, `${hours % 24}${units.hour}`].join(separator);
  if (hours > 0) {
    return [`${hours}${units.hour}`, `${minutes}${units.minute}`].join(separator);
  }
  if (minutes > 0) return [`${minutes}${units.minute}`, `${remainder}${units.second}`].join(separator);
  return `${remainder}${units.second}`;
}
