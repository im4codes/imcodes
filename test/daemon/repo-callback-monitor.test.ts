import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CALLBACK_SOURCES,
  buildCallbackId,
} from '../../shared/callback-types.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import {
  createDefaultRepoCallbackConfig,
  renderRepoCallbackPrompt,
  resolveRepoCallbackPromptTemplate,
  type RepoCallbackTemplate,
} from '../../shared/repo-callback.js';
import { CallbackTaskStore } from '../../src/daemon/callback-task-store.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import { RepoCallbackMonitor } from '../../src/daemon/repo-callback-monitor.js';
import type { RepoProvider } from '../../src/repo/provider.js';
import type {
  RepoActionDetail,
  RepoContext,
  RepoIssue,
  RepoPR,
  RepoWorkflowRun,
} from '../../src/repo/types.js';
import type { SessionRecord } from '../../src/store/session-store.js';

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: 'deck_proj_brain',
    projectName: 'proj',
    role: 'brain',
    agentType: 'codex-sdk',
    projectDir: '/tmp/repo-a',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeCaller(overrides: Partial<McpRuntimeCaller> = {}): McpRuntimeCaller {
  return {
    userId: 'user-1',
    namespace: { scope: 'user_private', userId: 'user-1', projectId: 'proj' },
    sessionName: 'deck_proj_brain',
    projectName: 'proj',
    projectRoot: '/tmp/repo-a',
    serverId: 'srv-1',
    providerId: 'codex-sdk',
    transport: 'in_process',
    ...overrides,
  };
}

function createOkContext(projectDir = '/tmp/repo-a'): RepoContext {
  return {
    status: 'ok',
    info: {
      platform: 'github',
      owner: 'acme',
      repo: 'widget',
      remoteUrl: 'https://github.com/acme/widget.git',
      defaultBranch: 'main',
    },
    cliVersion: '2.50.0',
    cliMinVersion: '2.40.0',
  };
}

function createMockProvider(state: {
  prs?: RepoPR[];
  issues?: RepoIssue[];
  actions?: RepoWorkflowRun[];
  actionDetails?: Record<number, RepoActionDetail>;
  failEvents?: Set<'pr' | 'issue' | 'action'>;
}): RepoProvider {
  return {
    detect: vi.fn(async () => createOkContext()),
    listPRs: vi.fn(async () => {
      if (state.failEvents?.has('pr')) throw new Error('gh pr list failed');
      return { items: state.prs ?? [], hasMore: false, page: 1 };
    }),
    listIssues: vi.fn(async () => {
      if (state.failEvents?.has('issue')) throw new Error('gh issue list failed');
      return { items: state.issues ?? [], hasMore: false, page: 1 };
    }),
    listActions: vi.fn(async () => {
      if (state.failEvents?.has('action')) throw new Error('gh run list failed');
      return { items: state.actions ?? [], hasMore: false, page: 1 };
    }),
    getActionDetail: vi.fn(async (runId: number) => {
      return state.actionDetails?.[runId] ?? {
        id: runId,
        name: 'CI',
        headBranch: 'main',
        status: 'failure',
        conclusion: 'failure',
        url: `https://github.com/acme/widget/actions/runs/${runId}`,
        createdAt: '2026-11-14T00:00:00Z',
        updatedAt: '2026-11-14T00:05:00Z',
        jobs: [],
      };
    }),
    listBranches: vi.fn(async () => ({ items: [], hasMore: false, page: 1 })),
    listCommits: vi.fn(async () => ({ items: [], hasMore: false, page: 1 })),
    getCommitDetail: vi.fn(async (sha: string) => ({
      sha,
      message: '',
      author: '',
      date: '',
      files: [],
    })),
    getPRDetail: vi.fn(async () => {
      throw new Error('not needed');
    }),
    getIssueDetail: vi.fn(async () => {
      throw new Error('not needed');
    }),
  };
}

