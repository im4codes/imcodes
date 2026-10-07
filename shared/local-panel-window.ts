/**
 * The ONE decision layer that opens the local aiDesk management panel as an independent application window, on every controlled-node
 * platform (Windows, macOS, Linux). Pure functions only: what to try, in which order, and why something was skipped. The node-side
 * executor (src/node/local-panel-window.ts) probes the machine, runs the plan and logs the reason codes; the three platforms'
 * native click handlers do nothing but start `imcodes-node --open-local-panel`.
 *
 * Fallback chain (identical everywhere): the native aiDesk window -> a system Chromium-family browser in app mode (no tabs, no
 * address bar, own window) -> the default browser. A machine without a desktop gets no window attempt at all: the panel stays
 * reachable and the URL is logged.
 */
import { AIDESK_PRODUCT_NAME } from './aidesk-product.js';
import { REMOTE_DESKTOP_LOCAL_MANAGEMENT } from './remote-desktop-local-management.js';

export type LocalPanelPlatform = 'win32' | 'darwin' | 'linux';

/** Every outcome of an open request carries exactly one of these codes (logged; also the test vocabulary). */
export const LOCAL_PANEL_WINDOW_REASON = Object.freeze({
  OPENED_NATIVE: 'opened_native_window',
  OPENED_APP_MODE: 'opened_app_mode_window',
  OPENED_DEFAULT_BROWSER: 'opened_default_browser',
  FOCUSED_EXISTING: 'focused_existing_window',
  KEPT_EXISTING: 'kept_existing_window_focus_unsupported',
  NO_PANEL: 'panel_not_running',
  NO_DESKTOP: 'no_desktop_session',
  NO_USER_SESSION: 'no_user_session',
  NATIVE_UI_MISSING: 'native_window_not_installed',
  NO_APP_MODE_BROWSER: 'no_app_mode_browser_found',
  LAUNCH_FAILED: 'launch_failed',
  URL_REJECTED: 'url_not_allowed',
  UNSUPPORTED_PLATFORM: 'unsupported_platform',
} as const);
export type LocalPanelWindowReason = typeof LOCAL_PANEL_WINDOW_REASON[keyof typeof LOCAL_PANEL_WINDOW_REASON];

export const LOCAL_PANEL_WINDOW_MECHANISM = Object.freeze({
  NATIVE: 'native',
  APP_MODE: 'app_mode',
  DEFAULT_BROWSER: 'default_browser',
} as const);
export type LocalPanelWindowMechanism = typeof LOCAL_PANEL_WINDOW_MECHANISM[keyof typeof LOCAL_PANEL_WINDOW_MECHANISM];

/**
 * The one window title, native or app-mode: the product name (also the native window's title and the panel's heading). The panel page
 * sets it as its <title>, which is what an app-mode window shows; the single-instance focus helpers look for it.
 */
export const LOCAL_PANEL_WINDOW_TITLE = AIDESK_PRODUCT_NAME;
/** Per-user record of the open window (pid + process start time), kept in the node state directory. */
export const LOCAL_PANEL_WINDOW_STATE_FILE = 'local-panel-window.json';
/** Directory (inside the state dir) of the dedicated browser profile used for app mode, so it never touches the user's own profile. */
export const LOCAL_PANEL_WINDOW_PROFILE_DIR = 'local-panel-browser-profile';
/** Absolute path that replaces the app-mode browser profile directory (isolated verification and operators; unset = the desktop user's own state directory). */
export const LOCAL_PANEL_PROFILE_DIR_ENV = 'IMCODES_LOCAL_PANEL_PROFILE_DIR' as const;
/** Query value used by the panel's external links: they go to the default browser through the node, never inside the app window. */
export const LOCAL_PANEL_EXTERNAL_PATH = '/open-external';
/**
 * How long the panel's open-window endpoint waits for the node to finish opening before it answers anyway (`in_progress`, still 200).
 * Shorter than the native clients' wait (local_management_open_window.h: 10 s), so on a slow machine a native client never gives up
 * and opens the browser while the node is still opening its window.
 */
export const LOCAL_PANEL_OPEN_ANSWER_BUDGET_MS = 8_000;
/**
 * The window opens at this size and the user can resize it. The browser offers no minimum-size flag: the panel page itself must lay
 * out from `LOCAL_PANEL_WINDOW_MIN_SIZE` up (a narrower or shorter window may scroll, never clip).
 */
export const LOCAL_PANEL_WINDOW_SIZE = Object.freeze({ width: 780, height: 560 } as const);
export const LOCAL_PANEL_WINDOW_MIN_SIZE = Object.freeze({ width: 480, height: 400 } as const);

