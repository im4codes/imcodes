/**
 * Daemon-owned automation for task pairs: the pair heartbeat (D6), automatic
 * auditor replacement (D6.5), executor escalation (D6.5a), and the
 * auto-dispatching concurrency queue (D7).
 *
 * Every message goes through `sendTaskPairMessage` (ordinary durable FIFO,
 * one pending message per pair and reason). Liveness is judged per side: only
 * the side whose turn it is decides whether to nudge, and a silent side gets
 * at most TASK_PAIR_SILENCE_LIMIT - 1 nudges before it escalates.
 */
import {
  SUPERVISION_HEARTBEAT_KIND,
  SUPERVISION_HEARTBEAT_STATE,
} from '../../../shared/supervision-heartbeat.js';
import {
  SUPERVISION_HEARTBEAT_PROJECTION_SOURCE,
  clearSupervisionHeartbeatProjectionSource,
  setSupervisionHeartbeatProjection,
} from '../supervision-heartbeat-projection.js';
import logger from '../../util/logger.js';
import { getSession } from '../../store/session-store.js';
import {
  TASK_PAIR_BOTH_IDLE_NUDGE_MS,
  TASK_PAIR_BRAIN_REMINDER_INITIAL_MS,
  TASK_PAIR_BRAIN_REMINDER_SECOND_MS,
  TASK_PAIR_BRAIN_REMINDER_REPEAT_MS,
  TASK_PAIR_BRAIN_MIN_GAP_MS,
  TASK_PAIR_HEARTBEAT_MS,
  TASK_PAIR_NO_AUDITOR,
  TASK_PAIR_OPEN_STATUSES,
  TASK_PAIR_QUEUE_STALL_NOTICE_MS,
  TASK_PAIR_SILENCE_LIMIT,
  TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION,
  compareQueuedTaskPairs,
  isTerminalTaskPairStatus,
  taskPairSideToAct,
  type TaskPairFlag,
  type TaskPairIntent,
  type TaskPairState,
} from '../../../shared/task-pair.js';
import { getTaskPairStore, type StoredTaskPair, type TaskPairLiveness } from './store.js';
import { isPairsEngineProject, projectBrainSession, resolveTaskPairMaxConcurrency } from './engine.js';
import { sendTaskPairMessage } from './delivery.js';
import { hasRecentTaskPairProviderError } from './provider-errors.js';
import { ensureTaskPairWorkspaceAvailable, refreshTaskPairWorkspaceHead, taskPairService, type TaskPairScheduler } from './service.js';
import {
  roleEligibleProvisionConfig,
  brainHasConfiguredPools,
  describeAuditorPoolGap,
  describeLimitedProviderFamilies,
  describePoolSyncGap,
  describeRequestedModelMiss,
  isSessionBusy,
  isSessionProviderLimited,
  listTaskPairCandidates,
  poolOfSession,
  providerFamilyOfSession,
  type TaskPairPickRole,
} from './pool.js';
import {
  buildAggregatedBrainNoticeMessage,
  buildBrainHeartbeatMessage,
  buildAuditorAssignmentMessage,
  buildAuditorHandoffMessage,
  buildBrainLine,
  buildBrainNoticeMessage,
  buildDispatchTrailer,
  buildExecutorHandoffMessage,
  buildExecutorResendMessage,
  buildNoBriefDigestMessage,
  buildNoBriefLine,
  buildNoPoolAskMessage,
  buildNudgeMessage,
  buildQueueStallNoticeMessage,
  type PendingBrainFlagNotice,
  type PendingBrainLineNotice,
  type PendingBrainNotice,
} from './messages.js';

/** Synthetic task id for an aggregated multi-pair Brain notice (dedup key only; no real pair). */
const TASK_PAIR_AGGREGATE_NOTICE_ID = '__aggregate__' as const;

/** Heartbeat interval override, e.g. for real-device testing. */
export const TASK_PAIR_HEARTBEAT_ENV = 'IMCODES_TASK_PAIR_HEARTBEAT_MS' as const;
/** Both-idle nudge threshold override, e.g. for real-device testing. */
export const TASK_PAIR_BOTH_IDLE_NUDGE_ENV = 'IMCODES_TASK_PAIR_BOTH_IDLE_NUDGE_MS' as const;
/** How often the lightweight both-idle check runs; independent of, and much cheaper than, a full heartbeat tick. */
const TASK_PAIR_BOTH_IDLE_CHECK_INTERVAL_MS = 30_000;
/** Bound pool discovery/provisioning so one provider or transport cannot freeze the queue. */
export const TASK_PAIR_QUEUE_OPERATION_TIMEOUT_ENV = 'IMCODES_TASK_PAIR_QUEUE_OPERATION_TIMEOUT_MS' as const;
const TASK_PAIR_QUEUE_OPERATION_TIMEOUT_MS = 15_000;

export interface TaskPairSchedulerDeps {
  now?: () => number;
  isBusy?: (sessionName: string) => boolean;
  isLimited?: (sessionName: string) => boolean;
  pickCandidate?: (input: { brain: string; role: TaskPairPickRole; pool: 'primary' | 'economy'; exclude: ReadonlySet<string>; project: string; requestedModel?: string; avoidProviderFamily?: string }) => string | undefined;
  provision?: (input: { brain: string; role: TaskPairPickRole; pool: 'primary' | 'economy'; project: string; taskId: string; requestedModel?: string; avoidProviderFamily?: string }) => Promise<string | undefined>;
  /** Import not-yet-imported in-flight legacy tasks of `pairs` projects (idempotent). */
  importLegacy?: (now: number) => void | Promise<void>;
  poolOf?: (brain: string, sessionName: string) => 'primary' | 'economy' | undefined;
}

export function resolveTaskPairHeartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[TASK_PAIR_HEARTBEAT_ENV]);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : TASK_PAIR_HEARTBEAT_MS;
}

export function resolveTaskPairBothIdleNudgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[TASK_PAIR_BOTH_IDLE_NUDGE_ENV]);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : TASK_PAIR_BOTH_IDLE_NUDGE_MS;
}

/** Public pure helpers keep the cadence contract regression-testable without
 * starting a daemon timer or depending on session state. */
export function resolveTaskPairBrainReminderInterval(count: number): number {
  return count <= 0 ? TASK_PAIR_BRAIN_REMINDER_INITIAL_MS
    : count === 1 ? TASK_PAIR_BRAIN_REMINDER_SECOND_MS : TASK_PAIR_BRAIN_REMINDER_REPEAT_MS;
}

export function isTaskPairBrainReminderDue(waitStartedAt: number, now: number, count = 0): boolean {
  return now - waitStartedAt >= resolveTaskPairBrainReminderInterval(count);
}

export function isTaskPairBrainReminderGapSatisfied(now: number, lastDeliveryAt = 0, lastBrainActivityAt = 0): boolean {
  const latest = Math.max(lastDeliveryAt, lastBrainActivityAt);
  return latest === 0 || now - latest >= TASK_PAIR_BRAIN_MIN_GAP_MS;
}

async function defaultImportLegacy(now: number): Promise<void> {
  const [{ importLegacyTasks }, { getSupervisionTaskRegistry }] = await Promise.all([
    import('./legacy-import.js'),
    import('../supervision-state-store.js'),
  ]);
  importLegacyTasks(getSupervisionTaskRegistry(), now);
}

export class TaskPairAutomation implements TaskPairScheduler {
  #timer?: NodeJS.Timeout;
  #bothIdleTimer?: NodeJS.Timeout;
  #deps: TaskPairSchedulerDeps;
  #queueRuns = new Map<string, Promise<void>>();

  constructor(deps: TaskPairSchedulerDeps = {}) {
    this.#deps = deps;
  }

  #intervalMs = TASK_PAIR_HEARTBEAT_MS;
  #bothIdleNudgeMs = resolveTaskPairBothIdleNudgeMs();
  #nextTickAt = 0;
  #badgeSessions = new Set<string>();
  /** Main Brain heartbeat state is separate from participant pair badges. */
  #mainHeartbeatPaused = new Set<string>();
  #mainHeartbeatPauseCleared = new Set<string>();
  #mainHeartbeatDelivered = new Map<string, string>();
  #mainHeartbeatPending = new Set<string>();
  #mainHeartbeatSessions = new Set<string>();