describe('CallbackTaskStore & callback_update MCP tool', () => {
  it('supports updating statuses, relatedTaskId, metadata, and generic non-repo sources with listeners', async () => {
    const store = new CallbackTaskStore(':memory:');
    const repoListener = vi.fn();
    const webhookListener = vi.fn();
    const unsubRepo = store.onCallbackUpdated(CALLBACK_SOURCES.REPO, repoListener);
    const unsubWebhook = store.onCallbackUpdated('webhook', webhookListener);

    const repoCbId = buildCallbackId('repo', '1');
    store.createCallback({
      callbackId: repoCbId,
      source: CALLBACK_SOURCES.REPO,
      eventType: 'ci_failed',
      scopeKey: '/tmp/repo-a',
      entityKey: 'run#10#1',
      dedupKey: 'repo:/tmp/repo-a:ci_failed:10:1',
      title: 'CI failed: test',
      url: 'https://github.com/acme/widget/actions/runs/10',
      targetSession: 'deck_proj_w1',
      status: 'pending',
      createdAt: 100,
    });

    const webhookCbId = buildCallbackId('webhook', '99');
    store.createCallback({
      callbackId: webhookCbId,
      source: 'webhook',
      eventType: 'deploy_alert',
      scopeKey: '/tmp/repo-a',
      entityKey: 'hook#99',
      dedupKey: 'webhook:hook#99',
      title: 'Prod error spike',
      targetSession: 'deck_proj_brain',
      status: 'pending',
      createdAt: 110,
    });
    expect(repoListener).toHaveBeenCalledTimes(1);
    expect(webhookListener).toHaveBeenCalledTimes(1);

    const sessions = [
      makeSession(),
      makeSession({ name: 'deck_proj_w1', role: 'w1' }),
    ];

    const subHandlers = createMemoryMcpToolHandlers(
      makeCaller({ sessionName: 'deck_proj_w1' }),
      {
        callbackStore: store,
        sendDeps: { listSessions: () => sessions },
      },
    );

    const progressRes = await subHandlers[MEMORY_MCP_TOOL_NAMES.CALLBACK_UPDATE]({
      callbackId: repoCbId,
      status: 'in_progress',
      summary: 'Investigating failing vitest shard',
      relatedTaskId: 'tsk_abc123',
      metadata: { job: 'unit-tests' },
    }) as { status: string; callback?: { status: string; relatedTaskId?: string; metadata?: Record<string, unknown> } };

    expect(progressRes.status).toBe('ok');
    expect(progressRes.callback?.status).toBe('in_progress');
    expect(progressRes.callback?.relatedTaskId).toBe('tsk_abc123');
    expect(progressRes.callback?.metadata).toEqual({ job: 'unit-tests' });
    expect(repoListener).toHaveBeenCalledTimes(2);
    expect(webhookListener).toHaveBeenCalledTimes(1);

    const brainHandlers = createMemoryMcpToolHandlers(makeCaller(), {
      callbackStore: store,
      sendDeps: { listSessions: () => sessions },
    });

    for (const nextStatus of ['done', 'ignored', 'failed'] as const) {
      const res = await brainHandlers[MEMORY_MCP_TOOL_NAMES.CALLBACK_UPDATE]({
        callbackId: repoCbId,
        status: nextStatus,
        summary: `Transitioned to ${nextStatus}`,
      }) as { status: string; callback?: { status: string; summary: string } };
      expect(res.status).toBe('ok');
      expect(res.callback?.status).toBe(nextStatus);
      expect(res.callback?.summary).toBe(`Transitioned to ${nextStatus}`);
    }

    const webhookRes = await brainHandlers[MEMORY_MCP_TOOL_NAMES.CALLBACK_UPDATE]({
      callbackId: webhookCbId,
      source: 'webhook',
      status: 'done',
      summary: 'Mitigated webhook alert',
      metadata: { severity: 'sev2' },
    }) as { status: string; callback?: { source: string; status: string } };
    expect(webhookRes.status).toBe('ok');
    expect(webhookRes.callback?.source).toBe('webhook');
    expect(webhookListener).toHaveBeenCalledTimes(2);

    unsubRepo();
    unsubWebhook();
    store.close();
  });

  it('rejects oversized summary/metadata and enforces strict caller and source authorization', async () => {
    const store = new CallbackTaskStore(':memory:');
    const cbId = buildCallbackId('repo', 'auth1');
    store.createCallback({
      callbackId: cbId,
      source: CALLBACK_SOURCES.REPO,
      eventType: 'pr_new',
      scopeKey: '/tmp/repo-a',
      entityKey: 'pr#42',
      dedupKey: 'repo:/tmp/repo-a:pr_new:42',
      title: 'PR #42',
      targetSession: 'deck_proj_w1',
      status: 'pending',
    });

    const sessions = [
      makeSession({ name: 'deck_proj_brain', role: 'brain', projectName: 'proj', projectDir: '/tmp/repo-a' }),
      makeSession({ name: 'deck_proj_w1', role: 'w1', projectName: 'proj', projectDir: '/tmp/repo-a' }),
      makeSession({ name: 'deck_proj_w2', role: 'w2', projectName: 'proj', projectDir: '/tmp/repo-a' }),
      makeSession({ name: 'deck_other_brain', role: 'brain', projectName: 'other', projectDir: '/tmp/repo-b' }),
    ];

    const w1Handlers = createMemoryMcpToolHandlers(makeCaller({ sessionName: 'deck_proj_w1' }), {
      callbackStore: store,
      sendDeps: { listSessions: () => sessions },
    });

    const bigSummaryRes = await w1Handlers[MEMORY_MCP_TOOL_NAMES.CALLBACK_UPDATE]({
      callbackId: cbId,
      status: 'done',
      summary: 'x'.repeat(2001),
    }) as { status: string; reason: string };
    expect(bigSummaryRes).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });

    const bigMetaRes = await w1Handlers[MEMORY_MCP_TOOL_NAMES.CALLBACK_UPDATE]({
      callbackId: cbId,
      status: 'done',
      metadata: { payload: 'a'.repeat(4100) },
    }) as { status: string; reason: string };
    expect(bigMetaRes).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });

    const unrelatedSubHandlers = createMemoryMcpToolHandlers(
      makeCaller({ sessionName: 'deck_proj_w2' }),
      {
        callbackStore: store,
        sendDeps: { listSessions: () => sessions },
      },
    );
    const w2Res = await unrelatedSubHandlers[MEMORY_MCP_TOOL_NAMES.CALLBACK_UPDATE]({
      callbackId: cbId,
      status: 'done',
      summary: 'Attempted update by unrelated sub-session',
    }) as { status: string; reason: string };
    expect(w2Res).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN });

    const otherBrainHandlers = createMemoryMcpToolHandlers(
      makeCaller({
        sessionName: 'deck_other_brain',
        projectName: 'other',
        projectRoot: '/tmp/repo-b',
      }),
      {
        callbackStore: store,
        sendDeps: { listSessions: () => sessions },
      },
    );
    const otherBrainRes = await otherBrainHandlers[MEMORY_MCP_TOOL_NAMES.CALLBACK_UPDATE]({
      callbackId: cbId,
      status: 'done',
      summary: 'Cross-project update attempt',
    }) as { status: string; reason: string };
    expect(otherBrainRes).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN });

    const wrongSourceRes = await w1Handlers[MEMORY_MCP_TOOL_NAMES.CALLBACK_UPDATE]({
      callbackId: cbId,
      source: 'webhook',
      status: 'done',
      summary: 'Source mismatch attempt',
    }) as { status: string; reason: string };
    expect(wrongSourceRes).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN });

    const sameProjectBrainHandlers = createMemoryMcpToolHandlers(makeCaller(), {
      callbackStore: store,
      sendDeps: { listSessions: () => sessions },
    });
    const brainRes = await sameProjectBrainHandlers[MEMORY_MCP_TOOL_NAMES.CALLBACK_UPDATE]({
      callbackId: cbId,
      status: 'done',
      summary: 'Reviewed and merged',
    }) as { status: string; callback?: { status: string } };
    expect(brainRes.status).toBe('ok');
    expect(brainRes.callback?.status).toBe('done');

    store.close();
  });
});

