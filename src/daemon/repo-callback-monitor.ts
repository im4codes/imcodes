import { randomUUID } from 'node:crypto';
import {
  CALLBACK_SOURCES,
  buildCallbackId,
  type CallbackTaskRecord,
} from '../../shared/callback-types.js';
import { CHAT_MESSAGE_ORIGINS } from '../../shared/chat-message-origin.js';
import { MEMORY_MCP_SEND_DELIVERY_MODES } from '../../shared/memory-mcp-contracts.js';
import {
  REPO_CALLBACK_EVENTS,
  REPO_CALLBACK_RECENT_HISTORY_LIMIT,
  REPO_CALLBACK_TARGET_BRAIN,
  buildRepoCallbackDedupKey,
  normalizeRepoCallbackGlobalPrefs,
  normalizeRepoCallbackServerPrefs,
  renderRepoCallbackPrompt,
  resolveRepoCallbackPromptTemplate,
  type RepoCallbackEventType,
  type RepoCallbackPromptContext,
  type RepoCallbackRepoConfig,
  type RepoCallbackTemplate,
} from '../../shared/repo-callback.js';
import { REPO_MSG } from '../../shared/repo-types.js';
import { FS_SESSION_ROOT_PATH } from '../shared/transport/fs.js';
import { createSendDispatchId, createSendMessageId } from '../../shared/send-message-id.js';
import { resolveEffectiveProjectName } from '../../shared/session-scope.js';
import { loadCredentials } from '../bind/bind-flow.js';
import { detectRepo } from '../repo/detector.js';
import { GitHubProvider } from '../repo/github-provider.js';
import { GitLabProvider } from '../repo/gitlab-provider.js';
import type { RepoProvider } from '../repo/provider.js';
import type { RepoActionDetail, RepoContext, RepoIssue, RepoPR, RepoWorkflowRun } from '../repo/types.js';
import { listSessions, type SessionRecord } from '../store/session-store.js';
import logger from '../util/logger.js';
import { getCallbackTaskStore, type CallbackPendingSeqEntry, type CallbackTaskStore } from './callback-task-store.js';
import type { ServerLink } from './server-link.js';
import { dispatchSessionMessage } from './session-dispatch.js';
import { projectBrainSession } from './task-pairs/engine.js';

const DEFAULT_CONFIG_SYNC_INTERVAL_MS = 120_000;
const DEFAULT_POLL_TICK_MS = 15_000;
const FETCH_TIMEOUT_MS = 15_000;
export const REPO_CALLBACK_DEFAULT_PER_PAGE = 30;
export const REPO_CALLBACK_DEFAULT_MAX_PAGES_PER_POLL = 5;
export const REPO_CALLBACK_DEFAULT_MAX_BASELINE_PAGES = 100;
export const REPO_CALLBACK_MAX_DETAIL_FETCHES_PER_POLL = 10;
const PENDING_RUN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED_PENDING_RUNS = 50;

const FAILED_CI_CONCLUSIONS = new Set([
  'failure',
  'failed',
  'timed_out',
  'startup_failure',
]);

const PENDING_CI_CONCLUSIONS = new Set([
  'queued',
  'in_progress',
  'running',
  'pending',
  'waiting_for_resource',
  'preparing',
  'created',
  'scheduled',
]);

interface DetectedEventCandidate {
  eventType: RepoCallbackEventType;
  entityKey: string;
  dedupKey: string;
  title: string;
  url: string;
  number: string;
  author: string;
  branch: string;
  status: string;
  conclusion: string;
  details: string;
  metadata: Record<string, unknown>;
}

interface PollPageItem {
  seq: number;
  pending: boolean;
  runAttempt?: number;
  createdAtMs?: number;
  dedupKey: string;
  candidate?: DetectedEventCandidate;
}

export interface RepoCallbackMonitorDeps {
  store?: CallbackTaskStore;
  getServerLink?: () => ServerLink | null;
  loadCreds?: () => Promise<{ serverId: string; token: string; workerUrl: string } | null>;
  fetchImpl?: typeof fetch;
  detect?: (projectDir: string) => Promise<RepoContext>;
  createProvider?: (ctx: RepoContext, projectDir: string) => RepoProvider | null;
  listSessions?: () => SessionRecord[];
  sendToSession?: (sessionName: string, text: string, record?: SessionRecord) => Promise<void>;
  now?: () => number;
  configSyncIntervalMs?: number;
  pollTickMs?: number;
  perPage?: number;
  maxPagesPerPoll?: number;
  maxBaselinePages?: number;
  maxDetailFetchesPerPoll?: number;
}

