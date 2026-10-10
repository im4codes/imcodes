/**
 * A new aiDesk app on disk replaces the old RUNNING menu-bar process, only when safe. Pure decisions + the effects with every system call
 * injected (ps, lsappinfo, plutil, kill, open, the state file, the clock): nothing here touches a real process or depends on wall time.
 */
import { describe, expect, it } from 'vitest';
import {
  AIDESK_APP_REFRESH_LIMITS,
  AIDESK_APP_REFRESH_REASON,
  decideAideskAppRefresh,
  nextAideskAppRefreshDelayMs,
  parseAideskMenuBarProcesses,
  recordAideskAppRefreshAttempt,
  type AideskAppRefreshState,
} from '../../shared/aidesk-app-refresh.js';
import { refreshMacosAideskApp, startMacosAideskAppRefresh, type AideskAppRefreshDeps } from '../../src/node/macos-aidesk-app-refresh.js';

const APP = '/Library/Application Support/aidesk/aiDesk.to by IM.codes.app';
const EXE = `${APP}/Contents/MacOS/aidesk-agent`;
const user = { name: 'k', uid: 501, gid: 20, home: '/Users/k', tempDir: '/tmp' };

describe('which processes are the menu-bar app', () => {
  it('matches the app executable (whose path has spaces) with no arguments, --aidesk-background, --aidesk-open-panel or a launch serial token, for this uid only', () => {
    const ps = [
      `  986     1 ${EXE} --aidesk-background`.replace('986     1', '986   501'),
      `  987   501 ${EXE}`,
      `  988   501 ${EXE} -psn_0_123456`,
      `  989   501 ${EXE} --aidesk-background --aidesk-open-panel`,
      `  990   502 ${EXE} --aidesk-background`,
    ].join('\n');
    expect(parseAideskMenuBarProcesses(ps, EXE, 501).map((p) => p.pid)).toEqual([986, 987, 988, 989]);
  });

  it('never matches the launch agent, the worker components, the file-system delegate or a look-alike path', () => {
    const ps = [
      `10322   501 ${EXE} --aidesk-component-dir=/Library/Application Support/imcodes-node/remote-desktop-worker/x --macos-remote-desktop-launch-agent`,
      `10323   501 ${EXE} --aidesk-fs-delegate /tmp/request`,
      `10324   501 ${EXE}2 --aidesk-background`,
      `10325   501 ${EXE}-extra`,
      `10326   501 /Applications/Other.app/Contents/MacOS/aidesk-agent --aidesk-background`,
      `10327   501 ${EXE} --aidesk-background --something-else`,
      'garbage line',
      '',
    ].join('\n');
    expect(parseAideskMenuBarProcesses(ps, EXE, 501)).toEqual([]);
  });
});

