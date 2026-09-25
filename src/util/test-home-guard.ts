/**
 * Hard stop: a test process must never open or write the developer's real
 * ~/.imcodes.
 *
 * test/setup/isolated-home.ts points HOME at a temp dir for the daemon project,
 * but that only covers configs which install it. A test run through any other
 * config (or a subprocess it spawns) resolved ~/.imcodes to the real home and
 * wrote its fixtures into the live sessions.json; the running daemon then
 * reloaded that file and lost every main session. This guard sits at the store
 * boundary itself, so no config, helper, or child process can get around it.
 *
 * The real home is read from passwd (userInfo), not $HOME, so it still names the
 * production directory after a test has overridden the environment. VITEST is
 * inherited by child processes and worker threads, so they are covered too.
 */
import { userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';

function realImcodesDir(): string | undefined {
  try {
    return resolve(join(userInfo().homedir, '.imcodes'));
  } catch {
    return undefined;
  }
}

export function isUnderTestRunner(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.VITEST === 'string' && env.VITEST.length > 0;
}

/** True when `target` is the real ~/.imcodes or anything inside it. */
export function isRealImcodesPath(target: string): boolean {
  const real = realImcodesDir();
  if (!real) return false;
  const resolved = resolve(target);
  return resolved === real || resolved.startsWith(real + sep);
}

/**
 * Throws when a test process is about to touch the real ~/.imcodes. `':memory:'`
 * and other non-path SQLite targets pass through.
 */
export function assertNotRealImcodesPathInTests(target: string, what: string): void {
  if (!isUnderTestRunner()) return;
  if (!target || target === ':memory:') return;
  if (!isRealImcodesPath(target)) return;
  throw new Error(
    `refusing to open ${what} in the real ~/.imcodes from a test process (${target}). `
    + 'Tests must use an isolated HOME / explicit temp path; the production store is off limits.',
  );
}
