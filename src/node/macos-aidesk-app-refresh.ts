/**
 * Replaces a RUNNING old aiDesk menu-bar app with the installed new one, only when it is safe (see shared/aidesk-app-refresh.ts for the
 * decision and for what a restart can and cannot touch). The node installs the bundle but nothing restarted the process that was
 * already running, so a Mac kept running days-old code (the tray click kept opening the browser) after the new app was on disk.
 *
 * Works for old and new apps alike (it needs nothing from the running app): the running version is read from LaunchServices
 * (`lsappinfo`, in the user's session), the installed one from the bundle's Info.plist.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AIDESK_APP_REFRESH_LIMITS,
  AIDESK_APP_REFRESH_REASON,
  decideAideskAppRefresh,
  nextAideskAppRefreshDelayMs,
  parseAideskMenuBarProcesses,
  recordAideskAppRefreshAttempt,
  type AideskAppRefreshDecision,
  type AideskAppRefreshReason,
  type AideskAppRefreshState,
} from '../../shared/aidesk-app-refresh.js';
import logger from '../util/logger.js';
import { defaultCredentialPath } from './enrollment.js';
import { MACOS_AIDESK_EXECUTABLE } from './macos-computer-use.js';
import { ensureMacosAideskAppInstalled } from './macos-remote-desktop-production.js';
import { MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_PATH } from './macos-remote-desktop-responsible-spawn.js';
import { launchMacosUserSessionCommand, resolveMacosUserSession, type MacosUserSession } from './user-session-launcher.js';

const STATE_FILE = 'aidesk-app-refresh.json';

export interface AideskAppRefreshDeps {
  appPath?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  resolveUser?: () => Promise<MacosUserSession>;
  /** Install-or-confirm the app from the upgrade archive first (default: the shared installer). */
  ensureInstalled?: () => Promise<void>;
  /** `ps -axo pid=,uid=,command=` */
  listProcesses?: () => Promise<string>;
  /** CFBundleVersion of the bundle on disk. */
  readInstalledVersion?: (appPath: string) => Promise<string | undefined>;
  /** CFBundleVersion the running process was started from, read in the user's session. */
  readRunningVersion?: (user: MacosUserSession, pid: number) => Promise<string | undefined>;
  /** Active remote-desktop connections right now (any > 0 defers the restart). */
  activeConnections: () => number;
  terminate?: (pid: number) => void;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Starts the app again in the user's session (never called while the old process is alive). */
  launch?: (user: MacosUserSession, appPath: string) => void;
  readState?: () => Promise<AideskAppRefreshState>;
  writeState?: (state: AideskAppRefreshState) => Promise<void>;
}

