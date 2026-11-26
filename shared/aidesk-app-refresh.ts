/**
 * Making a new aiDesk app bundle take effect on a Mac that is already running the old one.
 *
 * The node installs the app bundle (from the archive it was upgraded with) but nothing restarts the menu-bar process: a process that
 * started before the install keeps running its OLD code for days (the tray click kept opening the browser, not the app's own window).
 * This is the pure part of the fix: which running processes are "the menu-bar app", and whether/when one may be restarted. The effects
 * (ps, lsappinfo, kill, open, state file) live in src/node/macos-aidesk-app-refresh.ts.
 *
 * What a restart can touch: ONLY the menu-bar process (`aidesk-agent` with no arguments or `--aidesk-background`). The remote-desktop
 * launch agent and its workers are other processes (a LaunchAgent job and its children, started by launchd / the node, not by the app)
 * that merely run through the same executable path with other arguments (`--aidesk-component-dir=… --macos-remote-desktop-launch-agent`),
 * so they are never matched, and a session is never interrupted: with any active remote-desktop connection the restart waits.
 */

/** Limits and cadence; every number is deliberate, none is a timeout tuned to a machine. */
export const AIDESK_APP_REFRESH_LIMITS = Object.freeze({
  /** After the node started (the app install itself is lazy; this checks it first). */
  initialDelayMs: 45_000,
  /** While a restart is pending or deferred (a session is active, a retry is waiting). */
  pendingIntervalMs: 5 * 60 * 1000,
  /** When nothing is stale. */
  settledIntervalMs: 60 * 60 * 1000,
  /** Per installed app version: the node tries this many times, then stops until the next version. */
  maxAttemptsPerVersion: 3,
  /** Between two attempts for the same version. */
  minAttemptSpacingMs: 10 * 60 * 1000,
  /** How long a terminated process may take to exit before the attempt counts as failed (it is never killed harder). */
  terminateWaitMs: 5_000,
} as const);

export const AIDESK_APP_REFRESH_REASON = Object.freeze({
  RESTARTED: 'restarted',
  CURRENT: 'current',
  NOT_RUNNING: 'not_running',
  NO_APP_INSTALLED: 'no_app_installed',
  NO_USER_SESSION: 'no_user_session',
  VERSION_UNKNOWN: 'version_unknown',
  ACTIVE_SESSION: 'active_session',
  RETRY_WAIT: 'retry_wait',
  CAP_REACHED: 'cap_reached',
  TERMINATE_TIMEOUT: 'terminate_timeout',
  LAUNCH_FAILED: 'launch_failed',
  UNSUPPORTED_PLATFORM: 'unsupported_platform',
  ERROR: 'error',
} as const);
export type AideskAppRefreshReason = typeof AIDESK_APP_REFRESH_REASON[keyof typeof AIDESK_APP_REFRESH_REASON];

export interface AideskAppProcess {
  pid: number;
  /** The arguments after the executable path (empty for a Dock/Finder launch). */
  args: readonly string[];
}

/** Arguments the menu-bar app itself is started with (a LaunchServices -psn_ token is also tolerated). */
const MENU_BAR_ARGUMENTS: ReadonlySet<string> = new Set(['--aidesk-background', '--aidesk-open-panel']);

/**
 * The menu-bar processes of `uid` in `ps -axo pid=,uid=,command=` output: the app's own executable with no argument, `--aidesk-background`
 * (optionally with `--aidesk-open-panel`) or a LaunchServices serial token. The executable path may contain spaces, so it is matched as a
 * prefix of the whole command line. Anything else running through the same path (the launch-agent / worker components, the file-system
 * delegate) is NOT a menu-bar process.
 */
export function parseAideskMenuBarProcesses(psOutput: string, executablePath: string, uid: number): AideskAppProcess[] {
  const found: AideskAppProcess[] = [];
  for (const line of psOutput.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/u.exec(line);
    if (!match || Number(match[2]) !== uid) continue;
    const command = match[3]!;
    if (!command.startsWith(executablePath)) continue;
    const rest = command.slice(executablePath.length);
    if (rest !== '' && !rest.startsWith(' ')) continue;
    const args = rest.trim() === '' ? [] : rest.trim().split(/\s+/u);
    if (!args.every((arg) => MENU_BAR_ARGUMENTS.has(arg) || /^-psn_\d+_\d+$/u.test(arg))) continue;
    const pid = Number(match[1]);
    if (Number.isSafeInteger(pid) && pid > 0) found.push({ pid, args });
  }
  return found;
}