describe('decideAideskAppRefresh', () => {
  const base = { installedVersion: '2026.10.5', processes: [{ pid: 986, runningVersion: '2026.9.1' }], activeConnections: 0, state: { attempts: 0 } as AideskAppRefreshState, nowMs: 1_000_000 };

  it('restarts the stale process when nothing is active and nothing was tried', () => {
    expect(decideAideskAppRefresh(base)).toEqual({ action: 'restart', pid: 986, from: '2026.9.1', to: '2026.10.5' });
  });

  it('does nothing when the app is current, not running, not installed or a running version cannot be read (fail-safe)', () => {
    expect(decideAideskAppRefresh({ ...base, processes: [{ pid: 1, runningVersion: '2026.10.5' }] })).toEqual({ action: 'none', reason: 'current' });
    expect(decideAideskAppRefresh({ ...base, processes: [] })).toEqual({ action: 'none', reason: 'not_running' });
    expect(decideAideskAppRefresh({ ...base, installedVersion: undefined })).toEqual({ action: 'none', reason: 'no_app_installed' });
    expect(decideAideskAppRefresh({ ...base, processes: [{ pid: 1, runningVersion: undefined }] })).toEqual({ action: 'none', reason: 'version_unknown' });
    // one unreadable process among stale ones: still no restart
    expect(decideAideskAppRefresh({ ...base, processes: [{ pid: 1, runningVersion: '2026.9.1' }, { pid: 2, runningVersion: undefined }] }).action).toBe('none');
  });

  it('waits for ANY active connection, however many attempts or time have passed', () => {
    for (const activeConnections of [1, 2, 50]) {
      expect(decideAideskAppRefresh({ ...base, activeConnections })).toEqual({ action: 'defer', reason: 'active_session', pids: [986] });
    }
    expect(decideAideskAppRefresh({ ...base, activeConnections: 1, nowMs: 10 ** 12 })).toMatchObject({ action: 'defer', reason: 'active_session' });
  });

  it('spaces attempts for one version, caps them, and starts fresh for a newer version', () => {
    const tried = (attempts: number, ago: number): AideskAppRefreshState => ({ version: '2026.10.5', attempts, lastAttemptAtMs: base.nowMs - ago });
    expect(decideAideskAppRefresh({ ...base, state: tried(1, AIDESK_APP_REFRESH_LIMITS.minAttemptSpacingMs - 1) })).toMatchObject({ action: 'defer', reason: 'retry_wait' });
    expect(decideAideskAppRefresh({ ...base, state: tried(1, AIDESK_APP_REFRESH_LIMITS.minAttemptSpacingMs) }).action).toBe('restart');
    expect(decideAideskAppRefresh({ ...base, state: tried(AIDESK_APP_REFRESH_LIMITS.maxAttemptsPerVersion, 10 ** 9) })).toMatchObject({ action: 'defer', reason: 'cap_reached' });
    // a cap reached for an older version does not count against the newly installed one
    expect(decideAideskAppRefresh({ ...base, state: { version: '2026.10.4', attempts: 99, lastAttemptAtMs: base.nowMs } }).action).toBe('restart');
  });

  it('counts an attempt per version and records it with the time', () => {
    expect(recordAideskAppRefreshAttempt({ attempts: 0 }, 'v1', 5)).toEqual({ version: 'v1', attempts: 1, lastAttemptAtMs: 5 });
    expect(recordAideskAppRefreshAttempt({ version: 'v1', attempts: 2, lastAttemptAtMs: 5 }, 'v1', 9)).toEqual({ version: 'v1', attempts: 3, lastAttemptAtMs: 9 });
    expect(recordAideskAppRefreshAttempt({ version: 'v1', attempts: 2, lastAttemptAtMs: 5 }, 'v2', 9)).toEqual({ version: 'v2', attempts: 1, lastAttemptAtMs: 9 });
  });

  it('checks soon while something is pending and rarely otherwise; a capped version is not polled soon', () => {
    const pending = AIDESK_APP_REFRESH_LIMITS.pendingIntervalMs;
    const settled = AIDESK_APP_REFRESH_LIMITS.settledIntervalMs;
    expect(nextAideskAppRefreshDelayMs({ action: 'defer', reason: 'active_session', pids: [1] })).toBe(pending);
    expect(nextAideskAppRefreshDelayMs({ action: 'restart', pid: 1, from: 'a', to: 'b' }, 'terminate_timeout')).toBe(pending);
    expect(nextAideskAppRefreshDelayMs({ action: 'none', reason: 'current' })).toBe(settled);
    expect(nextAideskAppRefreshDelayMs({ action: 'defer', reason: 'cap_reached', pids: [1] })).toBe(settled);
    expect(nextAideskAppRefreshDelayMs({ action: 'restart', pid: 1, from: 'a', to: 'b' }, 'restarted')).toBe(pending);
  });
});