describe('RepoCallbackMonitor background polling & delivery', () => {
  it('polls without frontend, baselines per-(projectDir, eventType), survives provider errors, enriches CI failures, and deduplicates by attempt', async () => {
    const store = new CallbackTaskStore(':memory:');
    let nowMs = 1_700_000_000_000;
    const sent: Array<{ sessionName: string; text: string }> = [];

    const state: {
      prs: RepoPR[];
      issues: RepoIssue[];
      actions: RepoWorkflowRun[];
      actionDetails: Record<number, RepoActionDetail>;
      failEvents: Set<'pr' | 'issue' | 'action'>;
    } = {
      prs: [
        {
          number: 1,
          title: 'Old PR before enable',
          author: 'alice',
          state: 'open',
          draft: false,
          head: 'feat/old',
          base: 'main',
          labels: [],
          createdAt: '2026-11-10T00:00:00Z',
          updatedAt: '2026-11-10T00:00:00Z',
          url: 'https://github.com/acme/widget/pull/1',
        },
      ],
      issues: [],
      actions: [
        {
          id: 100,
          name: 'CI',
          branch: 'main',
          commitSha: '1111111111111',
          commitMessage: 'Old commit',
          status: 'failure',
          conclusion: 'failure',
          runAttempt: 1,
          actor: 'alice',
          createdAt: '2026-11-10T00:00:00Z',
          updatedAt: '2026-11-10T00:01:00Z',
          url: 'https://github.com/acme/widget/actions/runs/100',
        },
      ],
      actionDetails: {},
      failEvents: new Set(),
    };

    const provider = createMockProvider(state);
    const sessions = [makeSession()];

    const config = createDefaultRepoCallbackConfig('/tmp/repo-a');
    config.enabled = true;
    config.intervalMs = 60_000;
    config.events.pr_new.enabled = true;
    config.events.ci_failed.enabled = true;
    config.events.issue_new.enabled = false;

    const monitor = new RepoCallbackMonitor({
      store,
      getServerLink: () => null, // No frontend/ws link needed for polling & dispatch
      loadCreds: async () => ({ serverId: 'srv-1', token: 'tok', workerUrl: 'https://worker.test' }),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        globalTemplates: [],
        repos: { '/tmp/repo-a': config },
      }), { status: 200 })) as unknown as typeof fetch,
      detect: async () => createOkContext('/tmp/repo-a'),
      createProvider: () => provider,
      listSessions: () => sessions,
      sendToSession: async (sessionName, text) => {
        sent.push({ sessionName, text });
      },
      now: () => nowMs,
    });

    await expect(monitor.refreshConfig()).resolves.toBe(true);

    // 1. Cold-start baseline suppresses historical PR #1 and failed CI #100
    await monitor.pollDueRepos();
    expect(sent).toHaveLength(0);
    expect(store.listCallbacks()).toHaveLength(0);

    // Not yet due until intervalMs elapses
    nowMs += 30_000;
    await monitor.pollDueRepos();
    expect(provider.listPRs).toHaveBeenCalledTimes(1);

    // 2. Enable issue_new later while PR/CI are already baselined; provider fails on issue -> no baseline poison!
    nowMs += 40_000;
    config.events.issue_new.enabled = true;
    monitor.setConfigsForTesting({ repos: { '/tmp/repo-a': { ...config } } });
    state.issues.push({
      number: 5,
      title: 'Existing historical issue',
      author: 'bob',
      state: 'open',
      labels: ['bug'],
      createdAt: '2026-11-11T00:00:00Z',
      updatedAt: '2026-11-11T00:00:00Z',
      commentsCount: 0,
      url: 'https://github.com/acme/widget/issues/5',
    });
    state.failEvents.add('issue');
    const errPoll = await monitor.checkProject('/tmp/repo-a');
    expect(errPoll.error).toContain('issue_new');
    expect(sent).toHaveLength(0);

    // Recover issue provider -> baselines existing Issue #5 without flooding
    state.failEvents.delete('issue');
    nowMs += 60_000;
    const baselineIssuePoll = await monitor.checkProject('/tmp/repo-a');
    expect(baselineIssuePoll.error).toBeUndefined();
    expect(sent).toHaveLength(0);

    // 3. New PR #2, Issue #6, and failed CI run #101 with job/step detail
    nowMs += 60_000;
    state.prs.push({
      number: 2,
      title: 'Add webhook adapter',
      author: 'carol',
      state: 'open',
      draft: false,
      head: 'feat/webhook',
      base: 'main',
      labels: [],
      createdAt: '2026-11-14T10:00:00Z',
      updatedAt: '2026-11-14T10:00:00Z',
      url: 'https://github.com/acme/widget/pull/2',
    });
    state.issues.push({
      number: 6,
      title: 'Crash on boot',
      author: 'dave',
      state: 'open',
      labels: ['p0'],
      createdAt: '2026-11-14T10:01:00Z',
      updatedAt: '2026-11-14T10:01:00Z',
      commentsCount: 1,
      url: 'https://github.com/acme/widget/issues/6',
    });
    state.actions.push({
      id: 101,
      name: 'CI Build',
      branch: 'main',
      commitSha: 'deadbeef1234567',
      commitMessage: 'Fix parser',
      status: 'failure',
      conclusion: 'failure',
      runAttempt: 1,
      actor: 'carol',
      createdAt: '2026-11-14T10:02:00Z',
      updatedAt: '2026-11-14T10:03:00Z',
      url: 'https://github.com/acme/widget/actions/runs/101',
    });
    state.actionDetails[101] = {
      id: 101,
      name: 'CI Build',
      headBranch: 'main',
      status: 'failure',
      conclusion: 'failure',
      url: 'https://github.com/acme/widget/actions/runs/101',
      createdAt: '2026-11-14T10:02:00Z',
      updatedAt: '2026-11-14T10:03:00Z',
      jobs: [
        {
          id: 1,
          name: 'unit-tests',
          status: 'failure',
          conclusion: 'failure',
          steps: [{ name: 'Run vitest', status: 'failure', conclusion: 'failure', number: 4 }],
        },
      ],
    };

    const thirdPoll = await monitor.checkProject('/tmp/repo-a');
    expect(thirdPoll).toEqual({ checked: true, dispatched: 3 });
    expect(sent).toHaveLength(3);
    expect(sent.every((s) => s.sessionName === 'deck_proj_brain')).toBe(true);
    const ciMsg = sent.find((s) => s.text.includes('CI Build'));
    expect(ciMsg?.text).toContain('Failed job "unit-tests" -> steps: 4. Run vitest');
    expect(ciMsg?.text).toContain('callback_update');

    // 4. Re-polling identical state fires nothing; rerun attempt 2 of run 101 fires again
    nowMs += 60_000;
    const repeatPoll = await monitor.checkProject('/tmp/repo-a');
    expect(repeatPoll).toEqual({ checked: true, dispatched: 0 });

    state.actions[1] = { ...state.actions[1]!, runAttempt: 2 };
    nowMs += 60_000;
    const rerunPoll = await monitor.checkProject('/tmp/repo-a');
    expect(rerunPoll).toEqual({ checked: true, dispatched: 1 });
    expect(store.listCallbacks({ scopeKey: '/tmp/repo-a' })).toHaveLength(4);

    store.close();
  });

  it('delivers to a same-project sub-session with rendered global templates and marks stopped/missing targets as failed', async () => {
    const store = new CallbackTaskStore(':memory:');
    const sent: Array<{ sessionName: string; text: string }> = [];
    const prs: RepoPR[] = [];
    const provider = createMockProvider({ prs });
    const sessions: SessionRecord[] = [
      makeSession({ name: 'deck_proj_brain', role: 'brain' }),
      makeSession({ name: 'deck_proj_ci', role: 'w1', state: 'idle' }),
      makeSession({ name: 'deck_proj_stopped', role: 'w2', state: 'stopped' }),
    ];

    const globalTemplate: RepoCallbackTemplate = {
      id: 'gtpl-ci',
      name: 'Global PR Review',
      scope: 'global',
      eventType: 'pr_new',
      prompt: 'Review {{title}} for {{repo}} and report {{callbackId}}',
      updatedAt: 1,
    };

    const config = createDefaultRepoCallbackConfig('/tmp/repo-a');
    config.enabled = true;
    config.target = 'deck_proj_ci';
    config.events.pr_new.enabled = true;
    config.events.pr_new.templateScope = 'global';
    config.events.pr_new.templateId = globalTemplate.id;

    const monitor = new RepoCallbackMonitor({
      store,
      detect: async () => createOkContext('/tmp/repo-a'),
      createProvider: () => provider,
      listSessions: () => sessions,
      sendToSession: async (sessionName, text) => {
        sent.push({ sessionName, text });
      },
    });
    monitor.setConfigsForTesting({
      globalTemplates: [globalTemplate],
      repos: { '/tmp/repo-a': config },
    });

    // Baseline empty PR list
    await monitor.checkProject('/tmp/repo-a');

    // Deliver PR #10 to sub-session
    prs.push({
      number: 10,
      title: 'Sub-session test PR',
      author: 'eve',
      state: 'open',
      draft: false,
      head: 'feat/x',
      base: 'main',
      labels: [],
      createdAt: '2026-11-14T12:00:00Z',
      updatedAt: '2026-11-14T12:00:00Z',
      url: 'https://github.com/acme/widget/pull/10',
    });
    await monitor.checkProject('/tmp/repo-a');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sessionName).toBe('deck_proj_ci');
    expect(sent[0]!.text).toContain('Review PR #10: Sub-session test PR for acme/widget and report cb_repo_');

    // Switch target to stopped session -> records failed status without throwing
    config.target = 'deck_proj_stopped';
    monitor.setConfigsForTesting({ repos: { '/tmp/repo-a': { ...config } } });
    prs.push({
      number: 11,
      title: 'Stopped target PR',
      author: 'eve',
      state: 'open',
      draft: false,
      head: 'feat/y',
      base: 'main',
      labels: [],
      createdAt: '2026-11-14T12:05:00Z',
      updatedAt: '2026-11-14T12:05:00Z',
      url: 'https://github.com/acme/widget/pull/11',
    });
    await monitor.checkProject('/tmp/repo-a');
    expect(sent).toHaveLength(1);
    const failed = store.listCallbacks({ scopeKey: '/tmp/repo-a', status: 'failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.lastError).toContain('stopped');

    // Verify helper exports work identically when rendering template directly
    const resolved = resolveRepoCallbackPromptTemplate(config, 'pr_new', [globalTemplate]);
    const rendered = renderRepoCallbackPrompt(resolved, {
      repo: 'acme/widget',
      projectDir: '/tmp/repo-a',
      event: 'pr_new',
      title: 'T',
      number: '1',
      url: 'u',
      author: 'a',
      branch: 'b',
      status: 'open',
      conclusion: '',
      details: 'd',
      callbackId: 'cb_repo_x',
    });
    expect(rendered).toContain('Review T for acme/widget and report cb_repo_x');
    expect(rendered).toContain('[Callback ID: cb_repo_x | source: repo]');

    store.close();
  });

  it('F1: completes multi-page historical baseline, prevents shifted old PRs from refiring, detects closed new items, survives mid-pagination failures & restarts, and bounds API calls per poll', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'imcodes-cb-restart-'));
    const dbPath = join(tmpDir, 'callback-tasks.sqlite');
    const sessions = [makeSession()];
    const sent: Array<{ sessionName: string; text: string }> = [];

    const makePR = (num: number, state: 'open' | 'closed' | 'merged' = 'open'): RepoPR => ({
      number: num,
      title: `PR ${num}`,
      author: 'alice',
      state,
      draft: false,
      head: `feat/${num}`,
      base: 'main',
      labels: [],
      createdAt: 1_700_000_000_000 + num * 1000,
      updatedAt: 1_700_000_000_000 + num * 1000,
      url: `https://github.com/acme/widget/pull/${num}`,
    });

    // Scenario A: 6 open PRs (#6..#1) with perPage=5 -> page 1 [#6..#2], page 2 [#1].
    // Closing #6 shifts #1 onto page 1, which must NOT fire as pr_new.
    const allPrs: RepoPR[] = [6, 5, 4, 3, 2, 1].map((n) => makePR(n, 'open'));
    let failPrPage: number | null = null;
    const requestedPages: number[] = [];

    const provider: RepoProvider = {
      ...createMockProvider({}),
      listPRs: vi.fn(async (opts) => {
        const page = opts?.page ?? 1;
        requestedPages.push(page);
        if (failPrPage === page) throw new Error(`transient error on page ${page}`);
        const stateFilter = opts?.state ?? 'open';
        const filtered = (stateFilter === 'all' ? allPrs : allPrs.filter((p) => p.state === stateFilter))
          .slice()
          .sort((a, b) => b.number - a.number);
        const pageSize = 5;
        const start = (page - 1) * pageSize;
        const slice = filtered.slice(start, start + pageSize);
        return {
          items: slice,
          page,
          hasMore: start + pageSize < filtered.length,
          projectDir: '/tmp/repo-a',
        };
      }),
    };

    try {
      let store = new CallbackTaskStore(dbPath);
      const config = createDefaultRepoCallbackConfig('/tmp/repo-a');
      config.enabled = true;
      config.events.pr_new.enabled = true;
      config.events.ci_failed.enabled = false;
      config.events.issue_new.enabled = false;

      const buildMonitor = (s: CallbackTaskStore, maxPagesPerPoll = 2) => {
        const m = new RepoCallbackMonitor({
          store: s,
          detect: async () => createOkContext('/tmp/repo-a'),
          createProvider: () => provider,
          listSessions: () => sessions,
          sendToSession: async (sessionName, text) => {
            sent.push({ sessionName, text });
          },
          perPage: 5,
          maxPagesPerPoll,
        });
        m.setConfigsForTesting({ repos: { '/tmp/repo-a': config } });
        return m;
      };

      // Fail mid-baseline on page 2 -> baseline must remain incomplete!
      let monitor = buildMonitor(store, 2);
      failPrPage = 2;
      const partialErr = await monitor.checkProject('/tmp/repo-a');
      expect(partialErr.error).toContain('transient error on page 2');
      expect(sent).toHaveLength(0);
      expect(store.getCheckpoint(CALLBACK_SOURCES.REPO, '/tmp/repo-a', 'pr_new')?.baselineComplete).toBe(false);

      // Simulate daemon restart on the same SQLite DB; next poll finishes page 2 and completes baseline.
      store.close();
      store = new CallbackTaskStore(dbPath);
      monitor = buildMonitor(store, 2);
      failPrPage = null;
      const completeBaseline = await monitor.checkProject('/tmp/repo-a');
      expect(completeBaseline.error).toBeUndefined();
      expect(sent).toHaveLength(0);
      expect(store.getCheckpoint(CALLBACK_SOURCES.REPO, '/tmp/repo-a', 'pr_new')?.baselineComplete).toBe(true);

      // Close #6 so #1 shifts onto page 1 -> zero historical callbacks!
      allPrs[0] = makePR(6, 'closed');
      await monitor.checkProject('/tmp/repo-a');
      expect(sent).toHaveLength(0);

      // Add 12 new PRs (#7..#18), including #11 already closed/merged between polls,
      // with maxPagesPerPoll = 2 (perPage=5 => max 10 items per poll tick -> 3 pages total).
      // Also inject failure on page 3 on tick 1 to verify bounded resumable catch-up across restart!
      for (let n = 7; n <= 18; n += 1) {
        allPrs.push(makePR(n, n === 11 ? 'closed' : 'open'));
      }
      requestedPages.length = 0;
      const tick1 = await monitor.checkProject('/tmp/repo-a');
      // Bounded: at most maxPagesPerPoll (2) API calls in one poll -> collects #18..#9 (10 PRs)
      expect(requestedPages).toEqual([1, 2]);
      expect(tick1.dispatched).toBe(10);

      // Restart daemon while catch-up is at syncNextPage = 3; fail page 3 once, then succeed.
      store.close();
      store = new CallbackTaskStore(dbPath);
      monitor = buildMonitor(store, 2);
      failPrPage = 3;
      const tick2Fail = await monitor.checkProject('/tmp/repo-a');
      expect(tick2Fail.error).toContain('transient error on page 3');

      failPrPage = null;
      requestedPages.length = 0;
      const tick3 = await monitor.checkProject('/tmp/repo-a');
      expect(requestedPages).toEqual([3]);
      // Remaining new PRs #8 and #7 are recovered, hitting #6 watermark without losing them or duplicating #18..#9!
      expect(tick3.dispatched).toBe(2);
      expect(sent).toHaveLength(12);
      const deliveredTitles = sent.map((m) => m.text);
      expect(deliveredTitles.some((t) => t.includes('PR #11:'))).toBe(true);
      expect(deliveredTitles.some((t) => t.includes('PR #7:'))).toBe(true);
      expect(deliveredTitles.some((t) => t.includes('PR #1:'))).toBe(false);

      // Re-poll settles to 1 API call and 0 dispatches
      requestedPages.length = 0;
      const tick4 = await monitor.checkProject('/tmp/repo-a');
      expect(requestedPages).toEqual([1]);
      expect(tick4.dispatched).toBe(0);

      // Pending CI run #300 during baseline shifts onto page 2 before failing -> must still fire
      config.events.pr_new.enabled = false;
      config.events.ci_failed.enabled = true;
      config.events.issue_new.enabled = true;
      monitor.setConfigsForTesting({ repos: { '/tmp/repo-a': { ...config } } });

      const issues: RepoIssue[] = [];
      const actions: RepoWorkflowRun[] = [
        {
          id: 300,
          name: 'Slow E2E',
          status: 'running',
          conclusion: undefined,
          branch: 'main',
          commitSha: '111',
          commitMessage: 'init',
          actor: 'alice',
          url: 'https://github.com/acme/widget/actions/runs/300',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          runAttempt: 1,
        },
      ];
      (provider.listIssues as ReturnType<typeof vi.fn>).mockImplementation(async (opts) => {
        const page = opts?.page ?? 1;
        const sorted = issues.slice().sort((a, b) => b.number - a.number);
        const start = (page - 1) * 5;
        return { items: sorted.slice(start, start + 5), page, hasMore: start + 5 < sorted.length, projectDir: '/tmp/repo-a' };
      });
      (provider.listActions as ReturnType<typeof vi.fn>).mockImplementation(async (opts) => {
        const page = opts?.page ?? 1;
        const sorted = actions.slice().sort((a, b) => b.id - a.id);
        const start = (page - 1) * 5;
        return { items: sorted.slice(start, start + 5), page, hasMore: start + 5 < sorted.length, projectDir: '/tmp/repo-a' };
      });

      const beforeCiIssueCount = sent.length;
      await monitor.checkProject('/tmp/repo-a'); // baseline empty issues + running CI #300
      expect(sent).toHaveLength(beforeCiIssueCount);

      // 6 newer green runs push #300 onto page 2, and #300 fails; Issue #1 is opened & closed between polls
      for (let id = 301; id <= 306; id += 1) {
        actions.push({
          id,
          name: `Quick CI ${id}`,
          status: 'success',
          conclusion: 'success',
          branch: 'main',
          commitSha: String(id),
          commitMessage: 'ok',
          actor: 'bob',
          url: `https://github.com/acme/widget/actions/runs/${id}`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          runAttempt: 1,
        });
      }
      actions[0] = { ...actions[0]!, status: 'failure', conclusion: 'failure' };
      issues.push({
        id: 'iss-1',
        number: 1,
        title: 'Quickly closed bug',
        body: '',
        state: 'closed',
        author: 'bob',
        labels: [],
        url: 'https://github.com/acme/widget/issues/1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const ciIssueTick = await monitor.checkProject('/tmp/repo-a');
      expect(ciIssueTick.dispatched).toBe(2);
      expect(sent.slice(beforeCiIssueCount).map((m) => m.text).some((t) => t.includes('Slow E2E'))).toBe(true);
      expect(sent.slice(beforeCiIssueCount).map((m) => m.text).some((t) => t.includes('Quickly closed bug'))).toBe(true);

      store.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('F2: treats explicit non-failure CI conclusions (skipped/neutral) as non-failures even when status is failure, while alerting failure/timed_out/startup_failure', async () => {
    const store = new CallbackTaskStore(':memory:');
    const sent: Array<{ sessionName: string; text: string }> = [];
    const actions: RepoWorkflowRun[] = [];
    const actionDetails: Record<number, RepoActionDetail> = {};
    const provider = createMockProvider({ actions, actionDetails });

    const config = createDefaultRepoCallbackConfig('/tmp/repo-a');
    config.enabled = true;
    config.events.ci_failed.enabled = true;
    config.events.pr_new.enabled = false;
    config.events.issue_new.enabled = false;

    const monitor = new RepoCallbackMonitor({
      store,
      detect: async () => createOkContext('/tmp/repo-a'),
      createProvider: () => provider,
      listSessions: () => [makeSession()],
      sendToSession: async (sessionName, text) => {
        sent.push({ sessionName, text });
      },
    });
    monitor.setConfigsForTesting({ repos: { '/tmp/repo-a': config } });

    // Empty baseline
    await monitor.checkProject('/tmp/repo-a');

    const baseRun = {
      branch: 'main',
      commitSha: 'abcdef1',
      commitMessage: 'chore: test',
      actor: 'alice',
      url: 'https://github.com/acme/widget/actions/runs/',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_010_000,
    };

    // Normalized GitHub status='failure' with skipped/neutral MUST NOT fire!
    actions.unshift(
      { ...baseRun, id: 201, name: 'Skipped optional CI', status: 'failure', conclusion: 'skipped', runAttempt: 1 },
      { ...baseRun, id: 202, name: 'Neutral check', status: 'failure', conclusion: 'neutral', runAttempt: 1 },
      { ...baseRun, id: 203, name: 'Green build', status: 'success', conclusion: 'success', runAttempt: 1 },
      { ...baseRun, id: 204, name: 'Cancelled build', status: 'cancelled', conclusion: 'cancelled', runAttempt: 1 },
      { ...baseRun, id: 205, name: 'Timed out suite', status: 'failure', conclusion: 'timed_out', runAttempt: 1 },
      { ...baseRun, id: 206, name: 'Startup failure', status: 'failure', conclusion: 'startup_failure', runAttempt: 1 },
      { ...baseRun, id: 207, name: 'Hard failure', status: 'failure', conclusion: 'failure', runAttempt: 1 },
    );

    actionDetails[207] = {
      runId: 207,
      jobs: [
        {
          id: 1,
          name: 'Skipped Job',
          status: 'failure',
          conclusion: 'skipped',
          steps: [{ number: 1, name: 'Skipped Step', status: 'failure', conclusion: 'skipped' }],
        },
        {
          id: 2,
          name: 'Test Job',
          status: 'failure',
          conclusion: 'failure',
          steps: [
            { number: 1, name: 'Skipped sub-step', status: 'failure', conclusion: 'skipped' },
            { number: 2, name: 'Failing vitest', status: 'failure', conclusion: 'failure' },
          ],
        },
      ],
    };

    const res = await monitor.checkProject('/tmp/repo-a');
    expect(res).toEqual({ checked: true, dispatched: 3 });
    const texts = sent.map((s) => s.text).join('\n');
    expect(texts).not.toContain('Skipped optional CI');
    expect(texts).not.toContain('Neutral check');
    expect(texts).not.toContain('Green build');
    expect(texts).not.toContain('Cancelled build');
    expect(texts).toContain('Timed out suite');
    expect(texts).toContain('Startup failure');
    expect(texts).toContain('Hard failure');
    expect(texts).not.toContain('Skipped Job');
    expect(texts).not.toContain('Skipped sub-step');
    expect(texts).toContain('Failed job "Test Job" -> steps: 2. Failing vitest');

    store.close();
  });

  it('F3 & F4: prioritizes customPrompt over templateId and unconditionally appends current callbackId envelope', () => {
    const config = createDefaultRepoCallbackConfig('/tmp/repo-a');
    config.templates = [
      { id: 'repo_1', name: 'Repo tpl', scope: 'repo', eventType: 'pr_new', prompt: 'Original repo prompt', updatedAt: 1 },
    ];
    const globalTemplates: RepoCallbackTemplate[] = [
      { id: 'global_1', name: 'Global tpl', scope: 'global', eventType: 'pr_new', prompt: 'Original global prompt', updatedAt: 1 },
    ];

    // Even if templateScope/templateId is present alongside customPrompt, customPrompt MUST win
    config.events.pr_new = {
      enabled: true,
      templateScope: 'global',
      templateId: 'global_1',
      customPrompt: 'Edited prompt that user saved',
    };
    expect(resolveRepoCallbackPromptTemplate(config, 'pr_new', globalTemplates)).toBe('Edited prompt that user saved');

    config.events.pr_new = {
      enabled: true,
      templateScope: 'repo',
      templateId: 'repo_1',
      customPrompt: 'Edited repo prompt',
    };
    expect(resolveRepoCallbackPromptTemplate(config, 'pr_new', globalTemplates)).toBe('Edited repo prompt');

    // Without customPrompt, live global template updates take effect automatically
    config.events.pr_new = { enabled: true, templateScope: 'global', templateId: 'global_1' };
    globalTemplates[0] = { ...globalTemplates[0]!, prompt: 'Updated global prompt v2' };
    expect(resolveRepoCallbackPromptTemplate(config, 'pr_new', globalTemplates)).toBe('Updated global prompt v2');

    // F4: template or remote title containing callback_update or stale cb_repo_old MUST still emit current callbackId
    const ctx = {
      repo: 'acme/widget',
      projectDir: '/tmp/repo-a',
      event: 'pr_new' as const,
      title: 'Fix callback_update bug',
      number: '42',
      url: 'https://github.com/acme/widget/pull/42',
      author: 'alice',
      branch: 'fix -> main',
      status: 'open',
      conclusion: '',
      details: 'Mentions callback_update in details',
      callbackId: 'cb_repo_test123',
    };

    const withToolName = renderRepoCallbackPrompt('After triage call callback_update with your summary.', ctx);
    expect(withToolName).toContain('After triage call callback_update with your summary.');
    expect(withToolName).toContain('cb_repo_test123');
    expect(withToolName).toContain('callbackId="cb_repo_test123"');

    const withStaleId = renderRepoCallbackPrompt('call callback_update for cb_repo_old999 on {{title}} ({{details}})', ctx);
    expect(withStaleId).toContain('Fix callback_update bug');
    expect(withStaleId).toContain('callbackId="cb_repo_test123"');
  });

  it('runs autonomous timer polling via start() / stop() without frontend connections', async () => {
    vi.useFakeTimers();
    try {
      const store = new CallbackTaskStore(':memory:');
      const prs: RepoPR[] = [];
      const sent: Array<{ sessionName: string; text: string }> = [];
      const provider = createMockProvider({ prs });

      const config = createDefaultRepoCallbackConfig('/tmp/repo-a');
      config.enabled = true;
      config.intervalMs = 60_000;
      config.events.pr_new.enabled = true;
      config.events.ci_failed.enabled = false;
      config.events.issue_new.enabled = false;

      const monitor = new RepoCallbackMonitor({
        store,
        getServerLink: () => null,
        detect: async () => createOkContext('/tmp/repo-a'),
        createProvider: () => provider,
        listSessions: () => [makeSession()],
        sendToSession: async (sessionName, text) => {
          sent.push({ sessionName, text });
        },
        pollTickMs: 10_000,
        configSyncIntervalMs: 300_000,
      });
      monitor.setConfigsForTesting({ repos: { '/tmp/repo-a': config } });
      monitor.start();

      // First interval completes cold-start baseline autonomously
      await vi.advanceTimersByTimeAsync(10_000);
      expect(provider.listPRs).toHaveBeenCalledTimes(1);
      expect(sent).toHaveLength(0);

      // Push PR #55 and advance past intervalMs -> timer triggers poll & dispatch
      prs.push({
        number: 55,
        title: 'Timer dispatched PR',
        author: 'alice',
        state: 'open',
        draft: false,
        head: 'feat/timer',
        base: 'main',
        labels: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        url: 'https://github.com/acme/widget/pull/55',
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain('Timer dispatched PR');

      // stop() clears timers cleanly -> no further polling occurs
      const callsBeforeStop = (provider.listPRs as ReturnType<typeof vi.fn>).mock.calls.length;
      monitor.stop();
      await vi.advanceTimersByTimeAsync(180_000);
      expect((provider.listPRs as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBeforeStop);

      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('F1b: detects CI reruns (new attempt or status transition) on page 2+ behind creation watermark across restarts with bounded API calls and page-1 freshness', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'imcodes-cb-ci-rerun-'));
    const dbPath = join(tmpDir, 'callback-tasks.sqlite');
    const sessions = [makeSession()];
    const sent: Array<{ sessionName: string; text: string }> = [];

    const makeRun = (
      id: number,
      status: RepoWorkflowRun['status'],
      conclusion: string,
      runAttempt = 1,
    ): RepoWorkflowRun => ({
      id,
      name: `CI #${id}`,
      status,
      conclusion,
      runAttempt,
      branch: 'main',
      commitSha: `sha-${id}`,
      commitMessage: `commit ${id}`,
      actor: 'alice',
      url: `https://github.com/acme/widget/actions/runs/${id}`,
      createdAt: 1_700_000_000_000 + id * 1000,
      updatedAt: 1_700_000_000_000 + id * 1000,
    });

    // 5 baseline runs: [300(success), 299(success), 298(failed attempt 1), 297(success), 296(failed attempt 1)]
    // perPage=2 -> 3 pages; page 1=[300,299], page 2=[298,297], page 3=[296].
    const runs: RepoWorkflowRun[] = [
      makeRun(300, 'success', 'success', 1),
      makeRun(299, 'success', 'success', 1),
      makeRun(298, 'failure', 'failure', 1),
      makeRun(297, 'success', 'success', 1),
      makeRun(296, 'failure', 'failure', 1),
    ];
    const requestedPages: number[] = [];

    const provider: RepoProvider = {
      ...createMockProvider({}),
      listActions: vi.fn(async (opts) => {
        const page = opts?.page ?? 1;
        requestedPages.push(page);
        const sorted = runs.slice().sort((a, b) => b.id - a.id);
        const start = (page - 1) * 2;
        return {
          items: sorted.slice(start, start + 2),
          page,
          hasMore: start + 2 < sorted.length,
          projectDir: '/tmp/repo-a',
        };
      }),
    };

    try {
      let store = new CallbackTaskStore(dbPath);
      const config = createDefaultRepoCallbackConfig('/tmp/repo-a');
      config.enabled = true;
      config.events.ci_failed.enabled = true;
      config.events.pr_new.enabled = false;
      config.events.issue_new.enabled = false;

      const buildMonitor = (s: CallbackTaskStore) => {
        const m = new RepoCallbackMonitor({
          store: s,
          detect: async () => createOkContext('/tmp/repo-a'),
          createProvider: () => provider,
          listSessions: () => sessions,
          sendToSession: async (sessionName, text) => {
            sent.push({ sessionName, text });
          },
          perPage: 2,
          maxPagesPerPoll: 2,
        });
        m.setConfigsForTesting({ repos: { '/tmp/repo-a': config } });
        return m;
      };

      // Baseline takes 2 bounded polls (pages 1..2, then page 3)
      let monitor = buildMonitor(store);
      await monitor.checkProject('/tmp/repo-a');
      expect(store.getCheckpoint(CALLBACK_SOURCES.REPO, '/tmp/repo-a', 'ci_failed')?.baselineComplete).toBe(false);
      await monitor.checkProject('/tmp/repo-a');
      expect(store.getCheckpoint(CALLBACK_SOURCES.REPO, '/tmp/repo-a', 'ci_failed')?.baselineComplete).toBe(true);
      expect(sent).toHaveLength(0);

      // Re-run #298 (page 2) -> attempt 2 failed; and #296 (page 3) -> attempt 2 failed!
      runs[2] = makeRun(298, 'failure', 'failure', 2);
      runs[4] = makeRun(296, 'failure', 'failure', 2);

      // Poll 1: fetches pages 1..2 (bounded by maxPagesPerPoll=2), MUST NOT stop on minSeq(299)<=300!
      // Delivers #298 attempt 2 immediately and persists syncNextPage=3.
      requestedPages.length = 0;
      const poll1 = await monitor.checkProject('/tmp/repo-a');
      expect(requestedPages).toEqual([1, 2]);
      expect(poll1.dispatched).toBe(1);
      expect(sent[0]!.text).toContain('CI #298');

      // Also inject brand-new failure #301 on page 1 BEFORE next poll + restart daemon ->
      // Poll 2 must BOTH peek page 1 (#301 immediate freshness) AND finish page 3 (#296 attempt 2) within 2 API calls!
      runs.unshift(makeRun(301, 'failure', 'failure', 1));
      store.close();
      store = new CallbackTaskStore(dbPath);
      monitor = buildMonitor(store);

      requestedPages.length = 0;
      const poll2 = await monitor.checkProject('/tmp/repo-a');
      expect(requestedPages).toHaveLength(2);
      expect(requestedPages).toEqual([1, 3]);
      expect(poll2.dispatched).toBe(2);
      expect(sent.map((m) => m.text).some((t) => t.includes('CI #301'))).toBe(true);
      expect(sent.map((m) => m.text).some((t) => t.includes('CI #296'))).toBe(true);

      store.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('F1c: never marks baselineComplete=true when per-poll baseline page budget is exhausted before EOF', async () => {
    const store = new CallbackTaskStore(':memory:');
    const sent: Array<{ sessionName: string; text: string }> = [];
    const prs: RepoPR[] = Array.from({ length: 7 }, (_, i) => ({
      number: 7 - i,
      title: `Hist PR ${7 - i}`,
      author: 'alice',
      state: 'open',
      draft: false,
      head: `b/${7 - i}`,
      base: 'main',
      labels: [],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      url: `https://github.com/acme/widget/pull/${7 - i}`,
    }));

    const provider: RepoProvider = {
      ...createMockProvider({}),
      listPRs: vi.fn(async (opts) => {
        const page = opts?.page ?? 1;
        const start = (page - 1) * 2;
        return {
          items: prs.slice(start, start + 2),
          page,
          hasMore: start + 2 < prs.length,
          projectDir: '/tmp/repo-a',
        };
      }),
    };

    const config = createDefaultRepoCallbackConfig('/tmp/repo-a');
    config.enabled = true;
    config.events.pr_new.enabled = true;
    config.events.ci_failed.enabled = false;
    config.events.issue_new.enabled = false;

    const monitor = new RepoCallbackMonitor({
      store,
      detect: async () => createOkContext('/tmp/repo-a'),
      createProvider: () => provider,
      listSessions: () => [makeSession()],
      sendToSession: async (sessionName, text) => {
        sent.push({ sessionName, text });
      },
      perPage: 2,
      maxPagesPerPoll: 2,
      maxBaselinePages: 1, // Even with legacy option=1, baseline MUST stay incomplete until !hasMore
    });
    monitor.setConfigsForTesting({ repos: { '/tmp/repo-a': config } });

    // Poll 1: pages 1..2 (hasMore=true) -> incomplete, cursor at page 3
    await monitor.checkProject('/tmp/repo-a');
    let cp = store.getCheckpoint(CALLBACK_SOURCES.REPO, '/tmp/repo-a', 'pr_new');
    expect(cp?.baselineComplete).toBe(false);
    expect(cp?.baselineNextPage).toBe(3);

    // Poll 2: pages 3..4 (page 4 is final short page [PR#1], hasMore=false) -> now complete
    await monitor.checkProject('/tmp/repo-a');
    cp = store.getCheckpoint(CALLBACK_SOURCES.REPO, '/tmp/repo-a', 'pr_new');
    expect(cp?.baselineComplete).toBe(true);
    expect(sent).toHaveLength(0);

    store.close();
  });
});
