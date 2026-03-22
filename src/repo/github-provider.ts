/** GitHub RepoProvider — uses `gh api` (REST) via execFile. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  RepoContext,
  RepoListResult,
  RepoIssue,
  RepoPR,
  RepoBranch,
  RepoCommit,
  RepoError,
} from './types.js';
import type { RepoProvider, ListOptions, CommitListOptions } from './provider.js';
import { DEFAULT_PAGE_SIZE } from './provider.js';
import { detectRepo } from './detector.js';

const execFileAsync = promisify(execFile);

/** Translate gh CLI failures into typed RepoError. */
function translateError(err: unknown): RepoError {
  if (err && typeof err === 'object') {
    const e = err as { code?: number; exitCode?: number; stderr?: string };
    const exitCode = e.exitCode ?? e.code;
    const stderr = e.stderr ?? '';

    if (exitCode === 4 || /auth/i.test(stderr)) return 'unauthorized';
    if (/403|429|rate.?limit/i.test(stderr)) return 'rate_limited';
  }
  return 'cli_error';
}

const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

export class GitHubProvider implements RepoProvider {
  constructor(
    private readonly owner: string,
    private readonly repo: string,
    private readonly projectDir: string,
  ) {
    if (!SAFE_NAME_RE.test(owner) || !SAFE_NAME_RE.test(repo)) {
      throw new Error(`Invalid owner/repo: ${owner}/${repo}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  detect                                                             */
  /* ------------------------------------------------------------------ */

  async detect(projectDir: string): Promise<RepoContext> {
    return detectRepo(projectDir);
  }

  /* ------------------------------------------------------------------ */
  /*  listIssues                                                         */
  /* ------------------------------------------------------------------ */

  async listIssues(opts?: ListOptions): Promise<RepoListResult<RepoIssue>> {
    const page = opts?.page ?? 1;
    const perPage = opts?.perPage ?? DEFAULT_PAGE_SIZE;
    const state = opts?.state ?? 'open';

    const jq = `[.[] | select(.pull_request == null) | {id: (.id | tostring), number, title, body: (.body // ""), state, author: .user.login, labels: [.labels[].name], url: .html_url, assignee: (.assignee.login // null), createdAt: (.created_at | fromdateiso8601), updatedAt: (.updated_at | fromdateiso8601)}]`;

    try {
      const { stdout } = await execFileAsync('gh', [
        'api',
        `/repos/${this.owner}/${this.repo}/issues?state=${state}&per_page=${perPage}&page=${page}`,
        '-q', jq,
      ], { cwd: this.projectDir, timeout: 15000, maxBuffer: 10 * 1024 * 1024 });

      const items: RepoIssue[] = JSON.parse(stdout || '[]');
      return { items, page, hasMore: items.length === perPage, projectDir: this.projectDir };
    } catch (err) {
      const code = translateError(err);
      const error = new Error(`gh error: ${code}`);
      (error as any).code = code;
      throw error;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  listPRs                                                            */
  /* ------------------------------------------------------------------ */

  async listPRs(opts?: ListOptions): Promise<RepoListResult<RepoPR>> {
    const page = opts?.page ?? 1;
    const perPage = opts?.perPage ?? DEFAULT_PAGE_SIZE;
    const state = opts?.state ?? 'open';

    const jq = `[.[] | {number, title, state: (if .merged_at then "merged" elif .state == "closed" then "closed" else "open" end), author: .user.login, head: .head.ref, base: .base.ref, url: .html_url, createdAt: (.created_at | fromdateiso8601), updatedAt: (.updated_at | fromdateiso8601), reviewDecision: null, draft: .draft, labels: [.labels[].name]}]`;

    try {
      const { stdout } = await execFileAsync('gh', [
        'api',
        `/repos/${this.owner}/${this.repo}/pulls?state=${state}&per_page=${perPage}&page=${page}`,
        '-q', jq,
      ], { cwd: this.projectDir, timeout: 15000, maxBuffer: 10 * 1024 * 1024 });

      const items: RepoPR[] = JSON.parse(stdout || '[]');
      return { items, page, hasMore: items.length === perPage, projectDir: this.projectDir };
    } catch (err) {
      const code = translateError(err);
      const error = new Error(`gh error: ${code}`);
      (error as any).code = code;
      throw error;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  listBranches                                                       */
  /* ------------------------------------------------------------------ */

  async listBranches(): Promise<RepoListResult<RepoBranch>> {
    try {
      // Fetch branches, current branch, and default branch in parallel
      const [branchesResult, currentResult, defaultResult] = await Promise.all([
        execFileAsync('gh', [
          'api',
          `/repos/${this.owner}/${this.repo}/branches?per_page=100`,
          '-q', `[.[] | {name, lastCommitDate: (.commit.commit.committer.date | fromdateiso8601)}]`,
        ], { cwd: this.projectDir, timeout: 15000 }),

        execFileAsync('git', [
          'branch', '--show-current',
        ], { cwd: this.projectDir, timeout: 3000 }).catch(() => ({ stdout: '' })),

        execFileAsync('gh', [
          'api',
          `/repos/${this.owner}/${this.repo}`,
          '-q', '.default_branch',
        ], { cwd: this.projectDir, timeout: 10000 }).catch(() => ({ stdout: '' })),
      ]);

      const currentBranch = currentResult.stdout.trim();
      const defaultBranch = defaultResult.stdout.trim();

      const raw: Array<{ name: string; lastCommitDate?: number }> = JSON.parse(branchesResult.stdout || '[]');

      const items: RepoBranch[] = raw.map((b) => ({
        name: b.name,
        isDefault: b.name === defaultBranch,
        isCurrent: b.name === currentBranch,
        lastCommitDate: b.lastCommitDate,
      }));

      return { items, page: 1, hasMore: items.length === 100, projectDir: this.projectDir };
    } catch (err) {
      const code = translateError(err);
      const error = new Error(`gh error: ${code}`);
      (error as any).code = code;
      throw error;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  listCommits                                                        */
  /* ------------------------------------------------------------------ */

  async listCommits(opts?: CommitListOptions): Promise<RepoListResult<RepoCommit>> {
    const page = opts?.page ?? 1;
    const perPage = opts?.perPage ?? DEFAULT_PAGE_SIZE;

    const jq = `[.[] | {sha, shortSha: .sha[:7], message: .commit.message, author: (.commit.author.name // .author.login // "unknown"), date: (.commit.author.date | fromdateiso8601), url: .html_url}]`;

    const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    if (opts?.branch) params.set('sha', opts.branch);

    const args = [
      'api',
      `/repos/${this.owner}/${this.repo}/commits?${params}`,
      '-q', jq,
    ];

    try {
      const { stdout } = await execFileAsync('gh', args, {
        cwd: this.projectDir,
        timeout: 15000,
      });

      const items: RepoCommit[] = JSON.parse(stdout || '[]');
      return { items, page, hasMore: items.length === perPage, projectDir: this.projectDir };
    } catch (err) {
      const code = translateError(err);
      const error = new Error(`gh error: ${code}`);
      (error as any).code = code;
      throw error;
    }
  }
}
