/** Control messages shared by the daemon terminal streamer and web viewer. */
export const TERMINAL_CONTROL = {
  STREAM_RESET: 'terminal.stream_reset',
  RECOVERY_EXHAUSTED: 'terminal.recovery_exhausted',
} as const;

export type TerminalControlType = typeof TERMINAL_CONTROL[keyof typeof TERMINAL_CONTROL];

/**
 * Why a `terminal.stream_reset` was sent. The browser does not branch on it (every
 * reset means "your picture can no longer be trusted: resync"), but the values
 * are on the wire and in logs, so they live in one place.
 */
export const TERMINAL_STREAM_RESET_REASON = {
  /** The pane was re-attached to a new tmux pane. */
  REBIND: 'rebind',
  /** The daemon's snapshot-handoff buffer overflowed. */
  RAW_BUFFER_OVERFLOW: 'raw_buffer_overflow',
  /** The server dropped frames for a slow browser socket. */
  BACKPRESSURE: 'backpressure',
  /**
   * The slow socket has drained and frames flow again. The snapshot requested
   * when the drop began was itself dropped (the socket was still full), so the
   * browser must ask again NOW, while a snapshot can actually be delivered.
   */
  BACKPRESSURE_RESUME: 'backpressure_resume',
} as const;

export type TerminalStreamResetReason =
  typeof TERMINAL_STREAM_RESET_REASON[keyof typeof TERMINAL_STREAM_RESET_REASON];

