/**
 * Integration drift (tsk_cd_pair_integration_drift): a finished pair whose head never reached the integration branch is reminded
 * to Brain, and a head on a base far behind that branch draws a rebase warning. Everything here runs real git (a bare origin, a
 * clone, pair worktrees, cherry-picks) in temp directories; only the delivery of messages and the clock are injected.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { TaskPairService } from '../../../src/daemon/task-pairs/service.js';
import {
  TASK_PAIR_INTEGRATION_DIGEST_ID,
  TASK_PAIR_INTEGRATION_DIGEST_REASON,
  checkStaleBaseNotice,
  runIntegrationDriftPass,
  setIntegrationDriftDepsForTests,
} from '../../../src/daemon/task-pairs/integration-drift.js';
import {
  TASK_PAIR_INTEGRATION_ATTR,
  TASK_PAIR_INTEGRATION_DISMISSED_EFFECT,
  TASK_PAIR_INTEGRATION_DISMISS_VALUE,
  TASK_PAIR_INTEGRATION_REF_ENV,
  TASK_PAIR_INTEGRATION_REMINDER_GRACE_MS,
  TASK_PAIR_INTEGRATION_REMINDER_MAX_PAIRS,
  TASK_PAIR_INTEGRATION_REMINDER_WINDOW_MS,
  TASK_PAIR_STALE_BASE_MAX_COMMITS,
  type TaskPairState,
  type TaskPairStatus,
} from '../../../shared/task-pair.js';

const PROJECT = 'driftproj';
const BRAIN = 'deck_driftproj_brain';
const EXEC = 'deck_sub_driftexec';
const AUD = 'deck_sub_driftaud';
const MIN = 60_000;
const T0 = 1_800_000_000_000;

let root: string;
let origin: string;
let main: string;
let sent: Array<{ target: string; taskId: string; reason: string; text: string }>;
let gitCalls: string[];
let seq = 0;
let clock = T0;

const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, file: string, content: string, subject: string): string => {
  writeFileSync(join(cwd, file), content);
  run(cwd, 'add', '-A');
  run(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', subject);
  return run(cwd, 'rev-parse', 'HEAD');
};
const emptyCommits = (cwd: string, count: number): void => {
  for (let i = 0; i < count; i += 1) run(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', `dev ${i}`);
};

function session(name: string, role: SessionRecord['role']): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', projectDir: main, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`, restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}

/** origin (bare) <- main (clone on dev) ; a pair worktree on its own branch cut from dev. */
function setUpRepos(): { base: string } {
  origin = join(root, 'origin.git');
  main = join(root, 'main');
  mkdirSync(origin);
  run(origin, 'init', '-q', '--bare', '-b', 'dev');
  run(root, 'clone', '-q', origin, main);
  run(main, 'checkout', '-q', '-b', 'dev');
  const base = commit(main, 'README.md', 'base\n', 'base');
  run(main, 'push', '-q', 'origin', 'dev');
  return { base };
}

function addWorktree(name: string, base: string): string {
  const path = join(root, 'worktrees', name, 'repo');
  mkdirSync(join(root, 'worktrees', name), { recursive: true });
  run(main, 'worktree', 'add', '-q', '-b', `pair/${name}`, path, base);
  return path;
}

function savePair(taskId: string, over: Partial<TaskPairState> & { status?: TaskPairStatus } = {}, live: Record<string, unknown> = {}): void {
  getTaskPairStore().savePair(PROJECT, {
    taskId, status: 'done', brain: BRAIN, executor: EXEC, auditor: AUD, round: 1, blocking: ['P0'],
    flags: [], flagSides: {}, previousAuditors: [], capCounts: {}, capRound: 1, createdAt: T0 - 60 * MIN, updatedAt: T0, title: taskId,
    ...over,
  } as TaskPairState, Object.keys(live).length ? { liveness: { silenceExecutor: 0, silenceAuditor: 0, progressExecutorAt: 0, progressAuditorAt: 0, lastTickAt: 0, notified: [], ...live } as never } : {});
}

const donePair = (taskId: string, worktree: string, head: string, base: string, extra: Partial<TaskPairState> = {}): void => savePair(taskId, {
  material: { worktree, head, base, at: T0 - 5 * MIN },
  workspace: { kind: 'worktree', path: worktree, base, branch: `pair/${taskId}`, lastHead: head, createdAt: T0 - 60 * MIN, endedAt: T0, status: 'ended' } as never,
  ...extra,
});

