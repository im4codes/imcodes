import { describe, expect, it } from 'vitest';
import { findMainCheckoutGitWrite } from '../../shared/main-checkout-git-guard.js';

const ROOT = '/Users/k/codes/proj';
const WS = '/Users/k/.imcodes/worktrees/imcodes/deck_sub_x/pair_t/repo';
const hit = (command: string | string[], cwd = ROOT, extra: { roots?: string[]; home?: string } = {}) =>
  findMainCheckoutGitWrite({ command, cwd, roots: extra.roots ?? [ROOT], ...(extra.home ? { home: extra.home } : {}) });

describe('findMainCheckoutGitWrite: what counts as a write in the main checkout', () => {
  it.each([
    'git reset --hard origin/dev', 'git checkout dev', 'git checkout -- src/a.ts', 'git cherry-pick abc123', 'git commit -m "x"',
    'git commit -am x', 'git merge feature', 'git rebase dev', 'git revert HEAD', 'git add -A', 'git rm a.ts', 'git mv a b', 'git clean -fd',
    'git restore .', 'git switch -c topic', 'git pull --ff-only', 'git am x.patch', 'git apply x.diff', 'git update-ref -d refs/heads/x',
    'git stash', 'git stash push -m wip', 'git stash pop', 'git stash drop', 'git branch topic', 'git branch -D topic', 'git branch -m a b',
    'git tag v1', 'git tag -d v1',
  ])('reports %s in the main checkout', (command) => {
    expect(hit(command)).toMatchObject({ dir: ROOT, root: ROOT });
  });

  it.each([
    'git status', 'git status --short', 'git log --oneline -5', 'git diff', 'git diff --stat HEAD~1', 'git show HEAD', 'git rev-parse HEAD',
    'git fetch origin', 'git ls-files', 'git cat-file -p HEAD', 'git blame a.ts', 'git grep foo', 'git describe', 'git merge-base a b',
    'git worktree list', 'git worktree add ../x -b y', 'git config --get user.name', 'git remote -v', 'git symbolic-ref HEAD',
    'git branch', 'git branch --list', 'git branch -a', 'git branch --show-current', 'git branch -vv', 'git tag', 'git tag -l', 'git tag --list "v*"',
    'git stash list', 'git stash show', 'npm test', 'ls -la',
  ])('does not report %s (read-only or not git)', (command) => {
    expect(hit(command)).toBeUndefined();
  });

  it('a command that only PRINTS or searches for a git write is not a git invocation', () => {
    expect(hit('echo git reset --hard')).toBeUndefined();
    expect(hit('rg "git commit" src')).toBeUndefined();
    expect(hit('grep -R "git checkout" docs')).toBeUndefined();
  });

  it('follows the directory the command really runs in: -C, cd, and subshells', () => {
    expect(hit(`git -C ${WS} commit -m x`)).toBeUndefined();
    expect(hit(`git -C ${ROOT} commit -m x`, WS)).toMatchObject({ verb: 'commit', dir: ROOT });
    expect(hit('git commit -m x', WS)).toBeUndefined();
    expect(hit(`cd ${WS} && git commit -m x`)).toBeUndefined();
    expect(hit(`cd ${ROOT} && git reset --hard`, WS)).toMatchObject({ verb: 'reset' });
    expect(hit(`cd ${ROOT}/src && git checkout dev`, WS)).toMatchObject({ dir: `${ROOT}/src` });
    expect(hit(`cd ${WS}; git status; cd ${ROOT}; git commit -m x`)).toMatchObject({ verb: 'commit' });
    // A subshell's cd does not leak: the later commit runs in the original directory (the workspace here).
    expect(hit(`(cd ${ROOT} && git status) && git commit -m x`, WS)).toBeUndefined();
    expect(hit(`(cd ${WS} && git status) && git commit -m x`)).toMatchObject({ verb: 'commit' });
    expect(hit('cd .. && git reset --hard', `${ROOT}/sub`)).toMatchObject({ dir: ROOT });
    expect(hit('cd ../elsewhere && git reset --hard', ROOT)).toBeUndefined();
    expect(hit('git -C ../other reset --hard', ROOT)).toBeUndefined();
    expect(hit('git --work-tree=/ws/x commit -m y', ROOT)).toBeUndefined();
  });

  it('finds the write in a chain, a pipe, or behind env/sudo prefixes', () => {
    expect(hit('git status && git add -A && git commit -m x')).toMatchObject({ verb: 'add' });
    expect(hit('npm test; git reset --hard')).toMatchObject({ verb: 'reset' });
    expect(hit('git stash list | head -1')).toBeUndefined();
    expect(hit('GIT_AUTHOR_NAME=x git commit -m y')).toMatchObject({ verb: 'commit' });
    expect(hit('env FOO=1 git commit -m y')).toMatchObject({ verb: 'commit' });
    expect(hit('git -c user.name=x commit -m y')).toMatchObject({ verb: 'commit' });
    expect(hit('git --no-pager reset --hard')).toMatchObject({ verb: 'reset' });
    expect(hit('/usr/bin/git reset --hard')).toMatchObject({ verb: 'reset' });
    expect(hit('git status # git reset --hard')).toBeUndefined();
  });

  it('unwraps shell -c argv the way codex and gemini report commands', () => {
    expect(hit(['/bin/zsh', '-lc', 'git cherry-pick abc'])).toMatchObject({ verb: 'cherry-pick' });
    expect(hit(['bash', '-c', `cd ${WS} && git commit -m x`])).toBeUndefined();
    expect(hit(['/bin/zsh', '-lc', 'git status --short; git log -1'])).toBeUndefined();
    expect(hit(['git', 'reset', '--hard'])).toMatchObject({ verb: 'reset' });
  });

  it('never reports what it cannot resolve: $VAR/`cmd` directories, --git-dir, unknown cd targets', () => {
    expect(hit('cd $REPO && git reset --hard', WS)).toBeUndefined();
    expect(hit('cd "$(pwd)/x" && git reset --hard', WS)).toBeUndefined();
    expect(hit('git -C "$ROOT" reset --hard', WS)).toBeUndefined();
    expect(hit('git --git-dir=/somewhere/.git reset --hard', ROOT)).toBeUndefined();
    expect(hit('cd - && git reset --hard', ROOT)).toBeUndefined();
    expect(hit('cd ~/proj && git reset --hard', WS)).toBeUndefined(); // no home given: unresolved
    expect(hit('cd ~/codes/proj && git reset --hard', WS, { home: '/Users/k' })).toMatchObject({ dir: ROOT });
    expect(hit('git reset --hard', ROOT, { roots: [] })).toBeUndefined();
    expect(findMainCheckoutGitWrite({ command: undefined as never, cwd: ROOT, roots: [ROOT] })).toBeUndefined();
  });

  it('a root is matched on a path boundary and against every root given', () => {
    expect(hit('git reset --hard', '/Users/k/codes/proj-other')).toBeUndefined();
    expect(hit('git reset --hard', `${ROOT}/deep/er`)).toMatchObject({ root: ROOT });
    expect(hit('git reset --hard', '/b', { roots: [ROOT, '/b'] })).toMatchObject({ root: '/b' });
  });

  it('handles Windows paths: drive letters in any case, backslashes and mixed separators', () => {
    const win = 'C:\\Users\\k\\codes\\proj';
    const wsWin = 'C:\\Users\\k\\.imcodes\\worktrees\\imcodes\\deck_sub_x\\pair_t\\repo';
    expect(hit('git reset --hard', win, { roots: [win] })).toMatchObject({ verb: 'reset' });
    expect(hit('git reset --hard', 'c:/users/k/codes/proj/src', { roots: [win] })).toMatchObject({ verb: 'reset' });
    expect(hit(`git -C ${wsWin} commit -m x`, win, { roots: [win] })).toBeUndefined();
    expect(hit(`cd ${wsWin} && git commit -m x`, win, { roots: [win] })).toBeUndefined();
    expect(hit(`git -C C:\\Users\\k\\codes\\proj commit -m x`, wsWin, { roots: [win] })).toMatchObject({ verb: 'commit' });
    expect(hit('git -C "C:\\Users\\k\\codes\\proj" reset --hard', wsWin, { roots: [win] })).toMatchObject({ verb: 'reset' });
    expect(hit(['powershell.exe', '-c', 'git reset --hard'], win, { roots: [win] })).toMatchObject({ verb: 'reset' });
  });
});

