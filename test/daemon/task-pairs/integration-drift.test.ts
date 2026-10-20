/**
 * Integration drift (tsk_cd_pair_integration_drift): a finished pair whose head never reached the integration branch is reminded
 * to Brain, and a head on a base far behind that branch draws a rebase warning. Everything here runs real git (a bare origin, a
 * clone, pair worktrees, cherry-picks) in temp directories; only the delivery of messages and the clock are injected.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { listTaskPairBranchRefs, listTaskPairCommitsNotInAnyBranch, listTaskPairCommitsNotInIntegration } from '../../../src/daemon/supervision-worktree-gc.js';
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

/**
 * Every git this file runs (its own fixtures AND the product's, which inherit process.env) uses this config: no automatic gc / maintenance,
 * and nothing detached. A commit or fetch that trips `gc --auto` otherwise leaves a background git writing into .git/objects after the test
 * body is done, and the afterEach rmSync races it (CI: ENOTEMPTY on .../main/.git/objects, Node 22 job).
 */
const GIT_TEST_CONFIG = '[gc]\n\tauto = 0\n\tautoDetach = false\n[maintenance]\n\tauto = false\n[receive]\n\tautogc = false\n';
const GIT_ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
const isFetch = (args: string): boolean => args.split(' ').includes('fetch');
const removeTree = (path: string): void => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
const services: TaskPairService[] = [];
const newService = (): TaskPairService => { const service = new TaskPairService(); services.push(service); return service; };

