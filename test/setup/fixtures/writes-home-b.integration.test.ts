import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Probe for the parallel-cleanup test: a SUBPROCESS writes into the isolated
 * home, which is the shape that defeated per-worker cleanup — a child can
 * re-create the tree after the worker that owned it is gone.
 */
/**
 * Every probe first proves its home is EMPTY, then leaves a sentinel behind. Run
 * sequentially in one worker, that turns cross-file leakage into a failure: the
 * second file would find the first file's sentinel.
 */
function claimEmptyHome(tag: string): void {
  const sentinel = join(process.env.IMCODES_HOME!, 'prior-file-sentinel');
  if (existsSync(sentinel)) {
    throw new Error(`state leaked from a previous test file into ${process.env.HOME} (seen by ${tag})`);
  }
  writeFileSync(sentinel, tag);
}

it('lets a subprocess write into the isolated home', () => {
  claimEmptyHome('b');
  const target = join(process.env.HOME!, '.imcodes', 'state');
  const result = spawnSync(
    process.execPath,
    ['-e', `require('fs').mkdirSync(process.argv[1], { recursive: true }); require('fs').writeFileSync(require('path').join(process.argv[1], 'child.json'), '{}');`, target],
    { encoding: 'utf8', timeout: 30_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(target, 'child.json'))).toBe(true);
});