describe('findMainCheckoutGitWrite: per-call cost (runs on every tool event)', () => {
  const time = (command: string, iterations: number): number => {
    for (let i = 0; i < 500; i += 1) hit(command); // warm up
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) hit(command);
    return ((performance.now() - start) * 1000) / iterations; // microseconds per call
  };

  it('a command without a git write verb costs microseconds (one regex, no tokenising); a git write costs tens', () => {
    const plain = time('rg -n "function" src shared test | head -100; ls -la /tmp && npm run build 2>&1 | tail -20', 20_000);
    const readOnlyGit = time('git status --short && git log --oneline -20 && git diff --stat', 20_000);
    const write = time(`cd ${WS} && git add -A && git commit -m "message with several words" && git status`, 5_000);
    const long = time(`${'echo line; '.repeat(400)}git status`, 2_000);
    console.log(`classifier cost per call: plain=${plain.toFixed(2)}us readOnlyGit=${readOnlyGit.toFixed(2)}us gitWrite=${write.toFixed(2)}us long400stmt=${long.toFixed(2)}us`);
    // Generous CI-safe ceilings: the point is "not milliseconds" on a path taken by every tool event.
    expect(plain).toBeLessThan(50);
    expect(readOnlyGit).toBeLessThan(50);
    expect(write).toBeLessThan(500);
    expect(long).toBeLessThan(500);
  });
});