let root: string;
let origin: string;
let main: string;
let sent: Array<{ target: string; taskId: string; reason: string; text: string }>;
let gitCalls: string[];
let gitOptions: Array<{ args: string; env?: Record<string, string> }>;
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
  const previousSshCommand = process.env.GIT_SSH_COMMAND;
  const previousGitEnv = Object.fromEntries(GIT_ENV_KEYS.map((key) => [key, process.env[key]]));
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'imc-drift-'));
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    delete process.env[TASK_PAIR_INTEGRATION_REF_ENV];
    delete process.env.GIT_SSH_COMMAND;
    writeFileSync(join(root, 'test-gitconfig'), GIT_TEST_CONFIG);
    process.env.GIT_CONFIG_GLOBAL = join(root, 'test-gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    sent = [];
    gitCalls = [];
    gitOptions = [];
    seq = 0;
    clock = T0;
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, taskId: 'n/a', reason: id.split(':')[1] === '__integration__' ? TASK_PAIR_INTEGRATION_DIGEST_REASON : id, text }); } });
    setIntegrationDriftDepsForTests({
      now: () => clock,
      send: async (target, taskId, reason, text) => { sent.push({ target, taskId, reason, text }); return 'sent'; },
      git: async (cwd, args, timeoutMs, options) => {
        gitCalls.push(args.join(' '));
        gitOptions.push({ args: args.join(' '), ...(options?.env ? { env: options.env } : {}) });
        try {
          return { ok: true, stdout: execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: options?.maxBuffer ?? 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'test-gitconfig'), ...(options?.env ?? {}) } }) };
        } catch (error) {
          return { ok: false, stdout: '', exitCode: (error as { status?: number }).status };
        }
      },
    });
    upsertSession(session(BRAIN, 'brain'));
    upsertSession(session(EXEC, 'w1'));
    upsertSession(session(AUD, 'w2'));
  });
  afterEach(async () => {
    // Background work the service started from a marker (stale-base check, workspace head refresh) is finished before anything is removed.
    await Promise.all(services.splice(0).map((service) => service.waitForIdle()));
    setIntegrationDriftDepsForTests(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, EXEC, AUD]) removeSession(name);
    removeTree(root);
    for (const key of GIT_ENV_KEYS) {
      if (previousGitEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousGitEnv[key];
    }
    delete process.env[TASK_PAIR_INTEGRATION_REF_ENV];
    if (previousSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = previousSshCommand;
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

    // Brain cherry-picks onto a dev that has moved: the hunk context differs, so the patch-id differs, and `git cherry` (the strict
    // rule the worktree retention keeps) says "not merged" for a commit that IS in dev (audit: 21 of 44 flagged pairs were such).
    const moveContext = (): string => {
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
      return lines;
    };
    const setUpMovedContext = (subject: string): { wt: string; head: string; base: string } => {
      const { base: root0 } = setUpRepos();
      commit(main, 'shared.txt', moveContext(), 'chore: add shared file');
      run(main, 'push', '-q', 'origin', 'dev');
      const base = run(main, 'rev-parse', 'HEAD');
      expect(root0).not.toBe(base);
      const wt = addWorktree('mc', base);
      const head = commit(wt, 'shared.txt', moveContext().replace('line 15\n', 'line 15 changed by the pair\n'), subject);
      // dev meanwhile changes lines right next to the pair's hunk, then Brain cherry-picks the pair commit (3-way merge).
      commit(main, 'shared.txt', moveContext().replace('line 13\n', 'line 13 changed on dev\n'), 'fix: an unrelated change on dev');
      run(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'cherry-pick', ...(subject.startsWith('X') ? ['-x'] : []), head);
      run(main, 'push', '-q', 'origin', 'dev');
      return { wt, head, base };
    };

    it('a cherry-pick whose patch-id changed (dev moved the hunk context) is integrated: same subject in dev, no reminder', async () => {
      const { wt, head, base } = setUpMovedContext('feat: the pair change to the shared file');
      // The counterexample: the strict patch-id rule still says the commit is missing.
      expect(run(main, 'cherry', 'origin/dev', head)).toMatch(/^\+ /u);
      expect(await listTaskPairCommitsNotInIntegration(wt, base, { integrationRef: 'origin/dev', head })).toEqual([head]);
      donePair('mc', wt, head, base);
      const result = await passAt(30);
      expect(result.integrated).toBe(1);
      expect(digests()).toHaveLength(0);
      expect(live('mc').integrationIntegratedAt).toBeDefined();
    });

    it('a cherry-pick -x whose subject was edited is recognised by its "(cherry picked from commit ...)" line', async () => {
      const { wt, head, base } = setUpMovedContext('X feat: original subject');
      run(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--amend', '-m', `fix: reworded on dev\n\n(cherry picked from commit ${head})`);
      run(main, 'push', '-q', '--force', 'origin', 'dev');
      donePair('mcx', wt, head, base);
      expect((await passAt(30)).integrated).toBe(1);
      expect(digests()).toHaveLength(0);
    });

    it('a commit whose subject is NOT in dev stays unintegrated even though dev moved past it', async () => {
      const { wt, head, base } = setUpMovedContext('feat: merged one');
      const extra = commit(wt, 'extra.txt', 'x\n', 'feat: never merged extra work');
      donePair('mc2', wt, extra, base);
      const result = await passAt(30);
      expect(result.reminded).toBe(1);
      expect(digests()[0]!.text).toContain('1 commit not found on any branch of this repository');
      expect(head).not.toBe(extra);
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
      const service = newService();
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
      expect(gitCalls.some((call) => isFetch(call))).toBe(false);
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
      expect(gitCalls.filter((call) => isFetch(call)).length).toBeLessThanOrEqual(2);
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

    it('the fetch never prompts (no terminal, ssh BatchMode) and lands in a private ref, leaving the owner\'s origin/dev alone', async () => {
      const { base } = setUpRepos();
      const wt = addWorktree('pf', base);
      const head = commit(wt, 'pf.txt', 'x\n', 'feat: pf');
      // Brain merges and pushes from elsewhere: origin has the head, this checkout's own origin/dev is stale.
      run(main, 'push', '-q', 'origin', `${head}:refs/heads/dev`);
      run(main, 'update-ref', 'refs/remotes/origin/dev', base);
      donePair('pf', wt, head, base);
      const result = await passAt(30);
      expect(result.integrated).toBe(1);
      expect(digests()).toHaveLength(0);
      expect(run(main, 'rev-parse', 'origin/dev')).toBe(base);
      expect(run(main, 'rev-parse', 'refs/imcodes/integration/dev')).toBe(head);
      const fetch = gitOptions.find((call) => isFetch(call.args))!;
      expect(fetch.args).toContain('+refs/heads/dev:refs/imcodes/integration/dev');
      // The daemon's fetch never starts a detached gc / maintenance in the user's repository.
      expect(fetch.args).toContain('-c gc.auto=0 -c maintenance.auto=false -c gc.autoDetach=false');
      expect(fetch.env?.GIT_TERMINAL_PROMPT).toBe('0');
      expect(fetch.env?.GIT_SSH_COMMAND).toContain('BatchMode=yes');
    });

    describe('the fetch leaves the user\'s ssh command alone', () => {
      /** An "ssh" that records that git ran it, then fails like an unreachable host. */
      const fakeSsh = (name: string): { script: string; marker: string } => {
        const marker = join(root, `${name}.ran`);
        const script = join(root, `${name}.sh`);
        writeFileSync(script, `#!/bin/sh\necho "ran $@" >> "${marker}"\nexit 255\n`, { mode: 0o755 });
        return { script, marker };
      };
      const sshRemote = (base: string, id: string): string => {
        run(main, 'remote', 'set-url', 'origin', 'git@fake.invalid:org/repo.git');
        const wt = addWorktree(id, base);
        donePair(id, wt, commit(wt, `${id}.txt`, 'x\n', `feat: ${id}`), base);
        return wt;
      };
      const fetchCalls = () => gitOptions.filter((call) => isFetch(call.args));

      it('a repo with core.sshCommand keeps it: no GIT_SSH_COMMAND is set, and git really runs the user\'s command', async () => {
        const { base } = setUpRepos();
        const { script, marker } = fakeSsh('config');
        run(main, 'config', 'core.sshCommand', script);
        sshRemote(base, 'sc1');
        const loggerModule = await import('../../../src/util/logger.js');
        vi.spyOn(loggerModule.default, 'warn').mockImplementation(() => undefined as never);
        await passAt(30);
        expect(fetchCalls()).toHaveLength(1);
        expect(fetchCalls()[0]!.env).toEqual({ GIT_TERMINAL_PROMPT: '0' });
        // The proof that matters: had the daemon forced GIT_SSH_COMMAND, git would never have run the configured command.
        expect(readFileSync(marker, 'utf8')).toContain('ran');
      });

      it('a GIT_SSH_COMMAND already in the environment is left untouched too', async () => {
        const { base } = setUpRepos();
        const { script, marker } = fakeSsh('envvar');
        process.env.GIT_SSH_COMMAND = script;
        sshRemote(base, 'sc2');
        const loggerModule = await import('../../../src/util/logger.js');
        vi.spyOn(loggerModule.default, 'warn').mockImplementation(() => undefined as never);
        await passAt(30);
        expect(fetchCalls()[0]!.env).toEqual({ GIT_TERMINAL_PROMPT: '0' });
        expect(readFileSync(marker, 'utf8')).toContain('ran');
      });

      it('without either, the fetch cannot prompt: GIT_TERMINAL_PROMPT=0 and ssh BatchMode (as before)', async () => {
        const { base } = setUpRepos();
        const wt = addWorktree('sc3', base);
        donePair('sc3', wt, commit(wt, 'sc3.txt', 'x\n', 'feat: sc3'), base);
        await passAt(30);
        expect(fetchCalls()[0]!.env).toEqual({ GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' });
      });

      it('reads core.sshCommand once per repository, however many fetches follow', async () => {
        const { base } = setUpRepos();
        const wt = addWorktree('sc4', base);
        donePair('sc4', wt, commit(wt, 'sc4.txt', 'x\n', 'feat: sc4'), base);
        await passAt(30);
        await passAt(45);
        await passAt(70);
        expect(fetchCalls().length).toBeGreaterThanOrEqual(2);
        expect(gitCalls.filter((call) => call === 'config --get core.sshCommand')).toHaveLength(1);
      });
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
        removeTree(dir);
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

  describe('merged anywhere in the repository (not only the integration branch)', () => {
    const remind = async () => (await passAt(30)).reminded;
    const setUp = (name: string, subject = `feat: ${name}`) => {
      const { base } = setUpRepos();
      const wt = addWorktree(name, base);
      const head = commit(wt, `${name}.txt`, `${name}\n`, subject);
      donePair(name, wt, head, base);
      return { base, wt, head };
    };

    it('a head that only a branch outside the candidate list (feat/zjq) has is merged: no reminder (this is the 158 jdzs case)', async () => {
      const { head } = setUp('a1');
      run(main, 'branch', 'feat/zjq', head);
      const result = await passAt(30);
      expect(result.integrated).toBe(1);
      expect(digests()).toHaveLength(0);
      expect(live('a1').integrationIntegratedAt).toBeDefined();
    });

    it('the branch the main checkout is on counts, whatever its name (ff merge, then a cherry-pick whose patch-id differs)', async () => {
      const { base, head } = setUp('a2');
      run(main, 'checkout', '-q', '-b', 'work/current');
      run(main, 'merge', '-q', '--ff-only', head);
      expect((await passAt(30)).integrated).toBe(1);
      // a second pair, cherry-picked onto the checked-out branch with a reworded subject and a changed context
      const wt = addWorktree('a2b', base);
      const second = commit(wt, 'a2b.txt', 'a2b\n', 'feat: a2b original subject');
      donePair('a2b', wt, second, base);
      run(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'cherry-pick', '-x', second);
      expect((await passAt(31)).integrated).toBe(1);
      expect(digests()).toHaveLength(0);
    });

    it('a branch that exists only on the remote (origin/release/1, never checked out locally) counts', async () => {
      const { head } = setUp('a3');
      run(main, 'push', '-q', 'origin', `${head}:refs/heads/release/1`);
      run(main, 'fetch', '-q', 'origin');
      expect(run(main, 'branch', '-a', '--list', 'origin/release/1')).toContain('origin/release/1');
      expect((await passAt(30)).integrated).toBe(1);
      expect(digests()).toHaveLength(0);
    });

    it('a cherry-pick (same patch, new SHA; also the -x and same-subject forms) into a non-candidate branch counts', async () => {
      const { base, head } = setUp('a4');
      run(main, 'checkout', '-q', '-b', 'feat/zjq', 'origin/dev');
      commit(main, 'zjq-only.txt', 'z\n', 'chore: only on feat/zjq');
      run(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'cherry-pick', head);
      run(main, 'checkout', '-q', 'dev');
      expect(run(main, 'rev-parse', 'feat/zjq')).not.toBe(head);
      expect(run(main, 'branch', '--contains', head, '--list', 'feat/zjq')).toBe('');
      expect((await passAt(30)).integrated).toBe(1);
      expect(base).toBeTruthy();
      expect(digests()).toHaveLength(0);
    });

    it('a head that is on no branch at all is still reminded, naming what was checked and not hard-coding dev; the pair\'s own branch and a backup branch named after the task do not count', async () => {
      const { head } = setUp('a5');
      run(main, 'branch', 'backup/a5-copy', head);
      for (let i = 0; i < 8; i += 1) run(main, 'branch', `other/${i}`, 'origin/dev');
      expect(await remind()).toBe(1);
      const text = digests()[0]!.text;
      expect(text).toContain('not found on any branch of this repository');
      expect(text).toContain('origin/dev');
      expect(text).not.toContain('push dev');
      expect(text).not.toContain('not yet merged into origin/dev');
      expect(text).toContain(`${TASK_PAIR_INTEGRATION_ATTR}=${TASK_PAIR_INTEGRATION_DISMISS_VALUE}`);
    });

    it('a pair that only has evidence: commits left is merged (and stays so with other branches around)', async () => {
      const { base } = setUpRepos();
      const wt = addWorktree('a6', base);
      const work = commit(wt, 'w.txt', 'w\n', 'feat: a6 work');
      const head = commit(wt, 'e.md', 'numbers\n', 'evidence: a6 measurements');
      run(main, 'branch', 'feat/zjq', work);
      donePair('a6', wt, head, base);
      expect((await passAt(30)).integrated).toBe(1);
      expect(digests()).toHaveLength(0);
    });

    it('a repository with no remote and no dev/main/master: merged into whichever branch the owner works on is merged, otherwise reminded', async () => {
      const solo = join(root, 'solo2');
      mkdirSync(solo);
      run(solo, 'init', '-q', '-b', 'trunk');
      const base = commit(solo, 'a.txt', 'a\n', 'base');
      const wt = join(root, 'wt-solo2');
      run(solo, 'worktree', 'add', '-q', '-b', 'pair/solo2', wt, base);
      const head = commit(wt, 'f.txt', 'f\n', 'feat: solo2');
      donePair('s2', wt, head, base);
      expect((await passAt(30)).reminded).toBe(1);
      expect(gitCalls.some((call) => isFetch(call))).toBe(false);
      run(solo, 'merge', '-q', '--ff-only', head);
      expect((await passAt(60)).integrated).toBe(1);
    });

    it('a shallow clone that lacks the base, or git that cannot list the branches, answers unknown: no reminder, no crash', async () => {
      const { base } = setUpRepos();
      const shallow = join(root, 'shallow');
      run(root, 'clone', '-q', '--depth', '1', `file://${origin}`, shallow);
      const wt = join(root, 'wt-shallow');
      run(shallow, 'worktree', 'add', '-q', '-b', 'pair/shallow', wt, 'HEAD');
      const head = commit(wt, 's.txt', 's\n', 'feat: shallow');
      donePair('sh1', wt, head, 'f'.repeat(40));
      expect((await passAt(30)).reminded).toBe(0);
      // and when for-each-ref itself fails for the (otherwise fine) repository
      const wt2 = addWorktree('a7b', base);
      donePair('sh2', wt2, commit(wt2, 'b.txt', 'b\n', 'feat: b'), base);
      setIntegrationDriftDepsForTests({
        now: () => clock,
        send: async (target, taskId, reason, text) => { sent.push({ target, taskId, reason, text }); return 'sent'; },
        git: async (cwd, args, timeoutMs) => {
          if (args[0] === 'for-each-ref') return { ok: false, stdout: '', exitCode: 128 };
          try { return { ok: true, stdout: execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (error) { return { ok: false, stdout: '', exitCode: (error as { status?: number }).status }; }
        },
      });
      const result = await passAt(45);
      expect(result.reminded).toBe(0);
      expect(digests()).toHaveLength(0);
    });

    it('branch names with spaces-free special characters (#, @, unicode, nested slashes) are read and matched', async () => {
      const { head } = setUp('a8');
      run(main, 'branch', 'feat/ünï#cödé@1/x', head);
      expect((await passAt(30)).integrated).toBe(1);
      const refs = await listTaskPairBranchRefs(main);
      expect(refs?.some((entry) => entry.ref === 'refs/heads/feat/ünï#cödé@1/x')).toBe(true);
    });

    it('a repository with 200 branches costs a bounded number of git calls for one check (and none per heartbeat after it)', async () => {
      const { base, head } = setUp('a9');
      const stream: string[] = [];
      for (let i = 0; i < 200; i += 1) {
        stream.push(`commit refs/heads/bulk/${i}`, `committer t <t@t> ${1_700_000_000 + i} +0000`, `data ${`b${i}`.length}`, `b${i}`, `from ${base}`, '');
      }
      execFileSync('git', ['fast-import', '--quiet'], { cwd: main, input: `${stream.join('\n')}\n` });
      expect(run(main, 'for-each-ref', 'refs/heads/bulk').split('\n')).toHaveLength(200);
      gitCalls.length = 0;
      const started = Date.now();
      expect((await passAt(30)).reminded).toBe(1);
      const elapsed = Date.now() - started;
      expect(gitCalls.length).toBeLessThanOrEqual(40);
      expect(elapsed).toBeLessThan(15_000);
      const callsFirst = gitCalls.length;
      await passAt(31);
      expect(gitCalls.length).toBe(callsFirst); // not due again: no git at all
      expect(head).toBeTruthy();
    });

    it('the worktree GC answers the same question: a head on a branch is "not missing" from one git call, no per-branch cherry', async () => {
      const { base, wt, head } = setUp('b1');
      run(main, 'branch', 'feat/zjq', head);
      expect(await listTaskPairCommitsNotInAnyBranch(wt, base, { head })).toEqual([]);
      const other = commit(wt, 'b1b.txt', 'x\n', 'feat: never merged b1b');
      // the pair's own branch pair/b1 still holds it for the GC (nothing is lost), which is exactly what the reminder must NOT count
      expect(await listTaskPairCommitsNotInAnyBranch(wt, base, { head: other })).toEqual([]);
      donePair('b1', wt, other, base);
      expect(await remind()).toBe(1);
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
      const service = newService();
      const transition = service.applyMarker({
        project: PROJECT, writer: EXEC, source: 'marker', eventId: 'ready-st3', now: T0,
        marker: { verb: 'READY_FOR_AUDIT', knownVerb: 'READY_FOR_AUDIT', taskId: 'st3', attrs: { worktree: wt, head } },
      });
      expect(transition.toStatus).toBe('in_audit');
      await vi.waitFor(() => expect(staleNotices().length).toBeGreaterThanOrEqual(2));
      expect(getTaskPairStore().getPair(PROJECT, 'st3')!.state.status).toBe('in_audit');
    });

    describe('overlap: dev changed files the pair changed too (however few commits behind)', () => {
      const writeFiles = (cwd: string, files: Record<string, string>): void => {
        for (const [name, content] of Object.entries(files)) {
          mkdirSync(join(cwd, name, '..'), { recursive: true });
          writeFileSync(join(cwd, name), content);
        }
      };
      const commitFiles = (cwd: string, files: Record<string, string>, subject: string): string => {
        writeFiles(cwd, files);
        run(cwd, 'add', '-A');
        run(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', subject);
        return run(cwd, 'rev-parse', 'HEAD');
      };
      /** A base with the given files on dev, then a pair worktree cut from it. */
      const fixture = (taskId: string, baseFiles: Record<string, string>): { wt: string; base: string } => {
        setUpRepos();
        const base = commitFiles(main, baseFiles, 'chore: base files');
        run(main, 'push', '-q', 'origin', 'dev');
        return { wt: addWorktree(taskId, base), base };
      };
      const openAudit = (taskId: string, wt: string, base: string, head: string): void => savePair(taskId, {
        status: 'in_audit', material: { worktree: wt, head, base, at: T0 },
        workspace: { kind: 'worktree', path: wt, base, lastHead: head, createdAt: 1, status: 'active' } as never,
      });
      const pushDev = (): void => { run(main, 'push', '-q', 'origin', 'dev'); };
      const notices = () => sent.filter((entry) => entry.reason === 'stale-base' || entry.reason === 'brain-stale-base');
      const toExecutor = () => notices().filter((entry) => entry.target === EXEC);

      it('lists the overlapping files with the dev commit subjects, once; no overlap, no notice; a repeat READY on the same head and tip: none', async () => {
        const { wt, base } = fixture('ov1', { 'shared.txt': 'a\n', 'other.txt': 'a\n', 'pair-only.txt': 'a\n' });
        const head = commitFiles(wt, { 'shared.txt': 'pair\n', 'pair-only.txt': 'pair\n' }, 'feat: the pair change');
        openAudit('ov1', wt, base, head);
        // dev (5 commits, far below 50) changes a file the pair did NOT touch first: no overlap, no notice.
        commitFiles(main, { 'other.txt': 'dev\n' }, 'chore: dev touches another file');
        pushDev();
        await checkStaleBaseNotice(PROJECT, 'ov1', 'ready');
        expect(notices()).toHaveLength(0);
        // Now dev touches the shared file too.
        clock = T0 + 10 * MIN;
        commitFiles(main, { 'shared.txt': 'dev\n' }, 'fix: dev changes the shared file');
        pushDev();
        await checkStaleBaseNotice(PROJECT, 'ov1', 'ready');
        expect(notices().map((entry) => entry.target).sort()).toEqual([BRAIN, EXEC].sort());
        const text = toExecutor()[0]!.text;
        expect(text).toContain('changed 1 of the files');
        expect(text).toContain('shared.txt');
        expect(text).toContain('"fix: dev changes the shared file"');
        expect(text).not.toContain('pair-only.txt');
        expect(text).toContain('before audit');
        expect(text).toContain(head.slice(0, 12));
        // Same head, same tip: READY again and PASS both say nothing more.
        sent = [];
        await checkStaleBaseNotice(PROJECT, 'ov1', 'ready');
        await checkStaleBaseNotice(PROJECT, 'ov1', 'pass');
        expect(notices()).toHaveLength(0);
        // dev moves on to the same file again: a new tip, new information, told again (at PASS: before the final round).
        clock = T0 + 20 * MIN;
        commitFiles(main, { 'shared.txt': 'dev2\n' }, 'fix: dev changes the shared file again');
        pushDev();
        await checkStaleBaseNotice(PROJECT, 'ov1', 'pass');
        expect(toExecutor()).toHaveLength(1);
        expect(toExecutor()[0]!.text).toContain('before the final round');
        expect(toExecutor()[0]!.text).toContain('"fix: dev changes the shared file again"');
      });

      it('a file deleted in dev, a file renamed in dev and a file the pair renamed are all handled and listed', async () => {
        const { wt, base } = fixture('ov2', { 'deleted.txt': 'a\n', 'renamed-old.txt': 'a\n', 'pair-renames.txt': 'a\n', 'untouched.txt': 'a\n' });
        commitFiles(wt, { 'deleted.txt': 'pair\n', 'renamed-old.txt': 'pair\n' }, 'feat: edits two files');
        run(wt, 'mv', 'pair-renames.txt', 'pair-renamed.txt');
        const head = commitFiles(wt, {}, 'refactor: rename a file');
        openAudit('ov2', wt, base, head);
        run(main, 'rm', '-q', 'deleted.txt');
        run(main, 'mv', 'renamed-old.txt', 'renamed-new.txt');
        commitFiles(main, { 'pair-renames.txt': 'dev edit\n' }, 'fix: dev edits and deletes');
        pushDev();
        await expect(checkStaleBaseNotice(PROJECT, 'ov2', 'ready')).resolves.toBeUndefined();
        const text = toExecutor()[0]!.text;
        expect(text).toContain('deleted.txt [deleted in origin/dev]');
        expect(text).toContain('renamed-old.txt [deleted in origin/dev]');
        expect(text).toContain('pair-renames.txt');
        expect(text).not.toContain('untouched.txt');
      });

      describe('the pair\'s own earlier rounds, cherry-picked into dev, are not "dev changed your files"', () => {
        const cherryPick = (sha: string, ...extra: string[]): void => { run(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'cherry-pick', ...extra, sha); };
        const reword = (subject: string, trailer?: string): void => { run(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--amend', '-m', trailer ? `${subject}\n\n${trailer}` : subject); };
        /** Round 1 merged into dev (after an unrelated dev commit, so the SHA differs); the pair then continues on the same branch. */
        const twoRounds = (taskId: string, merge: (round1: string) => void): { wt: string; base: string; round1: string; round2: string } => {
          const { wt, base } = fixture(taskId, { 'shared.txt': 'a\n', 'other.txt': 'a\n' });
          const round1 = commitFiles(wt, { 'shared.txt': 'round 1\n' }, 'feat: round 1 change');
          commitFiles(main, { 'other.txt': 'dev\n' }, 'chore: unrelated dev commit');
          merge(round1);
          pushDev();
          const round2 = commitFiles(wt, { 'shared.txt': 'round 2\n' }, 'feat: round 2 change');
          openAudit(taskId, wt, base, round2);
          return { wt, base, round1, round2 };
        };

        it('round 1 cherry-picked (a different SHA), round 2 READY on the old branch: no notice from round 1\'s own commit', async () => {
          twoRounds('own1', (round1) => cherryPick(round1));
          await checkStaleBaseNotice(PROJECT, 'own1', 'ready');
          expect(notices()).toHaveLength(0);
        });

        it('recognised by patch-id alone (Brain reworded the subject, no trailer)', async () => {
          twoRounds('own2', (round1) => { cherryPick(round1); reword('fix: reworded by Brain'); });
          await checkStaleBaseNotice(PROJECT, 'own2', 'ready');
          expect(notices()).toHaveLength(0);
        });

        it('recognised by the -x trailer alone (Brain edited the resolution, so the patch-id differs, and reworded the subject)', async () => {
          const { round1 } = twoRounds('own3', (round1Sha) => {
            cherryPick(round1Sha, '-x', '--no-commit');
            writeFileSync(join(main, 'brain-resolution.txt'), 'a line Brain added while resolving\n');
            run(main, 'add', '-A');
            run(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `fix: a completely different subject\n\n(cherry picked from commit ${round1Sha})`);
          });
          // Neither patch-id nor subject would have recognised it.
          expect(run(main, 'cherry', 'origin/dev', round1)).toMatch(/^\+ /u);
          await checkStaleBaseNotice(PROJECT, 'own3', 'ready');
          expect(notices()).toHaveLength(0);
        });

        it('a FOREIGN dev change to the same file still gives one notice, naming only the foreign commit', async () => {
          twoRounds('own4', (round1) => { cherryPick(round1); commitFiles(main, { 'shared.txt': 'round 1\nforeign\n' }, 'fix: someone else edits the shared file'); });
          await checkStaleBaseNotice(PROJECT, 'own4', 'ready');
          expect(toExecutor()).toHaveLength(1);
          const text = toExecutor()[0]!.text;
          expect(text).toContain('changed 1 of the files');
          expect(text).toContain('shared.txt');
          expect(text).toContain('"fix: someone else edits the shared file"');
          expect(text).not.toContain('round 1 change');
          expect(notices().filter((entry) => entry.target === BRAIN)).toHaveLength(1);
        });

        it('if git cannot say which dev commits are the pair\'s own by patch-id, nothing is hidden (the commit stays listed)', async () => {
          twoRounds('own5', (round1) => { cherryPick(round1); reword('fix: reworded by Brain'); });
          setIntegrationDriftDepsForTests({
            now: () => clock,
            send: async (target, taskId, reason, text) => { sent.push({ target, taskId, reason, text }); return 'sent'; },
            git: async (cwd, args, timeoutMs, options) => {
              if (args[0] === 'cherry') return { ok: false, stdout: '' };
              try { return { ok: true, stdout: execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: options?.maxBuffer ?? 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'test-gitconfig') } }) }; } catch (error) { return { ok: false, stdout: '', exitCode: (error as { status?: number }).status }; }
            },
          });
          await checkStaleBaseNotice(PROJECT, 'own5', 'ready');
          expect(toExecutor()).toHaveLength(1);
          expect(toExecutor()[0]!.text).toContain('"fix: reworded by Brain"');
        });
      });

      it('lockfiles and evidence: commits alone are not an overlap', async () => {
        const { wt, base } = fixture('ov3', { 'package-lock.json': '1\n', 'notes.md': 'a\n', 'real.txt': 'a\n' });
        commitFiles(wt, { 'package-lock.json': 'pair\n' }, 'chore: pair bumps a dependency');
        const head = commitFiles(wt, { 'notes.md': 'measurements\n' }, 'evidence: measurements');
        openAudit('ov3', wt, base, head);
        commitFiles(main, { 'package-lock.json': 'dev\n', 'notes.md': 'dev notes\n' }, 'chore: dev bumps dependencies and edits notes');
        pushDev();
        await checkStaleBaseNotice(PROJECT, 'ov3', 'ready');
        expect(notices()).toHaveLength(0);
      });

      it('a pair that has only evidence: commits gets no overlap notice', async () => {
        const { wt, base } = fixture('ov4', { 'evidence.md': 'a\n' });
        const head = commitFiles(wt, { 'evidence.md': 'numbers\n' }, 'evidence: only numbers');
        openAudit('ov4', wt, base, head);
        commitFiles(main, { 'evidence.md': 'dev\n' }, 'docs: dev edits the same file');
        pushDev();
        await checkStaleBaseNotice(PROJECT, 'ov4', 'ready');
        expect(notices()).toHaveLength(0);
      });

      it('lists at most 10 files and says how many more; a huge dev diff is capped and still answers', async () => {
        const many: Record<string, string> = {};
        for (let i = 0; i < 14; i += 1) many[`src/m${String(i).padStart(2, '0')}.ts`] = 'a\n';
        const { wt, base } = fixture('ov5', many);
        const head = commitFiles(wt, Object.fromEntries(Object.keys(many).map((name) => [name, 'pair\n'])), 'feat: touch many files');
        openAudit('ov5', wt, base, head);
        const huge: Record<string, string> = Object.fromEntries(Object.keys(many).map((name) => [name, 'dev\n']));
        for (let i = 0; i < 3000; i += 1) huge[`gen/file-${i}.txt`] = `${i}\n`;
        commitFiles(main, huge, 'chore: dev regenerates thousands of files');
        pushDev();
        const started = Date.now();
        await checkStaleBaseNotice(PROJECT, 'ov5', 'ready');
        expect(Date.now() - started).toBeLessThan(8_000);
        const text = toExecutor()[0]!.text;
        expect(text).toContain('changed 14 of the files');
        expect(text).toContain('+4 more');
        expect(text.match(/src\/m\d\d\.ts/gu)).toHaveLength(10);
        expect(text).not.toContain('gen/file-');
      });

      it('one message carries both reasons when the base is far behind AND files overlap', async () => {
        const { wt, base } = fixture('ov6', { 'shared.txt': 'a\n' });
        const head = commitFiles(wt, { 'shared.txt': 'pair\n' }, 'feat: pair');
        openAudit('ov6', wt, base, head);
        emptyCommits(main, TASK_PAIR_STALE_BASE_MAX_COMMITS + 5);
        commitFiles(main, { 'shared.txt': 'dev\n' }, 'fix: dev shared');
        pushDev();
        await checkStaleBaseNotice(PROJECT, 'ov6', 'ready');
        expect(toExecutor()).toHaveLength(1);
        expect(toExecutor()[0]!.text).toContain('builds on a base');
        expect(toExecutor()[0]!.text).toContain('changed 1 of the files');
        expect(notices().filter((entry) => entry.target === BRAIN)).toHaveLength(1);
      });

      it('follows IMCODES_PAIR_INTEGRATION_REF (a ref that is not dev), and an unknown ref or an unreachable origin makes no notice and no crash', async () => {
        const { wt, base } = fixture('ov7', { 'shared.txt': 'a\n' });
        const head = commitFiles(wt, { 'shared.txt': 'pair\n' }, 'feat: pair');
        openAudit('ov7', wt, base, head);
        run(main, 'checkout', '-q', '-b', 'release-line', base);
        commitFiles(main, { 'shared.txt': 'release\n' }, 'fix: the release branch edits the file');
        run(main, 'push', '-q', 'origin', 'release-line');
        process.env[TASK_PAIR_INTEGRATION_REF_ENV] = 'origin/release-line';
        await checkStaleBaseNotice(PROJECT, 'ov7', 'ready');
        expect(toExecutor()[0]!.text).toContain('origin/release-line changed 1 of the files');
        // A ref that does not exist: nothing to compare against, nothing claimed.
        sent = [];
        savePair('ov7b', { status: 'in_audit', material: { worktree: wt, head, base, at: T0 }, workspace: { kind: 'worktree', path: wt, base, lastHead: head, createdAt: 1, status: 'active' } as never });
        process.env[TASK_PAIR_INTEGRATION_REF_ENV] = 'origin/not-a-branch';
        clock = T0 + 120 * MIN;
        await expect(checkStaleBaseNotice(PROJECT, 'ov7b', 'ready')).resolves.toBeUndefined();
        expect(notices()).toHaveLength(0);
        // The origin is gone: the fetch fails, the check still runs on the ref it has and never throws.
        delete process.env[TASK_PAIR_INTEGRATION_REF_ENV];
        run(main, 'remote', 'set-url', 'origin', join(root, 'does-not-exist.git'));
        const loggerModule = await import('../../../src/util/logger.js');
        vi.spyOn(loggerModule.default, 'warn').mockImplementation(() => undefined as never);
        clock = T0 + 300 * MIN;
        await expect(checkStaleBaseNotice(PROJECT, 'ov7b', 'ready')).resolves.toBeUndefined();
      });
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
