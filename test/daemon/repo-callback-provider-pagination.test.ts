import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRepoCallbackConfig } from '../../shared/repo-callback.js';
import { CallbackTaskStore } from '../../src/daemon/callback-task-store.js';
import { RepoCallbackMonitor } from '../../src/daemon/repo-callback-monitor.js';
import { GitHubProvider } from '../../src/repo/github-provider.js';
import { GitLabProvider } from '../../src/repo/gitlab-provider.js';
import type { RepoContext } from '../../src/repo/types.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const { repoExecMock } = vi.hoisted(() => ({
  repoExecMock: vi.fn(),
}));

vi.mock('../../src/repo/repo-exec.js', () => ({
  repoExecFile: (...args: unknown[]) => repoExecMock(...args),
}));

beforeEach(() => {
  repoExecMock.mockReset();
});

function makeSession(projectDir = '/tmp/repo-gh'): SessionRecord {
  return {
    name: 'deck_proj_brain',
    projectName: 'proj',
    role: 'brain',
    agentType: 'codex-sdk',
    projectDir,
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeGitlabContext(): RepoContext {
  return {
    status: 'ok',
    info: {
      platform: 'gitlab',
      owner: 'group',
      repo: 'widget',
      remoteUrl: 'https://gitlab.com/group/widget.git',
      defaultBranch: 'main',
    },
    cliVersion: '1.50.0',
    cliMinVersion: '1.40.0',
  };
}

function makeGhContext(): RepoContext {
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

describe('RepoCallbackMonitor + real GitHubProvider pagination', () => {
  it('continues past PR-only or filtered-empty /issues pages to deliver new issues on page 2+', async () => {
    type TimelineItem =
      | { kind: 'issue'; number: number; title: string; createdAt: number }
      | { kind: 'pr'; number: number };

    // Initial history: only Issue #10
    const timeline: TimelineItem[] = [
      { kind: 'issue', number: 10, title: 'Baseline issue', createdAt: 1_700_000_010_000 },
    ];
    const requestedIssuePages: number[] = [];

    repoExecMock.mockImplementation(async (_cmd: string, args: string[]) => {
      const url = String(args[1] ?? '');
      const pageMatch = url.match(/[?&]page=(\d+)/);
      const perPageMatch = url.match(/[?&]per_page=(\d+)/);
      const page = pageMatch ? Number(pageMatch[1]) : 1;
      const perPage = perPageMatch ? Number(perPageMatch[1]) : 2;
      requestedIssuePages.push(page);

      const sorted = timeline.slice().sort((a, b) => b.number - a.number);
      const start = (page - 1) * perPage;
      const rawSlice = sorted.slice(start, start + perPage);
      const filteredIssues = rawSlice
        .filter((entry): entry is Extract<TimelineItem, { kind: 'issue' }> => entry.kind === 'issue')
        .map((entry) => ({
          id: String(entry.number),
          number: entry.number,
          title: entry.title,
          body: '',
          state: 'open',
          author: 'alice',
          labels: [],
          url: `https://github.com/acme/widget/issues/${entry.number}`,
          assignee: null,
          createdAt: entry.createdAt,
          updatedAt: entry.createdAt,
        }));

      // Emulate `gh api -q {rawCount: length, items: [...]}` output after jq PR filtering
      return {
        stdout: JSON.stringify({ rawCount: rawSlice.length, items: filteredIssues }),
        stderr: '',
      };
    });

    const store = new CallbackTaskStore(':memory:');
    const sent: Array<{ sessionName: string; text: string }> = [];
    const config = createDefaultRepoCallbackConfig('/tmp/repo-gh');
    config.enabled = true;
    config.events.issue_new.enabled = true;
    config.events.pr_new.enabled = false;
    config.events.ci_failed.enabled = false;

    const monitor = new RepoCallbackMonitor({
      store,
      detect: async () => makeGhContext(),
      createProvider: (ctx, dir) => new GitHubProvider(ctx.info!.owner, ctx.info!.repo, dir),
      listSessions: () => [makeSession()],
      sendToSession: async (sessionName, text) => {
        sent.push({ sessionName, text });
      },
      perPage: 2,
      maxPagesPerPoll: 5,
    });
    monitor.setConfigsForTesting({ repos: { '/tmp/repo-gh': config } });

    // Baseline captures Issue #10 without sending callbacks
    await monitor.checkProject('/tmp/repo-gh');
    expect(sent).toHaveLength(0);

    // Add PR #13, PR #12 (which fill page 1 with [] after jq PR filter) + Issue #11 on page 2
    timeline.push(
      { kind: 'issue', number: 11, title: 'Missed on unfiltered page 1', createdAt: 1_700_000_011_000 },
      { kind: 'pr', number: 12 },
      { kind: 'pr', number: 13 },
    );

    requestedIssuePages.length = 0;
    const res = await monitor.checkProject('/tmp/repo-gh');
    expect(requestedIssuePages).toEqual([1, 2]);
    expect(res.dispatched).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Issue #11: Missed on unfiltered page 1');

    store.close();
  });
});

interface MockGitLabPipeline {
  id: number;
  iid: number;
  sha: string;
  ref: string;
  status: 'failed' | 'running' | 'success' | 'canceled' | 'pending';
  source: string;
  created_at: string;
  updated_at: string;
  web_url: string;
}

function installGitLabPipelineMock(
  pipelinesRef: () => MockGitLabPipeline[],
  requestedPages: number[],
): void {
  repoExecMock.mockImplementation(async (cmd: string, args: string[]) => {
    expect(cmd).toBe('glab');
    const url = String(args[1] ?? '');
    if (url.includes('/pipelines?')) {
      const pageMatch = url.match(/[?&]page=(\d+)/);
      const perPageMatch = url.match(/[?&]per_page=(\d+)/);
      const page = pageMatch ? Number(pageMatch[1]) : 1;
      const perPage = perPageMatch ? Number(perPageMatch[1]) : 2;
      requestedPages.push(page);
      const slice = pipelinesRef().slice((page - 1) * perPage, page * perPage);
      return { stdout: JSON.stringify(slice), stderr: '' };
    }
    if (url.includes('/repository/commits/')) {
      return { stdout: JSON.stringify({ title: 'build: fix ci' }), stderr: '' };
    }
    if (url.includes('/jobs?')) {
      return { stdout: '[]', stderr: '' };
    }
    throw new Error(`Unexpected glab api call: ${url}`);
  });
}

describe('RepoCallbackMonitor + real GitLabProvider & GitHubProvider CI run generation', () => {
  it('advances persisted generation on GitLab failed -> running -> failed retries and stays idempotent on identical polls', async () => {
    let pipelines: MockGitLabPipeline[] = [];
    const requestedPages: number[] = [];
    installGitLabPipelineMock(() => pipelines, requestedPages);

    const store = new CallbackTaskStore(':memory:');
    const sent: Array<{ sessionName: string; text: string }> = [];
    const projectDir = '/tmp/repo-gl-retry';
    const config = createDefaultRepoCallbackConfig(projectDir);
    config.enabled = true;
    config.events.ci_failed.enabled = true;
    config.events.issue_new.enabled = false;
    config.events.pr_new.enabled = false;

    const monitor = new RepoCallbackMonitor({
      store,
      detect: async () => makeGitlabContext(),
      createProvider: (ctx, dir) => new GitLabProvider(ctx.info!.owner, ctx.info!.repo, dir),
      listSessions: () => [makeSession(projectDir)],
      sendToSession: async (sessionName, text) => {
        sent.push({ sessionName, text });
      },
      perPage: 2,
      maxPagesPerPoll: 3,
    });
    monitor.setConfigsForTesting({ repos: { [projectDir]: config } });

    // Empty baseline completes cleanly
    await monitor.checkProject(projectDir);
    expect(sent).toHaveLength(0);

    // First failure of pipeline #44 -> generation 1 (run#44#1)
    pipelines = [
      {
        id: 44,
        iid: 44,
        sha: 'abcdef1234567890',
        ref: 'main',
        status: 'failed',
        source: 'push',
        created_at: '2026-11-14T10:00:00Z',
        updated_at: '2026-11-14T10:01:00Z',
        web_url: 'https://gitlab.com/group/widget/-/pipelines/44',
      },
    ];
    const r1 = await monitor.checkProject(projectDir);
    expect(r1.dispatched).toBe(1);
    expect(store.listCallbacks({ scopeKey: projectDir }).map((c) => c.entityKey)).toEqual(['run#44#1']);

    // Identical repeat poll -> no duplicate callback
    const rRepeat1 = await monitor.checkProject(projectDir);
    expect(rRepeat1.dispatched).toBe(0);

    // Retry running observed -> no callback yet, pending state persisted
    pipelines = [
      {
        ...pipelines[0]!,
        status: 'running',
        updated_at: '2026-11-14T10:02:00Z',
      },
    ];
    const rRunning = await monitor.checkProject(projectDir);
    expect(rRunning.dispatched).toBe(0);

    // Same pipeline #44 fails again -> advances to generation 2 (run#44#2)
    pipelines = [
      {
        ...pipelines[0]!,
        status: 'failed',
        updated_at: '2026-11-14T10:03:00Z',
      },
    ];
    const r2 = await monitor.checkProject(projectDir);
    expect(r2.dispatched).toBe(1);
    expect(sent).toHaveLength(2);
    expect(store.listCallbacks({ scopeKey: projectDir }).map((c) => c.entityKey)).toEqual([
      'run#44#2',
      'run#44#1',
    ]);

    // Subsequent identical poll at generation 2 -> still suppressed
    const rRepeat2 = await monitor.checkProject(projectDir);
    expect(rRepeat2.dispatched).toBe(0);

    store.close();
  });

  it('persists GitLab running transition across daemon restart so post-restart failure still delivers #2', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'imcodes-gl-restart-'));
    const dbPath = join(tmpDir, 'callbacks.db');
    try {
      let pipelines: MockGitLabPipeline[] = [];
      const requestedPages: number[] = [];
      installGitLabPipelineMock(() => pipelines, requestedPages);

      const sent: Array<{ sessionName: string; text: string }> = [];
      const projectDir = '/tmp/repo-gl-restart';
      const config = createDefaultRepoCallbackConfig(projectDir);
      config.enabled = true;
      config.events.ci_failed.enabled = true;
      config.events.issue_new.enabled = false;
      config.events.pr_new.enabled = false;

      const buildMonitor = (store: CallbackTaskStore) => {
        const monitor = new RepoCallbackMonitor({
          store,
          detect: async () => makeGitlabContext(),
          createProvider: (ctx, dir) => new GitLabProvider(ctx.info!.owner, ctx.info!.repo, dir),
          listSessions: () => [makeSession(projectDir)],
          sendToSession: async (sessionName, text) => {
            sent.push({ sessionName, text });
          },
          perPage: 2,
          maxPagesPerPoll: 3,
        });
        monitor.setConfigsForTesting({ repos: { [projectDir]: config } });
        return monitor;
      };

      const store1 = new CallbackTaskStore(dbPath);
      const monitor1 = buildMonitor(store1);
      await monitor1.checkProject(projectDir); // baseline

      pipelines = [
        {
          id: 44,
          iid: 44,
          sha: 'abcdef1234567890',
          ref: 'main',
          status: 'failed',
          source: 'push',
          created_at: '2026-11-14T10:00:00Z',
          updated_at: '2026-11-14T10:01:00Z',
          web_url: 'https://gitlab.com/group/widget/-/pipelines/44',
        },
      ];
      expect((await monitor1.checkProject(projectDir)).dispatched).toBe(1);

      // Observed running before restart
      pipelines = [
        {
          ...pipelines[0]!,
          status: 'running',
          updated_at: '2026-11-14T10:02:00Z',
        },
      ];
      expect((await monitor1.checkProject(projectDir)).dispatched).toBe(0);
      store1.close();

      // Recreate store + monitor from disk (simulating daemon restart)
      const store2 = new CallbackTaskStore(dbPath);
      const monitor2 = buildMonitor(store2);

      pipelines = [
        {
          ...pipelines[0]!,
          status: 'failed',
          updated_at: '2026-11-14T10:03:00Z',
        },
      ];
      const afterRestart = await monitor2.checkProject(projectDir);
      expect(afterRestart.dispatched).toBe(1);
      expect(sent).toHaveLength(2);
      expect(store2.listCallbacks({ scopeKey: projectDir }).map((c) => c.entityKey)).toEqual([
        'run#44#2',
        'run#44#1',
      ]);

      store2.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('suppresses historical failed GitLab pipeline in baseline while delivering its later retry within bounded pages', async () => {
    // Baseline contains historical failed pipeline #44 plus older pipelines across 2 pages
    let pipelines: MockGitLabPipeline[] = [
      {
        id: 44,
        iid: 44,
        sha: 'abcdef1234567890',
        ref: 'main',
        status: 'failed',
        source: 'push',
        created_at: '2026-11-14T09:00:00Z',
        updated_at: '2026-11-14T09:01:00Z',
        web_url: 'https://gitlab.com/group/widget/-/pipelines/44',
      },
      {
        id: 43,
        iid: 43,
        sha: 'abcdef1234567891',
        ref: 'main',
        status: 'success',
        source: 'push',
        created_at: '2026-11-14T08:00:00Z',
        updated_at: '2026-11-14T08:01:00Z',
        web_url: 'https://gitlab.com/group/widget/-/pipelines/43',
      },
      {
        id: 42,
        iid: 42,
        sha: 'abcdef1234567892',
        ref: 'main',
        status: 'failed',
        source: 'push',
        created_at: '2026-11-14T07:00:00Z',
        updated_at: '2026-11-14T07:01:00Z',
        web_url: 'https://gitlab.com/group/widget/-/pipelines/42',
      },
    ];
    const requestedPages: number[] = [];
    installGitLabPipelineMock(() => pipelines, requestedPages);

    const store = new CallbackTaskStore(':memory:');
    const sent: Array<{ sessionName: string; text: string }> = [];
    const projectDir = '/tmp/repo-gl-baseline';
    const config = createDefaultRepoCallbackConfig(projectDir);
    config.enabled = true;
    config.events.ci_failed.enabled = true;
    config.events.issue_new.enabled = false;
    config.events.pr_new.enabled = false;

    const monitor = new RepoCallbackMonitor({
      store,
      detect: async () => makeGitlabContext(),
      createProvider: (ctx, dir) => new GitLabProvider(ctx.info!.owner, ctx.info!.repo, dir),
      listSessions: () => [makeSession(projectDir)],
      sendToSession: async (sessionName, text) => {
        sent.push({ sessionName, text });
      },
      perPage: 2,
      maxPagesPerPoll: 2,
    });
    monitor.setConfigsForTesting({ repos: { [projectDir]: config } });

    // Baseline completes without dispatching historical failures #44 or #42
    await monitor.checkProject(projectDir);
    expect(sent).toHaveLength(0);
    expect(requestedPages.length).toBeLessThanOrEqual(2);

    // Newer pipeline #45 added on page 1; historical #44 is pushed to page 2 and retried without waiting for running poll
    requestedPages.length = 0;
    pipelines = [
      {
        id: 45,
        iid: 45,
        sha: 'abcdef1234567895',
        ref: 'main',
        status: 'success',
        source: 'push',
        created_at: '2026-11-14T10:00:00Z',
        updated_at: '2026-11-14T10:01:00Z',
        web_url: 'https://gitlab.com/group/widget/-/pipelines/45',
      },
      pipelines[1]!, // #43
      {
        ...pipelines[0]!, // #44 retried and failed again with bumped updated_at
        status: 'failed',
        updated_at: '2026-11-14T10:05:00Z',
      },
      pipelines[2]!, // #42 unchanged historical failure
    ];
    const rRetry = await monitor.checkProject(projectDir);
    expect(requestedPages.length).toBeLessThanOrEqual(2);
    expect(rRetry.dispatched).toBe(1);
    expect(store.listCallbacks({ scopeKey: projectDir }).map((c) => c.entityKey)).toEqual(['run#44#2']);

    store.close();
  });

  it('keeps native runAttempt authoritative on GitHubProvider.listActions', async () => {
    let runs = [
      {
        id: 50,
        name: 'CI',
        status: 'completed',
        branch: 'main',
        commitSha: '1234abcd',
        commitMessage: 'test',
        actor: 'alice',
        url: 'https://github.com/acme/widget/actions/runs/50',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_010_000,
        runNumber: 50,
        event: 'push',
        conclusion: 'failure',
        runAttempt: 1,
      },
    ];

    repoExecMock.mockImplementation(async (cmd: string, args: string[]) => {
      expect(cmd).toBe('gh');
      const url = String(args[1] ?? '');
      if (url.includes('/actions/runs/50/jobs')) {
        return { stdout: JSON.stringify({ runId: 50, jobs: [] }), stderr: '' };
      }
      if (url.includes('/actions/runs?')) {
        const pageMatch = url.match(/[?&]page=(\d+)/);
        const page = pageMatch ? Number(pageMatch[1]) : 1;
        return { stdout: JSON.stringify(page === 1 ? runs : []), stderr: '' };
      }
      throw new Error(`Unexpected gh api call: ${url}`);
    });

    const store = new CallbackTaskStore(':memory:');
    const projectDir = '/tmp/repo-gh-native-attempt';
    const config = createDefaultRepoCallbackConfig(projectDir);
    config.enabled = true;
    config.events.ci_failed.enabled = true;
    config.events.issue_new.enabled = false;
    config.events.pr_new.enabled = false;

    const monitor = new RepoCallbackMonitor({
      store,
      detect: async () => makeGhContext(),
      createProvider: (ctx, dir) => new GitHubProvider(ctx.info!.owner, ctx.info!.repo, dir),
      listSessions: () => [makeSession(projectDir)],
      sendToSession: async () => {},
      perPage: 2,
      maxPagesPerPoll: 3,
    });
    monitor.setConfigsForTesting({ repos: { [projectDir]: config } });

    // Baseline captures attempt 1
    await monitor.checkProject(projectDir);
    expect(store.getCiRunStates('repo', projectDir, [50]).size).toBe(0);

    // Native runAttempt bumps to 2 -> uses run#50#2 directly
    runs = [{ ...runs[0]!, runAttempt: 2, updatedAt: 1_700_000_020_000 }];
    const res = await monitor.checkProject(projectDir);
    expect(res.dispatched).toBe(1);
    expect(store.listCallbacks({ scopeKey: projectDir }).map((c) => c.entityKey)).toEqual(['run#50#2']);
    expect(store.getCiRunStates('repo', projectDir, [50]).size).toBe(0);

    store.close();
  });
});
