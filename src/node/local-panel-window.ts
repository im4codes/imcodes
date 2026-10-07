/**
 * Executor of the local-panel window decision (shared/local-panel-window.ts). It gathers the facts from a platform adapter, runs the
 * plan, keeps the single-instance record, and logs exactly one reason code per outcome. Everything platform-specific lives behind
 * `LocalPanelWindowPlatform`; nothing here knows how a window is opened on any one OS.
 */
import {
  LOCAL_PANEL_WINDOW_MECHANISM,
  LOCAL_PANEL_WINDOW_REASON,
  isAllowedLocalPanelUrl,
  isRecordedWindowAlive,
  localPanelUrl,
  openedReasonOf,
  parseLocalPanelWindowRecord,
  planLocalPanelWindow,
  type LocalPanelWindowAttempt,
  type LocalPanelWindowMechanism,
  type LocalPanelWindowReason,
  type LocalPanelWindowRecord,
} from '../../shared/local-panel-window.js';

export interface LocalPanelWindowProcess { pid: number; startedAtMs: number }

/** The thin, per-OS part: how to find, focus and start things for the ACTIVE USER's desktop. */
export interface LocalPanelWindowPlatform {
  readonly platform: NodeJS.Platform;
  /** An interactive desktop exists for a user (Windows/macOS: an active session; Linux: a reachable X/Wayland display). */
  hasDesktop(): Promise<boolean>;
  /** Absolute path of the native aiDesk window, when it is installed AND verified (see aidesk-local-ui-artifact.ts). */
  nativeUiPath(): Promise<string | undefined>;
  /** App-mode capable browsers that can be tried, in preference order (identifiers the platform's launchAppMode understands). */
  findAppModeBrowsers(): Promise<string[]>;
  /** A running panel window (native or app-mode), found by what it is -- not by a record. */
  findWindowProcess(): Promise<LocalPanelWindowProcess | undefined>;
  probePid(pid: number): Promise<{ alive: boolean; startedAtMs?: number }>;
  readonly canFocus: boolean;
  /** The native host (when installed) keeps its own single instance: it is simply asked each time, never looked for or focused from outside. */
  readonly nativeHostsOwnInstance?: boolean;
  focusWindow(window: LocalPanelWindowProcess): Promise<boolean>;
  launchNative(path: string): Promise<boolean>;
  launchAppMode(browser: string): Promise<boolean>;
  /** Last resort: the user's default browser opens `url` (always the panel URL, checked by the caller). */
  openDefaultBrowser(url: string): Promise<boolean>;
}

/** Where the single-instance record lives (the node state directory); a stale one is removed, never trusted. */
export interface LocalPanelWindowRecordStore {
  read(): string | undefined;
  write(value: string): void;
  clear(): void;
}

export interface LocalPanelWindowOutcome {
  reason: LocalPanelWindowReason;
  mechanism?: LocalPanelWindowMechanism;
  /** Reason codes of attempts that failed or mechanisms that were skipped on the way (for the log and for tests). */
  trail: LocalPanelWindowReason[];
}

