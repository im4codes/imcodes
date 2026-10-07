/**
 * The local-panel window decision: one shared plan, one executor, a thin adapter per OS. These tests drive the plan and the executor
 * with fake machines (no desktop, no browser, a stale record, a failing launcher...) and pin the reason codes.
 */
import { describe, expect, it } from 'vitest';
import { REMOTE_DESKTOP_LOCAL_MANAGEMENT } from '../../shared/remote-desktop-local-management.js';
import {
  LOCAL_PANEL_APP_MODE_BROWSERS,
  LOCAL_PANEL_WINDOW_MECHANISM,
  LOCAL_PANEL_WINDOW_REASON,
  LOCAL_PANEL_REFUSING_PROXY,
  LOCAL_PANEL_WARNING_BAR_FLAGS,
  buildLocalPanelAppModeArgs,
  isAllowedLocalPanelUrl,
  isRecordedWindowAlive,
  localPanelUrl,
  parseLocalPanelWindowRecord,
  planLocalPanelWindow,
  type LocalPanelWindowFacts,
} from '../../shared/local-panel-window.js';
import {
  openLocalPanelWindow,
  type LocalPanelWindowPlatform,
  type LocalPanelWindowProcess,
  type LocalPanelWindowRecordStore,
} from '../../src/node/local-panel-window.js';

const facts = (over: Partial<LocalPanelWindowFacts> = {}): LocalPanelWindowFacts => ({
  platform: 'linux', panelRunning: true, hasDesktop: true, nativeUiInstalled: false, appModeBrowsers: [],
  existingWindowAlive: false, canFocusExisting: true, ...over,
});

describe('the panel URL is the loopback panel and nothing else', () => {
  it('is exactly http://127.0.0.1:43751/ and accepts only that origin', () => {
    expect(localPanelUrl()).toBe(`http://${REMOTE_DESKTOP_LOCAL_MANAGEMENT.HOST}:${REMOTE_DESKTOP_LOCAL_MANAGEMENT.PORT}/`);
    expect(isAllowedLocalPanelUrl(localPanelUrl())).toBe(true);
    expect(isAllowedLocalPanelUrl('http://127.0.0.1:43751/api/state?x=1')).toBe(true);
    for (const bad of [
      'https://127.0.0.1:43751/', 'http://127.0.0.1:43752/', 'http://localhost:43751/', 'http://127.0.0.1/', 'http://evil.example/',
      'http://user:pw@127.0.0.1:43751/', 'http://127.0.0.1.evil.example:43751/', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '',
    ]) expect(isAllowedLocalPanelUrl(bad), bad).toBe(false);
  });

  it('app mode arguments: no tabs (--app), a dedicated profile, and a refusing proxy that only the loopback bypasses', () => {
    const args = buildLocalPanelAppModeArgs('/home/u/.imcodes/local-panel/browser-profile');
    expect(args).toContain(`--app=${localPanelUrl()}`);
    expect(args).toContain('--user-data-dir=/home/u/.imcodes/local-panel/browser-profile');
    expect(args).toContain('--window-size=960,640');
    expect(args).toContain(`--proxy-server=${LOCAL_PANEL_REFUSING_PROXY}`);
    expect(args).toContain('--proxy-bypass-list=127.0.0.1;localhost');
    expect(new URL(LOCAL_PANEL_REFUSING_PROXY).hostname).toBe('127.0.0.1');
    expect(new URL(LOCAL_PANEL_REFUSING_PROXY).port).not.toBe(String(REMOTE_DESKTOP_LOCAL_MANAGEMENT.PORT));
    expect(args.filter((arg) => arg.startsWith('--app='))).toHaveLength(1);
    expect(args.some((arg) => /^https?:\/\/(?!127\.0\.0\.1:(43751|1)\b)/u.test(arg))).toBe(false);
  });

  it('never passes a flag that makes the browser show its yellow "unsupported command-line flag" bar (a known-bad-flag guard)', () => {
    const flagNames = (args: readonly string[]): string[] => args.map((arg) => arg.split('=')[0]!);
    const names = flagNames(buildLocalPanelAppModeArgs('/home/u/profile'));
    for (const bad of LOCAL_PANEL_WARNING_BAR_FLAGS) expect(names, bad).not.toContain(bad);
    // The list itself must hold the flags known to raise the bar, so the guard cannot be emptied unnoticed.
    for (const known of ['--host-resolver-rules', '--no-sandbox', '--disable-web-security', '--ignore-certificate-errors']) expect(LOCAL_PANEL_WARNING_BAR_FLAGS).toContain(known);
    expect(flagNames(['--host-resolver-rules=MAP * ~NOTFOUND'])).toContain('--host-resolver-rules');
  });
});

