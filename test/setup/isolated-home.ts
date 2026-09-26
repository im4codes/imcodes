/**
 * Per-worker home isolation for the daemon test project.
 *
 * Why this file exists, and why it is a setupFile rather than a helper tests
 * opt into: paths are computed at MODULE IMPORT time all over the daemon —
 * `src/util/logger.ts` does `const LOG_DIR = join(homedir(), '.imcodes', 'logs')`
 * and then calls buildLogger() at import, which mkdirs that directory and opens
 * daemon.log for append. Under vitest stdout is not a TTY, so the logger takes
 * its daemon branch. Importing anything that transitively imports the logger is
 * therefore enough to append to the developer's real production log; 1558 lines
 * arrived there that way, 48 of them stamped with a test's mocked clock.
 *
 * vitest runs setupFiles before the test file is imported, so this is the
 * earliest point in a worker where the environment can still be changed before
 * any source module resolves a path. Anything later — an opt-in helper, a
 * beforeEach, a log filter — runs after the bytes are already in the real file.
 *
 * Explicit per-test overrides still win: a test that assigns process.env.HOME or
 * mocks os.homedir does so after this file has run.
 *
 * Each invocation gets its OWN directory, not one per worker. A worker is
 * long-lived and runs many files, so a per-worker path is shared on disk between
 * them: with `poolOptions.forks.singleFork` (or any config that pins pid and
 * worker id) file B starts inside the tree file A left behind, which makes
 * daemon tests order-dependent and can false-pass or false-fail them. Only the
 * environment was ever repaired per file; the filesystem was not.
 */
import { afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { ISOLATED_HOME_RUN_ROOT_ENV } from './isolated-home-global.js';

/**
 * A fresh home for THIS setup-file invocation, i.e. for this test file.
 *
 * mkdtempSync is what makes that true: the pid and worker id only name the
 * owner, they do not identify the directory. Deriving the path from them alone
 * hands the same directory to every file a worker runs, which is a leak the
 * environment reset cannot undo.
 *
 * It normally lives inside the run root owned by
 * test/setup/isolated-home-global.ts, which removes the whole tree once every
 * worker has exited — deterministic even when a worker is killed, or when a
 * subprocess a test spawned re-creates part of the tree afterwards.
 *
 * The fallback to tmpdir() keeps this file usable on its own: a throwaway config
 * that wires only setupFiles still isolates correctly, it just relies on the
 * afterAll below instead of run-scoped teardown.
 */
const OWNER = `${process.pid}-${process.env.VITEST_WORKER_ID ?? '0'}`;
const RUN_ROOT = process.env[ISOLATED_HOME_RUN_ROOT_ENV];
const RUN_SCOPED = typeof RUN_ROOT === 'string' && RUN_ROOT.length > 0;
const ISOLATED_HOME = mkdtempSync(
  RUN_SCOPED ? join(RUN_ROOT, `w-${OWNER}-`) : join(tmpdir(), `imcodes-test-home-${OWNER}-`),
);
const ISOLATED_IMCODES_HOME = join(ISOLATED_HOME, '.imcodes');

mkdirSync(ISOLATED_IMCODES_HOME, { recursive: true });

// os.homedir() reads HOME on POSIX and USERPROFILE on Windows, and it is what
// all of the ~/.imcodes path builders go through.
process.env.HOME = ISOLATED_HOME;
process.env.USERPROFILE = ISOLATED_HOME;
// Read directly by session-resource-registry, supervision-integration-bundle and
// supervision-worktree-gc, which prefer it over homedir(). Pointed at the same
// place so both routes resolve identically.
process.env.IMCODES_HOME = ISOLATED_IMCODES_HOME;

let cleaned = false;

/**
 * The real user home, read from passwd rather than $HOME so it still names the
 * right directory after this file has overridden the environment.
 */
function realUserHome(): string | undefined {
  try {
    return userInfo().homedir;
  } catch {
    return undefined;
  }
}

function cleanupOwnRoot(): void {
  if (cleaned) return;
  cleaned = true;
  // force: true so a worker that never wrote anything is not an error, and
  // recursive because the tree is whatever the tests built under it.
  try {
    rmSync(ISOLATED_HOME, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover temp dir is harmless, and throwing here would
    // fail an otherwise green run. In-flight async pino writes into a removed
    // directory are already tolerated (see the destination error handler in
    // src/util/logger.ts).
  }
}

/**
 * Per-file cleanup, and only when nobody else owns the tree.
 *
 * When the run root is present, the main process removes everything in teardown
 * and this worker deletes nothing: removing its own directory here would race
 * with subprocesses and real Workers that tests started with this HOME, which is
 * how 15 roots survived a full parallel run even though every file ran an
 * afterAll. The leak guard below still runs in both modes.
 */
afterAll(() => {
  // The guard, and it deliberately runs for EVERY daemon test file rather than
  // only the ones that thought about it: if a test pointed the home back at the
  // real one, that file fails, instead of the run quietly appending to the
  // developer's production ~/.imcodes. A test that wants its own home still
  // sets HOME to a temp dir of its own, which is not the real home and passes.
  const real = realUserHome();
  const leaked = real !== undefined
    && (process.env.HOME === real || process.env.IMCODES_HOME === join(real, '.imcodes'));
  if (!RUN_SCOPED) {
    cleanupOwnRoot();
    // The next file in this worker gets a fresh root from the top of this module.
    cleaned = false;
  }
  if (leaked) {
    throw new Error(
      `test home leaked to the real user home (${real}): HOME=${process.env.HOME}, `
      + `IMCODES_HOME=${process.env.IMCODES_HOME}. Point HOME at a temporary directory instead; `
      + 'writing under the real ~/.imcodes puts test output in the production daemon log.',
    );
  }
});

// Backstops only, for the paths afterAll cannot cover: a worker killed between
// files, or the run interrupted. SIGKILL is uncatchable, so a leftover root is
// still possible in that case — harmless, and never removed by another worker.
if (!(globalThis as { __imcodesIsolatedHomeCleanup?: boolean }).__imcodesIsolatedHomeCleanup) {
  (globalThis as { __imcodesIsolatedHomeCleanup?: boolean }).__imcodesIsolatedHomeCleanup = true;
  if (!RUN_SCOPED) {
    process.once('exit', cleanupOwnRoot);
    process.once('SIGINT', cleanupOwnRoot);
    process.once('SIGTERM', cleanupOwnRoot);
  }
}

// Do not pin a supervision engine globally. Tests must opt into the live
// `pairs` engine explicitly; an inherited legacy value is migration input only
// and must never silently reactivate retired supervision.

/**
 * Exported for the ownership test only: removes THIS worker's root and nothing
 * else, ignoring the once-per-file latch.
 */
export function removeIsolatedHomeRootForTests(): void {
  cleaned = false;
  cleanupOwnRoot();
  cleaned = false;
}

export { ISOLATED_HOME, ISOLATED_IMCODES_HOME, RUN_SCOPED };
