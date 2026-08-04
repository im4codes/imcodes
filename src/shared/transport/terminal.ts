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
}

export interface TerminalHistory {
  sessionName: string;
  content: string;
}
