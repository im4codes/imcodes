/**
 * The ONE answer to "where is IM.codes' state directory?" for the daemon, the CLI and their workers.
 *
 * `IMCODES_HOME` (trimmed; a relative value is resolved against the cwd) is the documented state-directory override and is
 * honoured by everything below; otherwise the default is `<home>/.imcodes`. A scoped or test daemon (IMCODES_HOME set) must never
 * open, create or write anything under the machine's real `~/.imcodes`, so no module may join `homedir()` with `.imcodes` itself:
 * test/util/imcodes-state-dir-guard.test.ts fails on any that does.
 *
 * The implementation is `resolveImcodesHome` (windows-daemon-lock.ts), which already carried the Windows rules (a profile home that
 * a scoped launcher overrides, IMCODES_DEFAULT_HOME) and was used by ~50 modules; this file is the name new code should reach for
 * and the single place the guard test allows to talk about it. The two standalone scripts that must run with only node builtins
 * (windows-launch-preflight.mjs, and windows-upgrade-runner.mjs which is copied ALONE to %TEMP%) cannot import it and carry an
 * inline copy of the IMCODES_HOME rule, pinned to this one by test/util/imcodes-state-dir.test.ts.
 *
 * Workers and child processes: a worker thread inherits process.env when it is created, and every spawned daemon helper receives
 * `IMCODES_HOME` through its environment (see childProcessEnvWithStateDir), so none of them re-derives it from homedir().
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { IMCODES_HOME_ENV } from '../../shared/imcodes-home-env.js';
import { resolveImcodesHome } from './windows-daemon-lock.js';

export { IMCODES_HOME_ENV };
/** Directory name under the account home when IMCODES_HOME is not set. */
export const IMCODES_STATE_DIR_NAME = '.imcodes' as const;

/** The state directory for `env` (default: this process). */
export function imcodesStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveImcodesHome({ env });
}

/**
 * The state directory for code that threads an account-home parameter (`homeDir`, defaulting to `homedir()`): the capability and
 * managed-skill stores. An EXPLICIT other home (a test's temp dir) keeps `<homeDir>/.imcodes`; the machine's own home defers to the
 * resolver, so IMCODES_HOME relocates those stores too without every caller having to know.
 */
export function imcodesStateDirForHome(homeDir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env[IMCODES_HOME_ENV]?.trim() && resolve(homeDir) === resolve(homedir())) return imcodesStateDir(env);
  return join(homeDir, IMCODES_STATE_DIR_NAME);
}

/** A path inside the state directory, evaluated when called (never cached at import time: IMCODES_HOME may be set later). */
export function imcodesStatePath(...segments: string[]): string {
  return join(imcodesStateDir(), ...segments);
}

/**
 * `env` for a spawned daemon helper (worker process, MCP child, upgrade script): the same environment plus the RESOLVED state
 * directory, so the child cannot fall back to its own `homedir()` guess. When IMCODES_HOME is not set nothing is added, which
 * keeps every default install byte-identical.
 */
export function childProcessEnvWithStateDir(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return env[IMCODES_HOME_ENV]?.trim() ? { ...env, [IMCODES_HOME_ENV]: imcodesStateDir(env) } : env;
}

/**
 * Just the state-directory entry, for env objects that are built from scratch instead of inheriting `process.env` (agent session
 * launch env, MCP server definitions). Empty when IMCODES_HOME is not set, so a default install's launch env is unchanged.
 */
export function imcodesStateDirEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return env[IMCODES_HOME_ENV]?.trim() ? { [IMCODES_HOME_ENV]: imcodesStateDir(env) } : {};
}
