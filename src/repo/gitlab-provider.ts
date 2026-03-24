/** GitLab RepoProvider — read-only, uses `glab api`. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  RepoBranch,
  RepoCommit,
  RepoError,
  RepoIssue,
  RepoPR,
  RepoListResult,
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
  return 'cli_error';
}

const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

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
    const data: any[] = JSON.parse(raw);

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
    const data: any[] = JSON.parse(raw);

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
    const data: any[] = JSON.parse(raw);

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
    const data: any[] = JSON.parse(raw);

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
      const error = new Error(`glab error: ${code}`);
      (error as any).code = code;
      throw error;
    }
  }
}
