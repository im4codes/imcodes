import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDirectIgnoredChildren, scanFsGitStatusSnapshot } from '../../src/daemon/fs-git-status-worker.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'imcodes-git-ignore-real-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('real git check-ignore -z --stdin integration', () => {
  it('detects ignored files, directories, dotfiles, spaces/unicode, and nested subdirs while respecting negation', async () => {
    const repo = makeTempDir();
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Tester']);

    writeFileSync(
      join(repo, '.gitignore'),
      [
        'node_modules/',
        'dist/',
        '*.log',
        '!important.log',
        '.env',
        '.DS_Store',
        'ignored file 中文.txt',
        'web/dist/',
      ].join('\n') + '\n',
      'utf8',
    );
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const ok = 1;\n', 'utf8');
    git(repo, ['add', '.gitignore', 'src/index.ts']);
    git(repo, ['commit', '-m', 'init']);

    // Ignored root entries + unignored/negated entries
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n', 'utf8');
    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(join(repo, 'dist', 'bundle.js'), '// built\n', 'utf8');
    writeFileSync(join(repo, 'debug.log'), 'noise\n', 'utf8');
    writeFileSync(join(repo, 'important.log'), 'keep\n', 'utf8');
    writeFileSync(join(repo, '.env'), 'SECRET=1\n', 'utf8');
    writeFileSync(join(repo, '.DS_Store'), 'mac\n', 'utf8');
    writeFileSync(join(repo, 'ignored file 中文.txt'), 'ignored unicode\n', 'utf8');
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const ok = 2;\n', 'utf8');

    // Nested subdirectory with ignored subdir + clean subdir
    mkdirSync(join(repo, 'web', 'dist'), { recursive: true });
    writeFileSync(join(repo, 'web', 'dist', 'app.js'), '// web build\n', 'utf8');
    mkdirSync(join(repo, 'web', 'src'), { recursive: true });
    writeFileSync(join(repo, 'web', 'src', 'app.ts'), 'export const app = 1;\n', 'utf8');

    const rootSnap = await scanFsGitStatusSnapshot({
      repoRoot: repo,
      repoSignature: 'real-1',
      requestedPath: repo,
      includeStats: false,
    });

    const byPath = new Map(rootSnap.files.map((f) => [f.path, f.code]));
    expect(byPath.get(join(repo, 'node_modules'))).toBe('!!');
    expect(byPath.get(join(repo, 'dist'))).toBe('!!');
    expect(byPath.get(join(repo, 'debug.log'))).toBe('!!');
    expect(byPath.get(join(repo, '.env'))).toBe('!!');
    expect(byPath.get(join(repo, '.DS_Store'))).toBe('!!');
    expect(byPath.get(join(repo, 'ignored file 中文.txt'))).toBe('!!');
    // Negated file & tracked modified file must NOT be '!!'
    expect(byPath.get(join(repo, 'important.log'))).toBe('??');
    expect(byPath.get(join(repo, 'src', 'index.ts'))).toBe('M');
    expect(byPath.has(join(repo, '.gitignore'))).toBe(false);
    // Ignored entries must not inflate real change totalCount
    expect(rootSnap.totalCount).toBe(3); // important.log (??), src/index.ts (M), web/src/app.ts (??)

    // Nested subdirectory check: web/dist ignored, web/src not ignored
    const webSnap = await scanFsGitStatusSnapshot({
      repoRoot: repo,
      repoSignature: 'real-1',
      requestedPath: join(repo, 'web'),
      includeStats: false,
    });
    const webByPath = new Map(webSnap.files.map((f) => [f.path, f.code]));
    expect(webByPath.get(join(repo, 'web', 'dist'))).toBe('!!');
    expect(webByPath.get(join(repo, 'web', 'src', 'app.ts'))).toBe('??');

    // Directory with zero ignored children (git check-ignore exits 1) returns cleanly
    const cleanSnap = await scanFsGitStatusSnapshot({
      repoRoot: repo,
      repoSignature: 'real-1',
      requestedPath: join(repo, 'src'),
      includeStats: false,
    });
    expect(cleanSnap.files).toEqual([{ path: join(repo, 'src', 'index.ts'), code: 'M' }]);

    // summaryOnly fast-path ignores ignored entries
    const summarySnap = await scanFsGitStatusSnapshot({
      repoRoot: repo,
      repoSignature: 'real-1',
      requestedPath: repo,
      includeStats: false,
      summaryOnly: true,
    });
    expect(summarySnap.files).toEqual([]);
    expect(summarySnap.totalCount).toBe(3);
  });

  it('handles hundreds/thousands of entries via stdin without ARG_MAX failure and degrades cleanly in non-git dirs', async () => {
    const repo = makeTempDir();
    git(repo, ['init']);
    writeFileSync(join(repo, '.gitignore'), '*.tmp\n', 'utf8');
    mkdirSync(join(repo, 'bulk'), { recursive: true });
    for (let i = 0; i < 600; i += 1) {
      writeFileSync(join(repo, 'bulk', `item-${i}.tmp`), 'x', 'utf8');
    }
    const bulkIgnored = await loadDirectIgnoredChildren(repo, join(repo, 'bulk'));
    expect(bulkIgnored).toHaveLength(600);
    expect(bulkIgnored.every((entry) => entry.code === '!!')).toBe(true);

    const nonGit = makeTempDir();
    writeFileSync(join(nonGit, 'a.tmp'), 'x', 'utf8');
    expect(await loadDirectIgnoredChildren(nonGit, nonGit)).toEqual([]);
  });
});
