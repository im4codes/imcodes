/**
 * Run-scoped ownership for the per-worker isolated homes.
 *
 * Why a second layer exists: per-file cleanup in a worker is not reliable. A
 * worker can be killed between files, and a test that spawns a subprocess or a
 * real Worker with the isolated HOME can re-create the tree after that worker's
 * afterAll already removed it. Measured under `--maxWorkers=4`: 15 roots
 * survived a full daemon run that had per-file cleanup only.
 *
 * So ownership is split. This file, which runs once in the MAIN process and
 * outlives every worker, owns one root directory per vitest invocation and
 * removes it in teardown. test/setup/isolated-home.ts gives each worker its own
 * subdirectory inside it and never deletes anything. Nothing here can touch
 * another invocation's directory, because the name carries this process's pid.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Workers read this to find the run root; see isolated-home.ts. */
export const ISOLATED_HOME_RUN_ROOT_ENV = 'IMCODES_TEST_HOME_RUN_ROOT';

function runRootPath(): string {
  return join(tmpdir(), `imcodes-test-homes-${process.pid}`);
}

export async function setup(): Promise<void> {
  const runRoot = runRootPath();
  mkdirSync(runRoot, { recursive: true });
  // Set before the worker pool starts, so forked workers inherit it.
  process.env[ISOLATED_HOME_RUN_ROOT_ENV] = runRoot;
}

export async function teardown(): Promise<void> {
  // One deterministic removal, after every worker has exited — including workers
  // that were killed, whose subdirectory would otherwise survive.
  try {
    rmSync(runRootPath(), { recursive: true, force: true });
  } catch {
    // A leftover temp directory is harmless; failing teardown would fail an
    // otherwise green run.
  }
}
