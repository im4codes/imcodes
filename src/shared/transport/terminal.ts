// Protocol bounds live in the root `shared/` tree so the web bundle can import
// them as values without crossing into daemon source. Re-exported here for the
// daemon-side callers that already import from this module.
export { TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS } from '../../../shared/terminal-limits.js';

export interface TerminalDiff {
  sessionName: string;
  timestamp: number;
  lines: Array<[number, string]>;
  cols: number;
  rows: number;
  frameSeq?: number;
  fullFrame?: boolean;
  snapshotRequested?: boolean;
  scrolled?: boolean;
  newLineCount?: number;
  /**
   * `fullFrame` only. Where the application left the cursor (0-based screen
   * cell). A browser that repaints from a snapshot must put its cursor here, or
   * every cursor-relative byte that follows (`\r` + counter, an echoed key, a
   * status-line redraw) lands on the wrong row. Absent from older daemons and
   * from backends that cannot report it: the browser then keeps its old
   * behaviour.
   */
  cursor?: { x: number; y: number; visible: boolean };
  /**
   * `fullFrame` only. The pane is showing its ALTERNATE screen (vim, less,
   * htop...). `lines` is that screen and `normalLines` the one the application
   * returns to on exit; a browser that ignores this paints the alternate screen
   * into its normal buffer and never restores the shell screen afterwards.
   */
  altScreen?: boolean;
  normalLines?: Array<[number, string]>;
}

export interface TerminalHistory {
  sessionName: string;
  content: string;
}
