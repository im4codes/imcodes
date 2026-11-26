/**
 * Disk hygiene for plain task directories (tsk_cd_non_git_pair_workspace): a `dir` workspace has no git and so no ignore list,
 * so only directories NAMED in the shared heavy list are stripped -- never a file, never anything else. Real files.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stripHeavyNamedDirs } from '../../../src/daemon/task-pairs/workspace-hygiene.js';
import { TASK_PAIR_HEAVY_DIR_NAMES } from '../../../shared/task-pair.js';

let base = '';
let dir = '';
const put = (rel: string, content = 'x') => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), content); };

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'imcodes-dirhyg-')));
  dir = join(base, 'task');
  mkdirSync(dir);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('stripHeavyNamedDirs', () => {
  it('removes directories named in the heavy list at any depth, and nothing else', async () => {
    for (const name of TASK_PAIR_HEAVY_DIR_NAMES) put(`${name}/x/y.bin`);
    put('pkg/a/node_modules/dep/i.js');
    put('pkg/a/src/keep.ts', 'source');
    put('report.md', 'the deliverable');
    put('notes/node_modules_notes.txt', 'a FILE whose name merely contains the words');
    put('deep/er/build', 'a plain FILE named build');
    put('results/dist-summary/out.csv', 'a directory that only starts with dist');
    const result = await stripHeavyNamedDirs(dir);
    expect(result.ok).toBe(true);
    expect(result.removed.sort()).toEqual([...TASK_PAIR_HEAVY_DIR_NAMES, 'pkg/a/node_modules'].sort());
    for (const name of TASK_PAIR_HEAVY_DIR_NAMES) expect(existsSync(join(dir, name))).toBe(false);
    expect(existsSync(join(dir, 'pkg', 'a', 'node_modules'))).toBe(false);
    // User files and look-alikes survive untouched.
    expect(readFileSync(join(dir, 'pkg', 'a', 'src', 'keep.ts'), 'utf8')).toBe('source');
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toBe('the deliverable');
    expect(existsSync(join(dir, 'notes', 'node_modules_notes.txt'))).toBe(true);
    expect(lstatSync(join(dir, 'deep', 'er', 'build')).isFile()).toBe(true);
    expect(existsSync(join(dir, 'results', 'dist-summary', 'out.csv'))).toBe(true);
  });

  it('a directory holding the named deliverable (keepPaths) survives, above and below it', async () => {
    put('dist/report.pdf', 'the deliverable');
    put('build/junk.o');
    const result = await stripHeavyNamedDirs(dir, { keepPaths: [join(dir, 'dist', 'report.pdf')] });
    expect(existsSync(join(dir, 'dist', 'report.pdf'))).toBe(true);
    expect(existsSync(join(dir, 'build'))).toBe(false);
    expect(result.skipped).toEqual([{ path: 'dist', reason: 'kept_path' }]);
  });

  it('a symlink named node_modules is unlinked and its target is never followed; a symlinked directory is not entered', async () => {
    const shared = join(base, 'shared-deps');
    mkdirSync(join(shared, 'lib'), { recursive: true });
    writeFileSync(join(shared, 'lib', 'a.js'), 'shared');
    symlinkSync(shared, join(dir, 'node_modules'));
    const outside = join(base, 'outside');
    mkdirSync(join(outside, 'dist'), { recursive: true });
    writeFileSync(join(outside, 'dist', 'x'), 'outside');
    symlinkSync(outside, join(dir, 'linked-dir'));
    const result = await stripHeavyNamedDirs(dir);
    expect(result.removed).toEqual(['node_modules']);
    expect(existsSync(join(dir, 'node_modules'))).toBe(false);
    expect(readFileSync(join(shared, 'lib', 'a.js'), 'utf8')).toBe('shared');
    expect(existsSync(join(outside, 'dist', 'x'))).toBe(true); // never walked through the link
  });

  it('does not enter .git, and stops when the pair is no longer eligible (reopened)', async () => {
    put('.git/objects/build/o');
    put('a/node_modules/x');
    put('b/node_modules/x');
    let allowed = 1;
    const result = await stripHeavyNamedDirs(dir, { stillEligible: () => allowed-- > 0 });
    expect(existsSync(join(dir, '.git', 'objects', 'build', 'o'))).toBe(true);
    expect(result.aborted).toBe(true);
    expect(result.removed).toHaveLength(1);
    expect([existsSync(join(dir, 'a', 'node_modules')), existsSync(join(dir, 'b', 'node_modules'))].filter(Boolean)).toHaveLength(1);
  });

  it('a missing directory is not ok and removes nothing', async () => {
    expect((await stripHeavyNamedDirs(join(base, 'nope'))).ok).toBe(false);
  });
});
