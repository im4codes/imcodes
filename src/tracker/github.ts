/**
 * GitHub issue tracker adapter.
 * Uses octokit — supports github.com + GitHub Enterprise (custom apiUrl).
 */
import type { IssueTracker, TrackerIssue, FetchIssueOptions } from './interface.js';
import { extractPriority, sortByPriority } from './priority.js';

export interface GitHubTrackerConfig {
  /** API URL — defaults to https://api.github.com for github.com */
  apiUrl?: string;
  /** Personal access token or App token */
  token: string;
  /** Owner/repo e.g. "myorg/myrepo" */
  repo: string;
}

export class GitHubTracker implements IssueTracker {
  private apiBase: string;
  private headers: Record<string, string>;
  private owner: string;
  private repo: string;

  constructor(config: GitHubTrackerConfig) {
    this.apiBase = (config.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.headers = {
      'Authorization': `Bearer ${config.token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const [owner, repo] = config.repo.split('/');
    this.owner = owner;
    this.repo = repo;
  }

  async fetchIssues(opts: FetchIssueOptions = {}): Promise<TrackerIssue[]> {
    const params = new URLSearchParams({
      state: opts.status === 'closed' ? 'closed' : 'open',
      per_page: String(opts.limit ?? 50),
    });
    if (opts.labels?.length) params.set('labels', opts.labels.join(','));
    if (opts.milestone) params.set('milestone', opts.milestone);
    if (opts.assignedToMe) params.set('assignee', '@me');

    const res = await this.get(`/repos/${this.owner}/${this.repo}/issues?${params}`);
    const issues = res as GitHubIssue[];

    const mapped = issues.map((i): TrackerIssue => ({
      id: String(i.number),
      title: i.title,
      body: i.body ?? '',
      priority: extractPriority(i.labels.map((l) => l.name)),
      labels: i.labels.map((l) => l.name),
      url: i.html_url,
      assignee: i.assignee?.login,
      state: i.state === 'open' ? 'open' : 'closed',
      createdAt: new Date(i.created_at).getTime(),
      updatedAt: new Date(i.updated_at).getTime(),
    }));

    return sortByPriority(mapped);
  }

  async claimIssue(issueId: string): Promise<void> {
    await this.addLabel(issueId, 'in-progress');
  }

  async updateStatus(issueId: string, status: 'in-progress' | 'review' | 'open' | 'done'): Promise<void> {
    const labelMap: Record<string, string> = {
      'in-progress': 'in-progress',
      'review': 'review',
      'done': 'done',
    };
    const label = labelMap[status];
    if (label) await this.addLabel(issueId, label);
  }

  async postComment(issueId: string, body: string): Promise<void> {
    await this.post(`/repos/${this.owner}/${this.repo}/issues/${issueId}/comments`, { body });
  }

  async closeIssue(issueId: string, resolution?: string): Promise<void> {
    if (resolution) {
      await this.postComment(issueId, resolution);
    }
    await this.patch(`/repos/${this.owner}/${this.repo}/issues/${issueId}`, {
      state: 'closed',
      state_reason: 'completed',
    });
  }

  async createBranch(issueId: string, branchName: string, fromBranch = 'main'): Promise<void> {
    // Get base branch SHA
    const ref = await this.get(`/repos/${this.owner}/${this.repo}/git/ref/heads/${fromBranch}`);
    const sha = (ref as { object: { sha: string } }).object.sha;

    await this.post(`/repos/${this.owner}/${this.repo}/git/refs`, {
      ref: `refs/heads/${branchName}`,
      sha,
    });
  }

  // ── HTTP helpers ────────────────────────────────────────────────────────────

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.apiBase}${path}`, { headers: this.headers });
    if (!res.ok) throw new Error(`GitHub API GET ${path}: ${res.status}`);
    return res.json();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GitHub API POST ${path}: ${res.status}`);
    return res.json();
  }

  private async patch(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GitHub API PATCH ${path}: ${res.status}`);
    return res.json();
  }

  private async addLabel(issueId: string, label: string): Promise<void> {
    await this.post(`/repos/${this.owner}/${this.repo}/issues/${issueId}/labels`, {
      labels: [label],
    });
  }
}

// ── GitHub API types (minimal) ────────────────────────────────────────────────

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels: Array<{ name: string }>;
  assignee: { login: string } | null;
  created_at: string;
  updated_at: string;
}
