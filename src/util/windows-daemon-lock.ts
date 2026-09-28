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

/** Resolve the immutable legacy installation home used for compatibility.
 * Scoped launchers may override USERPROFILE/HOME, so callers must be able to
 * carry the real default explicitly instead of deriving it from the child. */
export function resolveWindowsDefaultHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.IMCODES_DEFAULT_HOME?.trim();
  if (configured) return resolveLockPath(configured);
  return resolveLockPath(join(env.USERPROFILE?.trim() || homedir(), '.imcodes'));
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

  // Test runners commonly override HOME without changing USERPROFILE (the
  // value Node uses for homedir() on Windows). Honor that explicit HOME when
  // it points somewhere else so isolated daemons receive their own pipe.
  const configuredUserHome = options.env ? options.env.HOME?.trim() : process.env.HOME?.trim();
  const configuredUserProfile = options.env ? options.env.USERPROFILE?.trim() : process.env.USERPROFILE?.trim();
  // Vitest's global setup supplies IMCODES_HOME, while a number of legacy
  // tests deliberately replace HOME for one module and expect its state under
  // that replacement. Keep the production rule (IMCODES_HOME wins) intact,
  // but treat a divergent test HOME as the per-test override; the setup value
  // is stale only when its parent no longer matches HOME.
  const runningVitest = process.env.VITEST === 'true' || process.env.VITEST_WORKER_ID !== undefined;
  if (configuredHome && runningVitest && configuredUserHome) {
    const configuredParent = looksLikeWindowsPath(configuredHome)
      ? win32.dirname(configuredHome)
      : dirname(configuredHome);
    const sameHome = looksLikeWindowsPath(configuredHome) || looksLikeWindowsPath(configuredUserHome)
      ? normalizeWindowsLockPath(configuredParent) === normalizeWindowsLockPath(configuredUserHome)
      : resolve(configuredParent) === resolve(configuredUserHome);
    if (!sameHome) return resolveLockPath(join(configuredUserHome, '.imcodes'));
  }
  if (configuredHome) return resolveLockPath(configuredHome);
  // On POSIX, HOME is the same source as os.homedir() and test suites often
  // mock homedir() without rewriting the process environment.  Treating an
  // ordinary POSIX HOME as authoritative here makes those mocks resolve into
  // the real developer home.  HOME divergence is only a Windows concern
  // (where USERPROFILE drives os.homedir()); Windows-shaped paths also let
  // unit tests exercise that branch on a non-Windows host.
  const windowsHomeOverride = process.platform === 'win32'
    || looksLikeWindowsPath(configuredUserHome ?? '')
    || looksLikeWindowsPath(configuredUserProfile ?? '');
  if (windowsHomeOverride && configuredUserHome
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
  const defaultHome = resolveWindowsDefaultHome(options.env ?? process.env);
  if (normalizeWindowsLockPath(homePath) === normalizeWindowsLockPath(defaultHome)) {
    return WINDOWS_DAEMON_LOCK_PIPE;
  }

  return `${WINDOWS_DAEMON_LOCK_PIPE_PREFIX}${windowsHomeHash(homePath)}`;
}
