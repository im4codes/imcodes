/** Control messages shared by the daemon terminal streamer and web viewer. */
export const TERMINAL_CONTROL = {
  STREAM_RESET: 'terminal.stream_reset',
  RECOVERY_EXHAUSTED: 'terminal.recovery_exhausted',
} as const;

export type TerminalControlType = typeof TERMINAL_CONTROL[keyof typeof TERMINAL_CONTROL];
