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
import {
  TASK_PAIR_HEARTBEAT_MS,
  TASK_PAIR_NO_AUDITOR,
  TASK_PAIR_OPEN_STATUSES,
  TASK_PAIR_QUEUE_STALL_NOTICE_MS,
  TASK_PAIR_SILENCE_LIMIT,
  compareQueuedTaskPairs,
  isTerminalTaskPairStatus,
  taskPairSideToAct,
  type TaskPairFlag,
  type TaskPairIntent,
  type TaskPairState,
} from '../../../shared/task-pair.js';
import { getTaskPairStore, type StoredTaskPair, type TaskPairLiveness } from './store.js';
import { isPairsEngineProject, resolveTaskPairMaxConcurrency } from './engine.js';
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
  buildAuditorAssignmentMessage,
  buildAuditorHandoffMessage,
  buildBrainLine,
  buildBrainNoticeMessage,
  buildDispatchTrailer,
  buildExecutorHandoffMessage,
  buildExecutorResendMessage,
  buildNoPoolAskMessage,
  buildNudgeMessage,
  buildQueueStallNoticeMessage,
  type PendingBrainNotice,
} from './messages.js';

/** Synthetic task id for an aggregated multi-pair Brain notice (dedup key only; no real pair). */
const TASK_PAIR_AGGREGATE_NOTICE_ID = '__aggregate__' as const;

/** Heartbeat interval override, e.g. for real-device testing. */
export const TASK_PAIR_HEARTBEAT_ENV = 'IMCODES_TASK_PAIR_HEARTBEAT_MS' as const;

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

async function defaultImportLegacy(now: number): Promise<void> {
  const [{ importLegacyTasks }, { getSupervisionTaskRegistry }] = await Promise.all([
    import('./legacy-import.js'),
    import('../supervision-state-store.js'),
  ]);
  importLegacyTasks(getSupervisionTaskRegistry(), now);
}

export class TaskPairAutomation implements TaskPairScheduler {
  #timer?: NodeJS.Timeout;
  #deps: TaskPairSchedulerDeps;
  #queueRuns = new Map<string, Promise<void>>();

  constructor(deps: TaskPairSchedulerDeps = {}) {
    this.#deps = deps;
  }

  #intervalMs = TASK_PAIR_HEARTBEAT_MS;
  #nextTickAt = 0;
  #badgeSessions = new Set<string>();

  start(intervalMs = resolveTaskPairHeartbeatMs()): void {
    if (this.#timer) return;
    this.#intervalMs = intervalMs;
    this.#nextTickAt = this.#now() + intervalMs;
    this.publishBadges();
    this.#timer = setInterval(() => {
      void this.tick().catch((error) => logger.warn({ err: error }, 'task-pair: heartbeat tick failed'));
    }, intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
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

  async #flushPendingNotices(): Promise<void> {
    const pending = this.#pendingNotices;
    if (!pending) return;
    for (const [brain, entries] of pending) {
      if (entries.length === 0) continue;
      if (entries.length === 1) {
        const { pair, flag, detail } = entries[0]!;
        await sendTaskPairMessage(brain, pair.taskId, `brain-${flag}`, buildBrainNoticeMessage(pair, flag, detail));
      } else {
        await sendTaskPairMessage(brain, TASK_PAIR_AGGREGATE_NOTICE_ID, 'brain-aggregate', buildAggregatedBrainNoticeMessage(entries));
      }
    }
  }