/** What is remembered between runs (and restarts of the node): attempts per installed version. */
export interface AideskAppRefreshState {
  version?: string;
  attempts: number;
  lastAttemptAtMs?: number;
}

export interface AideskAppRefreshInput {
  /** CFBundleVersion of the bundle on disk; undefined when no app is installed. */
  installedVersion: string | undefined;
  /** The running menu-bar processes and the CFBundleVersion each was started from (undefined = could not be read). */
  processes: ReadonlyArray<{ pid: number; runningVersion: string | undefined }>;
  activeConnections: number;
  state: AideskAppRefreshState;
  nowMs: number;
}

export type AideskAppRefreshDecision =
  | { action: 'none'; reason: AideskAppRefreshReason }
  | { action: 'defer'; reason: AideskAppRefreshReason; pids: readonly number[] }
  | { action: 'restart'; pid: number; from: string; to: string };

/**
 * Whether to restart now. Fail-safe in every uncertain direction: an unreadable version never restarts, an active connection always
 * waits, and a version that was already tried its allowed number of times is left alone until a newer one is installed.
 */
export function decideAideskAppRefresh(input: AideskAppRefreshInput): AideskAppRefreshDecision {
  const { installedVersion, processes, activeConnections, state, nowMs } = input;
  if (!installedVersion) return { action: 'none', reason: AIDESK_APP_REFRESH_REASON.NO_APP_INSTALLED };
  if (processes.length === 0) return { action: 'none', reason: AIDESK_APP_REFRESH_REASON.NOT_RUNNING };
  if (processes.some((entry) => entry.runningVersion === undefined)) return { action: 'none', reason: AIDESK_APP_REFRESH_REASON.VERSION_UNKNOWN };
  const stale = processes.filter((entry) => entry.runningVersion !== installedVersion);
  if (stale.length === 0) return { action: 'none', reason: AIDESK_APP_REFRESH_REASON.CURRENT };
  const pids = stale.map((entry) => entry.pid);
  const sameVersion = state.version === installedVersion;
  if (sameVersion && state.attempts >= AIDESK_APP_REFRESH_LIMITS.maxAttemptsPerVersion) {
    return { action: 'defer', reason: AIDESK_APP_REFRESH_REASON.CAP_REACHED, pids };
  }
  if (activeConnections > 0) return { action: 'defer', reason: AIDESK_APP_REFRESH_REASON.ACTIVE_SESSION, pids };
  if (sameVersion && state.lastAttemptAtMs !== undefined && nowMs - state.lastAttemptAtMs < AIDESK_APP_REFRESH_LIMITS.minAttemptSpacingMs) {
    return { action: 'defer', reason: AIDESK_APP_REFRESH_REASON.RETRY_WAIT, pids };
  }
  const first = stale[0]!;
  return { action: 'restart', pid: first.pid, from: first.runningVersion!, to: installedVersion };
}

/** The state after an attempt for `version` is about to be made (recorded BEFORE the attempt, so a crash cannot loop). */
export function recordAideskAppRefreshAttempt(state: AideskAppRefreshState, version: string, nowMs: number): AideskAppRefreshState {
  return { version, attempts: (state.version === version ? state.attempts : 0) + 1, lastAttemptAtMs: nowMs };
}

/** How long until the next check: soon while something is pending, rarely when everything is current. */
export function nextAideskAppRefreshDelayMs(decision: AideskAppRefreshDecision, outcome?: AideskAppRefreshReason): number {
  const pending = decision.action === 'restart'
    || decision.action === 'defer'
    || outcome === AIDESK_APP_REFRESH_REASON.TERMINATE_TIMEOUT
    || outcome === AIDESK_APP_REFRESH_REASON.LAUNCH_FAILED;
  // A version that reached its attempt cap is not retried soon either: only a new install can change that.
  const capped = decision.action === 'defer' && decision.reason === AIDESK_APP_REFRESH_REASON.CAP_REACHED;
  return pending && !capped ? AIDESK_APP_REFRESH_LIMITS.pendingIntervalMs : AIDESK_APP_REFRESH_LIMITS.settledIntervalMs;
}
