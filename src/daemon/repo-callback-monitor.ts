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
import { getCallbackTaskStore, type CallbackTaskStore } from './callback-task-store.js';
import type { ServerLink } from './server-link.js';
import { dispatchSessionMessage } from './session-dispatch.js';
import { projectBrainSession } from './task-pairs/engine.js';

const DEFAULT_CONFIG_SYNC_INTERVAL_MS = 120_000;
const DEFAULT_POLL_TICK_MS = 15_000;
const FETCH_TIMEOUT_MS = 15_000;

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

function isFailedWorkflowRun(run: RepoWorkflowRun): boolean {
  if (run.status === 'failure') return true;
  const conclusion = (run.conclusion ?? '').toLowerCase();
  return conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure';
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
    const failedJobs = detail.jobs.filter((job) => job.status === 'failure' || (job.conclusion ?? '').toLowerCase() === 'failure');
    for (const job of failedJobs.slice(0, 5)) {
      const failedSteps = job.steps
        .filter((step) => step.status === 'failure' || (step.conclusion ?? '').toLowerCase() === 'failure')
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

function buildBaselineKey(projectDir: string, eventType: RepoCallbackEventType): string {
  return buildRepoCallbackDedupKey(projectDir, eventType, '__baseline__');
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
          const candidates = await this.fetchEventCandidates(provider, projectDir, eventType);
          const baselineKey = buildBaselineKey(projectDir, eventType);
          const hasBaseline = this.store.hasSeenDedupKey(CALLBACK_SOURCES.REPO, baselineKey);
          const allKeys = [baselineKey, ...candidates.map((c) => c.dedupKey)];

          if (!hasBaseline) {
            // Cold-start baseline: record all current open/failed items as already seen
            // without triggering a historical flood.
            this.store.markSeenDedupKeys(CALLBACK_SOURCES.REPO, projectDir, allKeys, this.now());
            continue;
          }

          for (const candidate of candidates) {
            if (this.store.hasSeenDedupKey(CALLBACK_SOURCES.REPO, candidate.dedupKey)) {
              continue;
            }
            if (eventType === 'ci_failed' && typeof candidate.metadata.runId === 'number') {
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
        } catch (err) {
          // Never write anything into callback_seen when provider fetch fails.
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

  private async fetchEventCandidates(
    provider: RepoProvider,
    projectDir: string,
    eventType: RepoCallbackEventType,
  ): Promise<DetectedEventCandidate[]> {
    if (eventType === 'pr_new') {
      const res = await provider.listPRs({ state: 'open', page: 1 });
      return res.items.map((pr: RepoPR) => ({
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
        details: pr.draft ? 'Draft PR' : 'Open PR',
        metadata: { number: pr.number, head: pr.head, base: pr.base },
      }));
    }

    if (eventType === 'issue_new') {
      const res = await provider.listIssues({ state: 'open', page: 1 });
      return res.items.map((issue: RepoIssue) => ({
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
        details: issue.labels.length > 0 ? `Labels: ${issue.labels.join(', ')}` : 'Open issue',
        metadata: { number: issue.number, labels: issue.labels },
      }));
    }

    const res = await provider.listActions({ page: 1 });
    return res.items
      .filter(isFailedWorkflowRun)
      .map((run: RepoWorkflowRun) => {
        const attempt = String(run.runAttempt ?? 1);
        return {
          eventType: 'ci_failed',
          entityKey: `run#${run.id}#${attempt}`,
          dedupKey: buildRepoCallbackDedupKey(projectDir, 'ci_failed', String(run.id), attempt),
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
            runAttempt: Number(attempt),
            branch: run.branch,
            commitSha: run.commitSha,
            _run: run,
          },
        };
      });
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
