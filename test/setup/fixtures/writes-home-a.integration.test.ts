import { expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Static, so the logger resolves its path when this file loads.
import logger from '../../../src/util/logger.js';

/** Probe for the parallel-cleanup test. Excluded from the ordinary suite. */
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

it('writes a daemon log inside the isolated home', async () => {
  claimEmptyHome('a');
  logger.info({ probe: 'worker-a' }, 'probe a');
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(existsSync(join(process.env.HOME!, '.imcodes', 'logs', 'daemon.log'))).toBe(true);
});
