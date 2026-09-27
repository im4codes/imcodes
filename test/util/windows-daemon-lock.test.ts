import { describe, expect, it } from 'vitest';
import {
  WINDOWS_DAEMON_LOCK_PIPE,
  normalizeWindowsLockPath,
  resolveImcodesHome,
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

  it('honors a test HOME override even when USERPROFILE is unchanged', () => {
    const pipe = windowsDaemonLockPipeName({ env: { HOME: 'C:\\isolated-home' } });
    expect(pipe).not.toBe(WINDOWS_DAEMON_LOCK_PIPE);
  });
});