const execText = (file: string, args: readonly string[], timeoutMs = 10_000): Promise<string> => new Promise((resolve, reject) => {
  execFile(file, [...args], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
});

export function defaultAideskAppRefreshStatePath(): string {
  return join(dirname(defaultCredentialPath('darwin')), STATE_FILE);
}

async function defaultReadState(): Promise<AideskAppRefreshState> {
  try {
    const raw = JSON.parse(await readFile(defaultAideskAppRefreshStatePath(), 'utf8')) as Record<string, unknown>;
    const attempts = typeof raw.attempts === 'number' && Number.isSafeInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0;
    return {
      ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
      attempts,
      ...(typeof raw.lastAttemptAtMs === 'number' && Number.isFinite(raw.lastAttemptAtMs) ? { lastAttemptAtMs: raw.lastAttemptAtMs } : {}),
    };
  } catch {
    return { attempts: 0 };
  }
}

async function defaultWriteState(state: AideskAppRefreshState): Promise<void> {
  const path = defaultAideskAppRefreshStatePath();
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

async function defaultReadInstalledVersion(appPath: string): Promise<string | undefined> {
  try {
    const out = (await execText('/usr/bin/plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', join(appPath, 'Contents', 'Info.plist')])).trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

async function defaultReadRunningVersion(user: MacosUserSession, pid: number): Promise<string | undefined> {
  try {
    const out = await execText('/bin/launchctl', ['asuser', String(user.uid), '/usr/bin/lsappinfo', 'info', '-only', 'version', '-app', `pid:${pid}`]);
    return /"CFBundleVersion"="([^"]+)"/u.exec(out)?.[1];
  } catch {
    return undefined;
  }
}

export interface AideskAppRefreshResult {
  decision: AideskAppRefreshDecision;
  outcome: AideskAppRefreshReason;
}

/** One check: decide, and when the decision is to restart, do it (terminate politely, wait, start again). Never throws. */
export async function refreshMacosAideskApp(deps: AideskAppRefreshDeps): Promise<AideskAppRefreshResult> {
  const platform = deps.platform ?? process.platform;
  const unsupported = { decision: { action: 'none', reason: AIDESK_APP_REFRESH_REASON.UNSUPPORTED_PLATFORM } as AideskAppRefreshDecision, outcome: AIDESK_APP_REFRESH_REASON.UNSUPPORTED_PLATFORM };
  if (platform !== 'darwin') return unsupported;
  const appPath = deps.appPath ?? MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_PATH;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isAlive = deps.isAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const terminate = deps.terminate ?? ((pid: number) => { process.kill(pid, 'SIGTERM'); });
  const readState = deps.readState ?? defaultReadState;
  const writeState = deps.writeState ?? defaultWriteState;
  const launch = deps.launch ?? ((user: MacosUserSession, path: string) => {
    launchMacosUserSessionCommand(user, { executable: '/usr/bin/open', args: ['-g', path, '--args', '--aidesk-background'] });
  });
  try {
    // The install is lazy (the first remote-desktop command triggers it): do it now so "installed" is what the upgrade delivered.
    await (deps.ensureInstalled ?? (() => ensureMacosAideskAppInstalled()))().catch(() => undefined);
    let user: MacosUserSession;
    try {
      user = await (deps.resolveUser ?? (() => resolveMacosUserSession()))();
    } catch {
      return { decision: { action: 'none', reason: AIDESK_APP_REFRESH_REASON.NO_USER_SESSION }, outcome: AIDESK_APP_REFRESH_REASON.NO_USER_SESSION };
    }
    const installedVersion = await (deps.readInstalledVersion ?? defaultReadInstalledVersion)(appPath);
    const menuBar = parseAideskMenuBarProcesses(await (deps.listProcesses ?? (() => execText('/bin/ps', ['-axo', 'pid=,uid=,command='])))(), join(appPath, 'Contents', 'MacOS', MACOS_AIDESK_EXECUTABLE), user.uid);
    const readRunning = deps.readRunningVersion ?? defaultReadRunningVersion;
    const processes = await Promise.all(menuBar.map(async (entry) => ({ pid: entry.pid, runningVersion: await readRunning(user, entry.pid) })));
    const state = await readState();
    const decision = decideAideskAppRefresh({ installedVersion, processes, activeConnections: deps.activeConnections(), state, nowMs: now() });
    if (decision.action !== 'restart') return { decision, outcome: decision.reason };

    // Recorded BEFORE the attempt: a crash or a hang in what follows can never turn into an endless loop of restarts.
    await writeState(recordAideskAppRefreshAttempt(state, decision.to, now())).catch(() => undefined);
    terminate(decision.pid);
    const deadline = now() + AIDESK_APP_REFRESH_LIMITS.terminateWaitMs;
    while (isAlive(decision.pid) && now() < deadline) await sleep(250);
    if (isAlive(decision.pid)) {
      // Never escalate: an app that will not quit is left running, and the failed attempt is counted and logged.
      return { decision, outcome: AIDESK_APP_REFRESH_REASON.TERMINATE_TIMEOUT };
    }
    try {
      launch(user, appPath);
    } catch {
      return { decision, outcome: AIDESK_APP_REFRESH_REASON.LAUNCH_FAILED };
    }
    return { decision, outcome: AIDESK_APP_REFRESH_REASON.RESTARTED };
  } catch (error) {
    logger.warn({ err: error }, 'aidesk app refresh failed');
    return { decision: { action: 'none', reason: AIDESK_APP_REFRESH_REASON.ERROR }, outcome: AIDESK_APP_REFRESH_REASON.ERROR };
  }
}

/** Runs the check shortly after start and then periodically (soon while pending, hourly when current). Returns the stop function. */
export function startMacosAideskAppRefresh(
  deps: AideskAppRefreshDeps,
  options: { refresh?: typeof refreshMacosAideskApp; schedule?: (callback: () => void, ms: number) => { unref?: () => void }; clear?: (handle: unknown) => void } = {},
): () => void {
  if ((deps.platform ?? process.platform) !== 'darwin') return () => undefined;
  const refresh = options.refresh ?? refreshMacosAideskApp;
  const schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
  const clear = options.clear ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  let stopped = false;
  let handle: { unref?: () => void } | undefined;
  let lastLogged = '';
  let quietTicks = 0;
  const arm = (ms: number): void => {
    if (stopped) return;
    handle = schedule(() => { void run(); }, ms);
    handle.unref?.();
  };
  const run = async (): Promise<void> => {
    if (stopped) return;
    const result = await refresh(deps);
    const summary = `${result.decision.action}:${result.outcome}`;
    quietTicks += 1;
    // Every change of outcome is logged (with its reason code), and an unchanged pending outcome is repeated now and then, not every tick.
    if (summary !== lastLogged || (result.decision.action !== 'none' && quietTicks >= 12)) {
      const detail = result.decision.action === 'restart'
        ? { pid: result.decision.pid, from: result.decision.from, to: result.decision.to }
        : result.decision.action === 'defer' ? { pids: result.decision.pids } : {};
      logger.info({ reason: result.outcome, action: result.decision.action, ...detail }, 'aidesk app refresh');
      lastLogged = summary;
      quietTicks = 0;
    }
    arm(nextAideskAppRefreshDelayMs(result.decision, result.outcome));
  };
  arm(AIDESK_APP_REFRESH_LIMITS.initialDelayMs);
  return () => { stopped = true; if (handle) clear(handle); };
}
