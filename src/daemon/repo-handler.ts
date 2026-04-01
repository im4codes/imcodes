/**
 * Daemon-side WS command handler for repo.* commands.
 * Routes repo detection and list operations through cached providers.
 */

import { detectRepo } from '../repo/detector.js';
import { repoCache, RepoCache } from '../repo/cache.js';
import { GitHubProvider } from '../repo/github-provider.js';
import { GitLabProvider } from '../repo/gitlab-provider.js';
import type { RepoContext, RepoError } from '../repo/types.js';
import type { RepoProvider, ListOptions, CommitListOptions } from '../repo/provider.js';
import { listSessions } from '../store/session-store.js';
import type { ServerLink } from './server-link.js';
import logger from '../util/logger.js';
import { REPO_MSG } from '../shared/repo-types.js';

// ---------------------------------------------------------------------------
// Concurrency limiter — max 20 concurrent CLI calls per projectDir, 15s queue timeout
// ---------------------------------------------------------------------------

const MAX_CONCURRENT = 20;
const QUEUE_TIMEOUT_MS = 15_000;

interface QueueEntry {
  fn: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const inflightCounts = new Map<string, number>();
const queues = new Map<string, QueueEntry[]>();

async function withConcurrencyLimit(projectDir: string, fn: () => Promise<void>): Promise<void> {
  const current = inflightCounts.get(projectDir) ?? 0;
  if (current < MAX_CONCURRENT) {
    inflightCounts.set(projectDir, current + 1);
    try {
      await fn();
    } finally {
      release(projectDir);
    }
    return;
  }

  // Queue excess with timeout
  await new Promise<void>((resolve, reject) => {
    let q = queues.get(projectDir);
    if (!q) {
      q = [];
      queues.set(projectDir, q);
    }
    const timer = setTimeout(() => {
      // Remove from queue and reject
      const queue = queues.get(projectDir);
      if (queue) {
        const idx = queue.findIndex((e) => e.resolve === resolve);
        if (idx >= 0) queue.splice(idx, 1);
        if (queue.length === 0) queues.delete(projectDir);
      }
      reject(new Error('Queue timeout'));
    }, QUEUE_TIMEOUT_MS);
    q.push({ fn, resolve, reject, timer });
  });
}

function release(projectDir: string): void {
  const count = (inflightCounts.get(projectDir) ?? 1) - 1;
  if (count <= 0) {
    inflightCounts.delete(projectDir);
  } else {
    inflightCounts.set(projectDir, count);
  }

  const q = queues.get(projectDir);
  if (q && q.length > 0) {
    const next = q.shift()!;
    clearTimeout(next.timer);
    if (q.length === 0) queues.delete(projectDir);
    inflightCounts.set(projectDir, (inflightCounts.get(projectDir) ?? 0) + 1);
    next.fn().then(
      () => { release(projectDir); next.resolve(); },
      (err) => { release(projectDir); next.reject(err); },
    );
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_STATES = new Set(['open', 'closed', 'merged', 'all']);
const BRANCH_RE = /^[a-zA-Z0-9_./-]+$/;

function isValidState(v: unknown): v is string {
  return typeof v === 'string' && VALID_STATES.has(v);
}

function isValidBranch(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 256 && BRANCH_RE.test(v);
}

function isValidPage(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100;
}

const SHA_RE = /^[0-9a-f]{7,40}$/;
function isValidSha(v: unknown): v is string {
  return typeof v === 'string' && SHA_RE.test(v);
}

function isValidNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 999999;
}

function isValidRunId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

function validateProjectDir(projectDir: unknown): projectDir is string {
  if (typeof projectDir !== 'string' || !projectDir) return false;
  const knownDirs = new Set(listSessions().map((s) => s.projectDir));
  return knownDirs.has(projectDir);
}

// ---------------------------------------------------------------------------
// Provider factory from cached detection
// ---------------------------------------------------------------------------

function createProvider(ctx: RepoContext, projectDir: string): RepoProvider | null {
  if (!ctx.info || ctx.status !== 'ok') return null;
  const { platform, owner, repo } = ctx.info;
  if (platform === 'github') return new GitHubProvider(owner, repo, projectDir);
  if (platform === 'gitlab') return new GitLabProvider(owner, repo, projectDir);
  return null;
}

// ---------------------------------------------------------------------------
// Individual command handlers
// ---------------------------------------------------------------------------

async function handleDetect(
  cmd: Record<string, unknown>,
  serverLink: ServerLink,
): Promise<void> {
  const projectDir = cmd.projectDir as string;
  const requestId = cmd.requestId as string | undefined;

  const cacheKey = RepoCache.buildKey(projectDir, 'detect');
  const cached = repoCache.get<RepoContext>(cacheKey);
  if (cached) {
    serverLink.send({ type: REPO_MSG.DETECT_RESPONSE, requestId, projectDir, ...cached });
    return;
  }

  const ctx = await detectRepo(projectDir);
  repoCache.set(cacheKey, ctx, projectDir, ctx.status !== 'ok');
  serverLink.send({ type: REPO_MSG.DETECT_RESPONSE, requestId, projectDir, ...ctx });
}

async function handleListIssues(
  cmd: Record<string, unknown>,
  serverLink: ServerLink,
): Promise<void> {
  const projectDir = cmd.projectDir as string;
  const requestId = cmd.requestId as string | undefined;

  const opts: ListOptions = {};
  if (cmd.state !== undefined) opts.state = cmd.state as string;
  if (cmd.page !== undefined) opts.page = cmd.page as number;

  const cacheKey = RepoCache.buildKey(projectDir, 'issues', { ...opts });
  const cached = repoCache.get<unknown>(cacheKey);
  if (cached) {
    serverLink.send({ type: REPO_MSG.ISSUES_RESPONSE, requestId, ...cached as object });
    return;
  }

  const provider = await getProvider(projectDir, requestId, serverLink);
  if (!provider) return;

  try {
    const result = await provider.listIssues(opts);
    repoCache.set(cacheKey, result, projectDir);
    serverLink.send({ type: REPO_MSG.ISSUES_RESPONSE, requestId, ...result });
  } catch (err) {
    sendError(serverLink, requestId, projectDir, 'cli_error', err);
  }
}

async function handleListPRs(
  cmd: Record<string, unknown>,
  serverLink: ServerLink,
): Promise<void> {
  const projectDir = cmd.projectDir as string;
  const requestId = cmd.requestId as string | undefined;

  const opts: ListOptions = {};
  if (cmd.state !== undefined) opts.state = cmd.state as string;
  if (cmd.page !== undefined) opts.page = cmd.page as number;

  const cacheKey = RepoCache.buildKey(projectDir, 'prs', { ...opts });
  const cached = repoCache.get<unknown>(cacheKey);
  if (cached) {
    serverLink.send({ type: REPO_MSG.PRS_RESPONSE, requestId, ...cached as object });
    return;
  }

  const provider = await getProvider(projectDir, requestId, serverLink);
  if (!provider) return;

  try {
    const result = await provider.listPRs(opts);
    repoCache.set(cacheKey, result, projectDir);
    serverLink.send({ type: REPO_MSG.PRS_RESPONSE, requestId, ...result });
  } catch (err) {
    sendError(serverLink, requestId, projectDir, 'cli_error', err);
  }
}

async function handleListBranches(
  cmd: Record<string, unknown>,
  serverLink: ServerLink,
): Promise<void> {
  const projectDir = cmd.projectDir as string;
  const requestId = cmd.requestId as string | undefined;

  const cacheKey = RepoCache.buildKey(projectDir, 'branches');
  const cached = repoCache.get<unknown>(cacheKey);
  if (cached) {
    serverLink.send({ type: REPO_MSG.BRANCHES_RESPONSE, requestId, ...cached as object });
    return;
  }

  const provider = await getProvider(projectDir, requestId, serverLink);
  if (!provider) return;

  try {
    const result = await provider.listBranches();
    repoCache.set(cacheKey, result, projectDir);
    serverLink.send({ type: REPO_MSG.BRANCHES_RESPONSE, requestId, ...result });
  } catch (err) {
    sendError(serverLink, requestId, projectDir, 'cli_error', err);
  }
}

async function handleListCommits(
  cmd: Record<string, unknown>,
  serverLink: ServerLink,
): Promise<void> {
  const projectDir = cmd.projectDir as string;
  const requestId = cmd.requestId as string | undefined;

  const opts: CommitListOptions = {};
  if (cmd.branch !== undefined) opts.branch = cmd.branch as string;
  if (cmd.page !== undefined) opts.page = cmd.page as number;

  const cacheKey = RepoCache.buildKey(projectDir, 'commits', { ...opts });
  const cached = repoCache.get<unknown>(cacheKey);
  if (cached) {
    serverLink.send({ type: REPO_MSG.COMMITS_RESPONSE, requestId, ...cached as object });
    return;
  }

  const provider = await getProvider(projectDir, requestId, serverLink);
  if (!provider) return;

  try {
    const result = await provider.listCommits(opts);
    repoCache.set(cacheKey, result, projectDir);
    serverLink.send({ type: REPO_MSG.COMMITS_RESPONSE, requestId, ...result });
  } catch (err) {
    sendError(serverLink, requestId, projectDir, 'cli_error', err);
  }
}

async function handleListActions(
  cmd: Record<string, unknown>,
  serverLink: ServerLink,
): Promise<void> {
  const projectDir = cmd.projectDir as string;
  const requestId = cmd.requestId as string | undefined;

  const opts: ListOptions = {};
  if (cmd.page !== undefined) opts.page = cmd.page as number;

  const cacheKey = RepoCache.buildKey(projectDir, 'actions', { ...opts });
  const cached = repoCache.get<unknown>(cacheKey);
  if (cached) {
    serverLink.send({ type: REPO_MSG.ACTIONS_RESPONSE, requestId, ...cached as object });
    return;
  }

  const provider = await getProvider(projectDir, requestId, serverLink);
  if (!provider) return;

  try {
    const result = await provider.listActions(opts);
    repoCache.set(cacheKey, result, projectDir);
    serverLink.send({ type: REPO_MSG.ACTIONS_RESPONSE, requestId, ...result });
  } catch (err) {
    sendError(serverLink, requestId, projectDir, 'cli_error', err);
  }
}

async function handleActionDetail(
  cmd: Record<string, unknown>,
  serverLink: ServerLink,
): Promise<void> {
  const projectDir = cmd.projectDir as string;
  const requestId = cmd.requestId as string | undefined;
  const runId = cmd.runId as number;

  const cacheKey = RepoCache.buildKey(projectDir, 'action_detail', { runId });
  const cached = repoCache.get<unknown>(cacheKey);
  if (cached) {
    serverLink.send({ type: REPO_MSG.ACTION_DETAIL_RESPONSE, requestId, projectDir, detail: cached });
    return;
  }

  const provider = await getProvider(projectDir, requestId, serverLink);
  if (!provider) return;

  try {
    const result = await provider.getActionDetail(runId);
    repoCache.set(cacheKey, result, projectDir);
    serverLink.send({ type: REPO_MSG.ACTION_DETAIL_RESPONSE, requestId, projectDir, detail: result });
  } catch (err) {
    sendError(serverLink, requestId, projectDir, 'cli_error', err);
  }
}

async function handleCommitDetail(
  cmd: Record<string, unknown>,
  serverLink: ServerLink,
): Promise<void> {
  const projectDir = cmd.projectDir as string;
  const requestId = cmd.requestId as string | undefined;
  const sha = cmd.sha as string;

  const cacheKey = RepoCache.buildKey(projectDir, 'commit_detail', { sha });
  const cached = repoCache.get<unknown>(cacheKey);
  if (cached) {
    serverLink.send({ type: REPO_MSG.COMMIT_DETAIL_RESPONSE, requestId, projectDir, detail: cached });
    return;
  }

  const provider = await getProvider(projectDir, requestId, serverLink);
  if (!provider) return;

  try {
    const result = await provider.getCommitDetail(sha);
    repoCache.set(cacheKey, result, projectDir, false, Infinity);
    serverLink.send({ type: REPO_MSG.COMMIT_DETAIL_RESPONSE, requestId, projectDir, detail: result });
  } catch (err) {
    sendError(serverLink, requestId, projectDir, 'cli_error', err);
  }
}

async function handlePRDetail(
  cmd: Record<string, unknown>,
  serverLink: ServerLink,
): Promise<void> {
  const projectDir = cmd.projectDir as string;
  const requestId = cmd.requestId as string | undefined;
  const num = cmd.number as number;

  const cacheKey = RepoCache.buildKey(projectDir, 'pr_detail', { number: num });
  const cached = repoCache.get<unknown>(cacheKey);
  if (cached) {
    serverLink.send({ type: REPO_MSG.PR_DETAIL_RESPONSE, requestId, projectDir, detail: cached });
    return;
  }

  const provider = await getProvider(projectDir, requestId, serverLink);
  if (!provider) return;

  try {
    const result = await provider.getPRDetail(num);
    repoCache.set(cacheKey, result, projectDir);
    serverLink.send({ type: REPO_MSG.PR_DETAIL_RESPONSE, requestId, projectDir, detail: result });
  } catch (err) {
    sendError(serverLink, requestId, projectDir, 'cli_error', err);
  }
}

async function handleIssueDetail(
  cmd: Record<string, unknown>,
  serverLink: ServerLink,
): Promise<void> {
  const projectDir = cmd.projectDir as string;
  const requestId = cmd.requestId as string | undefined;
  const num = cmd.number as number;

  const cacheKey = RepoCache.buildKey(projectDir, 'issue_detail', { number: num });
  const cached = repoCache.get<unknown>(cacheKey);
  if (cached) {
    serverLink.send({ type: REPO_MSG.ISSUE_DETAIL_RESPONSE, requestId, projectDir, detail: cached });
    return;
  }

  const provider = await getProvider(projectDir, requestId, serverLink);
  if (!provider) return;

  try {
    const result = await provider.getIssueDetail(num);
    repoCache.set(cacheKey, result, projectDir);
    serverLink.send({ type: REPO_MSG.ISSUE_DETAIL_RESPONSE, requestId, projectDir, detail: result });
  } catch (err) {
    sendError(serverLink, requestId, projectDir, 'cli_error', err);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Resolve a RepoProvider from the detection cache (or run fresh detection). */
async function getProvider(
  projectDir: string,
  requestId: string | undefined,
  serverLink: ServerLink,
): Promise<RepoProvider | null> {
  const detectKey = RepoCache.buildKey(projectDir, 'detect');
  let ctx = repoCache.get<RepoContext>(detectKey);
  if (!ctx) {
    ctx = await detectRepo(projectDir);
    repoCache.set(detectKey, ctx, projectDir, ctx.status !== 'ok');
  }

  const provider = createProvider(ctx, projectDir);
  if (!provider) {
    serverLink.send({
      type: REPO_MSG.ERROR,
      requestId,
      error: 'not_detected' as RepoError,
      status: ctx.status,
    });
    return null;
  }
  return provider;
}

/** Extract typed error code from provider errors, fall back to default. */
function extractErrorCode(err: unknown, fallback: RepoError): RepoError {
  if (typeof err === 'string') return err as RepoError;
  if (err && typeof err === 'object' && 'code' in err && typeof (err as any).code === 'string') {
    return (err as any).code as RepoError;
  }
  return fallback;
}

function sendError(
  serverLink: ServerLink,
  requestId: string | undefined,
  projectDir: string,
  fallbackError: RepoError,
  err?: unknown,
): void {
  const error = err ? extractErrorCode(err, fallbackError) : fallbackError;
  if (err) {
    logger.error({ err }, `repo handler: ${error}`);
  }
  serverLink.send({ type: REPO_MSG.ERROR, requestId, projectDir, error });
}

// ---------------------------------------------------------------------------
// Main exported handler
// ---------------------------------------------------------------------------

export function handleRepoCommand(cmd: Record<string, unknown>, serverLink: ServerLink): void {
  const requestId = cmd.requestId as string | undefined;
  const projectDir = cmd.projectDir;

  // projectDir validation for all commands
  if (!validateProjectDir(projectDir)) {
    logger.debug({ projectDir, knownDirs: listSessions().map((s) => s.projectDir) }, 'repo: projectDir validation failed');
    serverLink.send({ type: REPO_MSG.ERROR, requestId, projectDir, error: 'invalid_params' as RepoError });
    return;
  }

  // Input schema validation
  if (cmd.state !== undefined && !isValidState(cmd.state)) {
    serverLink.send({ type: REPO_MSG.ERROR, requestId, projectDir, error: 'invalid_params' as RepoError });
    return;
  }
  if (cmd.branch !== undefined && !isValidBranch(cmd.branch)) {
    serverLink.send({ type: REPO_MSG.ERROR, requestId, projectDir, error: 'invalid_params' as RepoError });
    return;
  }
  if (cmd.page !== undefined && !isValidPage(cmd.page)) {
    serverLink.send({ type: REPO_MSG.ERROR, requestId, projectDir, error: 'invalid_params' as RepoError });
    return;
  }
  if (cmd.sha !== undefined && !isValidSha(cmd.sha)) {
    serverLink.send({ type: REPO_MSG.ERROR, requestId, projectDir, error: 'invalid_params' as RepoError });
    return;
  }
  if (cmd.number !== undefined && !isValidNumber(cmd.number)) {
    serverLink.send({ type: REPO_MSG.ERROR, requestId, projectDir, error: 'invalid_params' as RepoError });
    return;
  }
  if (cmd.runId !== undefined && !isValidRunId(cmd.runId)) {
    serverLink.send({ type: REPO_MSG.ERROR, requestId, projectDir, error: 'invalid_params' as RepoError });
    return;
  }

  // Strip any browser-sent provider field
  delete cmd.provider;

  // Force refresh: invalidate cache for this projectDir before re-fetching
  if (cmd.force === true) {
    repoCache.invalidate(projectDir as string);
  }

  const run = async (): Promise<void> => {
    switch (cmd.type) {
      case REPO_MSG.DETECT:
        await handleDetect(cmd, serverLink);
        break;
      case REPO_MSG.LIST_ISSUES:
        await handleListIssues(cmd, serverLink);
        break;
      case REPO_MSG.LIST_PRS:
        await handleListPRs(cmd, serverLink);
        break;
      case REPO_MSG.LIST_BRANCHES:
        await handleListBranches(cmd, serverLink);
        break;
      case REPO_MSG.LIST_COMMITS:
        await handleListCommits(cmd, serverLink);
        break;
      case REPO_MSG.LIST_ACTIONS:
        await handleListActions(cmd, serverLink);
        break;
      case REPO_MSG.ACTION_DETAIL:
        await handleActionDetail(cmd, serverLink);
        break;
      case REPO_MSG.COMMIT_DETAIL:
        await handleCommitDetail(cmd, serverLink);
        break;
      case REPO_MSG.PR_DETAIL:
        await handlePRDetail(cmd, serverLink);
        break;
      case REPO_MSG.ISSUE_DETAIL:
        await handleIssueDetail(cmd, serverLink);
        break;
      default:
        logger.warn({ type: cmd.type }, 'repo: unknown subcommand');
    }
  };

  void withConcurrencyLimit(projectDir as string, run).catch((err) => {
    logger.error({ err, type: cmd.type }, 'repo handler failed');
    serverLink.send({ type: REPO_MSG.ERROR, requestId, projectDir, error: 'cli_error' as RepoError });
  });
}