/** The only address the app window may show or load: the loopback panel, exactly. */
export function localPanelUrl(): string {
  return `http://${REMOTE_DESKTOP_LOCAL_MANAGEMENT.HOST}:${REMOTE_DESKTOP_LOCAL_MANAGEMENT.PORT}${REMOTE_DESKTOP_LOCAL_MANAGEMENT.ROOT_PATH}`;
}

/** True only for the panel's own origin (scheme, host and port); no credentials, no other host, no other port. */
export function isAllowedLocalPanelUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'http:'
    && url.hostname === REMOTE_DESKTOP_LOCAL_MANAGEMENT.HOST
    && url.port === String(REMOTE_DESKTOP_LOCAL_MANAGEMENT.PORT)
    && url.username === '' && url.password === '';
}

/** Chromium-family browsers that support `--app=`, in preference order, per platform. Names are executables or app bundle names. */
export const LOCAL_PANEL_APP_MODE_BROWSERS: Readonly<Record<LocalPanelPlatform, readonly string[]>> = Object.freeze({
  win32: ['msedge.exe', 'chrome.exe', 'brave.exe'],
  darwin: ['Microsoft Edge', 'Google Chrome', 'Brave Browser', 'Chromium'],
  linux: ['microsoft-edge', 'microsoft-edge-stable', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser'],
});

/** Nothing listens here: an HTTP proxy at this address refuses every connection, so whatever it is asked to carry fails. */
export const LOCAL_PANEL_REFUSING_PROXY = `http://${REMOTE_DESKTOP_LOCAL_MANAGEMENT.HOST}:1`;

/**
 * Command-line flags Chromium-family browsers answer with a yellow "unsupported command-line flag ... stability and security
 * risks" bar in every window (chrome/browser/ui/startup/bad_flags_prompt.cc). The window is meant to look like an application, so
 * none of these may ever be passed; a test pins the list against the arguments built here.
 */
export const LOCAL_PANEL_WARNING_BAR_FLAGS: readonly string[] = Object.freeze([
  '--host-resolver-rules', '--no-sandbox', '--disable-web-security', '--ignore-certificate-errors', '--allow-running-insecure-content',
  '--single-process', '--disable-site-isolation-trials', '--disable-gpu-sandbox', '--reduce-security-for-testing', '--enable-automation',
  '--remote-debugging-port', '--remote-debugging-pipe', '--user-level-cache-dir', '--disable-popup-blocking-for-tests',
]);

/**
 * Arguments that make a Chromium-family browser show the panel as an application window: `--app` (no tabs/address bar), a profile
 * of its own, and a proxy that refuses every connection except the loopback (bypassed), so the window cannot load an external
 * site whatever the page does. (A host-resolver rule would do the same but makes the browser show a warning bar in every window.)
 */
export function buildLocalPanelAppModeArgs(profileDir: string): string[] {
  return [
    `--app=${localPanelUrl()}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${LOCAL_PANEL_WINDOW_SIZE.width},${LOCAL_PANEL_WINDOW_SIZE.height}`,
    `--proxy-server=${LOCAL_PANEL_REFUSING_PROXY}`,
    `--proxy-bypass-list=${REMOTE_DESKTOP_LOCAL_MANAGEMENT.HOST};localhost`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-features=Translate',
  ];
}

export interface LocalPanelWindowRecord {
  pid: number;
  /** The process start time (ms since epoch) when it was recorded: a recycled pid never matches. */
  startedAtMs: number;
  mechanism: LocalPanelWindowMechanism;
}

export function parseLocalPanelWindowRecord(raw: string): LocalPanelWindowRecord | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== 'object') return undefined;
    const mechanisms = Object.values(LOCAL_PANEL_WINDOW_MECHANISM) as string[];
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return undefined;
    if (typeof value.startedAtMs !== 'number' || !Number.isFinite(value.startedAtMs)) return undefined;
    if (typeof value.mechanism !== 'string' || !mechanisms.includes(value.mechanism)) return undefined;
    return { pid: value.pid as number, startedAtMs: value.startedAtMs, mechanism: value.mechanism as LocalPanelWindowMechanism };
  } catch { return undefined; }
}

/** The recorded window is still ours: that pid is alive and was started at the recorded time (start-time skew of a few seconds is clock rounding). */
export function isRecordedWindowAlive(
  record: LocalPanelWindowRecord | undefined,
  probe: { alive: boolean; startedAtMs?: number } | undefined,
  toleranceMs = 5_000,
): boolean {
  if (!record || !probe?.alive) return false;
  if (probe.startedAtMs === undefined) return true;
  return Math.abs(probe.startedAtMs - record.startedAtMs) <= toleranceMs;
}

