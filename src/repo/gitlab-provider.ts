/** GitLab RepoProvider — read-only, uses `glab api`. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  RepoBranch,
  RepoCommit,
  RepoCommitDetail,
  RepoCommitDetailFile,
  RepoError,
  RepoIssue,
  RepoIssueComment,
  RepoIssueDetail,
  RepoPR,
  RepoPRDetail,
  RepoListResult,
  RepoActionDetail,
  RepoWorkflowRun,
} from './types.js';
import type {
  CommitListOptions,
  ListOptions,
  RepoProvider,
} from './provider.js';
import { DEFAULT_PAGE_SIZE } from './provider.js';

const execFileAsync = promisify(execFile);

/** Map GitLab issue/MR state strings to our normalized states. */
function mapIssueState(state: string): 'open' | 'closed' {
  return state === 'opened' ? 'open' : 'closed';
}

function mapMRState(state: string): 'open' | 'merged' | 'closed' {
  if (state === 'opened') return 'open';
  if (state === 'merged') return 'merged';
  return 'closed';
}

/** Translate glab stderr into a typed RepoError. */
function translateError(stderr: string): RepoError {
  const lower = stderr.toLowerCase();
  if (lower.includes('auth') || lower.includes('401')) return 'unauthorized';
  if (lower.includes('rate limit') || lower.includes('429')) return 'rate_limited';
  if (lower.includes('404') || lower.includes('not found')) return 'unknown_project';
  return 'cli_error';
}

const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

function repoError(code: RepoError): Error {
  const error = new Error(`glab error: ${code}`);
  (error as { code?: RepoError }).code = code;
  return error;
}

function translatePayloadError(payload: unknown): RepoError {
  if (!payload || typeof payload !== 'object') return 'cli_error';
  const message = (payload as { message?: unknown; error?: unknown }).message
    ?? (payload as { error?: unknown }).error
    ?? '';
  const lower = String(message).toLowerCase();
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('auth')) return 'unauthorized';
  if (lower.includes('429') || lower.includes('rate limit')) return 'rate_limited';
  if (lower.includes('404') || lower.includes('not found')) return 'unknown_project';
  return 'cli_error';
}

function parseGitLabArray(raw: string): any[] {
  const payload = JSON.parse(raw || '[]');
  if (Array.isArray(payload)) return payload;
  throw repoError(translatePayloadError(payload));
}

export class GitLabProvider implements RepoProvider {
  private readonly encodedProject: string;

  constructor(
    private readonly owner: string,
    private readonly repo: string,
    private readonly projectDir: string,
  ) {
    if (!SAFE_NAME_RE.test(owner) || !SAFE_NAME_RE.test(repo)) {
      throw new Error(`Invalid owner/repo: ${owner}/${repo}`);
    }
    this.encodedProject = encodeURIComponent(`${owner}/${repo}`);
  }

  /* ------------------------------------------------------------------ */
  /*  detect() — not implemented here; use detectRepo() from detector   */
  /* ------------------------------------------------------------------ */

  async detect() {
    const { detectRepo } = await import('./detector.js');
    return detectRepo(this.projectDir);
  }

  /* ------------------------------------------------------------------ */
  /*  Issues                                                             */
  /* ------------------------------------------------------------------ */

  async listIssues(opts?: ListOptions): Promise<RepoListResult<RepoIssue>> {
    const page = opts?.page ?? 1;
    const perPage = opts?.perPage ?? DEFAULT_PAGE_SIZE;

    const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    if (opts?.state) params.set('state', opts.state === 'open' ? 'opened' : opts.state);

    const raw = await this.glab(['api', `/projects/${this.encodedProject}/issues?${params}`]);
    const data = parseGitLabArray(raw);

    const items: RepoIssue[] = data.map((i) => ({
      id: String(i.id),
      number: i.iid,
      title: i.title,
      body: i.description ?? '',
      state: mapIssueState(i.state),
      author: i.author?.username ?? '',
      labels: (i.labels ?? []) as string[],
      url: i.web_url,
      assignee: i.assignee?.username,
      createdAt: new Date(i.created_at).getTime(),
      updatedAt: new Date(i.updated_at).getTime(),
    }));

    return { items, page, hasMore: data.length === perPage, projectDir: this.projectDir };
  }

