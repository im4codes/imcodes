import { describe, expect, it } from 'vitest';
import {
  WINDOWS_DAEMON_LOCK_PIPE,
  normalizeWindowsLockPath,
  resolveImcodesHome,
  resolveWindowsDefaultHome,
  windowsDaemonLockPipeName,
} from '../../src/util/windows-daemon-lock.js';

describe('Windows daemon lock pipe identity', () => {
  it('keeps the legacy pipe for the default home', () => {
    const defaultHome = resolveImcodesHome();
    expect(windowsDaemonLockPipeName({ homePath: defaultHome })).toBe(WINDOWS_DAEMON_LOCK_PIPE);
  });

  it('derives different pipes for different non-default homes', () => {
    const first = windowsDaemonLockPipeName({ homePath: 'C:\\imcodes-test-a\\.imcodes' });
    const second = windowsDaemonLockPipeName({ homePath: 'C:\\imcodes-test-b\\.imcodes' });
    expect(first).not.toBe(WINDOWS_DAEMON_LOCK_PIPE);
    expect(second).not.toBe(WINDOWS_DAEMON_LOCK_PIPE);
    expect(first).not.toBe(second);
  });

  it('treats case, separators and trailing slashes as the same home', () => {
    const first = windowsDaemonLockPipeName({ homePath: 'C:\\Users\\Test\\.imcodes\\' });
    const second = windowsDaemonLockPipeName({ homePath: 'c:/users/test/.imcodes' });
    expect(normalizeWindowsLockPath('C:\\Users\\Test\\.imcodes\\')).toBe(
      normalizeWindowsLockPath('c:/users/test/.imcodes'),
    );
    expect(first).toBe(second);
  });

  it('uses the socket directory as the isolation identity', () => {
    const first = windowsDaemonLockPipeName({ socketPath: 'C:\\tmp\\a\\daemon.sock' });
    const second = windowsDaemonLockPipeName({ socketPath: 'C:\\tmp\\b\\daemon.sock' });
    expect(first).not.toBe(second);
    expect(first).not.toBe(WINDOWS_DAEMON_LOCK_PIPE);
  });

  it('honors an IMCODES_HOME override', () => {
    const pipe = windowsDaemonLockPipeName({ env: { IMCODES_HOME: 'C:\\isolated\\.imcodes' } });
    expect(pipe).not.toBe(WINDOWS_DAEMON_LOCK_PIPE);
  });

  it('keeps a scoped pipe when the child overrides USERPROFILE', () => {
    const scoped = windowsDaemonLockPipeName({
      env: {
        IMCODES_HOME: 'C:\\scope\\.imcodes',
        USERPROFILE: 'C:\\scope',
        IMCODES_DEFAULT_HOME: 'C:\\Users\\admin',
      },
    });
    expect(scoped).not.toBe(WINDOWS_DAEMON_LOCK_PIPE);
    expect(scoped).toBe(windowsDaemonLockPipeName({
      homePath: 'C:\\scope\\.imcodes',
      env: { IMCODES_DEFAULT_HOME: 'C:\\Users\\admin' },
    }));
  });

  it('treats IMCODES_DEFAULT_HOME as the default PROFILE directory, like the launchers that write it', () => {
    // Launchers bake IMCODES_DEFAULT_HOME=dirname(<default>\.imcodes) and the
    // upgrade runner appends .imcodes, so the resolver must do the same.
    expect(resolveWindowsDefaultHome({ IMCODES_DEFAULT_HOME: 'C:\\Users\\admin' }))
      .toBe('C:\\Users\\admin\\.imcodes');
  });

  it('derives the default identity from the real profile, not USERPROFILE', () => {
    const env = {
      USERPROFILE: 'C:\\scoped-test-home',
      IMCODES_HOME: 'C:\\scoped-test-home\\.imcodes',
    };
    const realProfileHome = 'C:\\Users\\real-account';
    expect(resolveWindowsDefaultHome(env, realProfileHome)).toBe('C:\\Users\\real-account\\.imcodes');
    const scopedPipe = windowsDaemonLockPipeName({ env, realProfileHome });
    expect(scopedPipe).not.toBe(WINDOWS_DAEMON_LOCK_PIPE);
    expect(scopedPipe).toBe(windowsDaemonLockPipeName({
      homePath: env.IMCODES_HOME,
      env: { USERPROFILE: realProfileHome },
      realProfileHome,
    }));
  });

  it('honors a test HOME override even when USERPROFILE is unchanged', () => {
    const pipe = windowsDaemonLockPipeName({ env: { HOME: 'C:\\isolated-home' } });
    expect(pipe).not.toBe(WINDOWS_DAEMON_LOCK_PIPE);
  });
});