  start(intervalMs = resolveTaskPairHeartbeatMs()): void {
    if (this.#timer) return;
    this.#intervalMs = intervalMs;
    this.#nextTickAt = this.#now() + intervalMs;
    this.publishBadges();
    this.#timer = setInterval(() => {
      void this.tick().catch((error) => logger.warn({ err: error }, 'task-pair: heartbeat tick failed'));
    }, intervalMs);
    this.#timer.unref?.();
    // Independent, much cheaper than a full tick: skips legacy import, queue
    // running, and workspace refresh, so an idle pair does not have to wait
    // for the next full heartbeat to be nudged.
    this.#bothIdleTimer = setInterval(() => {
      void this.checkBothIdlePairs().catch((error) => logger.warn({ err: error }, 'task-pair: both-idle check failed'));
    }, TASK_PAIR_BOTH_IDLE_CHECK_INTERVAL_MS);
    this.#bothIdleTimer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#bothIdleTimer) clearInterval(this.#bothIdleTimer);
    this.#bothIdleTimer = undefined;
  }

  #now(): number { return (this.#deps.now ?? Date.now)(); }
  /** Busy state as of the tick's first look at a session (see tick()). */
  #tickBusy?: Map<string, boolean>;
  #busy(session: string): boolean {
    const known = this.#tickBusy?.get(session);
    if (known !== undefined) return known;
    const busy = (this.#deps.isBusy ?? ((name) => isSessionBusy(name)))(session);
    this.#tickBusy?.set(session, busy);
    return busy;
  }

  /**
   * Feed the main-session timeline into the pairs heartbeat.  This is called
   * by lifecycle's single timeline listener so a user reply re-arms the
   * projection without reviving the retired legacy supervision engine.
   */
  observeTimelineEvent(event: { sessionId: string; type: string; payload: Record<string, unknown> }): void {
    const pairs = getTaskPairStore().listActivePairs().filter((stored) => (
      isPairsEngineProject(stored.project) && stored.state.brain === event.sessionId
    ));
    if (pairs.length === 0) return;
    // A real Brain reply (chat text, marker delivery, or a user message from
    // the main session) resolves the current reminder immediately, even when
    // the event arrives through the lifecycle observer rather than pair
    // service ingestion.
    const replyText = String(event.payload.text ?? event.payload.message ?? '').trim();
    if (replyText && event.type !== 'agent.status' && event.type !== 'session.state') {
      const at = this.#now();
      for (const stored of pairs) {
        const next = { ...stored.liveness, brainLastActivityAt: at, brainWaitKey: undefined, brainWaitStartedAt: undefined, brainReminderCount: 0, brainReminderLastAt: undefined, brainReminderDue: undefined, brainReminderResolvedAt: at, brainReminderLastDecisionAt: undefined, brainReminderLastDecisionReason: undefined };
        getTaskPairStore().saveLiveness(stored.project, stored.state.taskId, next);
      }
    }
    if (event.type === 'agent.status') {
      const status = String(event.payload.status ?? '').toLowerCase();
      if (status === 'needs_input' || status === 'supervision_needs_input') {
        this.#mainHeartbeatPaused.add(event.sessionId);
        this.#mainHeartbeatPauseCleared.delete(event.sessionId);
        this.publishBadges();
      }
    } else if (event.type === 'session.state') {
      const state = String(event.payload.state ?? '').toLowerCase();
      if (state === 'running' || state === 'idle') this.publishBadges();
    } else if (event.type === 'user.message' && event.payload.automation !== true
      && String(event.payload.text ?? '').trim()) {
      this.#mainHeartbeatPaused.delete(event.sessionId);
      this.#mainHeartbeatPauseCleared.add(event.sessionId);
      this.publishBadges();
    }
  }
  /**
   * A real, structured rate/usage limit (`provider_rate_limited`, a weekly
   * quota, `availability=limited`, ...). This is the ONLY case that fails
   * over to a different provider family: the session cannot serve this
   * account's quota at all, so retrying it (same or different work) will not
   * help until the provider says otherwise.
   */
  #rateLimited(session: string): boolean {
    return (this.#deps.isLimited ?? ((name) => isSessionProviderLimited(name)))(session);
  }

  /**
   * A transient provider refusal (owner correction, tsk_cd_limit_failover
   * addendum 2): "Selected model is at capacity" and similar overload/rate-
   * limit-shaped HTTP errors are NOT a quota limit -- the same session
   * typically works again within a heartbeat or two. This never fails over
   * or switches provider; the affected side just backs off (held without a
   * wasted nudge it cannot answer) and is retried on the next heartbeat.
   */
  #capacityLimited(session: string): boolean {
    return hasRecentTaskPairProviderError(session, this.#now(), this.#intervalMs);
  }
  #poolOf(brain: string, session: string) { return (this.#deps.poolOf ?? ((b, s) => poolOfSession(b, s)))(brain, session); }

  #queueOperationTimeoutMs(): number {
    const raw = Number(process.env[TASK_PAIR_QUEUE_OPERATION_TIMEOUT_ENV]);
    return Number.isFinite(raw) && raw >= 1 ? raw : TASK_PAIR_QUEUE_OPERATION_TIMEOUT_MS;
  }

  async #withQueueTimeout<T>(operation: Promise<T>, label: string, taskId: string): Promise<T | undefined> {
    const timeoutMs = this.#queueOperationTimeoutMs();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            logger.info({ taskId, label, timeoutMs }, 'task-pair: queue operation timed out');
            resolve(undefined);
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      logger.info({ err: error, taskId, label }, 'task-pair: queue operation failed');
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #queueProvision(input: { brain: string; role: TaskPairPickRole; pool: 'primary' | 'economy'; exclude?: ReadonlySet<string>; project: string; taskId: string; requestedModel?: string; avoidProviderFamily?: string }): Promise<string | undefined> {
    const { exclude: _exclude, ...provisionInput } = input;
    return this.#withQueueTimeout(this.#provision(provisionInput), 'provision', input.taskId);
  }

  #logQueueSkip(project: string, pair: TaskPairState, reason: string): void {
    logger.info({ project, taskId: pair.taskId, reason }, 'task-pair: queue skipped pair');
  }

  #pick(input: { brain: string; role: TaskPairPickRole; pool: 'primary' | 'economy'; exclude: ReadonlySet<string>; project: string; requestedModel?: string; avoidProviderFamily?: string }): string | undefined {
    if (this.#deps.pickCandidate) return this.#deps.pickCandidate(input);
    return listTaskPairCandidates(input)[0]?.name;
  }

  async #provision(input: { brain: string; role: TaskPairPickRole; pool: 'primary' | 'economy'; project: string; taskId: string; requestedModel?: string; avoidProviderFamily?: string }): Promise<string | undefined> {
    if (this.#deps.provision) return this.#deps.provision(input);
    const config = roleEligibleProvisionConfig(input);
    if (!config) return undefined;
    const { provisionSupervisionTarget } = await import('../supervision-auto-provision.js');
    const result = await provisionSupervisionTarget({
      parentSessionName: input.brain,
      pool: input.role === 'auditor' ? 'primary' : input.pool,
      // Owner rule: a named model is provisioned as-is even when it is not a
      // pool member -- manual_explicit is the only provenance that bypasses
      // the "pool must be configured" gate, so it must carry the full config
      // rather than just a capabilityId the pool may not actually contain.
      ...(input.requestedModel
        ? { provenance: 'manual_explicit' as const, requestedExecutionConfig: config }
        : { requestedCapabilityId: config.capabilityId }),
      idempotencyKey: `task-pair:${input.project}:${input.taskId}:${input.role}:${this.#now()}`,
    });
    return result.ok ? result.target.name : undefined;
  }

  // ---- intents from marker ingestion ------------------------------------

  async onIntent(project: string, pair: TaskPairState, intent: TaskPairIntent): Promise<void> {
    switch (intent.kind) {
      case 'pick_auditor':
      case 'replace_auditor':
        await this.replaceAuditor(project, pair.taskId, intent.kind === 'replace_auditor' ? 'executor blocked on the auditor' : 'no auditor named');
        break;
      case 'pick_executor':
        await this.#pickExecutor(project, pair.taskId);
        break;
      case 'slot_changed':
        await this.runQueue(project, pair.brain);
        break;
      default:
        break;
    }
    this.#checkPools(project, pair.taskId);
    this.publishBadges();
  }

  // ---- heartbeat ---------------------------------------------------------

  async tick(): Promise<void> {
    const now = this.#now();
    const store = getTaskPairStore();
    // A project switched back to `pairs` while the daemon runs gets its
    // in-flight legacy tasks on the next tick, not only at the next start.
    try {
      await (this.#deps.importLegacy ?? defaultImportLegacy)(now);
    } catch (error) {
      logger.warn({ err: error }, 'task-pair: legacy import failed');
    }
    const brains = new Map<string, string>();
    // One busy snapshot per tick: the nudge this tick queues for one pair must
    // not make the same idle session look busy for its other pairs.
    this.#tickBusy = new Map();
    // Brain notices raised this tick are collected and sent as one message
    // per Brain (see #queueNotice), instead of one per pair -- a single pool
    // outage or import batch must not spam Brain with N separate escalations.
    this.#pendingNotices = new Map();
    try {
      for (const stored of store.listActivePairs()) {
        if (!isPairsEngineProject(stored.project)) continue;
        brains.set(stored.state.brain, stored.project);
        try {
          await ensureTaskPairWorkspaceAvailable(stored.project, stored.state.taskId);
          await refreshTaskPairWorkspaceHead(stored.project, stored.state.taskId);
          await this.#tickPair(stored, now);
        } catch (error) {
          logger.warn({ err: error, taskId: stored.state.taskId }, 'task-pair: pair tick failed');
        }
      }
      for (const [brain, project] of brains) {
        await this.runQueue(project, brain);
        await this.#checkQueueStalls(project, brain, now);
        await this.#checkNoPoolAsk(project, brain, now);
      }
    } finally {
      this.#tickBusy = undefined;
      await this.#flushPendingNotices();
      this.#pendingNotices = undefined;
    }
    // Workspaces of pairs that ended a week ago go (hourly at most).
    await taskPairService.sweepWorkspaces(now);
    store.prune(now);
    this.#nextTickAt = now + this.#intervalMs;
    this.publishBadges();
  }

  /**
   * Brain notices raised outside a tick (marker-driven, e.g. `onIntent`) send
   * at once, as before. Notices raised during a tick's pair loop or queue run
   * are collected here and flushed as one message per Brain when the tick
   * ends, so N pairs hitting the same pool outage in one heartbeat produce
   * one notice, not N.
   */
  #pendingNotices?: Map<string, PendingBrainNotice[]>;

  #queueNotice(pair: TaskPairState, flag: TaskPairFlag, detail?: string): void {
    if (this.#pendingNotices) {
      const list = this.#pendingNotices.get(pair.brain) ?? [];
      list.push({ pair, flag, detail });
      this.#pendingNotices.set(pair.brain, list);
      return;
    }
    void sendTaskPairMessage(pair.brain, pair.taskId, `brain-${flag}`, buildBrainNoticeMessage(pair, flag, detail));
  }

  /**
   * Same batching as {@link #queueNotice} for a notice with no backing flag
   * (e.g. a queued pair with no brief): a batch of these (a legacy import
   * that lands many brief-less pairs at once) must not spam Brain one message
   * per pair either.
   */
  #queueLineNotice(pair: TaskPairState, reason: string, text: string): void {
    if (this.#pendingNotices) {
      const list = this.#pendingNotices.get(pair.brain) ?? [];
      list.push({ pair, text, reason });
      this.#pendingNotices.set(pair.brain, list);
      return;
    }
    void sendTaskPairMessage(pair.brain, pair.taskId, reason, buildBrainLine(pair, text));
  }

  async #flushPendingNotices(): Promise<void> {
    const pending = this.#pendingNotices;
    if (!pending) return;
    for (const [brain, entries] of pending) {
      if (entries.length === 0) continue;
      const lineEntries = entries.filter((entry): entry is PendingBrainLineNotice => 'text' in entry);
      const flagEntries = entries.filter((entry): entry is PendingBrainFlagNotice => !('text' in entry));
      // Line notices batch per reason: N brief-less pairs found in one
      // heartbeat get one digest naming them all plus one example marker,
      // never the same marker repeated once per pair (the actual 215 spam).
      const lineByReason = new Map<string, PendingBrainLineNotice[]>();
      for (const notice of lineEntries) {
        const list = lineByReason.get(notice.reason) ?? [];
        list.push(notice);
        lineByReason.set(notice.reason, list);
      }
      for (const [reason, group] of lineByReason) {
        if (group.length === 1) {
          const notice = group[0]!;
          await sendTaskPairMessage(brain, notice.pair.taskId, notice.reason, buildBrainLine(notice.pair, notice.text));
        } else {
          await sendTaskPairMessage(brain, TASK_PAIR_AGGREGATE_NOTICE_ID, `${reason}-digest`, buildNoBriefDigestMessage(group.map((notice) => notice.pair.taskId)));
        }
      }
      if (flagEntries.length === 1) {
        const notice = flagEntries[0]!;
        await sendTaskPairMessage(brain, notice.pair.taskId, `brain-${notice.flag}`, buildBrainNoticeMessage(notice.pair, notice.flag, notice.detail));
      } else if (flagEntries.length > 1) {
        await sendTaskPairMessage(brain, TASK_PAIR_AGGREGATE_NOTICE_ID, 'brain-aggregate', buildAggregatedBrainNoticeMessage(flagEntries));
      }
    }
  }

  /**
   * Session badges: every executor/auditor of an open pair shows the pair
   * heartbeat countdown; sessions that left every open pair are cleared.
   */
  publishBadges(): void {
    const next = new Set<string>();
    const mainPairs = new Map<string, StoredTaskPair[]>();
    const now = this.#now();
    for (const original of getTaskPairStore().listActivePairs()) {
      const stored = this.#refreshBrainReminder(original, now);
      if (!TASK_PAIR_OPEN_STATUSES.includes(stored.state.status) || !isPairsEngineProject(stored.project)) continue;
      for (const session of [stored.state.executor, stored.state.auditor]) {
        if (session && session !== TASK_PAIR_NO_AUDITOR) next.add(session);
      }
      const brain = stored.state.brain || projectBrainSession(stored.project);
      const list = mainPairs.get(brain) ?? [];
      list.push(stored);
      mainPairs.set(brain, list);
    }
    const nextHeartbeatAt = Math.max(this.#nextTickAt, this.#now());
    for (const session of next) {
      setSupervisionHeartbeatProjection(session, {
        state: SUPERVISION_HEARTBEAT_STATE.ARMED,
        kind: SUPERVISION_HEARTBEAT_KIND.PAIR,
        nextHeartbeatAt,
        updatedAt: this.#now(),
      }, SUPERVISION_HEARTBEAT_PROJECTION_SOURCE.PAIR);
    }
    for (const session of this.#badgeSessions) {
      if (!next.has(session)) clearSupervisionHeartbeatProjectionSource(session, SUPERVISION_HEARTBEAT_PROJECTION_SOURCE.PAIR);
    }
    this.#badgeSessions = next;

    const mainSessions = new Set<string>();
    for (const [brain, pairs] of mainPairs) {
      const brainRecord = getSession(brain);
      if (!brainRecord || brainRecord.role !== 'brain') continue;
      const actionable = pairs.filter((pair) => this.#mainHeartbeatNeedsAction(pair));
      const hasNeedsInput = pairs.some((pair) => pair.state.status === TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION || pair.state.flags.includes('needs_input'));
      if (actionable.length === 0 && !hasNeedsInput) continue;
      mainSessions.add(brain);
      const explicitlyPaused = this.#mainHeartbeatPaused.has(brain);
      const awaitingDecisionPause = hasNeedsInput && !this.#mainHeartbeatPauseCleared.has(brain);
      if (explicitlyPaused || awaitingDecisionPause) {
        setSupervisionHeartbeatProjection(brain, {
          state: SUPERVISION_HEARTBEAT_STATE.PAUSED_NEEDS_INPUT,
          kind: SUPERVISION_HEARTBEAT_KIND.PAIR,
          updatedAt: this.#now(),
        }, SUPERVISION_HEARTBEAT_PROJECTION_SOURCE.BRAIN);
        if (explicitlyPaused) {
          for (const due of actionable.filter((pair) => pair.liveness.brainReminderDue)) this.#recordReminderSkip(due, 'brain_needs_input', now);
          continue;
        }
        // Awaiting-decision is shown as paused for the legacy projection, but
        // a due cadence reminder is still delivered through the aggregate
        // heartbeat.  Until the first due point, keep the projection paused.
        if (awaitingDecisionPause && !actionable.some((pair) => pair.liveness.brainReminderDue)) continue;
      }
      if (actionable.length === 0 || this.#busy(brain)) {
        if (this.#busy(brain)) {
          for (const due of actionable.filter((pair) => pair.liveness.brainReminderDue)) this.#recordReminderSkip(due, 'brain_busy', now);
        }
        clearSupervisionHeartbeatProjectionSource(brain, SUPERVISION_HEARTBEAT_PROJECTION_SOURCE.BRAIN);
        continue;
      }
      if (!awaitingDecisionPause) {
        const nextHeartbeatAt = Math.max(this.#nextTickAt, this.#now());
        setSupervisionHeartbeatProjection(brain, {
          state: SUPERVISION_HEARTBEAT_STATE.ARMED,
          kind: SUPERVISION_HEARTBEAT_KIND.PAIR,
          nextHeartbeatAt,
          updatedAt: this.#now(),
        }, SUPERVISION_HEARTBEAT_PROJECTION_SOURCE.BRAIN);
      }
      this.#deliverMainHeartbeat(brain, actionable);
    }
    for (const brain of this.#mainHeartbeatSessions) {
      if (!mainSessions.has(brain)) {
        clearSupervisionHeartbeatProjectionSource(brain, SUPERVISION_HEARTBEAT_PROJECTION_SOURCE.BRAIN);
        this.#mainHeartbeatPaused.delete(brain);
        this.#mainHeartbeatPauseCleared.delete(brain);
        this.#mainHeartbeatPending.delete(brain);
      }
    }
    this.#mainHeartbeatSessions = mainSessions;
    for (const brain of this.#mainHeartbeatDelivered.keys()) {
      if (!mainSessions.has(brain)) this.#mainHeartbeatDelivered.delete(brain);
    }
  }

  #mainHeartbeatNeedsAction(stored: StoredTaskPair): boolean {
    const pair = stored.state;
    if (stored.liveness.brainReminderDue) return true;
    return pair.flags.some((flag) => [
      'blocked', 'needs_input', 'needs_auditor', 'executor_silent', 'verdict_inconsistent',
      'awaiting_audit_ignored', 'replacement_churn', 'markers_unresolved', 'all_providers_limited',
      'auditor_capacity_hold', 'no_pool_configured', 'policy_violation', 'waiting_for_capacity',
    ].includes(flag));
  }

  #deliverMainHeartbeat(brain: string, storedPairs: readonly StoredTaskPair[]): void {
    const fingerprint = storedPairs.map((stored) => {
      const pair = stored.state;
      return `${pair.taskId}:${pair.status}:${pair.round}:${pair.flags.join(',')}:r${stored.liveness.brainReminderCount ?? 0}:d${stored.liveness.brainReminderDue ? 1 : 0}`;
    }).sort().join('|');
    if (!fingerprint || this.#mainHeartbeatDelivered.get(brain) === fingerprint) return;
    if (this.#mainHeartbeatPending.has(brain)) {
      for (const due of storedPairs.filter((pair) => pair.liveness.brainReminderDue)) this.#recordReminderSkip(due, 'delivery_pending', this.#now());
      return;
    }
    this.#mainHeartbeatPending.add(brain);
    const onlyAwaitingDecision = storedPairs.length === 1 && storedPairs[0]!.state.status === TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION;
    void sendTaskPairMessage(brain, TASK_PAIR_AGGREGATE_NOTICE_ID, onlyAwaitingDecision ? 'brain-decision-reminder' : 'brain-heartbeat', buildBrainHeartbeatMessage(storedPairs.map((stored) => stored.state)))
      .then((result) => {
        if (result === 'sent' || result === 'queued' || result === 'skipped_pending') {
          const at = this.#now();
          const store = getTaskPairStore();
          const post = storedPairs.map((stored) => {
            const pair = stored.state;
            const reminder = stored.liveness.brainReminderDue;
            const count = (stored.liveness.brainReminderCount ?? 0) + (reminder ? 1 : 0);
            return `${pair.taskId}:${pair.status}:${pair.round}:${pair.flags.join(',')}:r${count}:d0`;
          }).sort().join('|');
          this.#mainHeartbeatDelivered.set(brain, post);
          for (const stored of storedPairs) {
            if (!stored.liveness.brainReminderDue) continue;
            store.saveLiveness(stored.project, stored.state.taskId, {
              ...stored.liveness,
              brainReminderDue: false,
              brainReminderLastAt: at,
              brainReminderCount: (stored.liveness.brainReminderCount ?? 0) + 1,
              brainReminderLastDecisionAt: undefined,
              brainReminderLastDecisionReason: undefined,
            });
            this.#recordLivenessDecision(stored, 'REMIND', 'sent', 'brain_idle', at);
          }
        }
      })
      .finally(() => { this.#mainHeartbeatPending.delete(brain); })
      .catch(() => { /* delivery logs its own failure; retry on the next state change */ });
  }

  #brainWaitKey(pair: TaskPairState): string | undefined {
    const relevant = pair.flags.filter((flag) => flag === 'blocked' || flag === 'needs_input').sort().join(',');
    if (pair.status === TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION) return `awaiting:${pair.round}:${relevant}`;
    if (pair.status === 'passed') return `passed:${pair.round}`;
    if (relevant) return `flags:${pair.round}:${relevant}`;
    return undefined;
  }

  #refreshBrainReminder(stored: StoredTaskPair, now: number): StoredTaskPair {
    const key = this.#brainWaitKey(stored.state);
    const current = stored.liveness;
    if (!key) {
      if (!current.brainWaitKey && !current.brainReminderDue) return stored;
      const cleared = { ...current, brainWaitKey: undefined, brainWaitStartedAt: undefined, brainReminderCount: 0, brainReminderLastAt: undefined, brainReminderDue: undefined, brainReminderResolvedAt: undefined, brainReminderLastDecisionAt: undefined, brainReminderLastDecisionReason: undefined };
      getTaskPairStore().saveLiveness(stored.project, stored.state.taskId, cleared);
      return { ...stored, liveness: cleared };
    }
    let next = current;
    if (current.brainWaitKey !== key) {
      next = { ...current, brainWaitKey: key, brainWaitStartedAt: Math.min(stored.state.updatedAt, now), brainReminderCount: 0, brainReminderLastAt: undefined, brainReminderDue: undefined, brainReminderResolvedAt: undefined, brainReminderLastDecisionAt: undefined, brainReminderLastDecisionReason: undefined };
    } else if (current.brainWaitStartedAt === undefined) {
      next = { ...current, brainWaitStartedAt: Math.min(stored.state.updatedAt, now), brainReminderCount: current.brainReminderCount ?? 0 };
    }
    const started = next.brainReminderLastAt ?? next.brainWaitStartedAt ?? now;
    const count = next.brainReminderCount ?? 0;
    const lastBrainTouch = Math.max(next.brainReminderLastAt ?? 0, next.brainLastActivityAt ?? 0);
    const gapElapsed = isTaskPairBrainReminderGapSatisfied(now, next.brainReminderLastAt, next.brainLastActivityAt);
    // A transient provider-capacity hold is not a Brain decision wait.  Keep
    // the durable wait key, but defer its cadence until capacity clears so a
    // held executor does not receive an unrelated aggregate heartbeat.
    const heldByProvider = [stored.state.executor, stored.state.auditor]
      .filter((session): session is string => !!session && session !== TASK_PAIR_NO_AUDITOR)
      .some((session) => hasRecentTaskPairProviderError(session, now, this.#intervalMs));
    const cadenceEligible = !heldByProvider
      && !stored.state.flags.includes('waiting_for_capacity')
      && !stored.state.flags.includes('all_providers_limited');
    const due = cadenceEligible && !next.brainReminderResolvedAt && gapElapsed
      && isTaskPairBrainReminderDue(started, now, count) && !next.brainReminderDue;
    if (due) next = { ...next, brainReminderDue: true };
    if (next !== current) getTaskPairStore().saveLiveness(stored.project, stored.state.taskId, next);
    return next === current ? stored : { ...stored, liveness: next };
  }

  #recordLivenessDecision(stored: StoredTaskPair, verb: 'NUDGE' | 'REMIND', effect: string, reason: string, at: number): void {
    const id = `heartbeat:${verb.toLowerCase()}:${stored.project}:${stored.state.taskId}:${at}:${reason}`;
    getTaskPairStore().recordEvent({
      id, project: stored.project, taskId: stored.state.taskId, writer: 'daemon', role: 'daemon', verb,
      attrs: { reason }, effect, unusual: false, source: 'heartbeat', fromStatus: stored.state.status, toStatus: stored.state.status, at,
    });
    logger.info({ taskId: stored.state.taskId, verb, effect, reason }, `task-pair: ${verb.toLowerCase()} decision`);
  }

  #recordReminderSkip(stored: StoredTaskPair, reason: string, at: number): void {
    const live = stored.liveness;
    if (!live.brainReminderDue) return;
    if (live.brainReminderLastDecisionReason === reason) return;
    const next = { ...live, brainReminderLastDecisionAt: at, brainReminderLastDecisionReason: reason };
    getTaskPairStore().saveLiveness(stored.project, stored.state.taskId, next);
    this.#recordLivenessDecision({ ...stored, liveness: next }, 'REMIND', 'skipped', reason, at);
  }

  async #tickPair(stored: StoredTaskPair, now: number): Promise<void> {
    let pair = stored.state;
    const store = getTaskPairStore();
    // Owner report (tsk_cd_limit_failover addendum): needs_auditor must never
    // be kept once a real auditor is actually assigned, whatever set it stale
    // (a race with the pick that filled the role, an import, ...). Self-heal
    // rather than let the generic "no auditor" text spam Brain forever. Not
    // when the auditor is itself rate/capacity limited: it is real but
    // unavailable, and needs_auditor may legitimately still describe a failed
    // replacement attempt for it.
    if (
      pair.flags.includes('needs_auditor') && pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR
      && !this.#rateLimited(pair.auditor) && !this.#capacityLimited(pair.auditor)
    ) {
      pair = { ...pair, flags: pair.flags.filter((flag) => flag !== 'needs_auditor'), updatedAt: now };
      store.savePair(stored.project, pair);
    }
    const side = taskPairSideToAct(pair);
    const liveness: TaskPairLiveness = { ...stored.liveness, notified: [...stored.liveness.notified] };
    const previousTick = liveness.lastTickAt;
    liveness.lastTickAt = now;
    if (pair.status === TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION) {
      store.saveLiveness(stored.project, pair.taskId, liveness);
      return;
    }
    if (!side) { store.saveLiveness(stored.project, pair.taskId, liveness); return; }

    const session = side === 'executor' ? pair.executor : pair.auditor;
    if (side === 'auditor' && (!session || session === TASK_PAIR_NO_AUDITOR)) {
      store.saveLiveness(stored.project, pair.taskId, liveness);
      await this.replaceAuditor(stored.project, pair.taskId, 'no auditor');
      return;
    }
    if (!session) { store.saveLiveness(stored.project, pair.taskId, liveness); return; }

    // A REAL rate/usage limit is reassigned at once, preferring a different
    // provider family so a whole-family outage does not just hand the pair to
    // another session behind the same limit. Only when no replacement at all
    // is available does the pair wait, flagged and aggregated to Brain rather
    // than escalated per pair.
    //
    // Owner correction (tsk_cd_limit_failover addendum 2): a transient
    // provider refusal ("Selected model is at capacity") is NOT a rate limit
    // and never fails over -- it is treated exactly like ordinary silence
    // below (held without a nudge it cannot answer, escalated only once the
    // silence limit is reached), just retried on the same session.
    if (this.#rateLimited(session)) {
      store.saveLiveness(stored.project, pair.taskId, liveness);
      if (side === 'auditor') await this.replaceAuditor(stored.project, pair.taskId, 'auditor hit a provider usage limit', { dueToLimit: true });
      else await this.#replaceExecutor(stored.project, pair.taskId, 'executor hit a provider usage limit', { dueToLimit: true });
      return;
    }
    const capacityLimited = this.#capacityLimited(session);

    // A pair is stuck only when *both* participants have been quiet since the
    // previous heartbeat -- a tick-boundary comparison, correct at this 6-
    // minute granularity (unlike an absolute duration: a check this
    // infrequent cannot otherwise tell "idle the whole window" from "just
    // became active moments before this tick runs"). The faster, absolute-
    // duration-based #maybeNudgeBothIdle (checkBothIdlePairs, every 30s)
    // normally already handles this sooner; reached here too so `.tick()`
    // alone (as tests drive it) still covers it without that faster timer
    // running, deduped via liveness.bothIdleNudgedAt so the two never both
    // fire for the same idle spell.
    if (await this.#maybeNudgeBothQuietSinceTick(stored, pair, liveness, previousTick, now)) return;

    const progressAt = side === 'executor' ? liveness.progressExecutorAt : liveness.progressAuditorAt;
    const activityAt = side === 'executor'
      ? (liveness.activityExecutorAt ?? progressAt)
      : (liveness.activityAuditorAt ?? progressAt);
    // An escalated executor that is working on this pair again can be escalated
    // again if it later goes silent.
    if (side === 'executor' && progressAt > previousTick && pair.flags.includes('executor_silent')) {
      store.savePair(stored.project, { ...pair, flags: pair.flags.filter((flag) => flag !== 'executor_silent'), updatedAt: now }, { liveness });
    }
    if (side === 'auditor' && progressAt > previousTick && pair.flags.includes('auditor_capacity_hold')) {
      store.savePair(stored.project, { ...pair, flags: pair.flags.filter((flag) => flag !== 'auditor_capacity_hold'), updatedAt: now }, { liveness });
    }
    if (this.#busy(session) || progressAt > previousTick || activityAt > previousTick) {
      store.saveLiveness(stored.project, pair.taskId, liveness);
      return;
    }
    // This side flagged itself blocked/needs_input: escalate once with the
    // real cause (owner report: never the generic no-auditor text when a
    // named, present participant is simply stuck) instead of nudging.
    const flagSide = pair.flagSides.blocked === side || pair.flagSides.needs_input === side;
    const flagged = flagSide && (pair.flags.includes('blocked') || pair.flags.includes('needs_input'));
    if (flagged) {
      store.saveLiveness(stored.project, pair.taskId, liveness);
      this.#escalateBlocked(stored.project, pair.taskId, side);
      return;
    }

    const silence = (side === 'executor' ? liveness.silenceExecutor : liveness.silenceAuditor) + 1;
    if (side === 'executor') liveness.silenceExecutor = silence;
    else liveness.silenceAuditor = silence;
    store.saveLiveness(stored.project, pair.taskId, liveness);

    if (silence < TASK_PAIR_SILENCE_LIMIT) {
      // A capacity-limited session cannot answer right now; a nudge would
      // just fail again. Silently back off and retry on the next heartbeat.
      if (!capacityLimited) {
        liveness.lastNudgedAt = now;
        store.saveLiveness(stored.project, pair.taskId, liveness);
        await sendTaskPairMessage(session, pair.taskId, `nudge-${side}`, buildNudgeMessage(pair, side));
        this.#recordLivenessDecision({ ...stored, liveness }, 'NUDGE', 'sent', `heartbeat_${side}`, now);
      } else {
        this.#recordLivenessDecision({ ...stored, liveness }, 'NUDGE', 'skipped', `capacity_${side}`, now);
      }
      return;
    }
    if (silence === TASK_PAIR_SILENCE_LIMIT) {
      if (side === 'auditor' && capacityLimited) {
        // Owner correction: a capacity error is never grounds to switch the
        // auditor, however long it persists -- only a REAL rate limit fails
        // over. Tell Brain once; the pair keeps retrying the same auditor.
        this.#escalateCapacityAuditor(stored.project, pair.taskId);
      } else if (side === 'auditor') {
        await this.replaceAuditor(stored.project, pair.taskId, `auditor silent for ${TASK_PAIR_SILENCE_LIMIT} heartbeats`);
      } else {
        const because = capacityLimited
          ? `hit a provider capacity error for ${TASK_PAIR_SILENCE_LIMIT} heartbeats`
          : `silent for ${TASK_PAIR_SILENCE_LIMIT} heartbeats`;
        this.#escalateExecutor(stored.project, pair.taskId, `executor ${because}`);
      }
    }
    // Past the limit: no more nudges until that side makes progress or is reassigned.
  }

  /**
   * Lightweight, frequent (default every 30s, see start()) check independent
   * of the 6-minute heartbeat tick: every open pair whose side(s) to act have
   * ALL been idle for at least TASK_PAIR_BOTH_IDLE_NUDGE_MS gets nudged at
   * once, instead of waiting for the next full heartbeat.
   */
  async checkBothIdlePairs(): Promise<void> {
    const now = this.#now();
    for (const stored of getTaskPairStore().listActivePairs()) {
      if (!isPairsEngineProject(stored.project)) continue;
      try {
        await this.#maybeNudgeBothIdle(stored.project, stored.state.taskId, now);
      } catch (error) {
        logger.warn({ err: error, taskId: stored.state.taskId }, 'task-pair: both-idle check failed');
      }
    }
  }

  /**
   * Absolute-duration version, meaningful at this method's fine (30s) polling
   * granularity: the side(s) whose turn it is (in_audit with a real auditor:
   * the auditor; otherwise the executor -- with no real auditor at all,
   * "both idle" collapses to the executor alone) have ALL been continuously
   * idle for at least the both-idle threshold. See #maybeNudgeBothQuietSinceTick
   * for the coarser, tick-boundary version #tickPair uses instead (a check
   * this infrequent cannot reliably measure a sub-interval duration).
   */
  async #maybeNudgeBothIdle(project: string, taskId: string, now: number): Promise<boolean> {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    if (!stored) return false;
    const pair = stored.state;
    if (!TASK_PAIR_OPEN_STATUSES.includes(pair.status)) return false;
    const executor = pair.executor;
    if (!executor) return false;
    const auditor = pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR ? pair.auditor : undefined;
    const isHeld = (sessionName: string) => this.#busy(sessionName) || this.#rateLimited(sessionName) || this.#capacityLimited(sessionName);
    const liveness = stored.liveness;
    const executorIdleSince = liveness.activityExecutorAt ?? liveness.progressExecutorAt;
    // The shared idle spell begins when the LAST participant became idle.
    const idleSince = auditor
      ? Math.max(executorIdleSince, liveness.activityAuditorAt ?? liveness.progressAuditorAt)
      : executorIdleSince;
    if (now - idleSince < this.#bothIdleNudgeMs) return false;
    if (isHeld(executor) || (auditor && isHeld(auditor))) {
      this.#recordLivenessDecision(stored, 'NUDGE', 'skipped', 'participant_held', now);
      return false;
    }
    // The fast trigger fires once per uninterrupted idle spell. A later
    // ordinary heartbeat remains responsible for its normal silence cadence.
    // Equality is a valid re-arm boundary: activity can share the same
    // millisecond as the nudge. Activity normally clears this marker, while
    // the strict comparison is an additional safe guard for older records.
    if (liveness.bothIdleNudgedAt !== undefined && liveness.bothIdleNudgedAt > idleSince) return false;
    return this.#nudgeBothIdleTarget(stored.project, pair, liveness, now);
  }

  /**
   * Coarse, tick-boundary version: "quiet since the previous heartbeat"
   * (compared against the tick BOUNDARY, not an absolute duration -- correct
   * at the 6-minute granularity #tickPair runs at; an absolute-duration check
   * this infrequent cannot otherwise tell "idle the whole window" from "just
   * became active moments before this tick runs", which the fast, 30s
   * #maybeNudgeBothIdle instead measures directly). Skips entirely once the
   * fast check already covered the same idle spell (liveness.bothIdleNudgedAt
   * recent), so the two never both send a nudge for it.
   */
  async #maybeNudgeBothQuietSinceTick(
    stored: StoredTaskPair, pair: TaskPairState, liveness: TaskPairLiveness, previousTick: number, now: number,
  ): Promise<boolean> {
    const executor = pair.executor;
    if (!executor) return false;
    const auditor = pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR ? pair.auditor : undefined;
    const isHeld = (sessionName: string) => this.#busy(sessionName) || this.#rateLimited(sessionName) || this.#capacityLimited(sessionName);
    const executorQuiet = !isHeld(executor) && (liveness.activityExecutorAt ?? liveness.progressExecutorAt) <= previousTick;
    // With no real auditor, "both idle" collapses to the executor alone.
    const auditorQuiet = auditor
      ? !isHeld(auditor) && (liveness.activityAuditorAt ?? liveness.progressAuditorAt) <= previousTick
      : true;
    if (!executorQuiet || !auditorQuiet) return false;
    // The fast nudge counts as one silence tick. Do not also send the normal
    // heartbeat nudge when it happened within the last heartbeat interval.
    // It is still handled so #tickPair does not fall through and double-count.
    if (liveness.bothIdleNudgedAt !== undefined && now - liveness.bothIdleNudgedAt < this.#intervalMs) return true;
    return this.#nudgeBothIdleTarget(stored.project, pair, liveness, now);
  }

  /**
   * Shared send/escalate step once a caller has determined the relevant
   * side(s) are both idle: nudges whoever holds the ball (in_audit with a
   * real auditor: the auditor; otherwise the executor), reusing the same
   * liveness counters and TASK_PAIR_SILENCE_LIMIT escalation as the ordinary
   * single-side quiet check. Never acts on a side already flagged
   * blocked/needs_input (its own dedicated path escalates that), or once the
   * executor is already flagged `executor_silent` (no more nudges until it
   * makes progress or is reassigned -- mirrors the single-side check below).
   * Returns true when it sent a nudge or escalated.
   */
  async #nudgeBothIdleTarget(project: string, pair: TaskPairState, liveness: TaskPairLiveness, now: number): Promise<boolean> {
    const executor = pair.executor;
    if (!executor) return false;
    const auditor = pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR ? pair.auditor : undefined;
    if (pair.flagSides.blocked || pair.flagSides.needs_input) {
      this.#recordLivenessDecision({ project, state: pair, liveness, queueOrder: 0 }, 'NUDGE', 'skipped', 'participant_flagged', now);
      return false;
    }
    if (pair.flags.includes('executor_silent')) {
      this.#recordLivenessDecision({ project, state: pair, liveness, queueOrder: 0 }, 'NUDGE', 'skipped', 'executor_already_escalated', now);
      return false;
    }

    const target = taskPairSideToAct(pair) === 'auditor' && auditor ? 'auditor' : 'executor';
    const targetSession = target === 'auditor' ? auditor! : executor;
    const silence = (target === 'executor' ? liveness.silenceExecutor : liveness.silenceAuditor) + 1;
    const nextLiveness: TaskPairLiveness = {
      ...liveness,
      notified: [...liveness.notified],
      bothIdleNudgedAt: now,
      lastNudgedAt: now,
      ...(target === 'executor' ? { silenceExecutor: silence } : { silenceAuditor: silence }),
    };
    getTaskPairStore().saveLiveness(project, pair.taskId, nextLiveness);

    if (silence < TASK_PAIR_SILENCE_LIMIT) {
      const repeat = silence > 1
        ? `This is repeated quiet heartbeat ${silence}; take ownership now.`
        : 'Both sides are idle; take ownership of the next action now.';
      await sendTaskPairMessage(targetSession, pair.taskId, `nudge-${target}`, buildNudgeMessage(pair, target, repeat));
      this.#recordLivenessDecision({ project, state: pair, liveness: nextLiveness, queueOrder: 0 }, 'NUDGE', 'sent', 'both_idle', now);
    } else if (silence === TASK_PAIR_SILENCE_LIMIT) {
      this.#recordLivenessDecision({ project, state: pair, liveness: nextLiveness, queueOrder: 0 }, 'NUDGE', 'escalated', 'both_idle_silence_limit', now);
      if (target === 'auditor') await this.replaceAuditor(project, pair.taskId, `auditor silent for ${TASK_PAIR_SILENCE_LIMIT} both-idle checks`);
      else this.#escalateExecutor(project, pair.taskId, `both executor and auditor idle for ${TASK_PAIR_SILENCE_LIMIT} both-idle checks`);
    }
    return true;
  }

  /**
   * Owner correction (tsk_cd_limit_failover, r1 audit): a capacity-limited
   * auditor is retried on the same session forever, never replaced -- unlike
   * a real rate limit (replaceAuditor with dueToLimit) or ordinary silence
   * (replaceAuditor). One notice per round, not one per heartbeat.
   */
  #escalateCapacityAuditor(project: string, taskId: string): void {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    if (!stored || stored.state.flags.includes('auditor_capacity_hold')) return;
    const state = { ...stored.state, flags: [...stored.state.flags, 'auditor_capacity_hold' as TaskPairFlag], updatedAt: this.#now() };
    store.savePair(project, state);
    this.#queueNotice(state, 'auditor_capacity_hold', `auditor ${state.auditor} hit a provider capacity error for ${TASK_PAIR_SILENCE_LIMIT} heartbeats; retrying on the same session`);
  }

  /**
   * The acting side flagged itself BLOCKED/NEEDS_INPUT: tell Brain the real
   * cause (owner report: "auditor <session> BLOCKED: <note>", never the
   * generic no-auditor text) once per round, not every heartbeat.
   */
  #escalateBlocked(project: string, taskId: string, side: 'executor' | 'auditor'): void {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    if (!stored) return;
    const pair = stored.state;
    const flag = pair.flagSides.blocked === side ? 'blocked' : 'needs_input';
    const key = `${flag}:${side}:${pair.round}`;
    if (stored.liveness.notified.includes(key)) return;
    store.saveLiveness(project, taskId, { ...stored.liveness, notified: [...stored.liveness.notified, key] });
    const session = side === 'executor' ? pair.executor : pair.auditor;
    const verb = flag === 'blocked' ? 'BLOCKED' : 'NEEDS_INPUT';
    const detail = `${side} ${session ?? '(unknown)'} ${verb}${pair.blockedNote ? `: ${pair.blockedNote}` : ''}`;
    this.#queueNotice(pair, flag, detail);
  }

  #escalateExecutor(project: string, taskId: string, reason: string): void {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    if (!stored || stored.state.flags.includes('executor_silent')) return;
    const state = { ...stored.state, flags: [...stored.state.flags, 'executor_silent' as TaskPairFlag], updatedAt: this.#now() };
    store.savePair(project, state);
    logger.info({ taskId, reason }, 'task-pair: executor escalated to Brain');
    this.#queueNotice(state, 'executor_silent');
  }

  // ---- auditor replacement ------------------------------------------------

  async replaceAuditor(project: string, taskId: string, reason: string, opts: { dueToLimit?: boolean } = {}): Promise<boolean> {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    if (!stored || isTerminalTaskPairStatus(stored.state.status) || stored.state.auditor === TASK_PAIR_NO_AUDITOR) return false;
    const pair = stored.state;
    const hadRealAuditor = !!pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR;
    // Owner report (tsk_cd_limit_failover addendum): a "there is no auditor"
    // pick must never fire, or leave needs_auditor set, once a real auditor
    // is actually assigned. `executor_blocked`/limited/silent reasons are
    // legitimate replacements of an existing auditor and are unaffected.
    if (!opts.dueToLimit && (reason === 'no auditor' || reason === 'no auditor named') && hadRealAuditor) {
      if (pair.flags.includes('needs_auditor')) {
        store.savePair(project, { ...pair, flags: pair.flags.filter((flag) => flag !== 'needs_auditor'), updatedAt: this.#now() });
      }
      return true;
    }
    // Starting an audit on a pair that has no auditor counts against Brain's
    // open-pair limit, so a batch (e.g. imported legacy work) is audited a few
    // at a time in queue order instead of provisioning an auditor for each.
    // Replacing an existing auditor starts nothing new and is never held.
    if (!pair.auditor && pair.status === 'in_audit'
      && this.#activeAudits(project, pair.brain, taskId) >= resolveTaskPairMaxConcurrency(pair.brain)) {
      if (!pair.flags.includes('waiting_for_capacity')) {
        store.savePair(project, { ...pair, flags: [...pair.flags, 'waiting_for_capacity'], updatedAt: this.#now() });
      }
      return false;
    }
    // Owner rule: an initial pick (never had a real auditor yet) with no
    // pool configured and no named auditor model cannot be picked or
    // provisioned at all -- ask the user instead of guessing. A dueToLimit
    // replacement of an auditor that DID exist is a different case (that
    // session was bound somehow before) and is unaffected.
    if (!hadRealAuditor && this.#needsUserPoolChoice(pair.brain, pair.auditorModel)) {
      await this.#flagNoPoolAndNotify(project, taskId, pair.brain);
      return false;
    }
    const exclude = new Set<string>([pair.brain, ...(pair.executor ? [pair.executor] : []), ...(pair.auditor ? [pair.auditor] : []), ...pair.previousAuditors]);
    // A limit-triggered replacement drops a named model pin: retrying the
    // exact model that just got limited can never succeed, and the point of
    // failover is to keep going, not to wait on that specific model.
    const requestedModel = opts.dueToLimit ? undefined : pair.auditorModel;
    const avoidProviderFamily = opts.dueToLimit && hadRealAuditor ? providerFamilyOfSession(pair.auditor!) : undefined;
    const pickInput = { brain: pair.brain, role: 'auditor' as const, pool: 'primary' as const, exclude, project, requestedModel, avoidProviderFamily };
    const next = this.#pick(pickInput) ?? await this.#provision({ ...pickInput, taskId });
    if (!next || exclude.has(next)) {
      if (opts.dueToLimit) {
        // The current (limited) auditor is EXCLUDED from `exclude` above so
        // the pick never re-selects it -- but it must stay IN this scan, or
        // the very session we are replacing because it is limited is never
        // counted as a limited family.
        const limitedScanExclude = new Set<string>([pair.brain, ...pair.previousAuditors]);
        const limited = describeLimitedProviderFamilies({ brain: pair.brain, role: 'auditor', pool: 'primary', exclude: limitedScanExclude });
        if (limited) {
          const key = `all_providers_limited:${pair.round}`;
          if (stored.liveness.notified.includes(key)) return false;
          const state = pair.flags.includes('all_providers_limited') ? pair : { ...pair, flags: [...pair.flags, 'all_providers_limited' as TaskPairFlag], updatedAt: this.#now() };
          store.savePair(project, state, { liveness: { ...stored.liveness, notified: [...stored.liveness.notified, key] } });
          this.#queueNotice(state, 'all_providers_limited', `auditor ${pair.auditor} limited; no cross-family replacement available (${limited.text})`);
          return false;
        }
      }
      const key = `needs_auditor:${pair.round}`;
      if (stored.liveness.notified.includes(key)) return false;
      const state = pair.flags.includes('needs_auditor') ? pair : { ...pair, flags: [...pair.flags, 'needs_auditor' as TaskPairFlag], updatedAt: this.#now() };
      store.savePair(project, state, { liveness: { ...stored.liveness, notified: [...stored.liveness.notified, key] } });
      // Owner rule (design D-pool-sync): an explicitly named auditor model
      // bypasses pool roles entirely, so a miss here is a pool-config gap,
      // not a role gap -- name the requested model instead of guessing.
      const gap = requestedModel
        ? describeRequestedModelMiss(requestedModel)
        : describeAuditorPoolGap({ brain: pair.brain });
      this.#queueNotice(state, 'needs_auditor', gap);
      return false;
    }
    const previousAuditor = pair.auditor;
    const result = taskPairService.applyMarker({
      project,
      writer: 'daemon',
      marker: { verb: 'REASSIGN', knownVerb: 'REASSIGN', taskId, attrs: { auditor: next } },
      source: 'heartbeat',
      now: this.#now(),
      eventId: `heartbeat:${project}:${taskId}:reassign:${next}:${this.#now()}`,
    });
    const updated = result.pair ?? store.getPair(project, taskId)?.state;
    if (!updated) return false;
    const auditorPool = this.#poolOf(updated.brain, next);
    if (auditorPool || updated.flags.includes('waiting_for_capacity') || updated.flags.includes('all_providers_limited')) {
      store.savePair(project, {
        ...updated,
        ...(auditorPool ? { auditorPool } : {}),
        flags: updated.flags.filter((flag) => flag !== 'waiting_for_capacity' && flag !== 'all_providers_limited'),
      });
    }
    await sendTaskPairMessage(next, taskId, 'handoff', buildAuditorHandoffMessage(updated));
    if (updated.executor) await sendTaskPairMessage(updated.executor, taskId, 'resend', buildExecutorResendMessage(updated, previousAuditor));
    await sendTaskPairMessage(updated.brain, taskId, 'brain-line-reassign', buildBrainLine(updated, `auditor ${previousAuditor ?? '(none)'} → ${next}: ${reason}.`));
    return true;
  }

  /**
   * Executor equivalent of {@link replaceAuditor}: only reached today from a
   * limit-triggered failover (`#tickPair`). Hands the new executor the
   * pair's existing workspace and state, and records the change in the pair
   * events via the same REASSIGN marker path.
   */
  async #replaceExecutor(project: string, taskId: string, reason: string, opts: { dueToLimit?: boolean } = {}): Promise<boolean> {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    if (!stored || isTerminalTaskPairStatus(stored.state.status) || !stored.state.executor) return false;
    const pair = stored.state;
    const pool = pair.executorPool === 'economy' ? 'economy' as const : 'primary' as const;
    const exclude = new Set<string>([pair.brain, pair.executor!, ...(pair.auditor ? [pair.auditor] : [])]);
    const requestedModel = opts.dueToLimit ? undefined : pair.executorModel;
    const avoidProviderFamily = opts.dueToLimit ? providerFamilyOfSession(pair.executor!) : undefined;
    const pickInput = { brain: pair.brain, role: 'executor' as const, pool, exclude, project, requestedModel, avoidProviderFamily };
    const next = this.#pick(pickInput) ?? await this.#provision({ ...pickInput, taskId });
    if (!next) {
      if (opts.dueToLimit) {
        // See replaceAuditor: the limited executor itself must stay IN this
        // scan even though it is excluded from the pick.
        const limitedScanExclude = new Set<string>([pair.brain, ...(pair.auditor ? [pair.auditor] : [])]);
        const limited = describeLimitedProviderFamilies({ brain: pair.brain, role: 'executor', pool, exclude: limitedScanExclude });
        if (limited) {
          const key = `all_providers_limited:${pair.round}`;
          if (stored.liveness.notified.includes(key)) return false;
          const state = pair.flags.includes('all_providers_limited') ? pair : { ...pair, flags: [...pair.flags, 'all_providers_limited' as TaskPairFlag], updatedAt: this.#now() };
          store.savePair(project, state, { liveness: { ...stored.liveness, notified: [...stored.liveness.notified, key] } });
          this.#queueNotice(state, 'all_providers_limited', `executor ${pair.executor} limited; no cross-family replacement available (${limited.text})`);
          return false;
        }
      }
      this.#flagOnce(project, taskId, 'waiting_for_capacity', requestedModel ? describeRequestedModelMiss(requestedModel) : describePoolSyncGap(pair.brain));
      return false;
    }
    const previousExecutor = pair.executor;
    const result = taskPairService.applyMarker({
      project,
      writer: 'daemon',
      marker: { verb: 'REASSIGN', knownVerb: 'REASSIGN', taskId, attrs: { executor: next } },
      source: 'heartbeat',
      now: this.#now(),
      eventId: `heartbeat:${project}:${taskId}:reassign-executor:${next}:${this.#now()}`,
    });
    const updated = result.pair ?? store.getPair(project, taskId)?.state;
    if (!updated) return false;
    const executorPool = this.#poolOf(updated.brain, next);
    if (executorPool || updated.flags.includes('all_providers_limited')) {
      store.savePair(project, {
        ...updated,
        ...(executorPool ? { executorPool } : {}),
        flags: updated.flags.filter((flag) => flag !== 'all_providers_limited'),
      });
    }
    await sendTaskPairMessage(next, taskId, 'executor-handoff', buildExecutorHandoffMessage(updated, previousExecutor, reason));
    await sendTaskPairMessage(updated.brain, taskId, 'brain-line-reassign', buildBrainLine(updated, `executor ${previousExecutor ?? '(none)'} → ${next}: ${reason}.`));
    return true;
  }

  /** Brain's pairs in this project whose audit is running (an auditor is assigned). */
  #activeAudits(project: string, brain: string, exceptTaskId: string): number {
    return getTaskPairStore().listActivePairs(project).filter((stored) => (
      stored.state.brain === brain
      && stored.state.taskId !== exceptTaskId
      && stored.state.status === 'in_audit'
      && !!stored.state.auditor
      && stored.state.auditor !== TASK_PAIR_NO_AUDITOR
    )).length;
  }

  async #pickExecutor(project: string, taskId: string): Promise<void> {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    if (!stored || stored.state.executor) return;
    const pair = stored.state;
    const requestedModel = pair.executorModel;
    if (this.#needsUserPoolChoice(pair.brain, requestedModel)) {
      await this.#flagNoPoolAndNotify(project, taskId, pair.brain);
      return;
    }
    const pool = pair.executorPool === 'economy' ? 'economy' : 'primary';
    const exclude = new Set<string>([pair.brain, ...(pair.auditor ? [pair.auditor] : [])]);
    const next = this.#pick({ brain: pair.brain, role: 'executor', pool, exclude, project, requestedModel })
      ?? await this.#provision({ brain: pair.brain, role: 'executor', pool, project, taskId, requestedModel });
    if (!next) {
      this.#flagOnce(
        project, taskId, 'waiting_for_capacity',
        requestedModel ? describeRequestedModelMiss(requestedModel) : describePoolSyncGap(pair.brain),
      );
      return;
    }
    taskPairService.applyMarker({
      project,
      writer: 'daemon',
      marker: { verb: 'REASSIGN', knownVerb: 'REASSIGN', taskId, attrs: { executor: next } },
      source: 'heartbeat',
      now: this.#now(),
      eventId: `heartbeat:${project}:${taskId}:executor:${next}:${this.#now()}`,
    });
    // A dispatch that named no executor briefs the one picked for it.
    await taskPairService.briefParticipants(project, taskId);
  }

  #flagOnce(project: string, taskId: string, flag: TaskPairFlag, detail?: string): void {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    if (!stored || stored.state.flags.includes(flag)) return;
    const state = { ...stored.state, flags: [...stored.state.flags, flag], updatedAt: this.#now() };
    store.savePair(project, state);
    this.#queueNotice(state, flag, detail);
  }

  /**
   * Like {@link #flagOnce} but never notifies Brain: a queued pair unable to
   * start yet is common and usually self-resolving, so per-pair noise here
   * would spam Brain for an ordinary transient gap. {@link #checkQueueStalls}
   * is the only path that tells Brain about this, and only once it has
   * actually persisted.
   */
  #flagQuiet(project: string, taskId: string, flag: TaskPairFlag): void {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    if (!stored || stored.state.flags.includes(flag)) return;
    store.savePair(project, { ...stored.state, flags: [...stored.state.flags, flag], updatedAt: this.#now() });
  }

  /**
   * Owner rule: a project with no execution pool configured has no built-in
   * default. A role with neither a named session nor a named model there
   * cannot be picked or provisioned at all -- ask the user instead of
   * guessing. Injected `pickCandidate`/`provision` deps stand in for a real
   * pool (the seam every other pool-backed pick test already relies on), so
   * this never fires while either is overridden.
   */
  #needsUserPoolChoice(brain: string, requestedModel: string | undefined): boolean {
    if (requestedModel) return false;
    if (this.#deps.pickCandidate || this.#deps.provision) return false;
    return !brainHasConfiguredPools(brain);
  }

  /** Flags the pair (idempotent) and tries the one combined, rate-limited ask-the-user notice for its project. */
  async #flagNoPoolAndNotify(project: string, taskId: string, brain: string): Promise<void> {
    this.#flagQuiet(project, taskId, 'no_pool_configured');
    await this.#checkNoPoolAsk(project, brain, this.#now());
  }

  /**
   * One combined, rate-limited notice per project for every pair currently
   * unable to start because no execution pool is configured and no model
   * was named for one of its roles. Fires promptly (unlike the queue-stall
   * notice, there is nothing to wait out here -- the pair can never resolve
   * this on its own) but never repeats faster than the same cooldown used
   * for the stall notice, and stops entirely once a pool is configured.
   */
  async #checkNoPoolAsk(project: string, brain: string, now: number): Promise<void> {
    if (brainHasConfiguredPools(brain)) return;
    const store = getTaskPairStore();
    const waiting = store.listActivePairs(project).filter((stored) => (
      stored.state.brain === brain && stored.state.flags.includes('no_pool_configured')
    ));
    if (waiting.length === 0) return;
    const key = `no_pool_ask_notice:${project}:${brain}`;
    const lastSent = Number(store.getMeta(key) ?? 0);
    if (now - lastSent < TASK_PAIR_QUEUE_STALL_NOTICE_MS) return;
    store.setMeta(key, String(now));
    await sendTaskPairMessage(
      brain, TASK_PAIR_AGGREGATE_NOTICE_ID, 'brain-no-pool-ask',
      buildNoPoolAskMessage(project, waiting.map((stored) => stored.state)),
    );
  }

  /**
   * One combined, rate-limited notice per Brain for queued pairs that have
   * been unable to start for a long time (owner correction: a queue miss is
   * ordinary and self-resolving; only a persistent one is worth Brain's
   * attention, and never one message per pair).
   */
  async #checkQueueStalls(project: string, brain: string, now: number): Promise<void> {
    const store = getTaskPairStore();
    const queued = store.listActivePairs(project).filter((stored) => (
      stored.state.brain === brain && stored.state.status === 'queued'
    ));
    // Queue misses are recorded per pair. Report once any queued work has
    // remained capacity-blocked for the stall interval; the scheduler may
    // continue past a miss when a later pair needs a different role/model.
    const stalledHead = queued.some((stored) => (
      stored.state.flags.includes('waiting_for_capacity') && now - stored.state.updatedAt >= TASK_PAIR_QUEUE_STALL_NOTICE_MS
    ));
    if (!stalledHead) return;
    const key = `queue_stall_notice:${project}:${brain}`;
    const lastSent = Number(store.getMeta(key) ?? 0);
    if (now - lastSent < TASK_PAIR_QUEUE_STALL_NOTICE_MS) return;
    store.setMeta(key, String(now));
    await sendTaskPairMessage(
      brain, TASK_PAIR_AGGREGATE_NOTICE_ID, 'brain-queue-stall',
      buildQueueStallNoticeMessage(queued.map((stored) => stored.state), now),
    );
  }

  /** Pool bookkeeping after role changes: record pools, flag off-pool and unreviewed economy work. */
  #checkPools(project: string, taskId: string): void {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    if (!stored) return;
    const pair = stored.state;
    let changed = false;
    const next = { ...pair, flags: [...pair.flags] };
    if (pair.executor && !pair.executorPool) {
      const pool = this.#poolOf(pair.brain, pair.executor);
      if (pool) { next.executorPool = pool; changed = true; }
    }
    if (pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR && !pair.auditorPool) {
      const pool = this.#poolOf(pair.brain, pair.auditor);
      if (pool) { next.auditorPool = pool; changed = true; }
    }
    if (changed) store.savePair(project, next);
  }

  /** Called after a PASS is applied: economy work passed outside the primary pool is flagged once. */
  flagEconomyUnreviewed(project: string, taskId: string): void {
    const stored = getTaskPairStore().getPair(project, taskId);
    if (!stored) return;
    const pair = stored.state;
    if (pair.status === 'passed' && pair.executorPool === 'economy' && pair.auditorPool !== 'primary') {
      this.#flagOnce(project, taskId, 'economy_unreviewed');
    }
  }

  // ---- queue ---------------------------------------------------------------

  async runQueue(project: string, brain: string): Promise<void> {
    const key = `${project}\u0000${brain}`;
    const running = this.#queueRuns.get(key);
    // Operations in a run are individually bounded, so waiting for an older
    // run cannot become an unbounded queue freeze. Re-run after it drains so a
    // trigger that arrived while the queue was settling is not lost.
    if (running) {
      await running;
      if (!this.#queueRuns.has(key)) await this.runQueue(project, brain);
      return;
    }
    const run = this.#runQueueOnce(project, brain).finally(() => this.#queueRuns.delete(key));
    this.#queueRuns.set(key, run);
    await run;
  }

  async #runQueueOnce(project: string, brain: string): Promise<void> {
    const store = getTaskPairStore();
    const max = resolveTaskPairMaxConcurrency(brain);
    const pairs = store.listActivePairs(project).filter((pair) => pair.state.brain === brain);
    let open = pairs.filter((pair) => TASK_PAIR_OPEN_STATUSES.includes(pair.state.status)).length;
    const queued = pairs.filter((pair) => pair.state.status === 'queued').sort(compareQueuedTaskPairs);
    for (const stored of queued) {
      if (open >= max) return;
      const pair = stored.state;
      // A brief-less pair imported from legacy supervision has no real work to
      // start: park it (one batched Brain notice) until Brain adds a brief.
      // A bare DISPATCH that was auto-queued (no brief, no legacy id) is
      // legitimate and starts below, briefed like an immediate DISPATCH.
      if (pair.brief === undefined && stored.legacyTaskId) {
        this.#flagOnceWithKey(stored, 'no_brief', buildNoBriefLine(pair.taskId));
        this.#logQueueSkip(project, pair, 'legacy pair has no brief');
        continue;
      }
      // A session named explicitly on QUEUE (executor=/auditor=) is a
      // reservation, but it is only BOUND at start: while queued it never
      // occupies a window (TASK_PAIR_OPEN_STATUSES excludes 'queued'), so
      // another pair may freely pick it in the meantime. If it is busy right
      // now, this pair waits for it rather than silently substituting an
      // auto-pick -- the owner named that session on purpose.
      if ((pair.executor && this.#busy(pair.executor)) || (pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR && this.#busy(pair.auditor))) {
        this.#flagQuiet(project, pair.taskId, 'waiting_for_capacity');
        this.#logQueueSkip(project, pair, 'named participant busy');
        continue;
      }
      // Owner rule: no execution pool configured and no model named for a
      // role this pair still needs -- nothing can be picked or provisioned
      // for it, and it cannot resolve on its own. Unlike an ordinary
      // capacity miss, this pair never blocks pairs behind it: it cannot
      // start regardless of order, so later queued pairs are still tried.
      const executorNeedsUser = !pair.executor && this.#needsUserPoolChoice(brain, pair.executorModel);
      const auditorNeedsUser = !pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR && this.#needsUserPoolChoice(brain, pair.auditorModel);
      if (executorNeedsUser || auditorNeedsUser) {
        await this.#flagNoPoolAndNotify(project, pair.taskId, brain);
        this.#logQueueSkip(project, pair, 'no execution pool configured');
        continue;
      }
      const pool = pair.executorPool === 'economy' ? 'economy' : 'primary';
      if (!pair.executor || !pair.auditor) {
        this.#flagQuiet(project, pair.taskId, 'waiting_for_capacity');
      }
      const executor = pair.executor
        ?? this.#pick({ brain, role: 'executor', pool, exclude: new Set([brain, ...(pair.auditor ? [pair.auditor] : [])]), project, requestedModel: pair.executorModel })
        ?? await this.#queueProvision({ brain, role: 'executor', pool, project, taskId: pair.taskId, requestedModel: pair.executorModel });
      const auditor = pair.auditor
        ?? (executor
          ? this.#pick({ brain, role: 'auditor', pool: 'primary', exclude: new Set([brain, executor]), project, requestedModel: pair.auditorModel })
            ?? await this.#queueProvision({ brain, role: 'auditor', pool: 'primary', project, taskId: pair.taskId, requestedModel: pair.auditorModel })
          : undefined);
      if (!executor || !auditor || executor === auditor) {
        // No per-pair notice here (owner correction): a queue miss is common
        // and self-resolving as soon as a matching session frees up or is
        // provisioned. Brain hears about it only via the combined, rate-
        // limited stall notice (see #checkQueueStalls) once it has actually
        // persisted a long time.
        this.#flagQuiet(project, pair.taskId, 'waiting_for_capacity');
        this.#logQueueSkip(project, pair, !executor ? 'executor capacity unavailable' : !auditor ? 'auditor capacity unavailable' : 'executor and auditor collide');
        continue;
      }
      const result = taskPairService.applyMarker({
        project,
        writer: 'daemon',
        marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: pair.taskId, attrs: { executor, auditor } },
        source: 'queue',
        now: this.#now(),
        eventId: `queue:${project}:${pair.taskId}:dispatch:${this.#now()}`,
      });
      const dispatched = result.pair ?? store.getPair(project, pair.taskId)?.state;
      if (!dispatched) continue;
      const cleaned = { ...dispatched, flags: dispatched.flags.filter((flag) => flag !== 'waiting_for_capacity' && flag !== 'no_pool_configured') };
      store.savePair(project, cleaned);
      open += 1;
      if (pair.brief !== undefined) {
        // The executor's worktree exists before the brief that names it is sent.
        const withWorkspace = await taskPairService.ensureWorkspace(project, pair.taskId) ?? cleaned;
        await sendTaskPairMessage(executor, pair.taskId, 'dispatch', `${pair.brief}${buildDispatchTrailer(withWorkspace)}`);
        if (auditor !== TASK_PAIR_NO_AUDITOR) await sendTaskPairMessage(auditor, pair.taskId, 'auditor-assigned', buildAuditorAssignmentMessage(cleaned));
      } else {
        // DISPATCH never required a brief (unlike QUEUE); a queued pair that
        // reached here without one -- a bare DISPATCH the queue could not
        // start right away -- is briefed the same way an immediate DISPATCH
        // always was, instead of stalling for a brief it was never going to get.
        await taskPairService.briefParticipants(project, pair.taskId);
      }
      await sendTaskPairMessage(brain, pair.taskId, 'brain-line-dispatch', buildBrainLine(cleaned, `dispatched from the queue: executor ${executor}, auditor ${auditor}.`));
    }
  }

  #flagOnceWithKey(stored: StoredTaskPair, key: string, text: string): void {
    if (stored.liveness.notified.includes(key)) return;
    getTaskPairStore().saveLiveness(stored.project, stored.state.taskId, { ...stored.liveness, notified: [...stored.liveness.notified, key] });
    this.#queueLineNotice(stored.state, `brain-${key}`, text);
  }
}

export const taskPairAutomation = new TaskPairAutomation();