/** A fake Mac: one stale menu-bar process, one helper, the state file in memory, time that only moves when told. */
function fakeMac(over: Partial<AideskAppRefreshDeps> & { alive?: boolean; connections?: number } = {}) {
  const calls: string[] = [];
  let alive = over.alive ?? true;
  let now = 5_000_000;
  let state: AideskAppRefreshState = { attempts: 0 };
  const deps: AideskAppRefreshDeps = {
    appPath: APP,
    platform: 'darwin',
    now: () => now,
    resolveUser: async () => user,
    ensureInstalled: async () => { calls.push('ensureInstalled'); },
    listProcesses: async () => `986 501 ${EXE} --aidesk-background\n10322 501 ${EXE} --aidesk-component-dir=/x --macos-remote-desktop-launch-agent\n`,
    readInstalledVersion: async () => '2026.10.5',
    readRunningVersion: async (_user, pid) => (pid === 986 ? '2026.9.1' : undefined),
    activeConnections: () => over.connections ?? 0,
    terminate: (pid) => { calls.push(`terminate:${pid}`); if (over.alive !== true) alive = false; },
    isAlive: () => alive,
    sleep: async (ms) => { now += ms; },
    launch: (_user, path) => { calls.push(`launch:${path}`); },
    readState: async () => state,
    writeState: async (next) => { calls.push('writeState'); state = next; },
    ...over,
  };
  return { deps, calls, getState: () => state, setState: (next: AideskAppRefreshState) => { state = next; }, setNow: (value: number) => { now = value; } };
}

describe('refreshMacosAideskApp', () => {
  it('installs first, records the attempt BEFORE acting, terminates only the menu-bar pid, then starts the app again once it is gone', async () => {
    const mac = fakeMac();
    const result = await refreshMacosAideskApp(mac.deps);
    expect(result.outcome).toBe('restarted');
    expect(mac.calls).toEqual(['ensureInstalled', 'writeState', 'terminate:986', `launch:${APP}`]);
    expect(mac.getState()).toMatchObject({ version: '2026.10.5', attempts: 1 });
  });

  it('with an active connection nothing is touched: no state, no terminate, no launch', async () => {
    const mac = fakeMac({ connections: 1 });
    const result = await refreshMacosAideskApp(mac.deps);
    expect(result).toMatchObject({ outcome: 'active_session', decision: { action: 'defer' } });
    expect(mac.calls).toEqual(['ensureInstalled']);
    expect(mac.getState()).toEqual({ attempts: 0 });
  });

  it('a process that will not quit is left alone (never killed harder, never started a second time) and the failed attempt counts', async () => {
    const mac = fakeMac({ alive: true });
    const result = await refreshMacosAideskApp(mac.deps);
    expect(result.outcome).toBe('terminate_timeout');
    expect(mac.calls).toEqual(['ensureInstalled', 'writeState', 'terminate:986']);
    expect(mac.getState().attempts).toBe(1);
    // the second try waits out the spacing, and after the cap there is no third attempt for this version
    expect((await refreshMacosAideskApp(mac.deps)).outcome).toBe('retry_wait');
    for (let attempt = 2; attempt <= AIDESK_APP_REFRESH_LIMITS.maxAttemptsPerVersion; attempt += 1) {
      mac.setNow(5_000_000 + attempt * AIDESK_APP_REFRESH_LIMITS.minAttemptSpacingMs * 2);
      expect((await refreshMacosAideskApp(mac.deps)).outcome).toBe('terminate_timeout');
    }
    mac.setNow(5_000_000 + 10 * AIDESK_APP_REFRESH_LIMITS.minAttemptSpacingMs);
    expect((await refreshMacosAideskApp(mac.deps)).outcome).toBe('cap_reached');
    expect(mac.calls.filter((call) => call.startsWith('terminate'))).toHaveLength(AIDESK_APP_REFRESH_LIMITS.maxAttemptsPerVersion);
    expect(mac.calls.some((call) => call.startsWith('launch'))).toBe(false);
  });

  it('a failing launch is reported, not thrown, and counted (the node\'s own startup launch still brings the app back later)', async () => {
    const mac = fakeMac({ launch: () => { throw new Error('launchctl failed'); } });
    expect((await refreshMacosAideskApp(mac.deps)).outcome).toBe('launch_failed');
    expect(mac.getState().attempts).toBe(1);
  });

  it('is quiet and safe when the app is current, not running, has an unreadable running version, no user is logged in, or nothing is installed', async () => {
    expect((await refreshMacosAideskApp(fakeMac({ readInstalledVersion: async () => '2026.9.1' }).deps)).outcome).toBe('current');
    expect((await refreshMacosAideskApp(fakeMac({ listProcesses: async () => `10322 501 ${EXE} --macos-remote-desktop-launch-agent\n` }).deps)).outcome).toBe('not_running');
    expect((await refreshMacosAideskApp(fakeMac({ readRunningVersion: async () => undefined }).deps)).outcome).toBe('version_unknown');
    expect((await refreshMacosAideskApp(fakeMac({ resolveUser: async () => { throw new Error('no console user'); } }).deps)).outcome).toBe('no_user_session');
    expect((await refreshMacosAideskApp(fakeMac({ readInstalledVersion: async () => undefined }).deps)).outcome).toBe('no_app_installed');
    const none = fakeMac({ readInstalledVersion: async () => '2026.9.1' });
    await refreshMacosAideskApp(none.deps);
    expect(none.calls).toEqual(['ensureInstalled']);
  });

  it('a failing install, an unreadable state file or any thrown error never throws out of the check; other platforms do nothing', async () => {
    expect((await refreshMacosAideskApp(fakeMac({ ensureInstalled: async () => { throw new Error('archive unreadable'); } }).deps)).outcome).toBe('restarted');
    expect((await refreshMacosAideskApp(fakeMac({ listProcesses: async () => { throw new Error('ps failed'); } }).deps)).outcome).toBe('error');
    expect((await refreshMacosAideskApp(fakeMac({ platform: 'linux' }).deps)).outcome).toBe('unsupported_platform');
    expect((await refreshMacosAideskApp(fakeMac({ platform: 'win32' }).deps)).decision).toEqual({ action: 'none', reason: 'unsupported_platform' });
  });
});

