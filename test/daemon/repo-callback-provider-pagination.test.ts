import { describe, expect, it, vi } from 'vitest';
import { createDefaultRepoCallbackConfig } from '../../shared/repo-callback.js';
import { CallbackTaskStore } from '../../src/daemon/callback-task-store.js';
import { RepoCallbackMonitor } from '../../src/daemon/repo-callback-monitor.js';
import { GitHubProvider } from '../../src/repo/github-provider.js';
import type { RepoContext } from '../../src/repo/types.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const { repoExecMock } = vi.hoisted(() => ({
  repoExecMock: vi.fn(),
}));

vi.mock('../../src/repo/repo-exec.js', () => ({
  repoExecFile: (...args: unknown[]) => repoExecMock(...args),
}));

function makeSession(): SessionRecord {
  return {
    name: 'deck_proj_brain',
    projectName: 'proj',
    role: 'brain',
    agentType: 'codex-sdk',
    projectDir: '/tmp/repo-gh',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
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
