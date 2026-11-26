/**
 * The bytes that repaint a terminal from a daemon snapshot ("full frame").
 *
 * A snapshot is text, but the raw PTY bytes that follow it assume state the text
 * does not carry: where the cursor is, and whether the application is on the
 * alternate screen. Rebuilding only the text left every cursor-relative update
 * (`\r` + a counter, an echoed keystroke, a status-line redraw) landing on the
 * wrong row, and made leaving vim/less/htop keep showing the application's last
 * page instead of restoring the shell screen. This module owns that sequence so
 * the component and its tests build exactly the same bytes.
 */

import { TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS } from '@shared/terminal-limits.js';
import type { TerminalDiff } from './types.js';

const ESC = '\x1b';

/**
 * Resolves the row bounds for one diff frame.
 *
 * `declaredRows` is what the frame actually claims, or `null` when it claims
 * nothing usable; `rows` is the bound to test line indices against. They differ
 * on purpose: a frame with no usable `rows` must still paint its lines, because
 * the original code sized the buffer with `lines.slice(0, diff.rows)` and
 * `slice(0, undefined)` keeps everything. Collapsing an absent `rows` to 0 made
 * every line fail the bounds test and blanked the buffer, so incremental frames
 * stopped rendering and output only appeared when the next full frame redrew
 * the whole screen at once.
 */
export function resolveDiffRows(rawRows: unknown): { declaredRows: number | null; rows: number } {
  const declaredRows = Number.isFinite(rawRows)
    ? Math.max(0, Math.min(Math.floor(rawRows as number), TERMINAL_MAX_ROWS))
    : null;
  return { declaredRows, rows: declaredRows ?? TERMINAL_MAX_ROWS };
}

/**
 * The single rule for "is this a row this frame may describe".
 *
 * Both the line-array path and the ANSI cursor-addressing path must agree; when
 * they did not, a frame with rows=1 and lines=[[1000, …]] dropped the line from
 * the array but still emitted `\x1b[1001;1H` to the terminal.
 */
export function isRenderableLineIndex(lineIdx: unknown, rows: number): lineIdx is number {
  return Number.isInteger(lineIdx)
    && (lineIdx as number) >= 0
    && (lineIdx as number) < rows
    && (lineIdx as number) < TERMINAL_MAX_ROWS;
}

/** Merge a frame's `[row, text]` pairs into `target`, bounded by the frame's declared size. */
function mergeRows(target: string[], pairs: ReadonlyArray<readonly [number, string]>, rows: number): void {
  for (const [lineIdx, content] of pairs) {
    if (!isRenderableLineIndex(lineIdx, rows)) continue;
    while (target.length <= lineIdx) target.push('');
    target[lineIdx] = content;
  }
}

/**
 * The screen rows after applying one diff frame to the rows the view held.
 * `rows` and every `lineIdx` arrive over the wire, so everything is bounded
 * before the array grows: a single bad value would otherwise lock the main
 * thread in a synchronous loop hard enough that the tab cannot even reload.
 */
export function applyDiffToRows(current: string[], diff: Pick<TerminalDiff, 'rows' | 'lines'>): string[] {
  const { declaredRows, rows } = resolveDiffRows(diff.rows);
  mergeRows(current, diff.lines, rows);
  if (declaredRows === null) return current;
  while (current.length < declaredRows) current.push('');
  return current.slice(0, declaredRows);
}

/** The bytes that repaint a terminal from one full-frame diff, given the rows it now holds. */
export function fullFrameWriteFromDiff(diff: TerminalDiff, lines: readonly string[]): string {
  const { declaredRows, rows } = resolveDiffRows(diff.rows);
  const normalLines: string[] = [];
  if (diff.altScreen && Array.isArray(diff.normalLines)) {
    mergeRows(normalLines, diff.normalLines, rows);
    while (normalLines.length < (declaredRows ?? lines.length)) normalLines.push('');
  }
  const cursor = diff.cursor && Number.isFinite(diff.cursor.x) && Number.isFinite(diff.cursor.y)
    ? {
      x: Math.max(0, Math.min(Math.floor(diff.cursor.x), TERMINAL_MAX_COLS)),
      y: Math.max(0, Math.min(Math.floor(diff.cursor.y), Math.max(0, lines.length - 1))),
      visible: diff.cursor.visible !== false,
    }
    : undefined;
  return buildFullFrameWrite({ lines, cursor, altScreen: diff.altScreen === true, normalLines });
}

export interface FullFrameRepaint {
  /** The screen rows, top to bottom (already bounded by the caller). */
  lines: readonly string[];
  /** Where the application left the cursor, when the daemon could tell. */
  cursor?: { x: number; y: number; visible: boolean };
  /** The pane shows its alternate screen: `lines` is that screen. */
  altScreen?: boolean;
  /** The screen the application returns to on leaving the alternate screen. */
  normalLines?: readonly string[];
}

/** Rows rewritten from the top-left; everything below the last row is cleared. */
function paintRows(lines: readonly string[]): string {
  let out = `${ESC}[H`;
  for (let i = 0; i < lines.length; i++) {
    out += `${lines[i] ?? ''}${ESC}[K`;
    if (i < lines.length - 1) out += '\r\n';
  }
  return `${out}${ESC}[J`;
}

/**
 * Where the shell's cursor sits on the normal screen while an application owns
 * the alternate one: the line below its last output (the command was entered
 * and the application started from there). Only used to give `?1049l` a sane
 * cursor to restore; the daemon does not report the saved normal cursor.
 */
function savedNormalCursorRow(normalLines: readonly string[]): number {
  let last = -1;
  for (let i = 0; i < normalLines.length; i++) {
    if ((normalLines[i] ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trim() !== '') last = i;
  }
  return Math.max(0, Math.min(last + 1, normalLines.length - 1));
}

export function buildFullFrameWrite(frame: FullFrameRepaint): string {
  // Always start from the normal screen: if the application was already on the
  // alternate one (raw bytes entered it), this leaves it so the repaint below
  // describes the screen the daemon actually reported.
  let out = '';
  if (frame.altScreen) {
    const normal = frame.normalLines ?? [];
    out += `${ESC}[?1049l`;
    out += paintRows(normal);
    out += `${ESC}[${savedNormalCursorRow(normal) + 1};1H`;
    out += `${ESC}[?1049h`;
  } else {
    out += `${ESC}[?1049l`;
  }
  out += paintRows(frame.lines);
  if (frame.cursor) {
    out += `${ESC}[${frame.cursor.y + 1};${frame.cursor.x + 1}H`;
    out += frame.cursor.visible ? `${ESC}[?25h` : `${ESC}[?25l`;
  }
  return out;
}
