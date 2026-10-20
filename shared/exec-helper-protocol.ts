/**
 * Wire contract between the daemon and its exec helper: a tiny long-lived child
 * process that forks/execs short-lived tools (tmux, git, ps, PowerShell) on the
 * daemon's behalf. The fork cost of a large-RSS daemon grows with its RSS, so the
 * daemon posts `{file, args, options}` here and awaits the result instead of
 * calling `child_process.execFile` on its own main thread.
 */

/** `0` disables the helper (every call spawns directly); `1` forces it on under vitest. */
export const EXEC_HELPER_ENV_SWITCH = 'IMCODES_EXEC_HELPER';

export const EXEC_HELPER_MSG = {
  EXEC: 'exec',
  RESULT: 'result',
  READY: 'ready',
} as const;

/** `error.code` values the client itself produces; anything else comes from the tool or from node. */
export const EXEC_HELPER_ERROR_CODE = {
  /** The helper exited while the call was in flight; the tool may or may not have run. */
  CRASHED: 'EXEC_HELPER_CRASHED',
  /** The helper answered neither the tool nor its timeout in time; it was killed and respawned. */
  UNRESPONSIVE: 'EXEC_HELPER_UNRESPONSIVE',
} as const;

/**
 * The only `execFile` options the helper forwards. Anything else (`shell`, `signal`,
 * `stdio`, `uid`, `detached`, ...) is not IPC-safe or changes what the child is, so
 * the call spawns directly instead.
 */
export const EXEC_HELPER_FORWARDED_OPTIONS = [
  'cwd',
  'env',
  'timeout',
  'maxBuffer',
  'killSignal',
  'encoding',
  'windowsHide',
  'windowsVerbatimArguments',
] as const;

export interface ExecHelperOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeout?: number;
  maxBuffer?: number;
  killSignal?: string | number;
  encoding?: string;
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
}

export interface ExecHelperRequest {
  type: typeof EXEC_HELPER_MSG.EXEC;
  id: number;
  file: string;
  args: string[];
  options: ExecHelperOptions;
}

/** The own properties node puts on an `execFile` failure, copied so the caller sees the same error. */
export interface ExecHelperErrorInfo {
  name: string;
  message: string;
  code?: string | number | null;
  errno?: number;
  syscall?: string;
  path?: string;
  spawnargs?: string[];
  killed?: boolean;
  signal?: string | null;
  cmd?: string;
  stdout?: string | Uint8Array;
  stderr?: string | Uint8Array;
}

export type ExecHelperResponse =
  | { type: typeof EXEC_HELPER_MSG.RESULT; id: number; ok: true; stdout: string | Uint8Array; stderr: string | Uint8Array }
  | { type: typeof EXEC_HELPER_MSG.RESULT; id: number; ok: false; error: ExecHelperErrorInfo }
  | { type: typeof EXEC_HELPER_MSG.READY; pid: number };