function defaultCreateProvider(ctx: RepoContext, projectDir: string): RepoProvider | null {
  if (!ctx.info || ctx.status !== 'ok') return null;
  if (ctx.info.platform === 'github') return new GitHubProvider(ctx.info.owner, ctx.info.repo, projectDir);
  if (ctx.info.platform === 'gitlab') return new GitLabProvider(ctx.info.owner, ctx.info.repo, projectDir);
  return null;
}

async function defaultSendToSession(sessionName: string, text: string, resolvedRecord?: SessionRecord): Promise<void> {
  const target = resolvedRecord ?? listSessions().find((s) => s.name === sessionName);
  if (!target) {
    throw new Error(`target session not found: ${sessionName}`);
  }
  await dispatchSessionMessage(target, text, {
    dispatchId: createSendDispatchId(),
    messageId: createSendMessageId(),
    deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.QUEUE,
    messageOrigin: CHAT_MESSAGE_ORIGINS.SYSTEM,
  });
}

/**
 * Classify CI workflow run, job, or step outcomes.
 * Prefer explicit raw `conclusion` whenever present because normalized provider statuses
 * (e.g. GitHubProvider) map non-success/non-cancelled outcomes like `skipped` or `neutral`
 * to `status='failure'`. Fall back to `status === 'failure'` only when no conclusion exists.
 */
export function isFailedCiOutcome(status: string, conclusion?: string | null): boolean {
  const rawConclusion = typeof conclusion === 'string' ? conclusion.trim().toLowerCase() : '';
  if (rawConclusion) {
    return FAILED_CI_CONCLUSIONS.has(rawConclusion);
  }
  return status.trim().toLowerCase() === 'failure';
}

function isPendingWorkflowRun(run: RepoWorkflowRun): boolean {
  if (run.status === 'queued' || run.status === 'running') return true;
  const rawConclusion = typeof run.conclusion === 'string' ? run.conclusion.trim().toLowerCase() : '';
  return rawConclusion ? PENDING_CI_CONCLUSIONS.has(rawConclusion) : false;
}

function isFailedWorkflowRun(run: RepoWorkflowRun): boolean {
  return isFailedCiOutcome(run.status, run.conclusion);
}

