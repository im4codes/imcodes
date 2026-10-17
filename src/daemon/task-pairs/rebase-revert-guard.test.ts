import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { formatPossibleSilentRevertWarning, inspectPossibleSilentRevert, isRewrittenHead } from './rebase-revert-guard.js';

const exec = promisify(execFile);
async function run(cwd: string, ...args: string[]) { await exec('git', args, { cwd }); }
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'pair-revert-guard-'));
  await run(dir, 'init', '-q');
  await run(dir, 'config', 'user.email', 'test@example.com');
  await run(dir, 'config', 'user.name', 'Test');
  return dir;
}
async function commit(dir: string, subject: string) { await run(dir, 'add', '.'); await run(dir, 'commit', '-qm', subject); return (await exec('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim(); }

const material = (worktree: string, base: string, head: string) => ({ worktree, base, head, source: 'executor' as const });

describe('possible silent rebase revert guard', () => {
  it('does not warn for an ordinary deletion on a normal READY submission', async () => {
    const dir = await repo();
    try {
      await writeFile(join(dir, 'app.txt'), 'before\n');
      await commit(dir, 'initial');
      await writeFile(join(dir, 'app.txt'), 'before\nforeign fix\n');
      const foreign = await commit(dir, 'foreign fix: preserve state');
      await writeFile(join(dir, 'app.txt'), 'before\n');
      const head = await commit(dir, 'stale resolution');
      expect(await inspectPossibleSilentRevert(material(dir, foreign, head))).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('does not warn for a clean rebase or an intentional Revert commit', async () => {
    const dir = await repo();
    try {
      await writeFile(join(dir, 'app.txt'), 'before\n');
      await commit(dir, 'initial');
      await writeFile(join(dir, 'app.txt'), 'before\nforeign fix\n');
      const foreign = await commit(dir, 'foreign fix: preserve state');
      await writeFile(join(dir, 'app.txt'), 'before\nforeign fix\nclean change\n');
      const clean = await commit(dir, 'clean rebase');
      expect(await inspectPossibleSilentRevert(material(dir, foreign, clean))).toBeUndefined();
      await writeFile(join(dir, 'app.txt'), 'before\n');
      const intentional = await commit(dir, 'Revert "foreign fix: preserve state"');
      expect(await inspectPossibleSilentRevert(material(dir, foreign, intentional))).toBeUndefined();
      await run(dir, 'reset', '-q', '--hard', foreign);
      await writeFile(join(dir, 'app.txt'), 'before\n');
      const explicitlyNoted = await commit(dir, 'stale resolution without revert subject');
      expect(await inspectPossibleSilentRevert({ ...material(dir, foreign, explicitlyNoted), intentionalNote: 'intentional revert for compatibility' })).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('recognises a rewritten parent chain and detects the deleted foreign line against the old head', async () => {
    const dir = await repo();
    try {
      await writeFile(join(dir, 'app.txt'), 'before\n');
      const initial = await commit(dir, 'initial');
      await writeFile(join(dir, 'app.txt'), 'before\nforeign fix\n');
      const oldHead = await commit(dir, 'foreign fix: preserve state');
      // The integration branch contains the foreign fix.  The rewritten
      // pair head is based on the original base and drops that line.
      await run(dir, 'branch', '-f', 'dev', oldHead);
      await run(dir, 'reset', '-q', '--hard', initial);
      await writeFile(join(dir, 'app.txt'), 'before\nrewritten change\n');
      const rewritten = await commit(dir, 'rebased stale resolution');
      expect(await isRewrittenHead(dir, oldHead, rewritten)).toBe(true);
      const warning = formatPossibleSilentRevertWarning(await inspectPossibleSilentRevert({
        ...material(dir, oldHead, rewritten), ownershipBase: initial, ownershipHead: oldHead,
      }));
      expect(warning).toContain('foreign fix: preserve state');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('does not warn when a rewritten head drops a line owned only by the old pair branch', async () => {
    const dir = await repo();
    try {
      await writeFile(join(dir, 'app.txt'), 'before\n');
      const initial = await commit(dir, 'initial');
      await writeFile(join(dir, 'app.txt'), 'before\npair-only line\n');
      const oldHead = await commit(dir, 'pair change: temporary implementation');
      // dev stayed at the original integration base, so the old commit is
      // stale pair history rather than a foreign merged fix.
      await run(dir, 'branch', '-f', 'dev', initial);
      await run(dir, 'reset', '-q', '--hard', initial);
      await writeFile(join(dir, 'app.txt'), 'before\nrewritten implementation\n');
      const rewritten = await commit(dir, 'rebased pair implementation');
      expect(await inspectPossibleSilentRevert({
        ...material(dir, oldHead, rewritten),
        ownershipBase: initial,
        ownershipHead: oldHead,
      })).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('skips task-directory material and whitespace-only deletions', async () => {
    const dir = await repo();
    try {
      await writeFile(join(dir, 'app.txt'), 'before\n');
      const base = await commit(dir, 'initial');
      await writeFile(join(dir, 'app.txt'), 'before\n   \n');
      const head = await commit(dir, 'whitespace only');
      expect(await inspectPossibleSilentRevert({ path: dir, source: 'executor' })).toBeUndefined();
      expect(await inspectPossibleSilentRevert(material(dir, base, head))).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('fails open within one total budget on a many-file rewrite', async () => {
    const dir = await repo();
    try {
      await writeFile(join(dir, 'seed.txt'), 'seed\n');
      const initial = await commit(dir, 'initial');
      for (let index = 0; index < 50; index++) await writeFile(join(dir, `file-${index}.txt`), `foreign line ${index}\n`);
      const oldHead = await commit(dir, 'foreign integration batch');
      await run(dir, 'branch', '-f', 'dev', oldHead);
      await run(dir, 'reset', '-q', '--hard', initial);
      for (let index = 0; index < 50; index++) await writeFile(join(dir, `file-${index}.txt`), 'rewritten\n');
      const rewritten = await commit(dir, 'rebased batch rewrite');
      const started = Date.now();
      await inspectPossibleSilentRevert({
        ...material(dir, oldHead, rewritten), ownershipBase: initial, ownershipHead: oldHead,
      });
      expect(Date.now() - started).toBeLessThan(5_500);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