describe('planLocalPanelWindow', () => {
  it('opens nothing without a panel, on an unsupported platform, or without a desktop -- each with its own reason', () => {
    expect(planLocalPanelWindow(facts({ panelRunning: false }))).toEqual({ action: 'none', reason: LOCAL_PANEL_WINDOW_REASON.NO_PANEL });
    expect(planLocalPanelWindow(facts({ platform: 'freebsd' }))).toEqual({ action: 'none', reason: LOCAL_PANEL_WINDOW_REASON.UNSUPPORTED_PLATFORM });
    expect(planLocalPanelWindow(facts({ hasDesktop: false }))).toEqual({ action: 'none', reason: LOCAL_PANEL_WINDOW_REASON.NO_DESKTOP });
    expect(planLocalPanelWindow(facts({ platform: 'win32', hasDesktop: false }))).toEqual({ action: 'none', reason: LOCAL_PANEL_WINDOW_REASON.NO_USER_SESSION });
    expect(planLocalPanelWindow(facts({ platform: 'darwin', hasDesktop: false }))).toEqual({ action: 'none', reason: LOCAL_PANEL_WINDOW_REASON.NO_USER_SESSION });
  });

  it('an open window is focused (or kept when the platform cannot focus), never duplicated', () => {
    expect(planLocalPanelWindow(facts({ existingWindowAlive: true, nativeUiInstalled: true, appModeBrowsers: ['chromium'] })))
      .toEqual({ action: 'focus', reason: LOCAL_PANEL_WINDOW_REASON.FOCUSED_EXISTING });
    expect(planLocalPanelWindow(facts({ existingWindowAlive: true, canFocusExisting: false })))
      .toEqual({ action: 'focus', reason: LOCAL_PANEL_WINDOW_REASON.KEPT_EXISTING });
  });

  it('chain order: native window, then each app-mode browser in order, then the default browser; skipped steps carry their reason', () => {
    expect(planLocalPanelWindow(facts({ nativeUiInstalled: true, appModeBrowsers: ['a', 'b'] }))).toEqual({
      action: 'open', skipped: [],
      attempts: [
        { mechanism: LOCAL_PANEL_WINDOW_MECHANISM.NATIVE },
        { mechanism: LOCAL_PANEL_WINDOW_MECHANISM.APP_MODE, browser: 'a' },
        { mechanism: LOCAL_PANEL_WINDOW_MECHANISM.APP_MODE, browser: 'b' },
        { mechanism: LOCAL_PANEL_WINDOW_MECHANISM.DEFAULT_BROWSER },
      ],
    });
    expect(planLocalPanelWindow(facts())).toEqual({
      action: 'open',
      skipped: [LOCAL_PANEL_WINDOW_REASON.NATIVE_UI_MISSING, LOCAL_PANEL_WINDOW_REASON.NO_APP_MODE_BROWSER],
      attempts: [{ mechanism: LOCAL_PANEL_WINDOW_MECHANISM.DEFAULT_BROWSER }],
    });
  });

  it('every platform lists app-mode browser candidates', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) expect(LOCAL_PANEL_APP_MODE_BROWSERS[platform].length).toBeGreaterThan(0);
  });
});

