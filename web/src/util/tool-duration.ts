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

/**
 * Trim a tool descriptor to fit the chip without cutting mid-character.
 *
 * Slices by code point so a surrogate pair (emoji, rare CJK) is never split
 * into a lone half, which renders as a replacement glyph.
 */
export function truncateToolLabel(text: string, maxCodePoints: number): string {
  const points = Array.from(text);
  if (points.length <= maxCodePoints) return text;
  return `${points.slice(0, maxCodePoints).join('')}…`;
}
