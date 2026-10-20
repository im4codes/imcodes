/**
 * Disk hygiene for pair worktrees (tsk_cd_worktree_disk_hygiene).
 *
 * On 2026-09-30 the Data volume hit 100%: ~35 GB of ~/.imcodes/worktrees was
 * node_modules in worktrees of finished pairs. These tests use real git
 * worktrees under temporary roots (never ~/.imcodes) and check both halves of
 * the contract: rebuildable ignored weight goes at once when a pair ends or
 * the volume runs low, and nothing else does -- not commits, tracked files,
 * uncommitted or untracked work, an open pair, a symlink's target, a sibling.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { resetTaskPairFocusForTests, setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { taskPairService, type TaskPairScheduler } from '../../../src/daemon/task-pairs/service.js';
import { setTaskPairWorkspaceDepsForTests } from '../../../src/daemon/task-pairs/workspace.js';
import {
  classifyDiskLevel,
  removeTree,
  setTaskPairHygieneDepsForTests,
  stripHeavyIgnoredDirs,
  toAbsoluteCandidate,
  type DiskReading,
} from '../../../src/daemon/task-pairs/workspace-hygiene.js';
import { TASK_PAIR_DISK_LEVEL_META_KEY, type TaskPairState } from '../../../shared/task-pair.js';

const PROJECT = 'hygproj';
const BRAIN = 'deck_hygproj_brain';
const EXEC = 'deck_sub_hygexec';
const EXEC2 = 'deck_sub_hygexec2';
const AUD = 'deck_sub_hygaud';
const AUD2 = 'deck_sub_hygaud2';
const GIB = 1024 ** 3;
const TOTAL = 100 * GIB;

let base = '';
let project = '';
let worktreesRoot = '';
let sent: Array<{ target: string; text: string; id: string }>;
let turn = 0;

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const put = (file: string, content = 'x') => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); };

function initRepo(dir: string, ignore: string): void {
  execFileSync('git', ['init', '-q', dir]);
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, '.gitignore'), ignore);
  put(join(dir, 'README.md'), 'hello\n');
  put(join(dir, 'src', 'app.ts'), 'export {};\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
}

const IGNORE = 'node_modules/\ndist/\nbuild/\n.vite/\ncoverage/\n*.log\n';

describe('stripHeavyIgnoredDirs (real git worktrees)', () => {
  let root = '';
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'imcodes-hyg-unit-'))); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function worktree(name: string, ignore = IGNORE): { main: string; wt: string } {
    const main = join(root, `${name}-main`);
    initRepo(main, ignore);
    const wt = join(root, `${name}-wt`);
    git(main, 'worktree', 'add', '-q', '--detach', wt);
    return { main, wt };
  }

  it('removes heavy ignored directories at any depth and nothing else: commits, tracked, uncommitted and untracked work survive', async () => {
    const { wt } = worktree('a');
    for (const dir of ['node_modules/pkg', 'web/node_modules/pkg', 'dist', '.vite/deps', 'coverage']) put(join(wt, dir, 'f.js'));
    put(join(wt, 'debug.log'), 'ignored, not a heavy dir name');
    put(join(wt, 'notes.txt'), 'untracked source');
    writeFileSync(join(wt, 'README.md'), 'uncommitted change\n');
    put(join(wt, 'src', 'made-in-worktree.ts'), 'committed');
    git(wt, 'add', 'src/made-in-worktree.ts');
    git(wt, 'commit', '-qm', 'work');
    const head = git(wt, 'rev-parse', 'HEAD');

    const result = await stripHeavyIgnoredDirs(wt);

    expect(result.ok).toBe(true);
    expect([...result.removed].sort()).toEqual(['.vite', 'coverage', 'dist', 'node_modules', 'web/node_modules']);
    for (const gone of ['node_modules', 'web/node_modules', 'dist', '.vite', 'coverage']) expect(existsSync(join(wt, gone)), gone).toBe(false);
    expect(readFileSync(join(wt, 'README.md'), 'utf8')).toBe('uncommitted change\n');
    expect(existsSync(join(wt, 'notes.txt'))).toBe(true);
    expect(existsSync(join(wt, 'debug.log'))).toBe(true);
    expect(existsSync(join(wt, 'src', 'app.ts'))).toBe(true);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(wt, 'status', '--porcelain')).toContain('M README.md');
  });

  it('never removes a directory that holds a tracked file, even if git lists it as ignored', async () => {
    const { wt } = worktree('b');
    put(join(wt, 'build', 'tracked.txt'), 'force-added');
    git(wt, 'add', '-f', 'build/tracked.txt');
    git(wt, 'commit', '-qm', 'tracked under an ignored name');
    put(join(wt, 'build', 'junk.o'));
    // The real listing already excludes it; feed it in anyway: the tracked-file guard must hold on its own.
    const forced = await stripHeavyIgnoredDirs(wt, { listIgnored: async () => ['build/'] });
    expect(forced.removed).toEqual([]);
    expect(existsSync(join(wt, 'build', 'tracked.txt'))).toBe(true);
    // A tracked `build` directory is not ignored at all.
    put(join(wt, 'src', 'build', 'tracked-src.ts'));
    git(wt, 'add', '-f', 'src/build/tracked-src.ts');
    const real = await stripHeavyIgnoredDirs(wt);
    expect(existsSync(join(wt, 'src', 'build', 'tracked-src.ts'))).toBe(true);
    expect(real.removed).not.toContain('src/build');
  });

  it('fails closed when git cannot say what is tracked', async () => {
    const { wt } = worktree('c');
    put(join(wt, 'node_modules', 'pkg', 'i.js'));
    const result = await stripHeavyIgnoredDirs(wt, { tracked: async () => undefined });
    expect(result.ok).toBe(false);
    expect(existsSync(join(wt, 'node_modules'))).toBe(true);
  });

  it('a git-ignored node_modules symlink is unlinked and its target is never followed', async () => {
    const { wt } = worktree('d', 'node_modules\n');
    const deps = join(root, 'shared-testdeps');
    put(join(deps, 'pkg', 'index.js'), 'shared');
    symlinkSync(deps, join(wt, 'node_modules'));
    put(join(wt, 'web', 'src.ts'));
    symlinkSync(deps, join(wt, 'web', 'node_modules'));

    const result = await stripHeavyIgnoredDirs(wt);

    expect([...result.removed].sort()).toEqual(['node_modules', 'web/node_modules']);
    expect(() => lstatSync(join(wt, 'node_modules'))).toThrow();
    expect(() => lstatSync(join(wt, 'web', 'node_modules'))).toThrow();
    expect(readFileSync(join(deps, 'pkg', 'index.js'), 'utf8')).toBe('shared');
  });

  it('a symlink git does not report as ignored is left alone', async () => {
    // `node_modules/` (trailing slash) does not match a symlink: it shows as untracked, which is not ours to delete.
    const { wt } = worktree('e', 'node_modules/\n');
    const deps = join(root, 'shared-testdeps');
    put(join(deps, 'x.js'));
    symlinkSync(deps, join(wt, 'node_modules'));
    const result = await stripHeavyIgnoredDirs(wt);
    expect(result.removed).toEqual([]);
    expect(readlinkSync(join(wt, 'node_modules'))).toBe(deps);
  });

  it('does not descend through a symlinked parent directory', async () => {
    const { wt } = worktree('f');
    const outside = join(root, 'outside');
    put(join(outside, 'node_modules', 'keep.js'));
    symlinkSync(outside, join(wt, 'linked'));
    await stripHeavyIgnoredDirs(wt);
    expect(existsSync(join(outside, 'node_modules', 'keep.js'))).toBe(true);
  });

  it('works on the legacy layout where the worktree sits directly beside unrelated siblings', async () => {
    const main = join(root, 'legacy-main');
    initRepo(main, IGNORE);
    const shared = join(root, 'cx7');
    mkdirSync(shared);
    const wt = join(shared, 'tsk_legacy');
    git(main, 'worktree', 'add', '-q', '--detach', wt);
    put(join(wt, 'node_modules', 'a.js'));
    put(join(shared, 'other_task', 'node_modules', 'b.js'), 'a sibling task, not ours');
    put(join(shared, 'metadata.json'), '{}');

    const result = await stripHeavyIgnoredDirs(wt);

    expect(result.removed).toEqual(['node_modules']);
    expect(existsSync(join(shared, 'other_task', 'node_modules', 'b.js'))).toBe(true);
    expect(existsSync(join(shared, 'metadata.json'))).toBe(true);
  });

  it('keeps a directory that holds a not-yet-copied deliverable, and stops when the pair is no longer eligible', async () => {
    const { wt } = worktree('g');
    put(join(wt, 'dist', 'report.md'), 'deliverable');
    put(join(wt, 'node_modules', 'a.js'));
    put(join(wt, 'coverage', 'c.js'));
    const kept = await stripHeavyIgnoredDirs(wt, { keepPaths: [join(wt, 'dist', 'report.md')] });
    expect(kept.skipped).toEqual([{ path: 'dist', reason: 'kept_path' }]);
    expect(existsSync(join(wt, 'dist', 'report.md'))).toBe(true);
    expect(existsSync(join(wt, 'node_modules'))).toBe(false);

    put(join(wt, 'node_modules', 'again.js'));
    let calls = 0;
    const aborted = await stripHeavyIgnoredDirs(wt, { stillEligible: () => (calls += 1) === 1 });
    expect(aborted.aborted).toBe(true);
    expect(aborted.removed).toHaveLength(1);
    // Whatever the reopen left after the first removal is untouched.
    expect(['coverage', 'node_modules'].filter((dir) => existsSync(join(wt, dir)))).toHaveLength(1);
  });

  it('removeTree unlinks a symlink and deletes a real tree', async () => {
    const target = join(root, 'target');
    put(join(target, 'f'));
    const link = join(root, 'link');
    symlinkSync(target, link);
    await removeTree(link);
    expect(() => lstatSync(link)).toThrow();
    expect(existsSync(join(target, 'f'))).toBe(true);
    await removeTree(target);
    expect(existsSync(target)).toBe(false);
  });

  it('resolves candidate paths for Windows spellings and rejects escapes', () => {
    expect(toAbsoluteCandidate('C:\\wt\\repo', 'web/node_modules', path.win32)).toBe('C:\\wt\\repo\\web\\node_modules');
    expect(toAbsoluteCandidate('/wt/repo', 'web/node_modules', path.posix)).toBe('/wt/repo/web/node_modules');
    for (const bad of ['../node_modules', 'a/../../b', '/abs/node_modules', '', 'a//b']) expect(toAbsoluteCandidate('/wt/repo', bad, path.posix), bad).toBeUndefined();
    expect(toAbsoluteCandidate('C:\\wt\\repo', 'C:/other/node_modules', path.win32)).toBeUndefined();
    expect(toAbsoluteCandidate('C:\\wt\\repo', '..\\x', path.win32)).toBeUndefined();
  });

  it('classifies free space with hysteresis so a boundary cannot flap', () => {
    const at = (freeGib: number): DiskReading => ({ freeBytes: freeGib * GIB, totalBytes: TOTAL });
    expect(classifyDiskLevel(at(50))).toBe('ok');
    expect(classifyDiskLevel(at(9))).toBe('low');
    expect(classifyDiskLevel(at(2.5))).toBe('critical');
    // Percentage rule: 4% of a 1 TB volume is 40 GB, still "low" under 5%.
    expect(classifyDiskLevel({ freeBytes: 40 * GIB, totalBytes: 1000 * GIB })).toBe('low');
    // Recovery needs 1.25x the threshold.
    expect(classifyDiskLevel(at(11), 'low')).toBe('low');
    expect(classifyDiskLevel(at(13), 'low')).toBe('ok');
    expect(classifyDiskLevel(at(3.5), 'critical')).toBe('critical');
    expect(classifyDiskLevel(at(4), 'critical')).toBe('low');
    // Getting worse is immediate.
    expect(classifyDiskLevel(at(9), 'ok')).toBe('low');
    expect(classifyDiskLevel(at(2), 'low')).toBe('critical');
  });
});

// ── through the service ──────────────────────────────────────────────────────

function session(name: string, role: SessionRecord['role'], projectDir: string): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'codex-sdk', projectDir, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}
function marker(writer: string, line: string) {
  turn += 1;
  return taskPairService.ingestText(PROJECT, writer, line, `hyg-turn-${turn}`);
}
function pair(taskId: string): TaskPairState {
  return getTaskPairStore().getPair(PROJECT, taskId)!.state;
}
/** Stand-in for the queue drain: a queued DISPATCH starts at once. */
const testScheduler: TaskPairScheduler = {
  async onIntent(projectName, pairState, intent) {
    if (intent.kind !== 'slot_changed') return;
    if (pairState.status !== 'queued' || !pairState.executor || pairState.auditor === undefined) return;
    taskPairService.applyMarker({
      project: projectName, writer: 'daemon',
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: pairState.taskId, attrs: { executor: pairState.executor, auditor: pairState.auditor } },
      source: 'queue', now: Date.now(), eventId: `hyg-drain:${pairState.taskId}:${Date.now()}:${Math.random()}`,
    });
    await taskPairService.briefParticipants(projectName, pairState.taskId);
  },
};
async function opened(taskId: string, executor = EXEC, auditor = AUD): Promise<string> {
  marker(BRAIN, `<!-- IMCODES_TASK DISPATCH ${taskId} executor=${executor} auditor=${auditor} -->`);
  await vi.waitFor(() => expect(pair(taskId).workspace?.status).toBe('active'), { timeout: 15_000, interval: 50 });
  return pair(taskId).workspace!.path;
}
/** Weight an executor would have installed. */
const weigh = (wt: string) => { put(join(wt, 'node_modules', 'pkg', 'index.js')); put(join(wt, 'web', 'node_modules', 'pkg', 'index.js')); put(join(wt, 'dist', 'bundle.js')); };
const weighed = (wt: string) => ['node_modules', 'web/node_modules', 'dist'].filter((dir) => existsSync(join(wt, dir)));
async function closed(taskId: string): Promise<string> {
  const wt = await opened(taskId);
  weigh(wt);
  marker(BRAIN, `<!-- IMCODES_TASK DONE ${taskId} force=true -->`);
  await vi.waitFor(() => expect(pair(taskId).workspace?.strippedAt).toBeTypeOf('number'), { timeout: 15_000, interval: 50 });
  return wt;
}
const diskNotices = () => sent.filter((entry) => entry.target === BRAIN && entry.id.includes(':brain-disk-pressure:'));

