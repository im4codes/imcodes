/**
 * `pair_create workspace=auto|worktree|dir|none` (owner requirement: a worktree is created only when the task changes tracked files
 * that will be merged; everything else uses a small task directory or no workspace at all).
 *
 * Real git and real directories under temporary roots standing in for ~/.imcodes/worktrees and ~/.imcodes/works, driven through the
 * real pair_create MCP handler and the real marker path.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextNamespace } from '../../../shared/context-types.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../../shared/memory-mcp-contracts.js';
import {
  TASK_PAIR_WORKS_DIR,
  TASK_PAIR_WORKSPACE_REQUESTS,
  type TaskPairState,
} from '../../../shared/task-pair.js';
import type { McpRuntimeCaller } from '../../../src/daemon/memory-mcp-caller.js';
import { createMemoryMcpToolHandlers } from '../../../src/daemon/memory-mcp-tools.js';
import { resetTaskPairFocusForTests, setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { setTaskPairMaterialDepsForTests } from '../../../src/daemon/task-pairs/material.js';
import { ensureTaskPairWorkspaceAvailable, taskPairService, type TaskPairScheduler } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { releaseTaskPairWorkspace, setTaskPairWorkspaceDepsForTests } from '../../../src/daemon/task-pairs/workspace.js';
import { evaluatePairMainCheckoutGitWrite } from '../../../src/daemon/task-pairs/main-checkout-write-guard.js';
import { runIntegrationDriftPass } from '../../../src/daemon/task-pairs/integration-drift.js';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';

const PROJECT = 'wkproj';
const BRAIN = 'deck_wkproj_brain';
const EXEC = 'deck_sub_wkexec';
const AUD = 'deck_sub_wkaud';

let base = '';
let project = '';
let worktreesRoot = '';
let worksRoot = '';
let sent: Array<{ target: string; text: string; id: string }>;
let turn = 0;
let sessions: SessionRecord[];

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const caller = (): McpRuntimeCaller => ({
  userId: 'u', namespace: { scope: 'user_private', userId: 'u', projectId: PROJECT } as ContextNamespace,
  sessionName: BRAIN, projectName: PROJECT, projectRoot: project, serverId: 'srv', transport: 'in_process',
});
function session(name: string, role: SessionRecord['role'], projectDir: string): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'codex-sdk', projectDir, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}
function marker(writer: string, line: string) {
  turn += 1;
  return taskPairService.ingestText(PROJECT, writer, line, `wk-turn-${turn}`);
}
const testScheduler: TaskPairScheduler = {
  async onIntent(projectName, pairState, intent) {
    if (intent.kind !== 'slot_changed') return;
    if (pairState.status !== 'queued' || !pairState.executor || pairState.auditor === undefined) return;
    taskPairService.applyMarker({
      project: projectName, writer: 'daemon',
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: pairState.taskId, attrs: { executor: pairState.executor, auditor: pairState.auditor } },
      source: 'queue', now: Date.now(), eventId: `test-queue-drain:${pairState.taskId}:${Date.now()}:${Math.random()}`,
    });
    await taskPairService.briefParticipants(projectName, pairState.taskId);
  },
};
const pair = (taskId: string): TaskPairState => getTaskPairStore().getPair(PROJECT, taskId)!.state;
const sentTo = (target: string, reason: string) => sent.filter((entry) => entry.target === target && entry.id.includes(`:${reason}:`));
const handlers = () => createMemoryMcpToolHandlers(caller(), { sendDeps: { listSessions: () => sessions } });
async function create(workspace: string | undefined, key: string) {
  const result = await handlers()[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
    brief: `# ${key}\n- [ ][ ] one`, executor: EXEC, auditor: AUD, title: key, idempotencyKey: key,
    ...(workspace !== undefined ? { workspace } : {}),
  });
  return result;
}
const projectWorktrees = () => git(project, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '));

describe('pair_create workspace=…', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    resetTaskPairFocusForTests();
    sent = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    base = realpathSync(mkdtempSync(join(tmpdir(), 'imcodes-pair-wk-')));
    project = join(base, 'project');
    worktreesRoot = join(base, 'worktrees');
    worksRoot = join(base, TASK_PAIR_WORKS_DIR);
    execFileSync('git', ['init', '-q', project]);
    git(project, 'config', 'user.email', 'test@example.invalid');
    git(project, 'config', 'user.name', 'Test');
    writeFileSync(join(project, 'README.md'), 'hello\n');
    git(project, 'add', '-A');
    git(project, 'commit', '-qm', 'base');
    setTaskPairWorkspaceDepsForTests({ env: { ...process.env, IMCODES_WORKTREES_ROOT: worktreesRoot, IMCODES_WORKS_ROOT: worksRoot } });
    sessions = [session(BRAIN, 'brain', project), session(EXEC, 'w1', project), session(AUD, 'w2', project)];
    for (const record of sessions) upsertSession(record);
    taskPairService.setScheduler(testScheduler);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await taskPairService.waitForIdle();
    taskPairService.setScheduler(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairWorkspaceDepsForTests(undefined);
    setTaskPairMaterialDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    resetTaskPairFocusForTests();
    for (const name of [BRAIN, EXEC, AUD]) removeSession(name);
    rmSync(base, { recursive: true, force: true });
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('rejects an unknown value before anything is created, naming the allowed values and the rule', async () => {
    const result = await create('worktee', 'bad');
    expect(result).toMatchObject({ status: 'error', reason: 'validation_failed' });
    expect(String(result.message)).toContain(TASK_PAIR_WORKSPACE_REQUESTS.join(', '));
    expect(String(result.message)).toContain('Pick workspace=dir or none unless this task edits tracked files that you will merge.');
    expect(getTaskPairStore().listActivePairs()).toEqual([]);
    expect(sent).toEqual([]);
    expect(existsSync(worktreesRoot)).toBe(false);
    expect(existsSync(worksRoot)).toBe(false);
  });

  it('workspace=none: nothing is created on disk or on the pair, the briefs say so, and the audit runs on the report', async () => {
    const created = await create('none', 'none-1');
    expect(created).toMatchObject({ status: 'ok', workspace: { requested: 'none' } });
    const taskId = String(created.taskId);
    await taskPairService.waitForIdle();
    expect(pair(taskId).workspaceKind).toBe('none');
    expect(pair(taskId).workspace).toBeUndefined();
    expect(existsSync(worktreesRoot)).toBe(false);
    expect(existsSync(worksRoot)).toBe(false);
    expect(projectWorktrees()).toHaveLength(1);

    await vi.waitFor(() => expect(sentTo(EXEC, 'pair-brief').length).toBeGreaterThan(0));
    const brief = sentTo(EXEC, 'pair-brief')[0]!.text;
    expect(brief).toContain('NO workspace');
    expect(brief).toContain(`READY_FOR_AUDIT ${taskId} -->`);
    expect(brief).not.toContain('Work in the worktree the daemon created');
    expect(brief).not.toContain('commit locally');
    const auditorBrief = sentTo(AUD, 'auditor-assigned')[0]?.text ?? sentTo(AUD, 'pair-brief')[0]?.text ?? '';
    expect(auditorBrief).toContain('NO workspace');

    // READY with no worktree/path/head still opens a material-backed round, and PASS applies.
    marker(EXEC, `<!-- IMCODES_TASK STARTED ${taskId} -->`);
    marker(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT ${taskId} -->`);
    await vi.waitFor(() => expect(sentTo(AUD, 'audit-request')).toHaveLength(1), { timeout: 10_000 });
    expect(pair(taskId).status).toBe('in_audit');
    expect(pair(taskId).material).toMatchObject({ report: true });
    const request = sentTo(AUD, 'audit-request')[0]!.text;
    expect(request).toContain('Material: this pair has NO workspace');
    expect(request).not.toMatch(/head [0-9a-f]{7}/);
    expect(sentTo(EXEC, 'material-pending')).toEqual([]);
    marker(AUD, `<!-- IMCODES_TASK PASS ${taskId} blocking=P0 -->`);
    expect(pair(taskId).status).toBe('passed');
    marker(EXEC, `<!-- IMCODES_TASK DONE ${taskId} -->`);
    await taskPairService.waitForIdle();
    expect(pair(taskId).status).toBe('done');

    // Nothing was created at any point, and nothing nags about a workspace or an unmerged worktree.
    expect(existsSync(worktreesRoot)).toBe(false);
    expect(existsSync(worksRoot)).toBe(false);
    expect(pair(taskId).workspace).toBeUndefined();
    const toBrain = sent.filter((entry) => entry.target === BRAIN).map((entry) => entry.text).join('\n');
    expect(toBrain).not.toMatch(/unprovisioned|unrecoverable|not integrated|unmerged|Brain merges|commit locally|Worktree:/i);
    expect(toBrain).toContain('nothing to merge');
    await runIntegrationDriftPass(Date.now() + 3 * 24 * 60 * 60_000);
    expect(sent.filter((entry) => entry.target === BRAIN && /integration|drift|unintegrated/i.test(entry.id))).toEqual([]);
    await expect(releaseTaskPairWorkspace(pair(taskId))).resolves.toEqual({ action: 'absent' });
  });

  it('a started workspace=none pair is never given a workspace by the repair paths', async () => {
    const taskId = String((await create('none', 'none-repair')).taskId);
    await taskPairService.waitForIdle();
    await ensureTaskPairWorkspaceAvailable(PROJECT, taskId);
    await taskPairService.provisionMissingWorkspace(PROJECT, taskId);
    await taskPairService.ensureWorkspace(PROJECT, taskId);
    expect(pair(taskId).workspace).toBeUndefined();
    expect(pair(taskId).workspaceRecoveryEscalatedAt).toBeUndefined();
    expect(existsSync(worktreesRoot)).toBe(false);
    expect(existsSync(worksRoot)).toBe(false);
    expect(sent.filter((entry) => /workspace-(unprovisioned|unrecoverable|provisioned|rebuilt)/.test(entry.id))).toEqual([]);
  });

  it('workspace=dir creates only the task directory (no worktree), and the pair is not nagged about merging', async () => {
    const created = await create('dir', 'dir-1');
    expect(created).toMatchObject({ status: 'ok', workspace: { requested: 'dir' } });
    const taskId = String(created.taskId);
    await vi.waitFor(() => expect(pair(taskId).workspace?.status).toBe('active'), { timeout: 15_000, interval: 50 });
    expect(pair(taskId).workspaceKind).toBe('dir');
    expect(pair(taskId).workspace).toMatchObject({ kind: 'dir', path: join(worksRoot, PROJECT, taskId) });
    expect(readdirSync(worksRoot)).toEqual([PROJECT]);
    expect(existsSync(worktreesRoot)).toBe(false);
    expect(projectWorktrees()).toHaveLength(1);
    marker(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT ${taskId} -->`);
    await vi.waitFor(() => expect(sentTo(AUD, 'audit-request')).toHaveLength(1), { timeout: 10_000 });
    expect(sentTo(AUD, 'audit-request')[0]!.text).toContain(`Material: task directory ${join(worksRoot, PROJECT, taskId)}.`);
    marker(AUD, `<!-- IMCODES_TASK PASS ${taskId} blocking=P0 -->`);
    const heartbeat = getTaskPairStore().getPair(PROJECT, taskId)!.state;
    expect(heartbeat.status).toBe('passed');
  });

  for (const requested of [undefined, 'auto', 'worktree'] as const) {
    it(`workspace=${requested ?? '(omitted)'} on a git project is today's behaviour: a worktree, and the note says to prefer dir/none for other work`, async () => {
      const created = await create(requested, `auto-${requested ?? 'omitted'}`);
      expect(created).toMatchObject({ status: 'ok', workspace: { requested: requested === 'worktree' ? 'worktree' : 'auto' } });
      expect(String((created.workspace as { note: string }).note)).toContain('Pick workspace=dir or none unless this task edits tracked files that you will merge.');
      const taskId = String(created.taskId);
      await vi.waitFor(() => expect(pair(taskId).workspace?.status).toBe('active'), { timeout: 15_000, interval: 50 });
      expect(pair(taskId).workspace).toMatchObject({ kind: 'worktree' });
      expect(pair(taskId).workspaceKind).toBe(requested === 'worktree' ? 'worktree' : undefined);
      expect(existsSync(join(worktreesRoot, 'imcodes', EXEC))).toBe(true);
      const projection = await handlers()[MEMORY_MCP_TOOL_NAMES.PAIR_GET]({ taskId });
      expect(projection).toMatchObject({ status: 'ok', pair: { workspace: { requested: requested === 'worktree' ? 'worktree' : 'auto', kind: 'worktree', status: 'active' } } });
    });
  }

  it('the choice survives a daemon restart (it is part of the stored pair) and shows in pair_get and pair_list', async () => {
    const taskId = String((await create('none', 'none-persist')).taskId);
    await taskPairService.waitForIdle();
    const stored = getTaskPairStore().getPair(PROJECT, taskId)!;
    const reopened = new TaskPairStore(':memory:');
    reopened.savePair(PROJECT, JSON.parse(JSON.stringify(stored.state)));
    expect(reopened.getPair(PROJECT, taskId)!.state.workspaceKind).toBe('none');
    const got = await handlers()[MEMORY_MCP_TOOL_NAMES.PAIR_GET]({ taskId });
    expect(got).toMatchObject({ pair: { workspace: { requested: 'none', kind: null, path: null, status: null } } });
    const listed = await handlers()[MEMORY_MCP_TOOL_NAMES.PAIR_LIST]({});
    expect((listed.pairs as Array<Record<string, unknown>>).find((item) => item.taskId === taskId)).toMatchObject({ workspace: { requested: 'none' } });
  });

  it('the main-checkout git-write guard still applies to a participant of a workspace=none pair', async () => {
    const taskId = String((await create('none', 'none-guard')).taskId);
    await taskPairService.waitForIdle();
    expect(pair(taskId).status).toBe('working');
    const hit = evaluatePairMainCheckoutGitWrite(EXEC, 'bash', { command: 'git commit -am x', cwd: project });
    expect(hit).toMatchObject({ taskId, role: 'executor', verb: 'commit' });
  });

  it('a dispatch marker carries the same choice (queued pairs and the marker path)', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH M1 executor=${EXEC} auditor=${AUD} workspace=none -->`);
    await taskPairService.waitForIdle();
    expect(pair('M1').workspaceKind).toBe('none');
    expect(pair('M1').workspace).toBeUndefined();
    mkdirSync(join(base, 'unused'));
    expect(existsSync(worksRoot)).toBe(false);
  });
  it('a pair that waits in the queue keeps the choice and starts without a workspace when its slot frees', async () => {
    const busy = { ...session(EXEC, 'w1', project), state: 'running' as const };
    sessions = [session(BRAIN, 'brain', project), busy, session(AUD, 'w2', project)];
    upsertSession(busy);
    taskPairService.setScheduler(undefined); // no queue drain: the pair stays queued until the test frees its slot
    const created = await create('none', 'none-queued');
    expect(created).toMatchObject({ status: 'ok', state: 'queued', workspace: { requested: 'none' } });
    const taskId = String(created.taskId);
    expect(pair(taskId).workspaceKind).toBe('none');
    upsertSession(session(EXEC, 'w1', project));
    taskPairService.applyMarker({
      project: PROJECT, writer: 'daemon',
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId, attrs: { executor: EXEC, auditor: AUD } },
      source: 'queue', now: Date.now(), eventId: `test-queue-drain:${taskId}`,
    });
    await taskPairService.briefParticipants(PROJECT, taskId);
    await taskPairService.waitForIdle();
    expect(pair(taskId).status).toBe('working');
    expect(pair(taskId).workspaceKind).toBe('none');
    expect(pair(taskId).workspace).toBeUndefined();
    expect(existsSync(worktreesRoot)).toBe(false);
    expect(existsSync(worksRoot)).toBe(false);
    expect(sentTo(EXEC, 'pair-brief').map((entry) => entry.text).join('\n')).toContain('NO workspace');
  });

  it('workspace=none: CANCEL and a DONE that names output= end cleanly (nothing to remove, nothing to copy, no notice about either)', async () => {
    const cancelled = String((await create('none', 'none-cancel')).taskId);
    const done = String((await create('none', 'none-output')).taskId);
    await taskPairService.waitForIdle();
    marker(BRAIN, `<!-- IMCODES_TASK CANCEL ${cancelled} -->`);
    marker(EXEC, `<!-- IMCODES_TASK DONE ${done} output=report.md -->`);
    await taskPairService.waitForIdle();
    expect(pair(cancelled).status).toBe('cancelled');
    expect(pair(cancelled).workspace).toBeUndefined();
    expect(sent.filter((entry) => /output-failed|workspace-kept|workspace-removed/.test(entry.id))).toEqual([]);
    expect(existsSync(worktreesRoot)).toBe(false);
    expect(existsSync(worksRoot)).toBe(false);
  });
  it('boundaries: a non-git project and a missing project directory need nothing for workspace=none, and a replaced executor is given nothing either', async () => {
    const plain = join(base, 'plain-project');
    mkdirSync(plain);
    writeFileSync(join(plain, 'notes.txt'), 'input\n');
    const exec2 = 'deck_sub_wkexec2';
    sessions = [session(BRAIN, 'brain', plain), session(EXEC, 'w1', plain), session(AUD, 'w2', plain), session(exec2, 'w3', join(base, 'gone-forever'))];
    for (const record of sessions) upsertSession(record);
    try {
      const taskId = String((await create('none', 'none-nongit')).taskId);
      await taskPairService.waitForIdle();
      expect(pair(taskId).workspace).toBeUndefined();
      expect(existsSync(join(plain, '.git'))).toBe(false); // the non-git project is neither initialised nor cloned
      expect(existsSync(worksRoot)).toBe(false);
      expect(readdirSync(plain)).toEqual(['notes.txt']);
      // REASSIGN to an executor whose project directory does not exist: still no workspace, no move, no error notice.
      marker(BRAIN, `<!-- IMCODES_TASK REASSIGN ${taskId} executor=${exec2} -->`);
      await taskPairService.waitForIdle();
      expect(pair(taskId).executor).toBe(exec2);
      expect(pair(taskId).workspace).toBeUndefined();
      expect(pair(taskId).workspaceKind).toBe('none');
      expect(sent.filter((entry) => /workspace-(move|unprovisioned|unrecoverable)|brain-workspace/.test(entry.id))).toEqual([]);
      expect(existsSync(worktreesRoot)).toBe(false);
    } finally {
      removeSession(exec2);
    }
  });
});

describe('pair_workspace_gc (on-demand cleanup of ended pairs)', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    resetTaskPairFocusForTests();
    sent = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    base = realpathSync(mkdtempSync(join(tmpdir(), 'imcodes-pair-gc-')));
    project = join(base, 'project');
    worktreesRoot = join(base, 'worktrees');
    worksRoot = join(base, TASK_PAIR_WORKS_DIR);
    execFileSync('git', ['init', '-q', project]);
    git(project, 'config', 'user.email', 'test@example.invalid');
    git(project, 'config', 'user.name', 'Test');
    writeFileSync(join(project, 'README.md'), 'hello\n');
    git(project, 'add', '-A');
    git(project, 'commit', '-qm', 'base');
    setTaskPairWorkspaceDepsForTests({ env: { ...process.env, IMCODES_WORKTREES_ROOT: worktreesRoot, IMCODES_WORKS_ROOT: worksRoot } });
    sessions = [session(BRAIN, 'brain', project), session(EXEC, 'w1', project), session(AUD, 'w2', project)];
    for (const record of sessions) upsertSession(record);
    taskPairService.setScheduler(testScheduler);
  });
  afterEach(async () => {
    await taskPairService.waitForIdle();
    taskPairService.setScheduler(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairWorkspaceDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    resetTaskPairFocusForTests();
    for (const name of [BRAIN, EXEC, AUD]) removeSession(name);
    rmSync(base, { recursive: true, force: true });
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  const gc = (input: Record<string, unknown> = {}) => handlers()[MEMORY_MCP_TOOL_NAMES.PAIR_WORKSPACE_GC](input);
  const entryOf = (result: Record<string, unknown>, taskId: string) => (result.entries as Array<Record<string, unknown>>).find((entry) => entry.taskId === taskId);
  async function endedPair(workspace: 'dir' | 'worktree', key: string, end: 'cancel' | 'done'): Promise<string> {
    const taskId = String((await create(workspace, key)).taskId);
    await vi.waitFor(() => expect(pair(taskId).workspace?.status).toBe('active'), { timeout: 15_000, interval: 50 });
    if (end === 'cancel') marker(BRAIN, `<!-- IMCODES_TASK CANCEL ${taskId} -->`);
    else {
      marker(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT ${taskId} -->`);
      marker(AUD, `<!-- IMCODES_TASK PASS ${taskId} blocking=P0 -->`);
      marker(EXEC, `<!-- IMCODES_TASK DONE ${taskId} -->`);
    }
    await vi.waitFor(() => expect(pair(taskId).workspace?.status).toBe('ended'), { timeout: 15_000, interval: 50 });
    return taskId;
  }

  it('lists by default and removes nothing; a real run removes clean ended workspaces only, never an open pair', async () => {
    const dirPair = await endedPair('dir', 'gc-dir', 'cancel');
    const cleanTree = await endedPair('worktree', 'gc-clean', 'cancel');
    const open = String((await create('dir', 'gc-open')).taskId);
    await vi.waitFor(() => expect(pair(open).workspace?.status).toBe('active'), { timeout: 15_000, interval: 50 });

    const listed = await gc();
    expect(listed).toMatchObject({ status: 'ok', dryRun: true });
    expect(entryOf(listed, dirPair)).toMatchObject({ action: 'would_remove', kind: 'dir' });
    expect(entryOf(listed, cleanTree)).toMatchObject({ action: 'would_remove', kind: 'worktree' });
    expect(entryOf(listed, open)).toBeUndefined();
    expect(existsSync(pair(dirPair).workspace!.path)).toBe(true);
    expect(existsSync(pair(cleanTree).workspace!.path)).toBe(true);
    expect(pair(dirPair).workspace!.status).toBe('ended');

    const removed = await gc({ dryRun: false });
    expect(entryOf(removed, dirPair)).toMatchObject({ action: 'removed' });
    expect(entryOf(removed, cleanTree)).toMatchObject({ action: 'removed' });
    expect(existsSync(pair(dirPair).workspace!.path)).toBe(false);
    expect(existsSync(pair(cleanTree).workspace!.path)).toBe(false);
    expect(pair(dirPair).workspace!.status).toBe('removed');
    expect(existsSync(pair(open).workspace!.path)).toBe(true);
    expect(pair(open).workspace!.status).toBe('active');
  });

  it('never removes uncommitted, untracked or unintegrated work, and says why', async () => {
    const dirty = await endedPair('worktree', 'gc-dirty', 'cancel');
    const untracked = await endedPair('worktree', 'gc-untracked', 'cancel');
    const committed = await endedPair('worktree', 'gc-committed', 'cancel');
    writeFileSync(join(pair(dirty).workspace!.path, 'README.md'), 'changed\n');
    writeFileSync(join(pair(untracked).workspace!.path, 'new-file.txt'), 'x\n');
    const path = pair(committed).workspace!.path;
    writeFileSync(join(path, 'work.txt'), 'work\n');
    git(path, 'add', 'work.txt');
    git(path, '-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-qm', 'unmerged work');
    const result = await gc({ dryRun: false });
    expect(entryOf(result, dirty)).toMatchObject({ action: 'kept', reason: 'dirty' });
    expect(entryOf(result, untracked)).toMatchObject({ action: 'kept', reason: 'untracked' });
    expect(entryOf(result, committed)).toMatchObject({ action: 'kept', reason: 'unpushed' });
    for (const taskId of [dirty, untracked, committed]) expect(existsSync(pair(taskId).workspace!.path)).toBe(true);
    expect(readFileSync(join(pair(dirty).workspace!.path, 'README.md'), 'utf8')).toBe('changed\n');
    // and the same answer in a dry run
    const dry = await gc();
    expect(entryOf(dry, dirty)).toMatchObject({ action: 'kept', reason: 'dirty' });
  });

  it('honours minAgeHours, only serves the project Brain, and a pair of another Brain is not listed', async () => {
    const recent = await endedPair('dir', 'gc-recent', 'cancel');
    const tooRecent = await gc({ dryRun: false, minAgeHours: 24 });
    expect(entryOf(tooRecent, recent)).toMatchObject({ action: 'too_recent' });
    expect(existsSync(pair(recent).workspace!.path)).toBe(true);
    const notBrain = createMemoryMcpToolHandlers({ ...caller(), sessionName: EXEC }, { sendDeps: { listSessions: () => sessions } });
    await expect(notBrain[MEMORY_MCP_TOOL_NAMES.PAIR_WORKSPACE_GC]({ dryRun: false })).resolves.toMatchObject({ status: 'error' });
    expect(existsSync(pair(recent).workspace!.path)).toBe(true);
  });
});