describe('the single-instance record', () => {
  it('parses only a complete record and rejects junk', () => {
    expect(parseLocalPanelWindowRecord('{"pid":42,"startedAtMs":1000,"mechanism":"app_mode"}')).toEqual({ pid: 42, startedAtMs: 1000, mechanism: 'app_mode' });
    for (const bad of ['', 'nope', '[]', '{}', '{"pid":0,"startedAtMs":1,"mechanism":"native"}', '{"pid":"7","startedAtMs":1,"mechanism":"native"}', '{"pid":7,"startedAtMs":1,"mechanism":"other"}', '{"pid":7,"mechanism":"native"}']) {
      expect(parseLocalPanelWindowRecord(bad), bad).toBeUndefined();
    }
  });

  it('is alive only for the same process: a recycled pid (different start time) or a dead pid is stale', () => {
    const record = { pid: 9, startedAtMs: 100_000, mechanism: LOCAL_PANEL_WINDOW_MECHANISM.APP_MODE };
    expect(isRecordedWindowAlive(record, { alive: true, startedAtMs: 101_000 })).toBe(true);
    expect(isRecordedWindowAlive(record, { alive: true })).toBe(true);
    expect(isRecordedWindowAlive(record, { alive: true, startedAtMs: 500_000 })).toBe(false);
    expect(isRecordedWindowAlive(record, { alive: false })).toBe(false);
    expect(isRecordedWindowAlive(undefined, { alive: true })).toBe(false);
  });
});

// ---- the executor, on fake machines ---------------------------------------------------------------------------------------------

function machine(over: Partial<{
  hasDesktop: boolean; native: string | undefined; browsers: string[]; running: LocalPanelWindowProcess | undefined;
  alive: Record<number, { alive: boolean; startedAtMs?: number }>; canFocus: boolean; focusOk: boolean;
  launchNativeOk: boolean; appModeOk: Record<string, boolean>; defaultOk: boolean; panelRunning: boolean; record: string | undefined;
}> = {}) {
  const state = {
    hasDesktop: true, native: undefined as string | undefined, browsers: [] as string[], running: undefined as LocalPanelWindowProcess | undefined,
    alive: {} as Record<number, { alive: boolean; startedAtMs?: number }>, canFocus: true, focusOk: true, launchNativeOk: true,
    appModeOk: {} as Record<string, boolean>, defaultOk: true, panelRunning: true, record: undefined as string | undefined, ...over,
  };
  const calls: string[] = [];
  const logs: Array<{ level: string; fields: Record<string, unknown> }> = [];
  const platform: LocalPanelWindowPlatform = {
    platform: 'linux',
    hasDesktop: async () => state.hasDesktop,
    nativeUiPath: async () => state.native,
    findAppModeBrowsers: async () => state.browsers,
    findWindowProcess: async () => state.running,
    probePid: async (pid) => state.alive[pid] ?? { alive: false },
    canFocus: state.canFocus,
    focusWindow: async () => { calls.push('focus'); return state.focusOk; },
    launchNative: async (path) => { calls.push(`native:${path}`); if (state.launchNativeOk) state.running = { pid: 77, startedAtMs: 5_000 }; return state.launchNativeOk; },
    launchAppMode: async (browser) => {
      calls.push(`app:${browser}`);
      const ok = state.appModeOk[browser] ?? true;
      if (ok) state.running = { pid: 88, startedAtMs: 6_000 };
      return ok;
    },
    openDefaultBrowser: async (url) => { calls.push(`default:${url}`); return state.defaultOk; },
  };
  const store: LocalPanelWindowRecordStore = {
    read: () => state.record,
    write: (value) => { state.record = value; },
    clear: () => { state.record = undefined; },
  };
  const run = () => openLocalPanelWindow({
    platform, store, panelRunning: async () => state.panelRunning,
    log: (level, fields) => { logs.push({ level, fields }); }, sleep: async () => undefined, locateTimeoutMs: 400,
  });
  return { state, calls, logs, run };
}