describe('startMacosAideskAppRefresh', () => {
  it('checks after the initial delay, then soon while pending and hourly when current; stops cleanly; does nothing off macOS', async () => {
    const armed: number[] = [];
    const runs: Array<() => void> = [];
    const results = [
      { decision: { action: 'defer', reason: 'active_session', pids: [1] }, outcome: 'active_session' },
      { decision: { action: 'restart', pid: 1, from: 'a', to: 'b' }, outcome: 'restarted' },
      { decision: { action: 'none', reason: 'current' }, outcome: 'current' },
    ];
    const cleared: unknown[] = [];
    const stop = startMacosAideskAppRefresh(
      { platform: 'darwin', activeConnections: () => 0 },
      {
        refresh: (async () => results.shift()) as never,
        schedule: (callback, ms) => { armed.push(ms); runs.push(callback); return { unref() {} }; },
        clear: (handle) => cleared.push(handle),
      },
    );
    expect(armed).toEqual([AIDESK_APP_REFRESH_LIMITS.initialDelayMs]);
    for (let index = 0; index < 3; index += 1) { runs[index]!(); await new Promise((resolve) => setTimeout(resolve, 0)); }
    expect(armed).toEqual([
      AIDESK_APP_REFRESH_LIMITS.initialDelayMs,
      AIDESK_APP_REFRESH_LIMITS.pendingIntervalMs,
      AIDESK_APP_REFRESH_LIMITS.pendingIntervalMs,
      AIDESK_APP_REFRESH_LIMITS.settledIntervalMs,
    ]);
    stop();
    expect(cleared.length).toBe(1);
    const other = startMacosAideskAppRefresh({ platform: 'linux', activeConnections: () => 0 }, { schedule: () => { throw new Error('must not arm'); } });
    other();
    expect(AIDESK_APP_REFRESH_REASON.RESTARTED).toBe('restarted');
  });
});
