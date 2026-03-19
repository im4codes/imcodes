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