  /* ------------------------------------------------------------------ */
  /*  Merge Requests (PRs)                                               */
  /* ------------------------------------------------------------------ */

  async listPRs(opts?: ListOptions): Promise<RepoListResult<RepoPR>> {
    const page = opts?.page ?? 1;
    const perPage = opts?.perPage ?? DEFAULT_PAGE_SIZE;

    const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    if (opts?.state) params.set('state', opts.state === 'open' ? 'opened' : opts.state);

    const raw = await this.glab(['api', `/projects/${this.encodedProject}/merge_requests?${params}`]);
    const data = parseGitLabArray(raw);

    const items: RepoPR[] = data.map((mr) => ({
      number: mr.iid,
      title: mr.title,
      state: mapMRState(mr.state),
      author: mr.author?.username ?? '',
      head: mr.source_branch,
      base: mr.target_branch,
      url: mr.web_url,
      createdAt: new Date(mr.created_at).getTime(),
      updatedAt: new Date(mr.updated_at).getTime(),
      draft: mr.draft ?? mr.work_in_progress ?? false,
      labels: (mr.labels ?? []) as string[],
    }));

    return { items, page, hasMore: data.length === perPage, projectDir: this.projectDir };
  }

  /* ------------------------------------------------------------------ */
  /*  Branches                                                           */
  /* ------------------------------------------------------------------ */

