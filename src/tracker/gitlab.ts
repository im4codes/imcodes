/**
 * GitLab issue tracker adapter.
 * Uses REST API — supports gitlab.com + self-hosted (custom apiUrl).
 */
import type { IssueTracker, TrackerIssue, FetchIssueOptions } from './interface.js';
import { extractPriority, sortByPriority } from './priority.js';

export interface GitLabTrackerConfig {
  /** API URL — defaults to https://gitlab.com for gitlab.com */
  apiUrl?: string;
  /** Personal access token */
  token: string;
  /** Project ID or "namespace/project-path" */
  projectId: string | number;
}

export class GitLabTracker implements IssueTracker {
  private apiBase: string;
  private headers: Record<string, string>;
  private projectId: string | number;

  constructor(config: GitLabTrackerConfig) {
    this.apiBase = `${(config.apiUrl ?? 'https://gitlab.com').replace(/\/$/, '')}/api/v4`;
    this.headers = {
      'PRIVATE-TOKEN': config.token,
      'Content-Type': 'application/json',
    };
    this.projectId = config.projectId;
  }

  private get encodedProjectId(): string {
    return encodeURIComponent(String(this.projectId));
  }

  async fetchIssues(opts: FetchIssueOptions = {}): Promise<TrackerIssue[]> {
    const params = new URLSearchParams({
      state: opts.status === 'closed' ? 'closed' : 'opened',
      per_page: String(opts.limit ?? 50),
    });
    if (opts.labels?.length) params.set('labels', opts.labels.join(','));
    if (opts.milestone) params.set('milestone', opts.milestone);
    if (opts.assignedToMe) params.set('assignee_id', 'me');

    const issues = await this.get<GitLabIssue[]>(`/projects/${this.encodedProjectId}/issues?${params}`);

    const mapped = issues.map((i): TrackerIssue => ({
      id: String(i.iid),
      title: i.title,
      body: i.description ?? '',
      priority: extractPriority(i.labels),
      labels: i.labels,
      url: i.web_url,
      assignee: i.assignees?.[0]?.username,
      state: i.state === 'opened' ? 'open' : 'closed',
      createdAt: new Date(i.created_at).getTime(),
      updatedAt: new Date(i.updated_at).getTime(),
    }));

    return sortByPriority(mapped);
  }

  async claimIssue(issueId: string): Promise<void> {
    await this.addLabel(issueId, 'in-progress');
  }

  async updateStatus(issueId: string, status: 'in-progress' | 'review' | 'open' | 'done'): Promise<void> {
    if (status === 'open') {
      await this.put(`/projects/${this.encodedProjectId}/issues/${issueId}`, {
        state_event: 'reopen',
      });
      return;
    }
    const labelMap: Record<string, string> = {
      'in-progress': 'in-progress',
      review: 'review',
      done: 'done',
    };
    const label = labelMap[status];
    if (label) await this.addLabel(issueId, label);
  }

  async postComment(issueId: string, body: string): Promise<void> {
    await this.post(`/projects/${this.encodedProjectId}/issues/${issueId}/notes`, { body });
  }

  async closeIssue(issueId: string, resolution?: string): Promise<void> {
    if (resolution) {
      await this.postComment(issueId, resolution);
    }
    await this.put(`/projects/${this.encodedProjectId}/issues/${issueId}`, {
      state_event: 'close',
    });
  }

  async createBranch(issueId: string, branchName: string, fromBranch = 'main'): Promise<void> {
    await this.post(`/projects/${this.encodedProjectId}/repository/branches`, {
      branch: branchName,
      ref: fromBranch,
    });
  }

  // ── HTTP helpers ────────────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, { headers: this.headers });
    if (!res.ok) throw new Error(`GitLab API GET ${path}: ${res.status}`);
    return res.json() as Promise<T>;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GitLab API POST ${path}: ${res.status}`);
    return res.json();
  }

  private async put(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GitLab API PUT ${path}: ${res.status}`);
    return res.json();
  }

  private async addLabel(issueId: string, label: string): Promise<void> {
    await this.put(`/projects/${this.encodedProjectId}/issues/${issueId}`, {
      add_labels: label,
    });
  }
}

// ── GitLab API types (minimal) ────────────────────────────────────────────────

interface GitLabIssue {
  iid: number;
  title: string;
  description: string | null;
  state: string;
  web_url: string;
  labels: string[];
  assignees: Array<{ username: string }>;
  created_at: string;
  updated_at: string;
}
