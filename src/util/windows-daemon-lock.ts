import { homedir, userInfo } from 'node:os';
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
  /** Real account profile, injectable for deterministic cross-platform tests. */
  realProfileHome?: string;
}

/**
 * Return the account profile that owns the Windows installation.  USERPROFILE
 * is process-controlled and therefore cannot identify the machine-wide
 * default when an isolated child overrides it.  libuv's userInfo().homedir
 * comes from the account profile API and is independent of that override.
 * Keep the Windows-shaped USERPROFILE fallback for POSIX unit tests that
 * emulate Windows paths, and for runtimes where userInfo is unavailable.
 */
function resolveRealProfileHome(env: NodeJS.ProcessEnv): string {
  const envProfile = env.USERPROFILE?.trim() ?? '';
  if (process.platform !== 'win32') {
    // Preserve POSIX homedir() semantics; Windows-shaped fixtures are the
    // only non-Windows case where USERPROFILE intentionally emulates a
    // Windows account profile.
    return looksLikeWindowsPath(envProfile) ? envProfile : homedir();
  }
  try {
    const profile = typeof userInfo === 'function' ? userInfo().homedir.trim() : '';
    if (profile) return profile;
  } catch { /* fall back to the platform home */ }
  return homedir();
}

/** Resolve the immutable legacy installation home used for compatibility.
 * Scoped launchers may override USERPROFILE/HOME, so callers must be able to
 * carry the real default explicitly instead of deriving it from the child. */
export function resolveWindowsDefaultHome(
  env: NodeJS.ProcessEnv = process.env,
  realProfileHome?: string,
): string {
  // IMCODES_DEFAULT_HOME names the default account's PROFILE directory (the
  // launchers write dirname(defaultHome) and the upgrade runner appends
  // .imcodes), so the state home is one level below it.
  const configured = env.IMCODES_DEFAULT_HOME?.trim();
  if (configured) return resolveLockPath(join(configured, '.imcodes'));
  return resolveLockPath(join(realProfileHome?.trim() || resolveRealProfileHome(env), '.imcodes'));
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

  const env = options.env ?? process.env;
  const configuredHome = env.IMCODES_HOME?.trim();

  // Test runners commonly override HOME without changing USERPROFILE (the
  // value Node uses for homedir() on Windows). Honor that explicit HOME when
  // it points somewhere else so isolated daemons receive their own pipe.
  const configuredUserHome = env.HOME?.trim();
  const configuredUserProfile = env.USERPROFILE?.trim();
  const realProfileHome = options.realProfileHome?.trim() || resolveRealProfileHome(env);
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
    && normalizeWindowsLockPath(configuredUserHome) !== normalizeWindowsLockPath(realProfileHome)) {
    return resolveLockPath(join(configuredUserHome, '.imcodes'));
  }

  return resolveLockPath(join(realProfileHome, '.imcodes'));
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
  const defaultHome = resolveWindowsDefaultHome(options.env ?? process.env, options.realProfileHome);
  if (normalizeWindowsLockPath(homePath) === normalizeWindowsLockPath(defaultHome)) {
    return WINDOWS_DAEMON_LOCK_PIPE;
  }

  return `${WINDOWS_DAEMON_LOCK_PIPE_PREFIX}${windowsHomeHash(homePath)}`;
}