export interface LocalPanelWindowFacts {
  platform: NodeJS.Platform;
  /** The panel server is up (a node enrolled with a public id): without it nothing may open a window onto a dead port. */
  panelRunning: boolean;
  /** An interactive desktop exists: Windows/macOS an active user session, Linux a DISPLAY/WAYLAND_DISPLAY. */
  hasDesktop: boolean;
  nativeUiInstalled: boolean;
  /** App-mode browsers found on this machine, in the order of LOCAL_PANEL_APP_MODE_BROWSERS. */
  appModeBrowsers: readonly string[];
  /** The window opened earlier is still alive. */
  existingWindowAlive: boolean;
  /** This platform has a way to bring that window to the front. */
  canFocusExisting: boolean;
}

export type LocalPanelWindowAttempt =
  | { mechanism: typeof LOCAL_PANEL_WINDOW_MECHANISM.NATIVE }
  | { mechanism: typeof LOCAL_PANEL_WINDOW_MECHANISM.APP_MODE; browser: string }
  | { mechanism: typeof LOCAL_PANEL_WINDOW_MECHANISM.DEFAULT_BROWSER };

export type LocalPanelWindowPlan =
  | { action: 'none'; reason: LocalPanelWindowReason }
  | { action: 'focus'; reason: LocalPanelWindowReason }
  | { action: 'open'; attempts: LocalPanelWindowAttempt[]; skipped: LocalPanelWindowReason[] };

/**
 * What to do for one click. The order is the product decision and lives only here:
 * 1. no panel / unsupported platform / no desktop -> nothing is opened (the reason is logged, the panel stays reachable);
 * 2. a window is already open -> focus it (or keep it when this platform cannot focus), never a second window;
 * 3. otherwise try the native window, then each app-mode browser, then the default browser; `skipped` records why earlier
 *    mechanisms were not even attempted.
 */
export function planLocalPanelWindow(facts: LocalPanelWindowFacts): LocalPanelWindowPlan {
  if (facts.platform !== 'win32' && facts.platform !== 'darwin' && facts.platform !== 'linux') {
    return { action: 'none', reason: LOCAL_PANEL_WINDOW_REASON.UNSUPPORTED_PLATFORM };
  }
  if (!facts.panelRunning) return { action: 'none', reason: LOCAL_PANEL_WINDOW_REASON.NO_PANEL };
  if (!facts.hasDesktop) {
    return { action: 'none', reason: facts.platform === 'linux' ? LOCAL_PANEL_WINDOW_REASON.NO_DESKTOP : LOCAL_PANEL_WINDOW_REASON.NO_USER_SESSION };
  }
  if (facts.existingWindowAlive) {
    return { action: 'focus', reason: facts.canFocusExisting ? LOCAL_PANEL_WINDOW_REASON.FOCUSED_EXISTING : LOCAL_PANEL_WINDOW_REASON.KEPT_EXISTING };
  }
  const attempts: LocalPanelWindowAttempt[] = [];
  const skipped: LocalPanelWindowReason[] = [];
  if (facts.nativeUiInstalled) attempts.push({ mechanism: LOCAL_PANEL_WINDOW_MECHANISM.NATIVE });
  else skipped.push(LOCAL_PANEL_WINDOW_REASON.NATIVE_UI_MISSING);
  if (facts.appModeBrowsers.length > 0) {
    for (const browser of facts.appModeBrowsers) attempts.push({ mechanism: LOCAL_PANEL_WINDOW_MECHANISM.APP_MODE, browser });
  } else {
    skipped.push(LOCAL_PANEL_WINDOW_REASON.NO_APP_MODE_BROWSER);
  }
  attempts.push({ mechanism: LOCAL_PANEL_WINDOW_MECHANISM.DEFAULT_BROWSER });
  return { action: 'open', attempts, skipped };
}

/** The reason code that describes a successful open by this mechanism. */
export function openedReasonOf(mechanism: LocalPanelWindowMechanism): LocalPanelWindowReason {
  return mechanism === LOCAL_PANEL_WINDOW_MECHANISM.NATIVE
    ? LOCAL_PANEL_WINDOW_REASON.OPENED_NATIVE
    : mechanism === LOCAL_PANEL_WINDOW_MECHANISM.APP_MODE
      ? LOCAL_PANEL_WINDOW_REASON.OPENED_APP_MODE
      : LOCAL_PANEL_WINDOW_REASON.OPENED_DEFAULT_BROWSER;
}
