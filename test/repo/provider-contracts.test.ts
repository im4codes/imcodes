import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { GitHubProvider } from '../../src/repo/github-provider.js';
import { GitLabProvider } from '../../src/repo/gitlab-provider.js';

function complete(stdout: unknown) {
  const text = typeof stdout === 'string' ? stdout : JSON.stringify(stdout);
  execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, { stdout: text, stderr: '' });
  });
}

function rejectExec(error: unknown) {
  execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(error);
  });
}

describe('GitHubProvider contracts', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('guards owner and repo names before shelling out', () => {
    expect(() => new GitHubProvider('good-owner', 'repo.name', '/tmp/project')).not.toThrow();
    expect(() => new GitHubProvider('../bad', 'repo', '/tmp/project')).toThrow('Invalid owner/repo');
    expect(() => new GitHubProvider('owner', 'bad/repo', '/tmp/project')).toThrow('Invalid owner/repo');
  });

  it('normalizes list and detail results from gh api output', async () => {
    const provider = new GitHubProvider('octo', 'repo', '/tmp/project');
    const now = Date.parse('2026-05-11T00:00:00.000Z');

    complete([
      { id: '1', number: 7, title: 'Bug', body: '', state: 'open', author: 'ana', labels: ['bug'], url: 'https://github.com/octo/repo/issues/7', assignee: null, createdAt: now, updatedAt: now },
      { id: '2', number: 8, title: 'Bug 2', body: '', state: 'open', author: 'ana', labels: [], url: 'https://github.com/octo/repo/issues/8', assignee: null, createdAt: now, updatedAt: now },
    ]);
    const githubIssues = await provider.listIssues({ page: 3, perPage: 2, state: 'closed' });
    expect(githubIssues).toMatchObject({ page: 3, hasMore: true, projectDir: '/tmp/project' });
    expect(githubIssues.items).toHaveLength(2);
    expect(githubIssues.items[0]).toMatchObject({ number: 7, state: 'open' });
    expect(execFileMock.mock.calls.at(-1)?.[1][1]).toContain('state=closed&per_page=2&page=3');

    complete([{ number: 5, title: 'PR', state: 'merged', author: 'ben', head: 'feature', base: 'main', url: 'https://github.com/octo/repo/pull/5', createdAt: now, updatedAt: now, reviewDecision: null, draft: false, labels: [] }]);
    await expect(provider.listPRs({ perPage: 5 })).resolves.toMatchObject({
      hasMore: false,
      items: [{ number: 5, state: 'merged', draft: false }],
    });

    complete([{ name: 'main', lastCommitDate: now }, { name: 'feature', lastCommitDate: now + 1 }]);
    complete('feature\n');
    complete('main\n');
    await expect(provider.listBranches()).resolves.toMatchObject({
      items: [
        { name: 'main', isDefault: true, isCurrent: false },
        { name: 'feature', isDefault: false, isCurrent: true },
      ],
    });

    complete([{ sha: 'abcdef1234567890', shortSha: 'abcdef1', message: 'commit', author: 'cat', date: now, url: 'https://github.com/octo/repo/commit/abcdef1' }]);
    await expect(provider.listCommits({ branch: 'main', page: 2, perPage: 1 })).resolves.toMatchObject({
      page: 2,
      hasMore: true,
      items: [{ shortSha: 'abcdef1', author: 'cat' }],
    });
    expect(String(execFileMock.mock.calls.at(-1)?.[1][1])).toContain('sha=main');

    complete({ runId: 99, jobs: [{ id: 1, name: 'test', status: 'success', conclusion: 'success', startedAt: now, completedAt: now + 1000, url: 'https://github.com/run', steps: [] }] });
    await expect(provider.getActionDetail(99)).resolves.toMatchObject({ runId: 99, jobs: [{ status: 'success' }] });

    complete({ sha: 'abcdef1234567890', shortSha: 'abcdef1', message: 'subject', author: 'cat', date: now, url: 'https://github.com/commit', body: 'body', stats: { additions: 1, deletions: 2, filesChanged: 3 }, files: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0 }], hasMoreFiles: false });
    await expect(provider.getCommitDetail('abcdef1234567890')).resolves.toMatchObject({
      shortSha: 'abcdef1',
      stats: { filesChanged: 3 },
      files: [{ filename: 'a.ts' }],
    });

    complete({ number: 5, title: 'PR', state: 'open', author: 'ben', head: 'feature', base: 'main', url: 'https://github.com/pr', createdAt: now, updatedAt: now, reviewDecision: null, draft: false, labels: ['ready'], body: 'x'.repeat(10_005), additions: 10, deletions: 4, changedFiles: 2, comments: 3, mergeable: true, mergeableState: 'blocked' });
    const pr = await provider.getPRDetail(5);
    expect(pr).toMatchObject({ bodyTruncated: true, checksStatus: 'pending', changedFiles: 2, comments: 3 });
    expect(pr.body).toHaveLength(10_000);

    complete({ id: '9', number: 9, title: 'Issue', body: 'y'.repeat(20_010), state: 'closed', author: 'dev', labels: [], url: 'https://github.com/issue', assignee: 'dev', createdAt: now, updatedAt: now });
    complete([{ author: 'dev', body: 'z'.repeat(20_010), createdAt: now }]);
    const issue = await provider.getIssueDetail(9);
    expect(issue).toMatchObject({ state: 'closed', bodyTruncated: true, comments: [{ author: 'dev' }] });
    expect(issue.body).toHaveLength(20_000);
    expect(issue.comments[0].body).toHaveLength(20_000);
  });

  it('maps gh failures to typed repo error codes', async () => {
    const provider = new GitHubProvider('octo', 'repo', '/tmp/project');

    rejectExec({ exitCode: 4, stderr: 'auth required' });
    await expect(provider.listIssues()).rejects.toMatchObject({ code: 'unauthorized' });

    rejectExec({ exitCode: 1, stderr: 'HTTP 429 rate limit' });
    await expect(provider.listPRs()).rejects.toMatchObject({ code: 'rate_limited' });

    rejectExec({ exitCode: 1, stderr: 'boom' });
    await expect(provider.listCommits()).rejects.toMatchObject({ code: 'cli_error' });
  });
});

