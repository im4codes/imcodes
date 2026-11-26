/**
 * A non-git project becomes a local git repository (tsk_cd_non_git_pair_workspace): the init, its guards, and the DONE merge.
 * Real git, real files; the user's global git config is pointed at a scratch file and must come out untouched.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildGitignoreBlock,
  gitInitEnabled,
  initProjectRepo,
  isImcodesInitRepo,
  mergePairIntoProject,
  nonGitRootRefusal,
  withGitignoreBlock,
} from '../../../src/daemon/task-pairs/git-init.js';
import {
  TASK_PAIR_GITIGNORE_BLOCK_END,
  TASK_PAIR_GITIGNORE_BLOCK_START,
  TASK_PAIR_GIT_INIT_ENABLE_ENV,
  TASK_PAIR_GIT_INIT_LARGE_FILE_BYTES_ENV,
  TASK_PAIR_GIT_INIT_MAX_TRACKED_BYTES_ENV,
} from '../../../shared/task-pair.js';

let base = '';
let project = '';
let globalConfig = '';
const saved: Record<string, string | undefined> = {};

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const write = (rel: string, content: string | Buffer, root = project) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), content); };

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'imcodes-gitinit-')));
  project = join(base, 'project');
  mkdirSync(project);
  // The developer's real global git config must never be read or written: point git at a scratch file.
  globalConfig = join(base, 'global.gitconfig');
  writeFileSync(globalConfig, '[user]\n\tname = Global Person\n\temail = global@example.invalid\n');
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', TASK_PAIR_GIT_INIT_LARGE_FILE_BYTES_ENV, TASK_PAIR_GIT_INIT_MAX_TRACKED_BYTES_ENV, TASK_PAIR_GIT_INIT_ENABLE_ENV]) saved[key] = process.env[key];
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(base, { recursive: true, force: true });
});

describe('initProjectRepo', () => {
  it('a non-git project becomes a local repo with the baseline commit: heavy dirs and over-threshold files untracked, identity repo-local, no remote, global config untouched', async () => {
    process.env[TASK_PAIR_GIT_INIT_LARGE_FILE_BYTES_ENV] = String(1024);
    write('src/a.ts', 'export const a = 1;\n');
    write('README.md', 'hello\r\nworld\r\n');
    write('run.sh', '#!/bin/sh\n');
    chmodSync(join(project, 'run.sh'), 0o755);
    write('node_modules/dep/index.js', 'heavy');
    write('dist/out.js', 'built');
    write('.venv/lib/x.py', 'venv');
    write('data/huge.bin', Buffer.alloc(4096, 1));
    write('data/small.bin', Buffer.alloc(100, 2));
    symlinkSync('README.md', join(project, 'link'));
    const globalBefore = readFileSync(globalConfig, 'utf8');
    const result = await initProjectRepo(project, { taskId: 'T1' });
    expect(result).toMatchObject({ ok: true, created: true, ignoredLargeFiles: 1 });
    if (!result.ok) return;
    expect(result.ignoredHeavyDirs).toEqual(expect.arrayContaining(['node_modules', 'dist', '.venv', 'target']));
    expect(git(project, 'log', '--format=%s')).toBe('imcodes: baseline before pair T1');
    expect(git(project, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    const tracked = git(project, 'ls-files').split('\n').sort();
    expect(tracked).toEqual(['.gitignore', 'README.md', 'data/small.bin', 'link', 'run.sh', 'src/a.ts']);
    expect(result.trackedFiles).toBe(tracked.length);
    // Untracked and ignored, but still on disk and untouched.
    for (const path of ['node_modules/dep/index.js', 'dist/out.js', '.venv/lib/x.py', 'data/huge.bin']) {
      expect(existsSync(join(project, path))).toBe(true);
      expect(git(project, 'check-ignore', path)).toBe(path);
    }
    expect(git(project, 'status', '--porcelain')).toBe('');
    // Identity and settings are repo-local; the global config is byte-identical; there is no remote.
    expect(git(project, 'config', '--local', 'user.name')).toBe('IM.codes');
    expect(git(project, 'config', '--local', 'core.autocrlf')).toBe('false');
    expect(git(project, 'log', '-1', '--format=%an <%ae>')).toBe('IM.codes <imcodes@localhost.invalid>');
    expect(git(project, 'remote')).toBe('');
    expect(readFileSync(globalConfig, 'utf8')).toBe(globalBefore);
    // Line endings, exec bit and links are kept as they are.
    expect(execFileSync('git', ['-C', project, 'cat-file', 'blob', 'HEAD:README.md']).toString()).toBe('hello\r\nworld\r\n');
    expect(git(project, 'ls-tree', 'HEAD', 'run.sh')).toMatch(/^100755 /);
    expect(git(project, 'ls-tree', 'HEAD', 'link')).toMatch(/^120000 /);
    expect(readlinkSync(join(project, 'link'))).toBe('README.md');
    // The block is in the .gitignore, with the large file listed explicitly.
    const ignore = readFileSync(join(project, '.gitignore'), 'utf8');
    expect(ignore).toContain(TASK_PAIR_GITIGNORE_BLOCK_START);
    expect(ignore).toContain('/data/huge.bin');
    expect(ignore).toContain('node_modules/');
    expect(await isImcodesInitRepo(project)).toBe(true);
  });

  it('an existing .gitignore is kept and extended with the marked block; running again replaces the block instead of duplicating it', async () => {
    write('.gitignore', '*.log\r\nsecrets/\r\n');
    write('a.txt', 'a');
    write('debug.log', 'ignored by the project');
    const result = await initProjectRepo(project, { taskId: 'T1' });
    expect(result.ok).toBe(true);
    const ignore = readFileSync(join(project, '.gitignore'), 'utf8');
    expect(ignore.startsWith('*.log\r\nsecrets/\r\n')).toBe(true);
    expect(ignore.split(TASK_PAIR_GITIGNORE_BLOCK_START).length - 1).toBe(1);
    expect(ignore).toContain('\r\n'); // the file's own line endings are kept
    expect(git(project, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'a.txt']); // the project's own ignore still applies
    // Pure function: replace, never duplicate.
    const block = buildGitignoreBlock(['node_modules'], ['x.bin'], 1024);
    const once = withGitignoreBlock('user rules\n', block);
    expect(withGitignoreBlock(once, block)).toBe(once);
    expect(withGitignoreBlock(once, buildGitignoreBlock(['dist'], [], 1024)).split(TASK_PAIR_GITIGNORE_BLOCK_START).length - 1).toBe(1);
    expect(withGitignoreBlock(undefined, block).endsWith(`${TASK_PAIR_GITIGNORE_BLOCK_END}\n`)).toBe(true);
  });

  it('OVER THE CAP: nothing is committed and every change is rolled back (.git gone, .gitignore back to what it was)', async () => {
    process.env[TASK_PAIR_GIT_INIT_MAX_TRACKED_BYTES_ENV] = String(1000);
    write('.gitignore', '*.tmp\n');
    write('big1.dat', Buffer.alloc(800, 1));
    write('big2.dat', Buffer.alloc(800, 2));
    const before = readFileSync(join(project, '.gitignore'), 'utf8');
    const result = await initProjectRepo(project, { taskId: 'T1' });
    expect(result).toMatchObject({ ok: false, reason: 'over_cap' });
    expect(existsSync(join(project, '.git'))).toBe(false);
    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe(before);
    // No .gitignore existed at all: none is left behind either.
    rmSync(join(project, '.gitignore'));
    expect((await initProjectRepo(project, { taskId: 'T1' })).ok).toBe(false);
    expect(existsSync(join(project, '.gitignore'))).toBe(false);
    expect(existsSync(join(project, '.git'))).toBe(false);
  });

  it('a large project stays cheap: only the tracked set counts against the cap, and the large files are never read into git', async () => {
    process.env[TASK_PAIR_GIT_INIT_LARGE_FILE_BYTES_ENV] = String(1024 * 1024);
    process.env[TASK_PAIR_GIT_INIT_MAX_TRACKED_BYTES_ENV] = String(10 * 1024 * 1024);
    write('a.txt', 'a');
    for (let i = 0; i < 5; i += 1) write(`big/f${i}.bin`, Buffer.alloc(4 * 1024 * 1024, i)); // 20 MiB total, each over the threshold
    const result = await initProjectRepo(project, { taskId: 'T1' });
    expect(result).toMatchObject({ ok: true, ignoredLargeFiles: 5 });
    expect(git(project, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'a.txt']);
    const objectBytes = Number(git(project, 'count-objects', '-v').split('\n').find((line) => line.startsWith('size:'))!.split(': ')[1]) * 1024;
    expect(objectBytes).toBeLessThan(1024 * 1024); // the 20 MiB of large files are not in .git
  });

  it('idempotent: a second call finds the repo IM.codes made and reports created:false; two pairs starting at once init exactly once', async () => {
    write('a.txt', 'a');
    const [one, two] = await Promise.all([initProjectRepo(project, { taskId: 'A' }), initProjectRepo(project, { taskId: 'B' })]);
    expect([one, two].filter((r) => r.ok && r.created)).toHaveLength(1);
    expect([one, two].every((r) => r.ok)).toBe(true);
    expect(git(project, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(project, 'log', '--format=%s')).toMatch(/^imcodes: baseline before pair (A|B)$/);
    const again = await initProjectRepo(project, { taskId: 'C' });
    expect(again).toMatchObject({ ok: true, created: false });
    expect(git(project, 'rev-list', '--count', 'HEAD')).toBe('1');
  });

  it('a daemon restart mid-init: a half-made repo (marker says initializing) is rolled back and the init runs again cleanly', async () => {
    write('.gitignore', 'keep-me\n');
    write('a.txt', 'a');
    // What a crash between `git init` and the baseline commit leaves behind.
    execFileSync('git', ['-C', project, 'init', '-q']);
    writeFileSync(join(project, '.git', 'imcodes-init.json'), JSON.stringify({ state: 'initializing', startedAt: 1, taskId: 'OLD', gitignore: { existed: true, original: 'keep-me\n' } }));
    writeFileSync(join(project, '.gitignore'), `keep-me\n${buildGitignoreBlock(['x'], [], 1)}\n`);
    const result = await initProjectRepo(project, { taskId: 'NEW' });
    expect(result).toMatchObject({ ok: true, created: true });
    expect(git(project, 'log', '--format=%s')).toBe('imcodes: baseline before pair NEW');
    const ignore = readFileSync(join(project, '.gitignore'), 'utf8');
    expect(ignore.startsWith('keep-me\n')).toBe(true);
    expect(ignore.split(TASK_PAIR_GITIGNORE_BLOCK_START).length - 1).toBe(1);
  });

  it('never touches a .git it did not create, a project inside another repo, a missing git, or a disabled setting', async () => {
    write('a.txt', 'a');
    // A .git directory that is not a usable work tree and has no IM.codes marker.
    mkdirSync(join(project, '.git'));
    writeFileSync(join(project, '.git', 'HEAD'), 'garbage');
    expect(await initProjectRepo(project, { taskId: 'T1' })).toMatchObject({ ok: false, reason: 'foreign_git_dir' });
    expect(readFileSync(join(project, '.git', 'HEAD'), 'utf8')).toBe('garbage');
    rmSync(join(project, '.git'), { recursive: true });
    // Inside a parent repo the project is not "non-git": left alone.
    execFileSync('git', ['-C', base, 'init', '-q']);
    expect(await initProjectRepo(project, { taskId: 'T1' })).toMatchObject({ ok: false, reason: 'inside_git' });
    expect(existsSync(join(project, '.git'))).toBe(false);
    rmSync(join(base, '.git'), { recursive: true });
    // Disabled.
    process.env[TASK_PAIR_GIT_INIT_ENABLE_ENV] = 'off';
    expect(gitInitEnabled()).toBe(false);
    expect(await initProjectRepo(project, { taskId: 'T1' })).toMatchObject({ ok: false, reason: 'disabled' });
    delete process.env[TASK_PAIR_GIT_INIT_ENABLE_ENV];
    // No git on PATH.
    const path = process.env.PATH;
    process.env.PATH = join(base, 'no-bin');
    try { expect(await initProjectRepo(project, { taskId: 'T1' })).toMatchObject({ ok: false, reason: 'git_unavailable' }); }
    finally { process.env.PATH = path; }
    expect(existsSync(join(project, '.git'))).toBe(false);
  });

  it('an empty project gets an empty baseline commit', async () => {
    const result = await initProjectRepo(project, { taskId: 'T1' });
    expect(result).toMatchObject({ ok: true, created: true });
    expect(git(project, 'rev-list', '--count', 'HEAD')).toBe('1');
  });
});

describe('mergePairIntoProject', () => {
  async function pair(name = 'wt') {
    write('src/a.ts', 'a1\n');
    write('src/b.ts', 'b1\n');
    write('notes.txt', 'n1\n');
    expect((await initProjectRepo(project, { taskId: 'T' })).ok).toBe(true);
    const worktree = join(base, name);
    git(project, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD');
    git(worktree, 'config', 'user.name', 'Executor');
    git(worktree, 'config', 'user.email', 'exec@example.invalid');
    return worktree;
  }
  const commit = (dir: string, message: string) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', message); return git(dir, 'rev-parse', 'HEAD'); };

  it('fast-forwards the project branch to the pair head; the project working tree then holds the pair\'s files', async () => {
    const worktree = await pair();
    write('src/a.ts', 'a2\n', worktree);
    write('src/new.ts', 'new\n', worktree);
    const head = commit(worktree, 'work');
    const result = await mergePairIntoProject(project, worktree, 'T');
    expect(result).toMatchObject({ status: 'merged', head, fastForward: true });
    expect((result as { files: string[] }).files.sort()).toEqual(['src/a.ts', 'src/new.ts']);
    expect(git(project, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('a2\n');
    expect(git(project, 'status', '--porcelain')).toBe('');
  });

  it('a second pair whose base is older is merged with a merge commit; both pairs\' work is in the project', async () => {
    const one = await pair('wt1');
    const two = join(base, 'wt2');
    git(project, 'worktree', 'add', '-q', '--detach', two, 'HEAD');
    git(two, 'config', 'user.name', 'E2'); git(two, 'config', 'user.email', 'e2@example.invalid');
    write('src/a.ts', 'a-from-one\n', one); commit(one, 'one');
    write('src/b.ts', 'b-from-two\n', two); commit(two, 'two');
    expect((await mergePairIntoProject(project, one, 'T1')).status).toBe('merged');
    const result = await mergePairIntoProject(project, two, 'T2');
    expect(result).toMatchObject({ status: 'merged', fastForward: false });
    expect(readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('a-from-one\n');
    expect(readFileSync(join(project, 'src', 'b.ts'), 'utf8')).toBe('b-from-two\n');
    expect(git(project, 'log', '-1', '--format=%s')).toBe('imcodes: merge pair T2');
  });

  it('REFUSES when the user has uncommitted edits in a file the pair changed: nothing overwritten, nothing merged', async () => {
    const worktree = await pair();
    write('src/a.ts', 'a-pair\n', worktree);
    commit(worktree, 'work');
    const headBefore = git(project, 'rev-parse', 'HEAD');
    write('src/a.ts', 'a-USER edit not committed\n');
    const result = await mergePairIntoProject(project, worktree, 'T');
    expect(result).toMatchObject({ status: 'refused_uncommitted', files: ['src/a.ts'] });
    expect(readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('a-USER edit not committed\n');
    expect(git(project, 'rev-parse', 'HEAD')).toBe(headBefore);
    // An untracked user file at a path the pair adds is refused too.
    write('src/added.ts', 'user file\n');
    write('src/added.ts', 'pair file\n', worktree);
    commit(worktree, 'more');
    expect((await mergePairIntoProject(project, worktree, 'T')) as { files: string[] }).toMatchObject({ status: 'refused_uncommitted', files: expect.arrayContaining(['src/a.ts', 'src/added.ts']) });
    expect(readFileSync(join(project, 'src', 'added.ts'), 'utf8')).toBe('user file\n');
  });

  it('uncommitted user edits in OTHER files are kept exactly and do not block the merge', async () => {
    const worktree = await pair();
    write('src/a.ts', 'a-pair\n', worktree);
    commit(worktree, 'work');
    write('notes.txt', 'n-user edit\n');
    write('scratch.txt', 'user scratch\n');
    const result = await mergePairIntoProject(project, worktree, 'T');
    expect(result.status).toBe('merged');
    expect(readFileSync(join(project, 'notes.txt'), 'utf8')).toBe('n-user edit\n');
    expect(readFileSync(join(project, 'scratch.txt'), 'utf8')).toBe('user scratch\n');
    expect(readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('a-pair\n');
  });

  it('REFUSES when the user has staged changes (a merge commit would sweep them in)', async () => {
    const worktree = await pair();
    write('src/a.ts', 'a-pair\n', worktree);
    commit(worktree, 'work');
    write('notes.txt', 'staged by the user\n');
    git(project, 'add', 'notes.txt');
    const result = await mergePairIntoProject(project, worktree, 'T');
    expect(result).toMatchObject({ status: 'refused_uncommitted', files: ['notes.txt'] });
    expect(git(project, 'diff', '--cached', '--name-only')).toBe('notes.txt');
  });

  it('commits that conflict with the project branch are aborted: the project is exactly as it was', async () => {
    const worktree = await pair();
    write('src/a.ts', 'a-pair\n', worktree);
    commit(worktree, 'pair');
    write('src/a.ts', 'a-branch\n');
    git(project, 'add', '-A');
    git(project, '-c', 'user.name=U', '-c', 'user.email=u@example.invalid', 'commit', '-q', '-m', 'user commit');
    const head = git(project, 'rev-parse', 'HEAD');
    const result = await mergePairIntoProject(project, worktree, 'T');
    expect(result).toMatchObject({ status: 'conflict', files: ['src/a.ts'] });
    expect(git(project, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(project, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('a-branch\n');
  });

  it('a merge already in progress in the project (a crash, or the user\'s own) is reported and never touched', async () => {
    const worktree = await pair();
    write('src/a.ts', 'a-pair\n', worktree);
    commit(worktree, 'pair');
    write('src/a.ts', 'a-branch\n');
    git(project, 'add', '-A');
    git(project, '-c', 'user.name=U', '-c', 'user.email=u@example.invalid', 'commit', '-q', '-m', 'user commit');
    try { git(project, 'merge', '--no-edit', git(worktree, 'rev-parse', 'HEAD')); } catch { /* conflicts: the merge stays in progress */ }
    expect(existsSync(join(project, '.git', 'MERGE_HEAD'))).toBe(true);
    const result = await mergePairIntoProject(project, worktree, 'T');
    expect(result).toMatchObject({ status: 'failed', detail: expect.stringContaining('merge in progress') });
    expect(existsSync(join(project, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  it('no new commits is a no-op; a detached project HEAD is reported, not merged into', async () => {
    const worktree = await pair();
    expect((await mergePairIntoProject(project, worktree, 'T')).status).toBe('noop');
    write('src/a.ts', 'a-pair\n', worktree);
    commit(worktree, 'work');
    git(project, 'checkout', '-q', '--detach');
    expect(await mergePairIntoProject(project, worktree, 'T')).toMatchObject({ status: 'failed', detail: expect.stringContaining('detached HEAD') });
  });
});

describe('which directories may become a repo at all (a container is never touched)', () => {
  it('refuses a filesystem root, the home directory, an ancestor of home, and a directory that contains another registered project', async () => {
    const home = join(base, 'home');
    mkdirSync(join(home, 'codes', 'app'), { recursive: true });
    expect(await nonGitRootRefusal('/', { home })).toMatchObject({ reason: 'container_root', detail: expect.stringContaining('filesystem root') });
    expect(await nonGitRootRefusal(home, { home })).toMatchObject({ reason: 'container_root', detail: expect.stringContaining('home directory') });
    expect(await nonGitRootRefusal(base, { home })).toMatchObject({ reason: 'container_root', detail: expect.stringContaining('contains the home directory') });
    // A container of projects: /clawd holds /clawd/agents/emma.
    const clawd = join(base, 'clawd');
    mkdirSync(join(clawd, 'agents', 'emma'), { recursive: true });
    expect(await nonGitRootRefusal(clawd, { home, otherProjectDirs: [join(clawd, 'agents', 'emma')] })).toMatchObject({ reason: 'container_root', detail: expect.stringContaining('contains another project') });
    // The project itself, its own sessions, a sibling and a child project are all fine.
    expect(await nonGitRootRefusal(join(clawd, 'agents', 'emma'), { home, otherProjectDirs: [clawd, join(clawd, 'agents', 'emma')] })).toBeUndefined();
    expect(await nonGitRootRefusal(join(home, 'codes', 'app'), { home, otherProjectDirs: [join(home, 'codes', 'app')] })).toBeUndefined();
    expect(await nonGitRootRefusal(clawd, { home, otherProjectDirs: [join(base, 'clawd-sibling')] })).toBeUndefined(); // a sibling with the same prefix is not "inside"
  });

  it('a directory holding a nested repository is refused by the init itself and rolled back: no .git, .gitignore as it was', async () => {
    write('top.txt', 'x');
    write('.gitignore', '*.log\n');
    mkdirSync(join(project, 'other-project'));
    execFileSync('git', ['-C', join(project, 'other-project'), 'init', '-q']);
    const before = readFileSync(join(project, '.gitignore'), 'utf8');
    const result = await initProjectRepo(project, { taskId: 'T' });
    expect(result).toMatchObject({ ok: false, reason: 'nested_repo' });
    expect(existsSync(join(project, '.git'))).toBe(false);
    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe(before);
    expect(existsSync(join(project, 'other-project', '.git'))).toBe(true); // the nested repo is untouched
  });
});

describe('a later pair starts from what is on disk (the owner does not commit)', () => {
  it('uncommitted edits, new files and a new large file since the baseline are committed as a snapshot; the large file stays untracked', async () => {
    process.env[TASK_PAIR_GIT_INIT_LARGE_FILE_BYTES_ENV] = String(1024);
    write('src/a.ts', 'a1\n');
    write('notes.txt', 'n1\n');
    expect((await initProjectRepo(project, { taskId: 'FIRST' })).ok).toBe(true);
    write('src/a.ts', 'a2 edited by the owner\n');
    write('src/new.ts', 'new file\n');
    rmSync(join(project, 'notes.txt'));
    write('data/huge.bin', Buffer.alloc(4096, 1));
    const result = await initProjectRepo(project, { taskId: 'SECOND' });
    expect(result).toMatchObject({ ok: true, created: false, snapshot: { committed: true } });
    expect(git(project, 'log', '-1', '--format=%s')).toBe('imcodes: snapshot before pair SECOND');
    expect(git(project, 'status', '--porcelain')).toBe('');
    expect(git(project, 'show', 'HEAD:src/a.ts')).toBe('a2 edited by the owner');
    expect(git(project, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'src/a.ts', 'src/new.ts']);
    expect(existsSync(join(project, 'data', 'huge.bin'))).toBe(true);
    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toContain('/data/huge.bin');
    expect(git(project, 'rev-list', '--count', 'HEAD')).toBe('2');
    // A clean tree: no new commit.
    const again = await initProjectRepo(project, { taskId: 'THIRD' });
    expect(again).toMatchObject({ ok: true, created: false, snapshot: { committed: false, files: 0 } });
    expect(git(project, 'rev-list', '--count', 'HEAD')).toBe('2');
  });

  it('the pair worktree cut after the snapshot holds the owner\'s current files, so its merge is not refused for stale content', async () => {
    write('src/a.ts', 'a1\n');
    expect((await initProjectRepo(project, { taskId: 'FIRST' })).ok).toBe(true);
    write('src/a.ts', 'a-owner\n');
    expect((await initProjectRepo(project, { taskId: 'SECOND' })).ok).toBe(true);
    const worktree = join(base, 'wt');
    git(project, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD');
    expect(readFileSync(join(worktree, 'src', 'a.ts'), 'utf8')).toBe('a-owner\n');
    write('src/a.ts', 'a-owner + pair\n', worktree);
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'pair');
    expect((await mergePairIntoProject(project, worktree, 'SECOND')).status).toBe('merged');
    expect(readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('a-owner + pair\n');
    // The merge is IM.codes' own commit: a later snapshot still applies.
    write('src/a.ts', 'a-owner again\n');
    expect(await initProjectRepo(project, { taskId: 'THIRD' })).toMatchObject({ ok: true, snapshot: { committed: true } });
  });

  it('when the user has committed themselves, their history is theirs: nothing is committed for them', async () => {
    write('src/a.ts', 'a1\n');
    expect((await initProjectRepo(project, { taskId: 'FIRST' })).ok).toBe(true);
    write('src/a.ts', 'a2\n');
    git(project, 'add', '-A');
    git(project, '-c', 'user.name=Me', '-c', 'user.email=me@example.invalid', 'commit', '-q', '-m', 'my own commit');
    write('src/a.ts', 'a3 uncommitted\n');
    const count = git(project, 'rev-list', '--count', 'HEAD');
    const result = await initProjectRepo(project, { taskId: 'SECOND' });
    expect(result).toMatchObject({ ok: true, created: false, snapshot: { committed: false, skipped: 'not_ours' } });
    expect(git(project, 'rev-list', '--count', 'HEAD')).toBe(count);
    expect(git(project, 'status', '--porcelain')).toBe('M src/a.ts');
  });

  it('changes over the size cap are not committed (and it is said)', async () => {
    write('a.txt', 'a');
    expect((await initProjectRepo(project, { taskId: 'FIRST' })).ok).toBe(true);
    process.env[TASK_PAIR_GIT_INIT_MAX_TRACKED_BYTES_ENV] = '100';
    write('big.txt', 'x'.repeat(500));
    const result = await initProjectRepo(project, { taskId: 'SECOND' });
    expect(result).toMatchObject({ ok: true, snapshot: { committed: false, skipped: 'over_cap' } });
    expect(git(project, 'rev-list', '--count', 'HEAD')).toBe('1');
  });
});