const digests = () => sent.filter((entry) => entry.reason === TASK_PAIR_INTEGRATION_DIGEST_REASON);
const live = (taskId: string) => getTaskPairStore().getPair(PROJECT, taskId)!.liveness;
const passAt = (minutesAfterDone: number) => {
  clock = T0 + minutesAfterDone * MIN;
  return runIntegrationDriftPass(clock);
};

describe('integration drift', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'imc-drift-'));
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    delete process.env[TASK_PAIR_INTEGRATION_REF_ENV];
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    sent = [];
    gitCalls = [];
    seq = 0;
    clock = T0;
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, taskId: 'n/a', reason: id.split(':')[1] === '__integration__' ? TASK_PAIR_INTEGRATION_DIGEST_REASON : id, text }); } });
    setIntegrationDriftDepsForTests({
      now: () => clock,
      send: async (target, taskId, reason, text) => { sent.push({ target, taskId, reason, text }); return 'sent'; },
      git: async (cwd, args, timeoutMs) => {
        gitCalls.push(args.join(' '));
        try {
          return { ok: true, stdout: execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] }) };
        } catch (error) {
          return { ok: false, stdout: '', exitCode: (error as { status?: number }).status };
        }
      },
    });
    upsertSession(session(BRAIN, 'brain'));
    upsertSession(session(EXEC, 'w1'));
    upsertSession(session(AUD, 'w2'));
  });
  afterEach(() => {
    setIntegrationDriftDepsForTests(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, EXEC, AUD]) removeSession(name);
    rmSync(root, { recursive: true, force: true });
    delete process.env[TASK_PAIR_INTEGRATION_REF_ENV];
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
    vi.restoreAllMocks();
  });

  describe('unintegrated DONE reminder', () => {
    it('reminds Brain after the grace, on the reminder pacing, and stops once a cherry-pick (a different SHA, the same patch) is in dev', async () => {
      const { base } = setUpRepos();
      const wt = addWorktree('t1', base);
      const head = commit(wt, 'feature.txt', 'feature\n', 'feat: the pair change');
      donePair('t1', wt, head, base);

      // Inside the grace: nothing is sent and git is not even asked.
      expect((await passAt(TASK_PAIR_INTEGRATION_REMINDER_GRACE_MS / MIN - 1)).checked).toBe(0);
      expect(digests()).toHaveLength(0);
      expect(gitCalls).toHaveLength(0);

      // After the grace: ONE digest naming taskId, head, worktree and age.
      const first = await passAt(TASK_PAIR_INTEGRATION_REMINDER_GRACE_MS / MIN + 1);
      expect(first.reminded).toBe(1);
      expect(digests()).toHaveLength(1);
      const line = digests()[0]!.text;
      expect(digests()[0]!.target).toBe(BRAIN);
      expect(line).toContain('t1');
      expect(line).toContain(head.slice(0, 12));
      expect(line).toContain(wt);
      expect(line).toContain('origin/dev');
      expect(line).toContain(`${TASK_PAIR_INTEGRATION_ATTR}=${TASK_PAIR_INTEGRATION_DISMISS_VALUE}`);
      expect(live('t1').integrationReminderCount).toBe(1);

      // Pacing: not again at +25 min (next is 10 min after the first), again at +32, then every 15.
      await passAt(25);
      expect(digests()).toHaveLength(1);
      await passAt(32);
      expect(digests()).toHaveLength(2);
      await passAt(40);
      expect(digests()).toHaveLength(2);
      await passAt(48);
      expect(digests()).toHaveLength(3);

      // Brain cherry-picks the pair's commit into dev and pushes: a different SHA, the same patch.
      commit(main, 'unrelated.txt', 'other work on dev\n', 'chore: other work on dev');
      run(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'cherry-pick', head);
      run(main, 'push', '-q', 'origin', 'dev');
      expect(run(main, 'rev-parse', 'HEAD')).not.toBe(head);
      const before = digests().length;
      const later = await passAt(48 + 20);
      expect(later.integrated).toBe(1);
      expect(digests()).toHaveLength(before);
      expect(live('t1').integrationIntegratedAt).toBeDefined();
      // Integrated is final: no reminder and no git for this pair from now on.
      gitCalls.length = 0;
      await passAt(48 + 20 + 60);
      await passAt(48 + 20 + 600);
      expect(digests()).toHaveLength(before);
      expect(gitCalls).toHaveLength(0);
    });

    it('sends nothing when the head is already an ancestor of dev', async () => {
      const { base } = setUpRepos();
      const wt = addWorktree('t2', base);
      const head = commit(wt, 'a.txt', 'a\n', 'feat: a');
      run(main, 'merge', '-q', '--ff-only', head);
      run(main, 'push', '-q', 'origin', 'dev');
      donePair('t2', wt, head, base);
      const result = await passAt(60);
      expect(result.integrated).toBe(1);
      expect(digests()).toHaveLength(0);
    });

    it('a cancelled pair, a pair that is not done and a dismissed pair get no reminder', async () => {
      const { base } = setUpRepos();
      const wt = addWorktree('t3', base);
      const head = commit(wt, 'b.txt', 'b\n', 'feat: b');
      donePair('t3', wt, head, base, { status: 'cancelled' });
      donePair('t3b', wt, head, base, { status: 'working' });
      donePair('t3c', wt, head, base, { integrationDismissedAt: T0 + MIN });
      const result = await passAt(60);
      expect(result.considered).toBe(0);
      expect(digests()).toHaveLength(0);
      expect(gitCalls).toHaveLength(0);
    });

    it('Brain dismisses a finished pair with DONE integration=dismiss or CANCEL: reminders stop, the pair stays done', async () => {
      const { base } = setUpRepos();
      const service = new TaskPairService();
      for (const [taskId, verb, attrs] of [['t4', 'DONE', { [TASK_PAIR_INTEGRATION_ATTR]: TASK_PAIR_INTEGRATION_DISMISS_VALUE }], ['t5', 'CANCEL', {}]] as const) {
        const wt = addWorktree(taskId, base);
        const head = commit(wt, `${taskId}.txt`, 'x\n', `feat: ${taskId}`);
        donePair(taskId, wt, head, base);
        seq += 1;
        const transition = service.applyMarker({
          project: PROJECT, writer: BRAIN, source: 'marker', eventId: `dismiss-${seq}`, now: T0 + 30 * MIN,
          marker: { verb, knownVerb: verb, taskId, attrs: { ...attrs } },
        });
        expect(transition.effect).toBe(TASK_PAIR_INTEGRATION_DISMISSED_EFFECT);
        expect(getTaskPairStore().getPair(PROJECT, taskId)!.state.status).toBe('done');
      }
      await passAt(60);
      expect(digests()).toHaveLength(0);
      // Only Brain may dismiss: an executor's DONE on a finished pair changes nothing.
      seq += 1;
      const wt = addWorktree('t6', base);
      donePair('t6', wt, commit(wt, 't6.txt', 'x\n', 'feat: t6'), base);
      const ignored = service.applyMarker({
        project: PROJECT, writer: EXEC, source: 'marker', eventId: `dismiss-${seq}`, now: T0 + 30 * MIN,
        marker: { verb: 'DONE', knownVerb: 'DONE', taskId: 't6', attrs: { [TASK_PAIR_INTEGRATION_ATTR]: TASK_PAIR_INTEGRATION_DISMISS_VALUE } },
      });
      expect(ignored.effect).not.toBe(TASK_PAIR_INTEGRATION_DISMISSED_EFFECT);
      await passAt(60);
      expect(digests()).toHaveLength(1);
    });

    it('evidence commits are never integrated and do not keep a merged pair alive', async () => {
      const { base } = setUpRepos();
      const wt = addWorktree('t7', base);
      const work = commit(wt, 'w.txt', 'w\n', 'feat: the work');
      const head = commit(wt, 'evidence.md', 'numbers\n', 'evidence: measurements');
      run(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'cherry-pick', work);
      run(main, 'push', '-q', 'origin', 'dev');
      donePair('t7', wt, head, base);
      expect((await passAt(60)).integrated).toBe(1);
      expect(digests()).toHaveLength(0);
    });

    it('one digest per Brain lists every due pair, one line each', async () => {
      const { base } = setUpRepos();
      for (const id of ['u1', 'u2', 'u3']) {
        const wt = addWorktree(id, base);
        donePair(id, wt, commit(wt, `${id}.txt`, 'x\n', `feat: ${id}`), base);
      }
      const result = await passAt(30);
      expect(result.reminded).toBe(3);
      expect(digests()).toHaveLength(1);
      const lines = digests()[0]!.text.split('\n').filter((entry) => entry.startsWith('- '));
      expect(lines).toHaveLength(3);
      for (const id of ['u1', 'u2', 'u3']) expect(digests()[0]!.text).toContain(`- ${id}:`);
    });

    it('a busy Brain (message not accepted) is retried on the next heartbeat with no state advanced', async () => {
      const { base } = setUpRepos();
      const wt = addWorktree('t8', base);
      donePair('t8', wt, commit(wt, 't8.txt', 'x\n', 'feat: t8'), base);
      setIntegrationDriftDepsForTests({
        now: () => clock,
        send: async () => 'skipped_pending',
        git: async (cwd, args, timeoutMs) => {
          try { return { ok: true, stdout: execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (error) { return { ok: false, stdout: '', exitCode: (error as { status?: number }).status }; }
        },
      });
      expect((await passAt(30)).reminded).toBe(0);
      expect(live('t8').integrationReminderCount).toBeUndefined();
    });
  });

  describe('boundaries', () => {
    it('a non-git / dir workspace, a local-repo (git_init) workspace and a pair without a workspace are skipped with no git', async () => {
      savePair('n1', { workspace: { kind: 'dir', path: join(root, 'task-dir'), createdAt: 1, endedAt: T0, status: 'ended' } as never, material: { head: 'abc1234', at: 1 } });
      mkdirSync(join(root, 'task-dir'));
      savePair('n2', { workspace: { kind: 'worktree', path: root, base: 'abc1234', nonGit: { mode: 'git_init', projectRoot: root }, lastHead: 'abc1234', createdAt: 1, endedAt: T0, status: 'ended' } as never });
      savePair('n3', {});
      const result = await passAt(60);
      expect(result).toMatchObject({ considered: 0, checked: 0, reminded: 0 });
      expect(gitCalls).toHaveLength(0);
      expect(digests()).toHaveLength(0);
    });

    it('a project with no origin uses its local dev branch and does not try to fetch', async () => {
      const bare = join(root, 'solo');
      mkdirSync(bare);
      run(bare, 'init', '-q', '-b', 'dev');
      const base = commit(bare, 'a.txt', 'a\n', 'base');
      const wt = join(root, 'wt-solo');
      run(bare, 'worktree', 'add', '-q', '-b', 'pair/solo', wt, base);
      const head = commit(wt, 'f.txt', 'f\n', 'feat: solo');
      donePair('s1', wt, head, base);
      expect((await passAt(30)).reminded).toBe(1);
      expect(gitCalls.some((call) => call.startsWith('fetch'))).toBe(false);
      run(bare, 'merge', '-q', '--ff-only', head);
      expect((await passAt(60)).integrated).toBe(1);
    });

    it('a failing fetch (origin unreachable) is logged once, never throws, and the check still runs on the ref it has', async () => {
      const { base } = setUpRepos();
      const wt = addWorktree('f1', base);
      donePair('f1', wt, commit(wt, 'f1.txt', 'x\n', 'feat: f1'), base);
      run(main, 'remote', 'set-url', 'origin', join(root, 'does-not-exist.git'));
      const loggerModule = await import('../../../src/util/logger.js');
      const warn = vi.spyOn(loggerModule.default, 'warn').mockImplementation(() => undefined as never);
      await expect(passAt(30)).resolves.toMatchObject({ reminded: 1 });
      await passAt(45);
      await passAt(200);
      const fetchWarnings = warn.mock.calls.filter((call) => String(call[1] ?? call[0]).includes('integration ref'));
      expect(fetchWarnings).toHaveLength(1);
      // Backed off: one fetch attempt inside the backoff window, not one per heartbeat.
      expect(gitCalls.filter((call) => call.startsWith('fetch')).length).toBeLessThanOrEqual(2);
    });

    it('a renamed integration branch is followed through IMCODES_PAIR_INTEGRATION_REF, and an unknown ref sends nothing', async () => {
      const { base } = setUpRepos();
      run(main, 'push', '-q', 'origin', 'dev:release');
      const wt = addWorktree('r1', base);
      const head = commit(wt, 'r.txt', 'r\n', 'feat: r');
      donePair('r1', wt, head, base);
      process.env[TASK_PAIR_INTEGRATION_REF_ENV] = 'origin/release';
      expect((await passAt(30)).reminded).toBe(1);
      expect(digests()[0]!.text).toContain('origin/release');
      setIntegrationDriftDepsForTests({ now: () => clock, send: async (target, taskId, reason, text) => { sent.push({ target, taskId, reason, text }); return 'sent'; } });
      process.env[TASK_PAIR_INTEGRATION_REF_ENV] = 'origin/nonexistent';
      sent = [];
      await passAt(300);
      expect(digests()).toHaveLength(0);
    });

    it('a project whose integration branch is main (no dev anywhere) falls back to origin/main', async () => {
      origin = join(root, 'origin-main.git');
      main = join(root, 'main-main');
      mkdirSync(origin);
      run(origin, 'init', '-q', '--bare', '-b', 'main');
      run(root, 'clone', '-q', origin, main);
      run(main, 'checkout', '-q', '-b', 'main');
      const base = commit(main, 'README.md', 'base\n', 'base');
      run(main, 'push', '-q', 'origin', 'main');
      const wt = addWorktree('m1', base);
      const head = commit(wt, 'm.txt', 'm\n', 'feat: m');
      donePair('m1', wt, head, base);
      expect((await passAt(30)).reminded).toBe(1);
      expect(digests()[0]!.text).toContain('origin/main');
      run(main, 'merge', '-q', '--ff-only', head);
      run(main, 'push', '-q', 'origin', 'main');
      expect((await passAt(60)).integrated).toBe(1);
    });

    it('only pairs that ended within the last 7 days are considered, and at most the cap are tracked per pass', async () => {
      const { base } = setUpRepos();
      const wt = addWorktree('w1', base);
      const head = commit(wt, 'w.txt', 'w\n', 'feat: w');
      for (let i = 0; i < 12; i += 1) {
        donePair(`old${i}`, wt, head, base, { updatedAt: T0 - 8 * 24 * 60 * MIN, workspace: { kind: 'worktree', path: wt, base, lastHead: head, createdAt: 1, endedAt: T0 - 8 * 24 * 60 * MIN, status: 'ended' } as never });
      }
      for (let i = 0; i < TASK_PAIR_INTEGRATION_REMINDER_MAX_PAIRS + 10; i += 1) donePair(`new${i}`, wt, head, base, { updatedAt: T0 - i });
      const result = await passAt(60);
      expect(result.considered).toBe(TASK_PAIR_INTEGRATION_REMINDER_MAX_PAIRS);
      expect(digests()[0]!.text).not.toContain('old0');
      expect(digests()[0]!.text.split('\n').filter((entry) => entry.startsWith('- ')).length).toBeLessThanOrEqual(TASK_PAIR_INTEGRATION_REMINDER_MAX_PAIRS);
      expect(TASK_PAIR_INTEGRATION_REMINDER_WINDOW_MS).toBe(7 * 24 * 60 * MIN);
    });

    it('a daemon restart neither repeats a burst nor restarts the grace (reminder state is persisted)', async () => {
      const { base } = setUpRepos();
      const dir = mkdtempSync(join(tmpdir(), 'imc-drift-db-'));
      const file = join(dir, 'task-pairs.sqlite');
      try {
        setTaskPairStoreForTests(new TaskPairStore(file));
        const wt = addWorktree('p1', base);
        donePair('p1', wt, commit(wt, 'p1.txt', 'x\n', 'feat: p1'), base);
        await passAt(30);
        expect(digests()).toHaveLength(1);
        setTaskPairStoreForTests(new TaskPairStore(file));
        await passAt(31);
        await passAt(35);
        expect(digests()).toHaveLength(1);
        await passAt(41);
        expect(digests()).toHaveLength(2);
      } finally {
        setTaskPairStoreForTests(undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a huge repository: git that runs out of time answers unknown, nothing is claimed, and the answer is remembered', async () => {
      const { base } = setUpRepos();
      const wt = addWorktree('h1', base);
      donePair('h1', wt, commit(wt, 'h.txt', 'x\n', 'feat: h'), base);
      setIntegrationDriftDepsForTests({
        now: () => clock,
        send: async (target, taskId, reason, text) => { sent.push({ target, taskId, reason, text }); return 'sent'; },
        git: async (_cwd, args) => { gitCalls.push(args.join(' ')); return { ok: false, stdout: '' }; },
      });
      const result = await passAt(30);
      expect(result.reminded).toBe(0);
      const callsAfterFirst = gitCalls.length;
      await passAt(31);
      await passAt(40);
      // Not one extra git call per heartbeat beyond the bounded probes of the first pass.
      expect(gitCalls.length).toBeLessThanOrEqual(callsAfterFirst * 3);
      expect(digests()).toHaveLength(0);
    });
  });

  describe('stale-base warning', () => {
    const staleFixture = async (behind: number, taskId: string) => {
      const { base } = setUpRepos();
      const wt = addWorktree(taskId, base);
      const head = commit(wt, `${taskId}.txt`, 'x\n', `feat: ${taskId}`);
      emptyCommits(main, behind);
      run(main, 'push', '-q', 'origin', 'dev');
      savePair(taskId, {
        status: 'in_audit', material: { worktree: wt, head, base, at: T0 },
        workspace: { kind: 'worktree', path: wt, base, lastHead: head, createdAt: 1, status: 'active' } as never,
      });
      return { wt, head };
    };
    const staleNotices = () => sent.filter((entry) => entry.reason === 'stale-base' || entry.reason === 'brain-stale-base');

    it('READY on a base more than N commits behind: one notice to the executor and one to Brain; the same head again: none', async () => {
      const { head } = await staleFixture(TASK_PAIR_STALE_BASE_MAX_COMMITS + 5, 'st1');
      await checkStaleBaseNotice(PROJECT, 'st1', 'ready');
      expect(staleNotices().map((entry) => entry.target).sort()).toEqual([BRAIN, EXEC].sort());
      const executorText = staleNotices().find((entry) => entry.target === EXEC)!.text;
      expect(executorText).toContain('Rebase');
      expect(executorText).toContain(head.slice(0, 12));
      expect(executorText).toContain(String(TASK_PAIR_STALE_BASE_MAX_COMMITS + 5));
      sent = [];
      await checkStaleBaseNotice(PROJECT, 'st1', 'ready');
      expect(staleNotices()).toHaveLength(0);
      // PASS on the same head is its own stage: told once more, then never again.
      await checkStaleBaseNotice(PROJECT, 'st1', 'pass');
      expect(staleNotices()).toHaveLength(2);
      sent = [];
      await checkStaleBaseNotice(PROJECT, 'st1', 'pass');
      expect(staleNotices()).toHaveLength(0);
    });

    it('within N commits: no notice, and a warning is never a gate (nothing about the pair changes)', async () => {
      await staleFixture(TASK_PAIR_STALE_BASE_MAX_COMMITS - 10, 'st2');
      const before = getTaskPairStore().getPair(PROJECT, 'st2')!.state;
      await checkStaleBaseNotice(PROJECT, 'st2', 'ready');
      expect(staleNotices()).toHaveLength(0);
      expect(getTaskPairStore().getPair(PROJECT, 'st2')!.state).toEqual(before);
    });

    it('the READY marker itself triggers it (in the background) and the audit still opens', async () => {
      const { wt, head } = await staleFixture(TASK_PAIR_STALE_BASE_MAX_COMMITS + 3, 'st3');
      savePair('st3', { status: 'working', workspace: { kind: 'worktree', path: wt, base: run(wt, 'rev-parse', 'HEAD~1'), lastHead: head, createdAt: 1, status: 'active' } as never });
      const service = new TaskPairService();
      const transition = service.applyMarker({
        project: PROJECT, writer: EXEC, source: 'marker', eventId: 'ready-st3', now: T0,
        marker: { verb: 'READY_FOR_AUDIT', knownVerb: 'READY_FOR_AUDIT', taskId: 'st3', attrs: { worktree: wt, head } },
      });
      expect(transition.toStatus).toBe('in_audit');
      await vi.waitFor(() => expect(staleNotices().length).toBeGreaterThanOrEqual(2));
      expect(getTaskPairStore().getPair(PROJECT, 'st3')!.state.status).toBe('in_audit');
    });

    it('a non-git workspace or a missing worktree makes no notice and no git call', async () => {
      savePair('st4', { status: 'in_audit', material: { path: root, head: 'abc1234', at: T0 }, workspace: { kind: 'dir', path: root, createdAt: 1, status: 'active' } as never });
      await checkStaleBaseNotice(PROJECT, 'st4', 'ready');
      savePair('st5', { status: 'in_audit', material: { worktree: join(root, 'gone'), head: 'abc1234', at: T0 }, workspace: { kind: 'worktree', path: join(root, 'gone'), createdAt: 1, status: 'active' } as never });
      await checkStaleBaseNotice(PROJECT, 'st5', 'ready');
      expect(staleNotices()).toHaveLength(0);
      expect(gitCalls).toHaveLength(0);
    });
  });
});