export interface OpenLocalPanelWindowInput {
  platform: LocalPanelWindowPlatform;
  store: LocalPanelWindowRecordStore;
  /** The panel server answers (a node with a public id): nothing may open a window onto a dead port. */
  panelRunning: () => Promise<boolean>;
  log: (level: 'info' | 'warn', fields: Record<string, unknown>, message: string) => void;
  /** How long to look for the window process after launching it (for the record). Default 3 s in 200 ms steps. */
  locateTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The window opened earlier, if it is still there: the record when it still matches a live process, else a fresh look. */
async function resolveExistingWindow(input: OpenLocalPanelWindowInput): Promise<LocalPanelWindowProcess | undefined> {
  const record = parseLocalPanelWindowRecord(input.store.read() ?? '');
  if (record) {
    const probe = await input.platform.probePid(record.pid);
    if (isRecordedWindowAlive(record, probe)) return { pid: record.pid, startedAtMs: record.startedAtMs };
    // The pid is gone, or was recycled by another process: the record is stale.
    input.store.clear();
    input.log('info', { reason: 'stale_window_record_cleared', pid: record.pid }, 'local panel window: stale record removed');
  } else if (input.store.read() !== undefined) {
    input.store.clear();
    input.log('info', { reason: 'unreadable_window_record_cleared' }, 'local panel window: unreadable record removed');
  }
  const found = await input.platform.findWindowProcess();
  if (found) rememberWindow(input.store, found, LOCAL_PANEL_WINDOW_MECHANISM.APP_MODE);
  return found;
}

function rememberWindow(store: LocalPanelWindowRecordStore, window: LocalPanelWindowProcess, mechanism: LocalPanelWindowMechanism): void {
  const record: LocalPanelWindowRecord = { pid: window.pid, startedAtMs: window.startedAtMs, mechanism };
  store.write(JSON.stringify(record));
}

async function locateLaunchedWindow(input: OpenLocalPanelWindowInput, mechanism: LocalPanelWindowMechanism): Promise<void> {
  const sleep = input.sleep ?? defaultSleep;
  const deadline = (input.locateTimeoutMs ?? 3_000) / 200;
  for (let step = 0; step <= deadline; step += 1) {
    const found = await input.platform.findWindowProcess();
    if (found) { rememberWindow(input.store, found, mechanism); return; }
    await sleep(200);
  }
}

async function runAttempt(input: OpenLocalPanelWindowInput, attempt: LocalPanelWindowAttempt): Promise<boolean> {
  const { platform } = input;
  if (attempt.mechanism === LOCAL_PANEL_WINDOW_MECHANISM.NATIVE) {
    const path = await platform.nativeUiPath();
    return path !== undefined && platform.launchNative(path);
  }
  if (attempt.mechanism === LOCAL_PANEL_WINDOW_MECHANISM.APP_MODE) return platform.launchAppMode(attempt.browser);
  const url = localPanelUrl();
  // Defense in depth: the only URL any mechanism is ever handed is the panel's own.
  return isAllowedLocalPanelUrl(url) && platform.openDefaultBrowser(url);
}

/** One click on "local management": open the panel as an independent window, or focus the one already open. Never throws. */
export async function openLocalPanelWindow(input: OpenLocalPanelWindowInput): Promise<LocalPanelWindowOutcome> {
  const trail: LocalPanelWindowReason[] = [];
  // A logger that cannot write (unwritable log file, closed stream) must never turn a window that opened into a failure.
  const log: OpenLocalPanelWindowInput['log'] = (level, fields, message) => { try { input.log(level, fields, message); } catch { /* logging is best effort */ } };
  const finish = (outcome: Omit<LocalPanelWindowOutcome, 'trail'>, level: 'info' | 'warn' = 'info'): LocalPanelWindowOutcome => {
    const result = { ...outcome, trail };
    log(level, { reason: result.reason, mechanism: result.mechanism, trail, url: localPanelUrl() }, 'local panel window');
    return result;
  };
  try {
    const panelRunning = await input.panelRunning();
    const hasDesktop = panelRunning ? await input.platform.hasDesktop() : false;
    const nativePath = panelRunning && hasDesktop ? await input.platform.nativeUiPath() : undefined;
    const selfManagedNative = nativePath !== undefined && input.platform.nativeHostsOwnInstance === true;
    const existing = panelRunning && hasDesktop && !selfManagedNative ? await resolveExistingWindow(input) : undefined;
    const appModeBrowsers = panelRunning && hasDesktop && !existing ? await input.platform.findAppModeBrowsers() : [];
    const plan = planLocalPanelWindow({
      platform: input.platform.platform,
      panelRunning,
      hasDesktop,
      nativeUiInstalled: nativePath !== undefined,
      nativeHostsOwnInstance: input.platform.nativeHostsOwnInstance === true,
      appModeBrowsers,
      existingWindowAlive: existing !== undefined,
      canFocusExisting: input.platform.canFocus,
    });
    if (plan.action === 'none') return finish({ reason: plan.reason }, plan.reason === LOCAL_PANEL_WINDOW_REASON.NO_PANEL ? 'warn' : 'info');
    if (plan.action === 'focus') {
      if (input.platform.canFocus && existing && !(await input.platform.focusWindow(existing))) {
        trail.push(LOCAL_PANEL_WINDOW_REASON.KEPT_EXISTING);
        return finish({ reason: LOCAL_PANEL_WINDOW_REASON.KEPT_EXISTING });
      }
      return finish({ reason: plan.reason });
    }
    trail.push(...plan.skipped);
    for (const attempt of plan.attempts) {
      let ok = false;
      try { ok = await runAttempt(input, attempt); } catch { ok = false; }
      if (ok) {
        const selfManaged = attempt.mechanism === LOCAL_PANEL_WINDOW_MECHANISM.NATIVE && input.platform.nativeHostsOwnInstance === true;
        if (attempt.mechanism !== LOCAL_PANEL_WINDOW_MECHANISM.DEFAULT_BROWSER && !selfManaged) await locateLaunchedWindow(input, attempt.mechanism);
        return finish({ reason: openedReasonOf(attempt.mechanism), mechanism: attempt.mechanism });
      }
      trail.push(LOCAL_PANEL_WINDOW_REASON.LAUNCH_FAILED);
    }
    return finish({ reason: LOCAL_PANEL_WINDOW_REASON.LAUNCH_FAILED }, 'warn');
  } catch (error) {
    log('warn', { reason: LOCAL_PANEL_WINDOW_REASON.LAUNCH_FAILED, error: error instanceof Error ? error.message : String(error) }, 'local panel window failed');
    return { reason: LOCAL_PANEL_WINDOW_REASON.LAUNCH_FAILED, trail };
  }
}