describe('workspace hygiene through the pair service', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    resetTaskPairFocusForTests();
    sent = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    base = realpathSync(mkdtempSync(join(tmpdir(), 'imcodes-pair-hyg-')));
    project = join(base, 'project');
    worktreesRoot = join(base, 'worktrees');
    initRepo(project, IGNORE);
    setTaskPairWorkspaceDepsForTests({ env: { ...process.env, IMCODES_WORKTREES_ROOT: worktreesRoot } });
    for (const record of [session(BRAIN, 'brain', project), session(EXEC, 'w1', project), session(EXEC2, 'w3', project), session(AUD, 'w2', project), session(AUD2, 'w4', project)]) upsertSession(record);
    taskPairService.setScheduler(testScheduler);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await taskPairService.waitForIdle();
    taskPairService.setScheduler(undefined);
    setTaskPairHygieneDepsForTests(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairWorkspaceDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    resetTaskPairFocusForTests();
    for (const name of [BRAIN, EXEC, EXEC2, AUD, AUD2]) removeSession(name);
    rmSync(base, { recursive: true, force: true });
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('on DONE the heavy ignored directories go at once; tracked, uncommitted and untracked files and commits survive', async () => {
    const wt = await opened('H1');
    weigh(wt);
    put(join(wt, 'notes.txt'), 'untracked');
    writeFileSync(join(wt, 'README.md'), 'uncommitted\n');
    put(join(wt, 'src', 'new.ts'));
    git(wt, 'add', 'src/new.ts');
    git(wt, 'commit', '-qm', 'executor work');
    const head = git(wt, 'rev-parse', 'HEAD');
    expect(weighed(wt)).toHaveLength(3);

    marker(BRAIN, '<!-- IMCODES_TASK DONE H1 force=true -->');
    await vi.waitFor(() => expect(pair('H1').workspace?.strippedAt).toBeTypeOf('number'), { timeout: 15_000, interval: 50 });

    expect(weighed(wt)).toEqual([]);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(wt, 'README.md'), 'utf8')).toBe('uncommitted\n');
    expect(existsSync(join(wt, 'notes.txt'))).toBe(true);
    expect(existsSync(join(wt, 'src', 'new.ts'))).toBe(true);
    // The worktree itself stays for the retention sweep to judge.
    expect(pair('H1').workspace).toMatchObject({ status: 'ended', path: wt });
  });

  it('the same happens on CANCEL', async () => {
    const wt = await opened('H1c');
    weigh(wt);
    marker(BRAIN, '<!-- IMCODES_TASK CANCEL H1c -->');
    await vi.waitFor(() => expect(pair('H1c').workspace?.strippedAt).toBeTypeOf('number'), { timeout: 15_000, interval: 50 });
    expect(weighed(wt)).toEqual([]);
  });

  it('never touches an open pair, even under critical disk pressure', async () => {
    const open = await opened('OPEN1', EXEC2, AUD2);
    weigh(open);
    const done = await closed('DONE1');
    weigh(done);
    getTaskPairStore().savePair(PROJECT, { ...pair('DONE1'), workspace: { ...pair('DONE1').workspace!, strippedAt: undefined } });
    setTaskPairHygieneDepsForTests({ worktreesRoot, readSpace: async () => ({ freeBytes: 1 * GIB, totalBytes: TOTAL }) });

    await taskPairService.checkDiskPressure(Date.now(), { force: true, waitMs: 10_000 });

    expect(weighed(open)).toHaveLength(3);
    expect(pair('OPEN1').workspace?.strippedAt).toBeUndefined();
    expect(weighed(done)).toEqual([]);
  });

  it('low disk: strips finished pairs oldest first, and tells Brain once per threshold crossing', async () => {
    await opened('OPEN2', EXEC2, AUD2); // an open pair makes Brain reachable and must survive
    const a = await closed('OLD1');
    const b = await closed('OLD2');
    const c = await closed('OLD3');
    const store = getTaskPairStore();
    const endedBase = Date.now() - 10 * 60_000;
    // Closed pairs still holding weight (as before stripping existed), with A the oldest.
    [['OLD1', a, 0], ['OLD2', b, 1_000], ['OLD3', c, 2_000]].forEach(([id, wt, offset]) => {
      weigh(wt as string);
      const state = pair(id as string);
      store.savePair(PROJECT, { ...state, workspace: { ...state.workspace!, endedAt: endedBase + (offset as number), strippedAt: undefined } });
    });
    const order: string[] = [];
    const { removeTree: realRemove } = await import('../../../src/daemon/task-pairs/workspace-hygiene.js');
    // 3 GiB of free space comes back per stripped worktree; 100 GiB volume, "low" below 10 GiB, "ok" again from 12.5 GiB.
    const free = () => 4 * GIB + [a, b, c].filter((wt) => !existsSync(join(wt, 'node_modules'))).length * 3 * GIB;
    setTaskPairHygieneDepsForTests({
      worktreesRoot,
      readSpace: async () => ({ freeBytes: free(), totalBytes: TOTAL }),
      remove: async (target) => { if (target.endsWith(`${path.sep}node_modules`) && !target.includes(`${path.sep}web${path.sep}`)) order.push(target); await realRemove(target); },
    });

    await taskPairService.checkDiskPressure(Date.now(), { force: true, waitMs: 20_000 });

    expect(order.map((target) => [a, b, c].findIndex((wt) => target.startsWith(wt)))).toEqual([0, 1, 2]);
    expect(diskNotices()).toHaveLength(1);
    expect(diskNotices()[0]!.text).toContain('Disk space on the worktree volume is low: 4.0 GiB free');
    expect(diskNotices()[0]!.text).toContain('from 3 finished pair(s)');
    expect(diskNotices()[0]!.text).toContain('now 13.0 GiB free');
    expect(getTaskPairStore().getMeta(TASK_PAIR_DISK_LEVEL_META_KEY)).toBe('ok');

    // Still fine on the next heartbeat: nothing.
    await taskPairService.checkDiskPressure(Date.now(), { force: true, waitMs: 5_000 });
    expect(diskNotices()).toHaveLength(1);

    // A second crossing (nothing left to strip) is announced once, then not again while it stays low.
    setTaskPairHygieneDepsForTests({ worktreesRoot, readSpace: async () => ({ freeBytes: 6 * GIB, totalBytes: TOTAL }) });
    await taskPairService.checkDiskPressure(Date.now(), { force: true, waitMs: 5_000 });
    expect(diskNotices()).toHaveLength(2);
    expect(diskNotices()[1]!.text).toContain('No finished pair had anything left to strip');
    for (let i = 0; i < 3; i += 1) await taskPairService.checkDiskPressure(Date.now(), { force: true, waitMs: 5_000 });
    expect(diskNotices()).toHaveLength(2);

    // Getting worse is a new crossing.
    setTaskPairHygieneDepsForTests({ worktreesRoot, readSpace: async () => ({ freeBytes: 2 * GIB, totalBytes: TOTAL }) });
    await taskPairService.checkDiskPressure(Date.now(), { force: true, waitMs: 5_000 });
    expect(diskNotices()).toHaveLength(3);
    expect(diskNotices()[2]!.text).toContain('critically low');
    expect(weighed(pair('OPEN2').workspace!.path)).toEqual([]);
  });

  it('a heartbeat check that is not forced is throttled and never waits for the reclaim', async () => {
    const reads = vi.fn(async () => ({ freeBytes: 50 * GIB, totalBytes: TOTAL }));
    setTaskPairHygieneDepsForTests({ worktreesRoot, readSpace: reads });
    // The service is a process-wide singleton: start past any earlier test's throttle window.
    const now = Date.now() + 24 * 60 * 60_000;
    await taskPairService.checkDiskPressure(now);
    await taskPairService.waitForIdle();
    await taskPairService.checkDiskPressure(now + 1_000);
    await taskPairService.waitForIdle();
    expect(reads).toHaveBeenCalledTimes(1);
    await taskPairService.checkDiskPressure(now + 61_000);
    await taskPairService.waitForIdle();
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('a new pair worktree is preceded by a reclaim when the volume is short', async () => {
    const stale = await closed('STALE1');
    weigh(stale);
    getTaskPairStore().savePair(PROJECT, { ...pair('STALE1'), workspace: { ...pair('STALE1').workspace!, strippedAt: undefined } });
    const free = () => (existsSync(join(stale, 'node_modules')) ? 4 : 20) * GIB;
    setTaskPairHygieneDepsForTests({ worktreesRoot, readSpace: async () => ({ freeBytes: free(), totalBytes: TOTAL }) });

    const fresh = await opened('FRESH1');

    expect(weighed(stale)).toEqual([]);
    expect(existsSync(fresh)).toBe(true);
    expect(pair('STALE1').workspace?.strippedAt).toBeTypeOf('number');
  });

  it('a reopened pair is open again: it is not stripped, and it is stripped again when it ends', async () => {
    const wt = await closed('RE1');
    expect(weighed(wt)).toEqual([]);

    // A Brain QUEUE is the explicit operation that reopens a finished pair.
    marker(BRAIN, `<!-- IMCODES_TASK QUEUE RE1 executor=${EXEC} auditor=${AUD} -->`);
    await vi.waitFor(() => expect(pair('RE1').workspace?.status).toBe('active'), { timeout: 15_000, interval: 50 });
    expect(pair('RE1').workspace?.strippedAt).toBeUndefined();

    // The executor reinstalls; a low-disk sweep leaves the open pair alone.
    weigh(wt);
    setTaskPairHygieneDepsForTests({ worktreesRoot, readSpace: async () => ({ freeBytes: 1 * GIB, totalBytes: TOTAL }) });
    await taskPairService.checkDiskPressure(Date.now(), { force: true, waitMs: 10_000 });
    await taskPairService.sweepWorkspaces(Date.now(), { force: true });
    await taskPairService.waitForIdle();
    expect(weighed(wt)).toHaveLength(3);

    marker(BRAIN, '<!-- IMCODES_TASK DONE RE1 force=true -->');
    await vi.waitFor(() => expect(pair('RE1').workspace?.strippedAt).toBeTypeOf('number'), { timeout: 15_000, interval: 50 });
    expect(weighed(wt)).toEqual([]);
  });

  it('a strip interrupted by a failure leaves the pair unstripped, and the sweep finishes it (restart mid-strip)', async () => {
    let failOn = 'web/node_modules';
    const { removeTree: realRemove } = await import('../../../src/daemon/task-pairs/workspace-hygiene.js');
    setTaskPairHygieneDepsForTests({
      remove: async (target) => {
        if (failOn && target.split(path.sep).join('/').endsWith(failOn)) throw new Error('daemon killed mid-strip');
        await realRemove(target);
      },
    });
    const wt = await opened('CR1');
    weigh(wt);
    marker(BRAIN, '<!-- IMCODES_TASK DONE CR1 force=true -->');
    await vi.waitFor(() => expect(pair('CR1').workspace?.status).toBe('ended'), { timeout: 15_000, interval: 50 });
    await taskPairService.waitForIdle();
    expect(pair('CR1').workspace?.strippedAt).toBeUndefined();
    expect(existsSync(join(wt, 'web', 'node_modules'))).toBe(true);

    failOn = '';
    await taskPairService.sweepWorkspaces(Date.now(), { force: true });
    await vi.waitFor(() => expect(pair('CR1').workspace?.strippedAt).toBeTypeOf('number'), { timeout: 15_000, interval: 50 });
    expect(weighed(wt)).toEqual([]);
  });

  it('the sweep also strips a kept worktree (unsaved work or commits no one merged), leaving that work alone', async () => {
    const wt = await opened('KEPT1');
    put(join(wt, 'src', 'unmerged.ts'));
    git(wt, 'add', 'src/unmerged.ts');
    git(wt, 'commit', '-qm', 'never merged');
    weigh(wt);
    marker(BRAIN, '<!-- IMCODES_TASK DONE KEPT1 force=true -->');
    await vi.waitFor(() => expect(pair('KEPT1').workspace?.strippedAt).toBeTypeOf('number'), { timeout: 15_000, interval: 50 });
    weigh(wt);
    const state = pair('KEPT1');
    getTaskPairStore().savePair(PROJECT, { ...state, workspace: { ...state.workspace!, status: 'kept', keptReason: 'unpushed', strippedAt: undefined } });

    await taskPairService.sweepWorkspaces(Date.now(), { force: true });
    await vi.waitFor(() => expect(pair('KEPT1').workspace?.strippedAt).toBeTypeOf('number'), { timeout: 15_000, interval: 50 });

    expect(weighed(wt)).toEqual([]);
    expect(existsSync(join(wt, 'src', 'unmerged.ts'))).toBe(true);
    expect(pair('KEPT1').workspace?.status).toBe('kept');
  });

  it('keeps a deliverable that still lives in a build directory', async () => {
    const wt = await opened('OUT1');
    weigh(wt);
    put(join(wt, 'dist', 'report.md'), 'the result');
    marker(BRAIN, '<!-- IMCODES_TASK DONE OUT1 force=true output=dist/report.md -->');
    await vi.waitFor(() => expect(pair('OUT1').workspace?.strippedAt).toBeTypeOf('number'), { timeout: 15_000, interval: 50 });
    expect(existsSync(join(wt, 'dist', 'report.md'))).toBe(true);
    expect(existsSync(join(wt, 'node_modules'))).toBe(false);
  });
});