describe('openLocalPanelWindow', () => {
  it('the native window wins when installed; the record then names it', async () => {
    const m = machine({ native: '/opt/aidesk-local-ui', browsers: ['chromium'] });
    const out = await m.run();
    expect(out).toMatchObject({ reason: LOCAL_PANEL_WINDOW_REASON.OPENED_NATIVE, mechanism: LOCAL_PANEL_WINDOW_MECHANISM.NATIVE });
    expect(m.calls).toEqual(['native:/opt/aidesk-local-ui']);
    expect(parseLocalPanelWindowRecord(m.state.record ?? '')).toMatchObject({ pid: 77, mechanism: 'native' });
  });

  it('falls back native -> app mode (second browser) -> default browser, logging each failure', async () => {
    const m = machine({ native: '/opt/aidesk-local-ui', browsers: ['chrome', 'chromium'], launchNativeOk: false, appModeOk: { chrome: false, chromium: false } });
    const out = await m.run();
    expect(out).toMatchObject({ reason: LOCAL_PANEL_WINDOW_REASON.OPENED_DEFAULT_BROWSER, mechanism: LOCAL_PANEL_WINDOW_MECHANISM.DEFAULT_BROWSER });
    expect(m.calls).toEqual(['native:/opt/aidesk-local-ui', 'app:chrome', 'app:chromium', `default:${localPanelUrl()}`]);
    expect(out.trail.filter((entry) => entry === LOCAL_PANEL_WINDOW_REASON.LAUNCH_FAILED)).toHaveLength(3);
    expect(m.state.record).toBeUndefined();
  });

  it('with no native window the first working app-mode browser opens the window and is recorded', async () => {
    const m = machine({ browsers: ['chrome', 'chromium'], appModeOk: { chrome: false } });
    const out = await m.run();
    expect(out).toMatchObject({ reason: LOCAL_PANEL_WINDOW_REASON.OPENED_APP_MODE, mechanism: LOCAL_PANEL_WINDOW_MECHANISM.APP_MODE });
    expect(out.trail).toEqual([LOCAL_PANEL_WINDOW_REASON.NATIVE_UI_MISSING, LOCAL_PANEL_WINDOW_REASON.LAUNCH_FAILED]);
    expect(parseLocalPanelWindowRecord(m.state.record ?? '')).toMatchObject({ pid: 88, mechanism: 'app_mode' });
  });

  it('no runtime at all: the default browser is used and the reasons are logged (never a silent failure)', async () => {
    const m = machine();
    const out = await m.run();
    expect(out.reason).toBe(LOCAL_PANEL_WINDOW_REASON.OPENED_DEFAULT_BROWSER);
    expect(out.trail).toEqual([LOCAL_PANEL_WINDOW_REASON.NATIVE_UI_MISSING, LOCAL_PANEL_WINDOW_REASON.NO_APP_MODE_BROWSER]);
    expect(m.logs.at(-1)?.fields).toMatchObject({ reason: LOCAL_PANEL_WINDOW_REASON.OPENED_DEFAULT_BROWSER, trail: out.trail });
  });

  it('everything failing is reported as launch_failed, as a warning, without throwing', async () => {
    const m = machine({ defaultOk: false });
    const out = await m.run();
    expect(out.reason).toBe(LOCAL_PANEL_WINDOW_REASON.LAUNCH_FAILED);
    expect(m.logs.at(-1)?.level).toBe('warn');
  });

  it('no desktop (headless server) opens nothing and attempts no launch at all', async () => {
    const m = machine({ hasDesktop: false, native: '/opt/aidesk-local-ui', browsers: ['chromium'] });
    expect((await m.run()).reason).toBe(LOCAL_PANEL_WINDOW_REASON.NO_DESKTOP);
    expect(m.calls).toEqual([]);
  });

  it('a node without a panel (no public id) opens no window onto a dead port', async () => {
    const m = machine({ panelRunning: false, native: '/opt/aidesk-local-ui' });
    expect((await m.run()).reason).toBe(LOCAL_PANEL_WINDOW_REASON.NO_PANEL);
    expect(m.calls).toEqual([]);
  });

  it('second click: the recorded live window is focused, not duplicated; a platform that cannot focus keeps it', async () => {
    const m = machine({ record: '{"pid":50,"startedAtMs":1000,"mechanism":"app_mode"}', alive: { 50: { alive: true, startedAtMs: 1100 } }, browsers: ['chromium'] });
    expect((await m.run()).reason).toBe(LOCAL_PANEL_WINDOW_REASON.FOCUSED_EXISTING);
    expect(m.calls).toEqual(['focus']);
    const unable = machine({ canFocus: false, record: '{"pid":50,"startedAtMs":1000,"mechanism":"app_mode"}', alive: { 50: { alive: true } } });
    expect((await unable.run()).reason).toBe(LOCAL_PANEL_WINDOW_REASON.KEPT_EXISTING);
    expect(unable.calls).toEqual([]);
    const refused = machine({ focusOk: false, record: '{"pid":50,"startedAtMs":1000,"mechanism":"app_mode"}', alive: { 50: { alive: true } } });
    expect((await refused.run()).reason).toBe(LOCAL_PANEL_WINDOW_REASON.KEPT_EXISTING);
  });

  it('a stale record (dead pid, recycled pid, junk) is removed and a fresh window is opened', async () => {
    for (const record of ['{"pid":50,"startedAtMs":1000,"mechanism":"app_mode"}', 'junk']) {
      const m = machine({ record, alive: { 50: { alive: false } }, browsers: ['chromium'] });
      const out = await m.run();
      expect(out.reason).toBe(LOCAL_PANEL_WINDOW_REASON.OPENED_APP_MODE);
      expect(parseLocalPanelWindowRecord(m.state.record ?? '')).toMatchObject({ pid: 88 });
    }
    const recycled = machine({ record: '{"pid":50,"startedAtMs":1000,"mechanism":"app_mode"}', alive: { 50: { alive: true, startedAtMs: 900_000 } }, browsers: ['chromium'] });
    expect((await recycled.run()).reason).toBe(LOCAL_PANEL_WINDOW_REASON.OPENED_APP_MODE);
    expect(recycled.calls).toEqual(['app:chromium']);
  });

  it('a window found without a record (node restarted) is adopted and focused, not duplicated', async () => {
    const m = machine({ running: { pid: 60, startedAtMs: 2_000 }, browsers: ['chromium'] });
    expect((await m.run()).reason).toBe(LOCAL_PANEL_WINDOW_REASON.FOCUSED_EXISTING);
    expect(parseLocalPanelWindowRecord(m.state.record ?? '')).toMatchObject({ pid: 60 });
    expect(m.calls).toEqual(['focus']);
  });

  it('a logger that throws never turns an opened window into a failure', async () => {
    const m = machine({ browsers: ['chromium'] });
    const out = await openLocalPanelWindow({
      platform: { ...({} as LocalPanelWindowPlatform), platform: 'linux', hasDesktop: async () => true, nativeUiPath: async () => undefined, findAppModeBrowsers: async () => ['chromium'], findWindowProcess: async () => undefined, probePid: async () => ({ alive: false }), canFocus: true, launchAppMode: async () => true, openDefaultBrowser: async () => true, launchNative: async () => false, focusWindow: async () => true },
      store: { read: () => undefined, write: () => undefined, clear: () => undefined },
      panelRunning: async () => true, log: () => { throw new Error('log file is not writable'); }, sleep: async () => undefined, locateTimeoutMs: 0,
    });
    expect(out.reason).toBe(LOCAL_PANEL_WINDOW_REASON.OPENED_APP_MODE);
    expect(m.calls).toEqual([]);
  });

  it('a throwing adapter never escapes the executor', async () => {
    const m = machine({ browsers: ['chromium'] });
    const run = () => openLocalPanelWindow({
      platform: { ...({} as LocalPanelWindowPlatform), platform: 'linux', hasDesktop: async () => { throw new Error('boom'); }, nativeUiPath: async () => undefined },
      store: { read: () => undefined, write: () => undefined, clear: () => undefined },
      panelRunning: async () => true, log: () => undefined,
    });
    await expect(run()).resolves.toMatchObject({ reason: LOCAL_PANEL_WINDOW_REASON.LAUNCH_FAILED });
    expect(m.calls).toEqual([]);
  });
});
