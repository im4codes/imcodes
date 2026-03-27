import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitLabTracker } from '../../src/tracker/gitlab.js';

const config = {
  token: 'glpat_test',
  projectId: '123',
};

function mockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(response),
  });
}

describe('GitLabTracker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('fetchIssues', () => {
    it('calls correct GitLab API endpoint', async () => {
      const fetchMock = mockFetch([]);
      vi.stubGlobal('fetch', fetchMock);
      const tracker = new GitLabTracker(config);
      await tracker.fetchIssues();
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/api/v4/projects/123/issues');
    });

    it('encodes project path for namespace/project format', async () => {
      const fetchMock = mockFetch([]);
      vi.stubGlobal('fetch', fetchMock);
      const tracker = new GitLabTracker({ ...config, projectId: 'mygroup/myproject' });
      await tracker.fetchIssues();
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('mygroup%2Fmyproject');
    });

    it('maps GitLab issues to TrackerIssue', async () => {
      const glIssues = [
        {
          iid: 7,
          title: 'Add feature',
          description: 'Some description',
          state: 'opened',
          web_url: 'https://gitlab.com/mygroup/myproject/-/issues/7',
          labels: ['p2', 'enhancement'],
          assignees: [{ username: 'bob' }],
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
        },
      ];
      vi.stubGlobal('fetch', mockFetch(glIssues));
      const tracker = new GitLabTracker(config);
      const issues = await tracker.fetchIssues();
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        id: '7',
        title: 'Add feature',
        body: 'Some description',
        priority: 2,
        labels: ['p2', 'enhancement'],
        assignee: 'bob',
        state: 'open',
      });
    });

    it('maps "opened" state to "open"', async () => {
      vi.stubGlobal('fetch', mockFetch([{
        iid: 1, title: 'T', description: null, state: 'opened',
        web_url: '', labels: [], assignees: [],
        created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
      }]));
      const tracker = new GitLabTracker(config);
      const issues = await tracker.fetchIssues();
      expect(issues[0].state).toBe('open');
    });

    it('uses status=closed param correctly', async () => {
      const fetchMock = mockFetch([]);
      vi.stubGlobal('fetch', fetchMock);
      const tracker = new GitLabTracker(config);
      await tracker.fetchIssues({ status: 'closed' });
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('state=closed');
    });
  });

  describe('claimIssue', () => {
    it('adds in-progress label', async () => {
      const fetchMock = mockFetch({});
      vi.stubGlobal('fetch', fetchMock);
      const tracker = new GitLabTracker(config);
      await tracker.claimIssue('7');
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/issues/7');
      expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.add_labels).toBe('in-progress');
    });
  });

  describe('postComment', () => {
    it('posts note to correct endpoint', async () => {
      const fetchMock = mockFetch({ id: 1 });
      vi.stubGlobal('fetch', fetchMock);
      const tracker = new GitLabTracker(config);
      await tracker.postComment('7', 'Review done');
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/issues/7/notes');
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.body).toBe('Review done');
    });
  });

  describe('updateStatus', () => {
    it('reopen uses state_event', async () => {
      const fetchMock = mockFetch({});
      vi.stubGlobal('fetch', fetchMock);
      const tracker = new GitLabTracker(config);
      await tracker.updateStatus('7', 'open');
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.state_event).toBe('reopen');
    });

    it('in-progress adds label', async () => {
      const fetchMock = mockFetch({});
      vi.stubGlobal('fetch', fetchMock);
      const tracker = new GitLabTracker(config);
      await tracker.updateStatus('7', 'in-progress');
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.add_labels).toBe('in-progress');
    });
  });

  describe('closeIssue', () => {
    it('posts comment then closes issue', async () => {
      const fetchMock = mockFetch({});
      vi.stubGlobal('fetch', fetchMock);
      const tracker = new GitLabTracker(config);
      await tracker.closeIssue('7', 'Done');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // First: comment
      expect(fetchMock.mock.calls[0][0]).toContain('/notes');
      // Second: close
      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.state_event).toBe('close');
    });
  });

  describe('custom apiUrl', () => {
    it('uses self-hosted GitLab URL', async () => {
      const fetchMock = mockFetch([]);
      vi.stubGlobal('fetch', fetchMock);
      const tracker = new GitLabTracker({ ...config, apiUrl: 'https://gitlab.example.com' });
      await tracker.fetchIssues();
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('gitlab.example.com/api/v4');
    });
  });
});
