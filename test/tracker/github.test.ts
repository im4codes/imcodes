import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubTracker } from '../../src/tracker/github.js';

const config = {
  token: 'ghp_test',
  repo: 'myorg/myrepo',
};

function mockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(response),
  });
}

describe('GitHubTracker', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = mockFetch([]);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('fetchIssues', () => {
    it('calls correct GitHub API endpoint', async () => {
      fetchMock = mockFetch([]);
      vi.stubGlobal('fetch', fetchMock);
      const tracker = new GitHubTracker(config);
      await tracker.fetchIssues();
      expect(fetchMock).toHaveBeenCalledOnce();
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/repos/myorg/myrepo/issues');
    });

    it('maps GitHub issues to TrackerIssue', async () => {
      const ghIssues = [
        {
          number: 42,
          title: 'Fix bug',
          body: 'Description',
          state: 'open',
          html_url: 'https://github.com/myorg/myrepo/issues/42',
          labels: [{ name: 'p1' }, { name: 'bug' }],
          assignee: { login: 'alice' },
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
        },
      ];
      vi.stubGlobal('fetch', mockFetch(ghIssues));
      const tracker = new GitHubTracker(config);
      const issues = await tracker.fetchIssues();
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        id: '42',
        title: 'Fix bug',
        body: 'Description',
        priority: 1,
        labels: ['p1', 'bug'],
        assignee: 'alice',
        state: 'open',
        url: 'https://github.com/myorg/myrepo/issues/42',
      });
    });

    it('passes status=closed param', async () => {
      const stub = mockFetch([]);
      vi.stubGlobal('fetch', stub);
      const tracker = new GitHubTracker(config);
      await tracker.fetchIssues({ status: 'closed' });
      const url = stub.mock.calls[0][0] as string;
      expect(url).toContain('state=closed');
    });

    it('passes label filter', async () => {
      const stub = mockFetch([]);
      vi.stubGlobal('fetch', stub);
      const tracker = new GitHubTracker(config);
      await tracker.fetchIssues({ labels: ['bug', 'p1'] });
      const url = stub.mock.calls[0][0] as string;
      expect(url).toContain('labels=bug%2Cp1');
    });

    it('sorts by priority', async () => {
      const ghIssues = [
        { number: 1, title: 'low', body: '', state: 'open', html_url: '', labels: [{ name: 'low' }], assignee: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
        { number: 2, title: 'critical', body: '', state: 'open', html_url: '', labels: [{ name: 'critical' }], assignee: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
      ];
      vi.stubGlobal('fetch', mockFetch(ghIssues));
      const tracker = new GitHubTracker(config);
      const issues = await tracker.fetchIssues();
      expect(issues[0].priority).toBe(0); // critical first
      expect(issues[1].priority).toBe(3); // low second
    });
  });

  describe('claimIssue', () => {
    it('adds in-progress label', async () => {
      const stub = mockFetch({ ok: true });
      vi.stubGlobal('fetch', stub);
      const tracker = new GitHubTracker(config);
      await tracker.claimIssue('42');
      expect(stub).toHaveBeenCalledOnce();
      const url = stub.mock.calls[0][0] as string;
      expect(url).toContain('/issues/42/labels');
      const body = JSON.parse(stub.mock.calls[0][1].body);
      expect(body.labels).toContain('in-progress');
    });
  });

  describe('postComment', () => {
    it('posts to correct endpoint', async () => {
      const stub = mockFetch({ id: 1 });
      vi.stubGlobal('fetch', stub);
      const tracker = new GitHubTracker(config);
      await tracker.postComment('42', 'Review complete');
      const url = stub.mock.calls[0][0] as string;
      expect(url).toContain('/issues/42/comments');
      const body = JSON.parse(stub.mock.calls[0][1].body);
      expect(body.body).toBe('Review complete');
    });
  });

  describe('closeIssue', () => {
    it('closes issue and posts resolution comment', async () => {
      const stub = mockFetch({ id: 1 });
      vi.stubGlobal('fetch', stub);
      const tracker = new GitHubTracker(config);
      await tracker.closeIssue('42', 'Resolved via PR #10');
      expect(stub).toHaveBeenCalledTimes(2);
      // First call: comment
      expect(stub.mock.calls[0][0]).toContain('/comments');
      // Second call: close
      expect(stub.mock.calls[1][0]).toContain('/issues/42');
      const body = JSON.parse(stub.mock.calls[1][1].body);
      expect(body.state).toBe('closed');
    });

    it('closes without comment when no resolution', async () => {
      const stub = mockFetch({});
      vi.stubGlobal('fetch', stub);
      const tracker = new GitHubTracker(config);
      await tracker.closeIssue('42');
      expect(stub).toHaveBeenCalledTimes(1);
    });
  });

  describe('createBranch', () => {
    it('fetches base branch SHA then creates ref', async () => {
      const getRefResponse = { object: { sha: 'abc123' } };
      let callCount = 0;
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(callCount === 1 ? getRefResponse : { ref: 'refs/heads/fix/42' }),
        });
      }));
      const tracker = new GitHubTracker(config);
      await tracker.createBranch('42', 'fix/42-test', 'main');
      expect(callCount).toBe(2);
    });
  });

  describe('custom apiUrl', () => {
    it('uses custom GitHub Enterprise URL', async () => {
      const stub = mockFetch([]);
      vi.stubGlobal('fetch', stub);
      const tracker = new GitHubTracker({ ...config, apiUrl: 'https://github.example.com/api/v3' });
      await tracker.fetchIssues();
      const url = stub.mock.calls[0][0] as string;
      expect(url).toContain('github.example.com');
    });
  });
});
