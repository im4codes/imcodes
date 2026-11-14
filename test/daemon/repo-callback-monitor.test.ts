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
});
