import { homedir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { normalizeWindowsTaskHome, windowsHomeHash } from './windows-daemon-watchdog.mjs';

/** The pipe name used by the real, default Windows daemon installation. */
export const WINDOWS_DAEMON_LOCK_PIPE = '\\\\.\\pipe\\imcodes-daemon-lock';

const WINDOWS_DAEMON_LOCK_PIPE_PREFIX = `${WINDOWS_DAEMON_LOCK_PIPE}-`;

export interface WindowsDaemonLockPathOptions {
  /** Explicit state directory used by an isolated daemon. */
  homePath?: string;
  /** A daemon.sock path supplied by an isolated caller. */
  socketPath?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the state directory that owns the daemon lock.
 *
 * IMCODES_HOME is the explicit state-directory override. A socketPath is also
 * an isolation boundary for callers that do not have an IMCODES_HOME. The
 * default remains the user's real ~/.imcodes directory.
 */
export function resolveImcodesHome(options: WindowsDaemonLockPathOptions = {}): string {
  const explicitHome = options.homePath?.trim();
  if (explicitHome) return resolveLockPath(explicitHome);

  const explicitSocket = options.socketPath?.trim();
  if (explicitSocket) {
    const socketHome = looksLikeWindowsPath(explicitSocket)
      ? win32.dirname(explicitSocket)
      : dirname(explicitSocket);
    return resolveLockPath(socketHome);
  }

  const configuredHome = options.env
    ? options.env.IMCODES_HOME?.trim()
    : process.env.IMCODES_HOME?.trim();
  if (configuredHome) return resolveLockPath(configuredHome);

  // Test runners commonly override HOME without changing USERPROFILE (the
  // value Node uses for homedir() on Windows). Honor that explicit HOME when
  // it points somewhere else so isolated daemons receive their own pipe.
  const configuredUserHome = options.env ? options.env.HOME?.trim() : process.env.HOME?.trim();
  if (configuredUserHome
    && normalizeWindowsLockPath(configuredUserHome) !== normalizeWindowsLockPath(homedir())) {
    return resolveLockPath(join(configuredUserHome, '.imcodes'));
  }

  return resolve(join(homedir(), '.imcodes'));
}

function looksLikeWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\');
}

function resolveLockPath(path: string): string {
  return looksLikeWindowsPath(path) ? win32.resolve(path.replaceAll('/', '\\')) : resolve(path);
}

/**
 * Canonicalize a Windows path for identity purposes. Named pipes are global,
 * so case and separator differences must not create separate lock identities.
 */
export function normalizeWindowsLockPath(path: string): string {
  return normalizeWindowsTaskHome(path);
}

/**
 * Return the named pipe used by the daemon instance lock.
 *
 * The default home intentionally retains the historical pipe for backward
 * compatibility with installed daemons, watchdogs and upgrade handover. Any
 * non-default home gets a stable short hash, allowing isolated Windows test
 * daemons to run concurrently without weakening same-home exclusion.
 */
export function windowsDaemonLockPipeName(options: WindowsDaemonLockPathOptions = {}): string {
  const homePath = resolveImcodesHome(options);
  const defaultHome = resolve(join(homedir(), '.imcodes'));
  if (normalizeWindowsLockPath(homePath) === normalizeWindowsLockPath(defaultHome)) {
    return WINDOWS_DAEMON_LOCK_PIPE;
  }

  return `${WINDOWS_DAEMON_LOCK_PIPE_PREFIX}${windowsHomeHash(homePath)}`;
}