function toTimestampMs(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function prunePendingMap(pendingMap: Map<number, number | undefined>, nowMs: number): CallbackPendingSeqEntry[] {
  const entries: CallbackPendingSeqEntry[] = [];
  for (const [seq, createdAt] of pendingMap) {
    if (createdAt !== undefined && nowMs - createdAt > PENDING_RUN_TTL_MS) {
      continue;
    }
    entries.push(createdAt !== undefined ? { seq, createdAt } : { seq });
  }
  entries.sort((a, b) => b.seq - a.seq);
  return entries.slice(0, MAX_TRACKED_PENDING_RUNS);
}

function formatActionFailureDetails(run: RepoWorkflowRun, detail: RepoActionDetail | null): string {
  const lines: string[] = [];
  if (run.headCommitMessage || run.commitMessage) {
    lines.push(`Commit: ${(run.commitSha ?? '').slice(0, 7)} ${(run.headCommitMessage ?? run.commitMessage).split('\n')[0] ?? ''}`.trim());
  }
  if (run.event) {
    lines.push(`Trigger: ${run.event}${run.workflowPath ? ` (${run.workflowPath})` : ''}`);
  }
  if (detail && detail.jobs.length > 0) {
    const failedJobs = detail.jobs.filter((job) => isFailedCiOutcome(job.status, job.conclusion));
    for (const job of failedJobs.slice(0, 5)) {
      const failedSteps = job.steps
        .filter((step) => isFailedCiOutcome(step.status, step.conclusion))
        .map((step) => `${step.number}. ${step.name}`);
      lines.push(
        failedSteps.length > 0
          ? `Failed job "${job.name}" -> steps: ${failedSteps.join(', ')}`
          : `Failed job "${job.name}" (${job.conclusion ?? job.status})`,
      );
    }
  }
  return lines.join('\n') || 'CI run failed.';
}

export class RepoCallbackMonitor {
  private readonly store: CallbackTaskStore;
  private readonly getServerLink: () => ServerLink | null;
  private readonly loadCreds: () => Promise<{ serverId: string; token: string; workerUrl: string } | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly detect: (projectDir: string) => Promise<RepoContext>;
  private readonly createProviderFn: (ctx: RepoContext, projectDir: string) => RepoProvider | null;
  private readonly listSessionsFn: () => SessionRecord[];
  private readonly sendToSession: (sessionName: string, text: string, record?: SessionRecord) => Promise<void>;
  private readonly now: () => number;
  private readonly configSyncIntervalMs: number;
  private readonly pollTickMs: number;
  private readonly perPage: number;
  private readonly maxPagesPerPoll: number;
  private readonly maxBaselinePages: number;
  private readonly maxDetailFetchesPerPoll: number;

  private globalTemplates: RepoCallbackTemplate[] = [];
  private repoConfigs = new Map<string, RepoCallbackRepoConfig>();
  private lastPollAt = new Map<string, number>();
  private lastErrorByProject = new Map<string, string>();
  private inFlightProjects = new Set<string>();
  private unsubscribeStore: (() => void) | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private refreshPromise: Promise<boolean> | null = null;
  private started = false;

  constructor(deps: RepoCallbackMonitorDeps = {}) {
    this.store = deps.store ?? getCallbackTaskStore();
    this.getServerLink = deps.getServerLink ?? (() => null);
    this.loadCreds = deps.loadCreds ?? loadCredentials;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.detect = deps.detect ?? detectRepo;
    this.createProviderFn = deps.createProvider ?? defaultCreateProvider;
    this.listSessionsFn = deps.listSessions ?? listSessions;
    this.sendToSession = deps.sendToSession ?? defaultSendToSession;
    this.now = deps.now ?? (() => Date.now());
    this.configSyncIntervalMs = deps.configSyncIntervalMs ?? DEFAULT_CONFIG_SYNC_INTERVAL_MS;
    this.pollTickMs = deps.pollTickMs ?? DEFAULT_POLL_TICK_MS;
    this.perPage = Math.max(1, deps.perPage ?? REPO_CALLBACK_DEFAULT_PER_PAGE);
    this.maxPagesPerPoll = Math.max(1, deps.maxPagesPerPoll ?? REPO_CALLBACK_DEFAULT_MAX_PAGES_PER_POLL);
    this.maxBaselinePages = Math.max(1, deps.maxBaselinePages ?? REPO_CALLBACK_DEFAULT_MAX_BASELINE_PAGES);
    this.maxDetailFetchesPerPoll = Math.max(0, deps.maxDetailFetchesPerPoll ?? REPO_CALLBACK_MAX_DETAIL_FETCHES_PER_POLL);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribeStore = this.store.onCallbackUpdated(CALLBACK_SOURCES.REPO, (record) => {
      this.broadcastCallbackEvent(record);
    });
    this.syncTimer = setInterval(() => {
      void this.refreshConfig({ pollNewlyEnabled: true });
    }, this.configSyncIntervalMs);
    this.syncTimer.unref?.();
    this.pollTimer = setInterval(() => {
      void this.pollDueRepos();
    }, this.pollTickMs);
    this.pollTimer.unref?.();
  }

  stop(): void {
    this.started = false;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
  }

  setConfigsForTesting(payload: { globalTemplates?: RepoCallbackTemplate[]; repos?: Record<string, RepoCallbackRepoConfig> }): void {
    if (payload.globalTemplates) this.globalTemplates = [...payload.globalTemplates];
    if (payload.repos) {
      this.repoConfigs.clear();
      for (const [dir, cfg] of Object.entries(payload.repos)) {
        this.repoConfigs.set(dir, cfg);
      }
    }
  }

  getRepoConfig(projectDir: string): RepoCallbackRepoConfig | undefined {
    return this.repoConfigs.get(projectDir);
  }

  getRecentCallbacks(projectDir: string, limit = REPO_CALLBACK_RECENT_HISTORY_LIMIT): CallbackTaskRecord[] {
    return this.store.listCallbacks({
      source: CALLBACK_SOURCES.REPO,
      scopeKey: projectDir,
      limit,
    });
  }

  private broadcastCallbackEvent(record: CallbackTaskRecord): void {
    const serverLink = this.getServerLink();
    if (!serverLink) return;
    try {
      serverLink.send({
        type: REPO_MSG.CALLBACK_EVENT,
        projectDir: record.scopeKey,
        callback: record,
      });
    } catch {
      // Best-effort live UI push; SQLite remains authoritative.
    }
  }

  async refreshConfig(options: { pollNewlyEnabled?: boolean } = {}): Promise<boolean> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefreshConfig(options).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefreshConfig(options: { pollNewlyEnabled?: boolean }): Promise<boolean> {
    try {
      const creds = await this.loadCreds();
      if (!creds?.workerUrl || !creds?.serverId || !creds?.token) {
        return false;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await this.fetchImpl(
          `${creds.workerUrl}/api/server/${creds.serverId}/repo-callbacks/daemon`,
          {
            headers: {
              Authorization: `Bearer ${creds.token}`,
              'X-Server-Id': creds.serverId,
            },
            signal: controller.signal,
          },
        );
      } finally {
        clearTimeout(timeout);
      }
      if (!res.ok) {
        logger.debug({ status: res.status }, 'repo-callback-monitor: config fetch returned non-ok');
        return false;
      }
      const body = (await res.json()) as { globalTemplates?: unknown; repos?: unknown };
      const globalPrefs = normalizeRepoCallbackGlobalPrefs({ version: 1, templates: body.globalTemplates });
      const serverPrefs = normalizeRepoCallbackServerPrefs({ version: 1, repos: body.repos });

      const previouslyEnabled = new Set<string>();
      for (const [dir, cfg] of this.repoConfigs) {
        if (cfg.enabled) previouslyEnabled.add(dir);
      }

      this.globalTemplates = globalPrefs.templates;
      this.repoConfigs.clear();
      const newlyEnabledDirs: string[] = [];
      for (const [dir, cfg] of Object.entries(serverPrefs.repos)) {
        this.repoConfigs.set(dir, cfg);
        if (cfg.enabled && !previouslyEnabled.has(dir)) {
          newlyEnabledDirs.push(dir);
        }
      }

      if (options.pollNewlyEnabled && newlyEnabledDirs.length > 0) {
        for (const dir of newlyEnabledDirs) {
          void this.checkProject(dir);
        }
      }
      return true;
    } catch (err) {
      logger.debug({ err }, 'repo-callback-monitor: config refresh failed');
      return false;
    }
  }

  async pollDueRepos(): Promise<void> {
    const now = this.now();
    const due: string[] = [];
    for (const [projectDir, cfg] of this.repoConfigs) {
      if (!cfg.enabled) continue;
      const last = this.lastPollAt.get(projectDir) ?? 0;
      if (now - last >= cfg.intervalMs) {
        due.push(projectDir);
      }
    }
    for (const projectDir of due) {
      await this.checkProject(projectDir);
    }
  }

  async checkProject(projectDir: string): Promise<{ checked: boolean; dispatched: number; error?: string }> {
    const config = this.repoConfigs.get(projectDir);
    if (!config || !config.enabled) {
      return { checked: false, dispatched: 0 };
    }
    if (this.inFlightProjects.has(projectDir)) {
      return { checked: false, dispatched: 0 };
    }
    this.inFlightProjects.add(projectDir);
    try {
      const enabledEvents = REPO_CALLBACK_EVENTS.filter((eventType) => config.events[eventType]?.enabled);
      if (enabledEvents.length === 0) {
        this.lastPollAt.set(projectDir, this.now());
        this.lastErrorByProject.delete(projectDir);
        return { checked: true, dispatched: 0 };
      }

      const ctx = await this.detect(projectDir);
      const provider = this.createProviderFn(ctx, projectDir);
      if (!provider || !ctx.info || ctx.status !== 'ok') {
        const errMsg = `repo unavailable (${ctx.status})`;
        this.lastErrorByProject.set(projectDir, errMsg);
        this.lastPollAt.set(projectDir, this.now());
        return { checked: false, dispatched: 0, error: errMsg };
      }

      const repoSlug = `${ctx.info.owner}/${ctx.info.repo}`;
      let dispatched = 0;
      const eventErrors: string[] = [];

      for (const eventType of enabledEvents) {
        try {
          dispatched += await this.pollEventWithCheckpoint(
            provider,
            config,
            repoSlug,
            projectDir,
            eventType,
          );
        } catch (err) {
          // Never write anything into callback_seen or advance checkpoint past a failed page.
          const msg = err instanceof Error ? err.message : String(err);
          eventErrors.push(`${eventType}: ${msg}`);
          logger.warn({ err, projectDir, eventType }, 'repo-callback-monitor: event poll failed');
        }
      }

      this.lastPollAt.set(projectDir, this.now());
      if (eventErrors.length > 0) {
        const joined = eventErrors.join('; ');
        this.lastErrorByProject.set(projectDir, joined);
        return { checked: true, dispatched, error: joined };
      }
      this.lastErrorByProject.delete(projectDir);
      return { checked: true, dispatched };
    } finally {
      this.inFlightProjects.delete(projectDir);
    }
  }

  private async pollEventWithCheckpoint(
    provider: RepoProvider,
    config: RepoCallbackRepoConfig,
    repoSlug: string,
    projectDir: string,
    eventType: RepoCallbackEventType,
  ): Promise<number> {
    const checkpoint = this.store.getCheckpoint(CALLBACK_SOURCES.REPO, projectDir, eventType);
    const pendingMap = new Map<number, number | undefined>();
    for (const entry of checkpoint?.pendingSeqs ?? []) {
      pendingMap.set(entry.seq, entry.createdAt);
    }

    // 1. Cold-start / resumable historical baseline sweep (never sets baselineComplete=true
    // until pagination completes or archival cap is reached without error).
    if (!checkpoint || !checkpoint.baselineComplete) {
      let currentPage = checkpoint?.baselineNextPage ?? 1;
      let watermarkSeq = checkpoint?.watermarkSeq ?? null;
      let pagesFetched = 0;

      while (pagesFetched < this.maxPagesPerPoll) {
        const pageResult = await this.fetchEventPage(provider, projectDir, eventType, currentPage);
        pagesFetched += 1;

        const dedupKeysToMark: string[] = [];
        for (const item of pageResult.items) {
          if (currentPage === 1 || watermarkSeq === null) {
            watermarkSeq = watermarkSeq === null ? item.seq : Math.max(watermarkSeq, item.seq);
          }
          if (item.pending) {
            pendingMap.set(item.seq, item.createdAtMs);
          } else {
            pendingMap.delete(item.seq);
            dedupKeysToMark.push(item.dedupKey);
          }
        }

        const reachedEnd = !pageResult.hasMore || pageResult.items.length === 0 || currentPage >= this.maxBaselinePages;
        const nextPending = prunePendingMap(pendingMap, this.now());
        this.store.saveCheckpointProgress(
          {
            source: CALLBACK_SOURCES.REPO,
            scopeKey: projectDir,
            eventType,
            baselineComplete: reachedEnd,
            baselineNextPage: reachedEnd ? 1 : currentPage + 1,
            watermarkSeq: reachedEnd ? (watermarkSeq ?? 0) : watermarkSeq,
            syncNextPage: 1,
            syncHighSeq: null,
            pendingSeqs: nextPending,
            updatedAt: this.now(),
          },
          dedupKeysToMark,
        );

        if (reachedEnd) break;
        currentPage += 1;
      }
      return 0;
    }

    // 2. Steady-state incremental & resumable multi-page polling.
    const watermarkSeq = checkpoint.watermarkSeq ?? 0;
    let currentPage = checkpoint.syncNextPage;
    let syncHighSeq = checkpoint.syncHighSeq;
    let pagesFetched = 0;
    let detailFetches = 0;
    let dispatched = 0;

    while (pagesFetched < this.maxPagesPerPoll) {
      const pageResult = await this.fetchEventPage(provider, projectDir, eventType, currentPage);
      pagesFetched += 1;

      let minSeqOnPage: number | null = null;
      const pageCandidates: DetectedEventCandidate[] = [];

      for (const item of pageResult.items) {
        if (currentPage === 1) {
          syncHighSeq = syncHighSeq === null ? item.seq : Math.max(syncHighSeq, item.seq);
        }
        minSeqOnPage = minSeqOnPage === null ? item.seq : Math.min(minSeqOnPage, item.seq);

        if (item.pending) {
          pendingMap.set(item.seq, item.createdAtMs);
          continue;
        }

        const wasTrackedPending = pendingMap.delete(item.seq);
        if (!item.candidate) {
          continue;
        }
        if (this.store.hasSeenDedupKey(CALLBACK_SOURCES.REPO, item.dedupKey)) {
          continue;
        }
        const isAboveWatermark = item.seq > watermarkSeq;
        const isCiRerun = eventType === 'ci_failed' && (item.runAttempt ?? 1) > 1;
        if (!isAboveWatermark && !wasTrackedPending && !isCiRerun) {
          continue;
        }
        pageCandidates.push(item.candidate);
      }

      for (const candidate of pageCandidates) {
        if (
          eventType === 'ci_failed'
          && typeof candidate.metadata.runId === 'number'
          && detailFetches < this.maxDetailFetchesPerPoll
        ) {
          detailFetches += 1;
          try {
            const detail = await provider.getActionDetail(candidate.metadata.runId);
            candidate.details = formatActionFailureDetails(
              candidate.metadata._run as RepoWorkflowRun,
              detail,
            );
          } catch {
            // Keep summary details already computed from run metadata.
          }
        }
        delete candidate.metadata._run;

        // Mark seen immediately before dispatch so overlapping ticks or errors after send never double-fire.
        this.store.markSeenDedupKeys(CALLBACK_SOURCES.REPO, projectDir, [candidate.dedupKey], this.now());
        await this.dispatchCandidate(config, repoSlug, candidate);
        dispatched += 1;
      }

      const nextPending = prunePendingMap(pendingMap, this.now());
      const oldestPendingSeq = nextPending.length > 0
        ? Math.min(...nextPending.map((entry) => entry.seq))
        : Infinity;
      const stopSeqThreshold = Math.min(watermarkSeq, oldestPendingSeq - 1);
      const reachedWatermark =
        pageResult.items.length === 0
        || !pageResult.hasMore
        || (minSeqOnPage !== null && minSeqOnPage <= stopSeqThreshold);

      this.store.saveCheckpointProgress({
        source: CALLBACK_SOURCES.REPO,
        scopeKey: projectDir,
        eventType,
        baselineComplete: true,
        baselineNextPage: 1,
        watermarkSeq: reachedWatermark ? Math.max(watermarkSeq, syncHighSeq ?? watermarkSeq) : watermarkSeq,
        syncNextPage: reachedWatermark ? 1 : currentPage + 1,
        syncHighSeq: reachedWatermark ? null : syncHighSeq,
        pendingSeqs: nextPending,
        updatedAt: this.now(),
      });

      if (reachedWatermark) break;
      currentPage += 1;
    }

    return dispatched;
  }

  private async fetchEventPage(
    provider: RepoProvider,
    projectDir: string,
    eventType: RepoCallbackEventType,
    page: number,
  ): Promise<{ items: PollPageItem[]; hasMore: boolean }> {
    if (eventType === 'pr_new') {
      const res = await provider.listPRs({ state: 'all', page, perPage: this.perPage });
      return {
        hasMore: res.hasMore,
        items: res.items.map((pr: RepoPR) => ({
          seq: pr.number,
          pending: false,
          createdAtMs: toTimestampMs(pr.createdAt),
          dedupKey: buildRepoCallbackDedupKey(projectDir, 'pr_new', String(pr.number)),
          candidate: {
            eventType: 'pr_new',
            entityKey: `pr#${pr.number}`,
            dedupKey: buildRepoCallbackDedupKey(projectDir, 'pr_new', String(pr.number)),
            title: `PR #${pr.number}: ${pr.title}`,
            url: pr.url,
            number: String(pr.number),
            author: pr.author,
            branch: `${pr.head} -> ${pr.base}`,
            status: pr.state,
            conclusion: pr.reviewDecision ?? '',
            details: pr.draft ? 'Draft PR' : (pr.state === 'open' ? 'Open PR' : `PR (${pr.state})`),
            metadata: { number: pr.number, head: pr.head, base: pr.base, state: pr.state },
          },
        })),
      };
    }

    if (eventType === 'issue_new') {
      const res = await provider.listIssues({ state: 'all', page, perPage: this.perPage });
      return {
        hasMore: res.hasMore,
        items: res.items.map((issue: RepoIssue) => ({
          seq: issue.number,
          pending: false,
          createdAtMs: toTimestampMs(issue.createdAt),
          dedupKey: buildRepoCallbackDedupKey(projectDir, 'issue_new', String(issue.number)),
          candidate: {
            eventType: 'issue_new',
            entityKey: `issue#${issue.number}`,
            dedupKey: buildRepoCallbackDedupKey(projectDir, 'issue_new', String(issue.number)),
            title: `Issue #${issue.number}: ${issue.title}`,
            url: issue.url,
            number: String(issue.number),
            author: issue.author,
            branch: '',
            status: issue.state,
            conclusion: '',
            details: issue.labels.length > 0
              ? `Labels: ${issue.labels.join(', ')}`
              : (issue.state === 'open' ? 'Open issue' : `Issue (${issue.state})`),
            metadata: { number: issue.number, labels: issue.labels, state: issue.state },
          },
        })),
      };
    }

    const res = await provider.listActions({ page, perPage: this.perPage });
    return {
      hasMore: res.hasMore,
      items: res.items.map((run: RepoWorkflowRun) => {
        const attempt = run.runAttempt ?? 1;
        const attemptStr = String(attempt);
        const dedupKey = buildRepoCallbackDedupKey(projectDir, 'ci_failed', String(run.id), attemptStr);
        const pending = isPendingWorkflowRun(run);
        const failed = !pending && isFailedWorkflowRun(run);
        return {
          seq: run.id,
          pending,
          runAttempt: attempt,
          createdAtMs: toTimestampMs(run.createdAt),
          dedupKey,
          candidate: failed
            ? {
                eventType: 'ci_failed',
                entityKey: `run#${run.id}#${attemptStr}`,
                dedupKey,
                title: `CI failed: ${run.name}`,
                url: run.url,
                number: String(run.runNumber ?? run.id),
                author: run.actor,
                branch: run.branch,
                status: run.status,
                conclusion: run.conclusion ?? 'failure',
                details: formatActionFailureDetails(run, null),
                metadata: {
                  runId: run.id,
                  runAttempt: attempt,
                  branch: run.branch,
                  commitSha: run.commitSha,
                  _run: run,
                },
              }
            : undefined,
        };
      }),
    };
  }

  private resolveTargetSession(config: RepoCallbackRepoConfig): { sessionName: string; record?: SessionRecord; error?: string } {
    const sessions = this.listSessionsFn();
    const projectSessions = sessions.filter((s) => s.projectDir === config.projectDir);
    const brainRecord = projectSessions.find((s) => s.role === 'brain');
    const inferredProjectName = brainRecord?.projectName
      ?? projectSessions.map((s) => resolveEffectiveProjectName(s, sessions)).find(Boolean);

    const requested = config.target.trim();
    if (!requested || requested === REPO_CALLBACK_TARGET_BRAIN) {
      if (brainRecord) {
        return { sessionName: brainRecord.name, record: brainRecord };
      }
      if (inferredProjectName) {
        const fallbackName = projectBrainSession(inferredProjectName);
        const fallbackRecord = sessions.find((s) => s.name === fallbackName);
        if (fallbackRecord) return { sessionName: fallbackRecord.name, record: fallbackRecord };
        return { sessionName: fallbackName, error: `Brain session not found for project ${inferredProjectName}` };
      }
      return { sessionName: REPO_CALLBACK_TARGET_BRAIN, error: `No session found for ${config.projectDir}` };
    }

    const exact = sessions.find((s) => (
      s.name === requested
      && (
        s.projectDir === config.projectDir
        || (inferredProjectName !== undefined && resolveEffectiveProjectName(s, sessions) === inferredProjectName)
      )
    ));
    if (!exact) {
      return { sessionName: requested, error: `Target session ${requested} is unavailable in ${config.projectDir}` };
    }
    if (exact.state === 'stopped') {
      return { sessionName: exact.name, record: exact, error: `Target session ${exact.name} is stopped` };
    }
    return { sessionName: exact.name, record: exact };
  }

  private async dispatchCandidate(
    config: RepoCallbackRepoConfig,
    repoSlug: string,
    candidate: DetectedEventCandidate,
  ): Promise<void> {
    const callbackId = buildCallbackId(
      CALLBACK_SOURCES.REPO,
      `${this.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    );
    const resolvedTarget = this.resolveTargetSession(config);
    const record = this.store.createCallback({
      callbackId,
      source: CALLBACK_SOURCES.REPO,
      eventType: candidate.eventType,
      scopeKey: config.projectDir,
      entityKey: candidate.entityKey,
      dedupKey: candidate.dedupKey,
      title: candidate.title,
      url: candidate.url,
      targetSession: resolvedTarget.sessionName,
      status: resolvedTarget.error ? 'failed' : 'pending',
      summary: '',
      ...(resolvedTarget.error ? { lastError: resolvedTarget.error } : {}),
      metadata: {
        repoSlug,
        ...candidate.metadata,
      },
      createdAt: this.now(),
    });

    if (resolvedTarget.error) {
      return;
    }

    const template = resolveRepoCallbackPromptTemplate(config, candidate.eventType, this.globalTemplates);
    const promptCtx: RepoCallbackPromptContext = {
      repo: repoSlug,
      projectDir: config.projectDir,
      event: candidate.eventType,
      title: candidate.title,
      number: candidate.number,
      url: candidate.url,
      author: candidate.author,
      branch: candidate.branch,
      status: candidate.status,
      conclusion: candidate.conclusion,
      details: candidate.details,
      callbackId: record.callbackId,
    };
    const prompt = renderRepoCallbackPrompt(template, promptCtx);

    try {
      await this.sendToSession(resolvedTarget.sessionName, prompt, resolvedTarget.record);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.store.updateCallback({
        callbackId: record.callbackId,
        status: 'failed',
        lastError: msg,
        updatedAt: this.now(),
      });
    }
  }

  buildStatusSnapshot(projectDir: string, requestId?: string): Record<string, unknown> {
    const cfg = this.repoConfigs.get(projectDir);
    const lastError = this.lastErrorByProject.get(projectDir);
    const lastCheckedAt = this.lastPollAt.get(projectDir);
    return {
      type: REPO_MSG.CALLBACK_STATUS_RESPONSE,
      ...(requestId ? { requestId } : {}),
      projectDir,
      enabled: cfg?.enabled ?? false,
      checking: this.inFlightProjects.has(projectDir),
      ...(lastCheckedAt ? { lastCheckedAt } : {}),
      ...(lastError ? { lastError } : {}),
      callbacks: this.getRecentCallbacks(projectDir),
    };
  }
}

let activeServerLink: ServerLink | null = null;
let monitorSingleton: RepoCallbackMonitor | null = null;

export function getRepoCallbackMonitor(): RepoCallbackMonitor {
  if (!monitorSingleton) {
    monitorSingleton = new RepoCallbackMonitor({
      getServerLink: () => activeServerLink,
    });
  }
  return monitorSingleton;
}

export function startRepoCallbackMonitor(serverLink: ServerLink | null): void {
  activeServerLink = serverLink;
  const monitor = getRepoCallbackMonitor();
  monitor.start();
  void monitor.refreshConfig({ pollNewlyEnabled: true });
}

export function stopRepoCallbackMonitor(): void {
  activeServerLink = null;
  monitorSingleton?.stop();
}

export function refreshRepoCallbackMonitor(): Promise<boolean> {
  return getRepoCallbackMonitor().refreshConfig({ pollNewlyEnabled: true });
}

export async function handleRepoCallbackCommand(
  cmd: Record<string, unknown>,
  serverLink: ServerLink,
): Promise<void> {
  const monitor = getRepoCallbackMonitor();
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : undefined;
  let rawProjectDir = typeof cmd.projectDir === 'string' ? cmd.projectDir.trim() : '';
  if (rawProjectDir === FS_SESSION_ROOT_PATH) {
    const sessionBinding = cmd.sessionName ?? cmd.sessionId ?? cmd.session ?? cmd.activeSessionName ?? cmd.activeSessionId;
    if (typeof sessionBinding === 'string' && sessionBinding.trim()) {
      rawProjectDir = listSessions().find((s) => s.name === sessionBinding.trim())?.projectDir ?? '';
    } else {
      rawProjectDir = '';
    }
  }

  if (cmd.type === REPO_MSG.CALLBACK_SYNC) {
    await monitor.refreshConfig({ pollNewlyEnabled: true });
    if (rawProjectDir) {
      try {
        serverLink.send(monitor.buildStatusSnapshot(rawProjectDir, requestId));
      } catch { /* best-effort */ }
    }
    return;
  }

  if (!rawProjectDir) {
    if (requestId) {
      serverLink.send({ type: REPO_MSG.ERROR, requestId, error: 'invalid_params' });
    }
    return;
  }

  // Scope check: projectDir must match an active session directory in this daemon.
  const knownDirs = new Set(listSessions().map((s) => s.projectDir));
  if (!knownDirs.has(rawProjectDir)) {
    serverLink.send({ type: REPO_MSG.ERROR, requestId, projectDir: rawProjectDir, error: 'unauthorized' });
    return;
  }

  if (cmd.type === REPO_MSG.CALLBACK_CHECK_NOW) {
    await monitor.refreshConfig({ pollNewlyEnabled: false });
    await monitor.checkProject(rawProjectDir);
    serverLink.send(monitor.buildStatusSnapshot(rawProjectDir, requestId));
    return;
  }

  if (cmd.type === REPO_MSG.CALLBACK_STATUS_REQUEST) {
    serverLink.send(monitor.buildStatusSnapshot(rawProjectDir, requestId));
  }
}