  async listBranches(): Promise<RepoListResult<RepoBranch>> {
    const raw = await this.glab(['api', `/projects/${this.encodedProject}/repository/branches?per_page=${DEFAULT_PAGE_SIZE}`]);
    const data = parseGitLabArray(raw);

    // Determine current branch via git
    let currentBranch: string | undefined;
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
        cwd: this.projectDir,
        timeout: 3000,
      });
      currentBranch = stdout.trim() || undefined;
    } catch {
      // ignore
    }

    const items: RepoBranch[] = data.map((b) => ({
      name: b.name,
      isDefault: b.default ?? false,
      isCurrent: b.name === currentBranch,
      lastCommitDate: b.commit?.committed_date
        ? new Date(b.commit.committed_date).getTime()
        : undefined,
    }));

    return { items, page: 1, hasMore: data.length === DEFAULT_PAGE_SIZE, projectDir: this.projectDir };
  }

  /* ------------------------------------------------------------------ */
  /*  Commits                                                            */
  /* ------------------------------------------------------------------ */

  async listCommits(opts?: CommitListOptions): Promise<RepoListResult<RepoCommit>> {
    const page = opts?.page ?? 1;
    const perPage = opts?.perPage ?? DEFAULT_PAGE_SIZE;

    const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    if (opts?.branch) params.set('ref_name', opts.branch);

    const raw = await this.glab(['api', `/projects/${this.encodedProject}/repository/commits?${params}`]);
    const data = parseGitLabArray(raw);

    const items: RepoCommit[] = data.map((c) => ({
      sha: c.id,
      shortSha: c.short_id,
      message: c.message,
      author: c.author_name ?? '',
      date: new Date(c.committed_date ?? c.created_at).getTime(),
      url: c.web_url,
    }));

    return { items, page, hasMore: data.length === perPage, projectDir: this.projectDir };
  }

  /* ------------------------------------------------------------------ */
  /*  Actions (pipelines) — stub                                         */
  /* ------------------------------------------------------------------ */

  async listActions(_opts?: ListOptions): Promise<RepoListResult<RepoWorkflowRun>> {
    return { items: [], page: 1, hasMore: false, projectDir: this.projectDir };
  }

  async getActionDetail(runId: number): Promise<RepoActionDetail> {
    return { runId, jobs: [] };
  }

  /* ------------------------------------------------------------------ */
  /*  getCommitDetail                                                    */
  /* ------------------------------------------------------------------ */

  async getCommitDetail(sha: string): Promise<RepoCommitDetail> {
    const [commitRaw, diffRaw] = await Promise.all([
      this.glab(['api', `/projects/${this.encodedProject}/repository/commits/${sha}`]),
      this.glab(['api', `/projects/${this.encodedProject}/repository/commits/${sha}/diff`]),
    ]);

    const c = JSON.parse(commitRaw);
    const diffs: any[] = JSON.parse(diffRaw);

    const messageParts = (c.message ?? '').split('\n');
    const message = messageParts[0] ?? '';
    const body = messageParts.slice(1).join('\n').replace(/^\n/, '');

    const files: RepoCommitDetailFile[] = diffs.slice(0, 100).map((d: any) => {
      let status = 'modified';
      if (d.new_file) status = 'added';
      else if (d.deleted_file) status = 'removed';
      else if (d.renamed_file) status = 'renamed';
      return { filename: d.new_path, status };
    });

    return {
      sha: c.id,
      shortSha: c.short_id,
      message,
      author: c.author_name ?? '',
      date: new Date(c.committed_date ?? c.created_at).getTime(),
      url: c.web_url,
      body,
      stats: {
        additions: c.stats?.additions ?? 0,
        deletions: c.stats?.deletions ?? 0,
        filesChanged: c.stats?.total ?? diffs.length,
      },
      files,
      hasMoreFiles: diffs.length > 100,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  getPRDetail                                                        */
  /* ------------------------------------------------------------------ */

  async getPRDetail(num: number): Promise<RepoPRDetail> {
    const raw = await this.glab(['api', `/projects/${this.encodedProject}/merge_requests/${num}`]);
    const mr = JSON.parse(raw);

    const MAX_BODY = 10_000;
    const rawBody = mr.description ?? '';
    const bodyTruncated = rawBody.length > MAX_BODY;
    const body = bodyTruncated ? rawBody.slice(0, MAX_BODY) : rawBody;

    const mergeable = mr.detailed_merge_status === 'mergeable' ? true
      : mr.detailed_merge_status ? false
      : null;

    return {
      number: mr.iid,
      title: mr.title,
      state: mapMRState(mr.state),
      author: mr.author?.username ?? '',
      head: mr.source_branch,
      base: mr.target_branch,
      url: mr.web_url,
      createdAt: new Date(mr.created_at).getTime(),
      updatedAt: new Date(mr.updated_at).getTime(),
      draft: mr.draft ?? mr.work_in_progress ?? false,
      labels: (mr.labels ?? []) as string[],
      body,
      bodyTruncated,
      checksStatus: 'none',
      additions: mr.changes_count ? parseInt(mr.changes_count, 10) || 0 : 0,
      deletions: 0,
      changedFiles: mr.changes_count ? parseInt(mr.changes_count, 10) || 0 : 0,
      comments: mr.user_notes_count ?? 0,
      mergeable,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  getIssueDetail                                                     */
  /* ------------------------------------------------------------------ */

  async getIssueDetail(num: number): Promise<RepoIssueDetail> {
    const [issueRaw, notesRaw] = await Promise.all([
      this.glab(['api', `/projects/${this.encodedProject}/issues/${num}`]),
      this.glab(['api', `/projects/${this.encodedProject}/issues/${num}/notes?per_page=20&sort=asc`]),
    ]);

    const i = JSON.parse(issueRaw);
    const notes: any[] = JSON.parse(notesRaw);

    const MAX_BODY = 20_000;
    const rawBody = i.description ?? '';
    const bodyTruncated = rawBody.length > MAX_BODY;
    const body = bodyTruncated ? rawBody.slice(0, MAX_BODY) : rawBody;

    const MAX_COMMENT = 20_000;
    const comments: RepoIssueComment[] = notes
      .filter((n: any) => !n.system)
      .map((n: any) => {
        const commentBody = n.body ?? '';
        return {
          author: n.author?.username ?? '',
          body: commentBody.length > MAX_COMMENT ? commentBody.slice(0, MAX_COMMENT) : commentBody,
          createdAt: new Date(n.created_at).getTime(),
        };
      });

    return {
      id: String(i.id),
      number: i.iid,
      title: i.title,
      body,
      state: mapIssueState(i.state),
      author: i.author?.username ?? '',
      labels: (i.labels ?? []) as string[],
      url: i.web_url,
      assignee: i.assignee?.username,
      createdAt: new Date(i.created_at).getTime(),
      updatedAt: new Date(i.updated_at).getTime(),
      comments,
      bodyTruncated,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Internal: run glab                                                 */
  /* ------------------------------------------------------------------ */

  private async glab(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('glab', args, {
        cwd: this.projectDir,
        timeout: 15_000, maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch (err: any) {
      const stderr: string = err?.stderr ?? err?.message ?? '';
      const code = translateError(stderr);
      throw repoError(code);
    }
  }
}
