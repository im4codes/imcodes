/**
 * The macOS aiDesk app's own diagnostics log: what it did while opening (phases, whole milliseconds) and when its main thread was
 * late. One small file the app writes (bounded; no user names, paths or URLs: event and phase names and numbers only) and the CLI reads.
 * The native side mirrors these values in native/macos-remote-desktop/aidesk_ui_support.h; test/native/aidesk-ui-support.test.ts pins both.
 */
export const AIDESK_UI_LOG = Object.freeze({
  /** Below the user's home directory. */
  DIRECTORY: 'Library/Logs/IM.codes',
  FILE: 'aidesk-ui.log',
  /** The file is moved to `<file>.1` once it reaches this size. */
  MAX_BYTES: 64 * 1024,
  MAX_LINES_PER_RUN: 200,
  /** `aidesk-agent <arg>` prints the log. */
  APP_ARGUMENT: '--aidesk-ui-log',
  /** `imcodes-node <flag>` prints the same log for the user running it. */
  CLI_FLAG: '--aidesk-ui-log',
  /** How many of the newest lines the CLI prints. */
  CLI_TAIL_LINES: 200,
} as const);