describe('GitLabProvider contracts', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('guards owner and repo names before shelling out', () => {
    expect(() => new GitLabProvider('group', 'repo_name', '/tmp/project')).not.toThrow();
    expect(() => new GitLabProvider('bad/group', 'repo', '/tmp/project')).toThrow('Invalid owner/repo');
    expect(() => new GitLabProvider('group', 'bad repo', '/tmp/project')).toThrow('Invalid owner/repo');
  });

  it('normalizes GitLab list, detail, and CI results', async () => {
    const provider = new GitLabProvider('group', 'repo', '/tmp/project');
    const created = '2026-05-11T00:00:00.000Z';
    const updated = '2026-05-11T00:01:00.000Z';

    complete([
      { id: 1, iid: 11, title: 'Issue', description: null, state: 'opened', author: { username: 'ana' }, labels: ['bug'], web_url: 'https://gitlab.com/group/repo/-/issues/11', assignee: { username: 'ben' }, created_at: created, updated_at: updated },
      { id: 2, iid: 12, title: 'Issue 2', description: 'closed', state: 'closed', author: {}, labels: [], web_url: 'https://gitlab.com/group/repo/-/issues/12', created_at: created, updated_at: updated },
    ]);
    const gitlabIssues = await provider.listIssues({ state: 'open', page: 4, perPage: 2 });
    expect(gitlabIssues).toMatchObject({ page: 4, hasMore: true });
    expect(gitlabIssues.items).toHaveLength(2);
    expect(gitlabIssues.items[0]).toMatchObject({ id: '1', number: 11, state: 'open', assignee: 'ben' });
    expect(execFileMock.mock.calls.at(-1)?.[1][1]).toContain('/projects/group%2Frepo/issues?');

    complete([{ iid: 7, title: 'MR', state: 'merged', author: { username: 'dev' }, source_branch: 'feature', target_branch: 'main', web_url: 'https://gitlab.com/mr', created_at: created, updated_at: updated, draft: undefined, work_in_progress: true, labels: ['ready'] }]);
    await expect(provider.listPRs({ state: 'merged', perPage: 1 })).resolves.toMatchObject({
      hasMore: true,
      items: [{ number: 7, state: 'merged', draft: true }],
    });

    complete([{ name: 'main', default: true, commit: { committed_date: updated } }, { name: 'feature', default: false, commit: null }]);
    complete('feature\n');
    await expect(provider.listBranches()).resolves.toMatchObject({
      items: [
        { name: 'main', isDefault: true, isCurrent: false },
        { name: 'feature', isDefault: false, isCurrent: true },
      ],
    });

    complete([{ id: 'abcdef1234567890', short_id: 'abcdef1', message: 'commit', author_name: 'cat', committed_date: created, web_url: 'https://gitlab.com/commit' }]);
    await expect(provider.listCommits({ branch: 'main', perPage: 1 })).resolves.toMatchObject({
      hasMore: true,
      items: [{ shortSha: 'abcdef1', author: 'cat' }],
    });

    // CI/CD pipelines → RepoWorkflowRun (status normalized; `name` from best-effort
    // commit-title enrichment, which issues one extra glab call per pipeline).
    complete([{ id: 50, iid: 5, sha: 'f00dcafef00dcafe', ref: 'main', status: 'failed', source: 'push', created_at: created, updated_at: updated, web_url: 'https://gitlab.com/group/repo/-/pipelines/50' }]);
    complete({ title: 'fix: thing' });
    await expect(provider.listActions({ perPage: 1 })).resolves.toMatchObject({
      page: 1,
      hasMore: true,
      items: [{ id: 50, name: 'fix: thing', status: 'failure', branch: 'main', commitSha: 'f00dcafe', runNumber: 5, event: 'push' }],
    });

    // Pipeline jobs → RepoActionJob, labelled "stage / name".
    complete([{ id: 8350, name: 'unit', stage: 'test', status: 'success', started_at: created, finished_at: updated, web_url: 'https://gitlab.com/job/8350' }]);
    await expect(provider.getActionDetail(123)).resolves.toMatchObject({
      runId: 123,
      jobs: [{ id: 8350, name: 'test / unit', status: 'success', steps: [] }],
    });

    complete({ id: 'abcdef1234567890', short_id: 'abcdef1', message: 'subject\n\nbody', author_name: 'cat', committed_date: created, web_url: 'https://gitlab.com/commit', stats: { additions: 4, deletions: 2, total: 6 } });
    complete([
      { new_file: true, new_path: 'new.ts' },
      { deleted_file: true, new_path: 'old.ts' },
      { renamed_file: true, new_path: 'renamed.ts' },
      { new_path: 'changed.ts' },
    ]);
    await expect(provider.getCommitDetail('abcdef1234567890')).resolves.toMatchObject({
      message: 'subject',
      body: 'body',
      stats: { filesChanged: 6 },
      files: [
        { filename: 'new.ts', status: 'added' },
        { filename: 'old.ts', status: 'removed' },
        { filename: 'renamed.ts', status: 'renamed' },
        { filename: 'changed.ts', status: 'modified' },
      ],
      hasMoreFiles: false,
    });

    complete({ iid: 7, title: 'MR', state: 'opened', author: { username: 'dev' }, source_branch: 'feature', target_branch: 'main', web_url: 'https://gitlab.com/mr', created_at: created, updated_at: updated, draft: false, description: 'x'.repeat(10_005), detailed_merge_status: 'checking', changes_count: '3', user_notes_count: 2, labels: ['ready'] });
    const pr = await provider.getPRDetail(7);
    expect(pr).toMatchObject({ state: 'open', bodyTruncated: true, mergeable: false, additions: 3, changedFiles: 3 });
    expect(pr.body).toHaveLength(10_000);

    complete({ id: 44, iid: 44, title: 'Issue', description: 'y'.repeat(20_010), state: 'closed', author: { username: 'dev' }, labels: ['triage'], web_url: 'https://gitlab.com/issue', assignee: undefined, created_at: created, updated_at: updated });
    complete([
      { system: true, body: 'skip', author: { username: 'bot' }, created_at: created },
      { system: false, body: 'z'.repeat(20_010), author: { username: 'dev' }, created_at: created },
    ]);
    const issue = await provider.getIssueDetail(44);
    expect(issue).toMatchObject({ id: '44', state: 'closed', bodyTruncated: true, comments: [{ author: 'dev' }] });
    expect(issue.body).toHaveLength(20_000);
    expect(issue.comments[0].body).toHaveLength(20_000);
  });

  it('maps glab command and payload failures to typed repo errors', async () => {
    const provider = new GitLabProvider('group', 'repo', '/tmp/project');

    complete({ message: '404 Not Found' });
    await expect(provider.listIssues()).rejects.toMatchObject({ code: 'unknown_project' });

    rejectExec({ stderr: '429 rate limit exceeded' });
    await expect(provider.getPRDetail(3)).rejects.toMatchObject({ code: 'rate_limited' });

    rejectExec({ stderr: '401 unauthorized' });
    await expect(provider.getIssueDetail(4)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