  /**
   * Session badges: every executor/auditor of an open pair shows the pair
   * heartbeat countdown; sessions that left every open pair are cleared.
   */
  publishBadges(): void {
    const next = new Set<string>();
    for (const stored of getTaskPairStore().listActivePairs()) {
      if (!TASK_PAIR_OPEN_STATUSES.includes(stored.state.status) || !isPairsEngineProject(stored.project)) continue;
      for (const session of [stored.state.executor, stored.state.auditor]) {
        if (session && session !== TASK_PAIR_NO_AUDITOR) next.add(session);
      }
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
    // previous heartbeat. In that case the executor is the single owner of
    // forward progress, regardless of the nominal side-to-act derived from
    // the pair status (including an audit that has gone quiet before its
    // materials arrived). One nudge per heartbeat escalates exactly once.
    const executor = pair.executor;
    const auditor = pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR ? pair.auditor : undefined;
    // Neither side counts as "quiet" (needing a nudge) while it is rate- or
    // capacity-limited: tsk_cd_limit_failover's whole point is that a limited
    // session is never nudged (it cannot answer) and is held/failed-over by
    // its own dedicated path below, not treated as plain silence here.
    const executorQuiet = Boolean(executor)
      && !this.#busy(executor!)
      && !this.#rateLimited(executor!)
      && !this.#capacityLimited(executor!)
      && (liveness.activityExecutorAt ?? liveness.progressExecutorAt) <= previousTick;
    const auditorQuiet = Boolean(auditor)
      && !this.#busy(auditor!)
      && !this.#rateLimited(auditor!)
      && !this.#capacityLimited(auditor!)
      && (liveness.activityAuditorAt ?? liveness.progressAuditorAt) <= previousTick;
    const executorFlagged = pair.flagSides.blocked === 'executor' || pair.flagSides.needs_input === 'executor';
    const auditorFlagged = pair.flagSides.blocked === 'auditor' || pair.flagSides.needs_input === 'auditor';
    if (executorQuiet && auditorQuiet && !executorFlagged && !auditorFlagged && !pair.flags.includes('executor_silent')) {
      const silence = liveness.silenceExecutor + 1;
      liveness.silenceExecutor = silence;
      store.saveLiveness(stored.project, pair.taskId, liveness);
      if (silence < TASK_PAIR_SILENCE_LIMIT) {
        const repeat = silence > 1
          ? `This is repeated quiet heartbeat ${silence}; take ownership now.`
          : 'Both sides are idle; take ownership of the next action now.';
        await sendTaskPairMessage(executor!, pair.taskId, 'nudge-executor', buildNudgeMessage(pair, 'executor', repeat));
      } else if (silence === TASK_PAIR_SILENCE_LIMIT) {
        this.#escalateExecutor(stored.project, pair.taskId, `both executor and auditor were silent for ${TASK_PAIR_SILENCE_LIMIT} heartbeats`);
      }
      return;
    }

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
      if (!capacityLimited) await sendTaskPairMessage(session, pair.taskId, `nudge-${side}`, buildNudgeMessage(pair, side));
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
    // The run-queue loop is strict FIFO and stops at the first pair it can't
    // start, so only the HEAD of the queue ever gets flagged/timestamped by
    // #flagQuiet -- everything behind it is equally stuck (it cannot start
    // until the head does), so once the head has been stuck long enough the
    // whole queued set is reported together.
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
    if (running) { await running; return; }
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
      // A session named explicitly on QUEUE (executor=/auditor=) is a
      // reservation, but it is only BOUND at start: while queued it never
      // occupies a window (TASK_PAIR_OPEN_STATUSES excludes 'queued'), so
      // another pair may freely pick it in the meantime. If it is busy right
      // now, this pair waits for it rather than silently substituting an
      // auto-pick -- the owner named that session on purpose.
      if ((pair.executor && this.#busy(pair.executor)) || (pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR && this.#busy(pair.auditor))) {
        this.#flagQuiet(project, pair.taskId, 'waiting_for_capacity');
        return;
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
        continue;
      }
      const pool = pair.executorPool === 'economy' ? 'economy' : 'primary';
      const executor = pair.executor
        ?? this.#pick({ brain, role: 'executor', pool, exclude: new Set([brain, ...(pair.auditor ? [pair.auditor] : [])]), project, requestedModel: pair.executorModel })
        ?? await this.#provision({ brain, role: 'executor', pool, project, taskId: pair.taskId, requestedModel: pair.executorModel });
      const auditor = pair.auditor
        ?? (executor
          ? this.#pick({ brain, role: 'auditor', pool: 'primary', exclude: new Set([brain, executor]), project, requestedModel: pair.auditorModel })
            ?? await this.#provision({ brain, role: 'auditor', pool: 'primary', project, taskId: pair.taskId, requestedModel: pair.auditorModel })
          : undefined);
      if (!executor || !auditor || executor === auditor) {
        // No per-pair notice here (owner correction): a queue miss is common
        // and self-resolving as soon as a matching session frees up or is
        // provisioned. Brain hears about it only via the combined, rate-
        // limited stall notice (see #checkQueueStalls) once it has actually
        // persisted a long time.
        this.#flagQuiet(project, pair.taskId, 'waiting_for_capacity');
        return;
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

}

export const taskPairAutomation = new TaskPairAutomation();
