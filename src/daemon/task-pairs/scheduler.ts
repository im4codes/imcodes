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
  TASK_PAIR_SILENCE_LIMIT,
  isTerminalTaskPairStatus,
  taskPairSideToAct,
  type TaskPairFlag,
  type TaskPairIntent,
  type TaskPairState,
} from '../../../shared/task-pair.js';
import { getTaskPairStore, type StoredTaskPair, type TaskPairLiveness } from './store.js';
import { isPairsEngineProject, resolveTaskPairAllowlist, resolveTaskPairMaxConcurrency } from './engine.js';
import { sendTaskPairMessage } from './delivery.js';
import { hasRecentTaskPairProviderError } from './provider-errors.js';
import { taskPairService, type TaskPairScheduler } from './service.js';
import {
  allowlistedProvisionConfig,
  describeAuditorAllowlistGap,
  isSessionBusy,
  isSessionProviderLimited,
  listTaskPairCandidates,
  poolOfSession,
  type TaskPairPickRole,
} from './pool.js';
import {
  buildAuditorAssignmentMessage,
  buildAuditorHandoffMessage,
  buildBrainLine,
  buildBrainNoticeMessage,
  buildDispatchTrailer,
  buildExecutorResendMessage,
  buildNudgeMessage,
} from './messages.js';

/** Heartbeat interval override, e.g. for real-device testing. */
export const TASK_PAIR_HEARTBEAT_ENV = 'IMCODES_TASK_PAIR_HEARTBEAT_MS' as const;

export interface TaskPairSchedulerDeps {
  now?: () => number;
  isBusy?: (sessionName: string) => boolean;
  isLimited?: (sessionName: string) => boolean;
  pickCandidate?: (input: { brain: string; role: TaskPairPickRole; pool: 'primary' | 'economy'; exclude: ReadonlySet<string>; project: string }) => string | undefined;
  provision?: (input: { brain: string; role: TaskPairPickRole; pool: 'primary' | 'economy'; project: string; taskId: string }) => Promise<string | undefined>;
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
  /** A structured usage limit, or a transient provider refusal (capacity, rate, overload) in the last heartbeat. */
  #limited(session: string): boolean {
    return (this.#deps.isLimited ?? ((name) => isSessionProviderLimited(name)))(session)
      || hasRecentTaskPairProviderError(session, this.#now(), this.#intervalMs);
  }
  #poolOf(brain: string, session: string) { return (this.#deps.poolOf ?? ((b, s) => poolOfSession(b, s)))(brain, session); }

  #pick(input: { brain: string; role: TaskPairPickRole; pool: 'primary' | 'economy'; exclude: ReadonlySet<string>; project: string }): string | undefined {
    if (this.#deps.pickCandidate) return this.#deps.pickCandidate(input);
    const allowlist = resolveTaskPairAllowlist(input.project);
    return listTaskPairCandidates({ ...input, allowlist })[0]?.name;
  }

  async #provision(input: { brain: string; role: TaskPairPickRole; pool: 'primary' | 'economy'; project: string; taskId: string }): Promise<string | undefined> {
    if (this.#deps.provision) return this.#deps.provision(input);
    const allowlist = resolveTaskPairAllowlist(input.project);
    const config = allowlistedProvisionConfig({ ...input, allowlist });
    if (!config) return undefined;
    const { provisionSupervisionTarget } = await import('../supervision-auto-provision.js');
    const result = await provisionSupervisionTarget({
      parentSessionName: input.brain,
      pool: input.role === 'auditor' ? 'primary' : input.pool,
      requestedCapabilityId: config.capabilityId,
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
    try {
      for (const stored of store.listActivePairs()) {
        if (!isPairsEngineProject(stored.project)) continue;
        brains.set(stored.state.brain, stored.project);
        try {
          await this.#tickPair(stored, now);
        } catch (error) {
          logger.warn({ err: error, taskId: stored.state.taskId }, 'task-pair: pair tick failed');
        }
      }
    } finally {
      this.#tickBusy = undefined;
    }
    for (const [brain, project] of brains) await this.runQueue(project, brain);
    // Workspaces of pairs that ended a week ago go (hourly at most).
    await taskPairService.sweepWorkspaces(now);
    store.prune(now);
    this.#nextTickAt = now + this.#intervalMs;
    this.publishBadges();
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
    const pair = stored.state;
    const side = taskPairSideToAct(pair);
    const liveness: TaskPairLiveness = { ...stored.liveness, notified: [...stored.liveness.notified] };
    const previousTick = liveness.lastTickAt;
    liveness.lastTickAt = now;
    const store = getTaskPairStore();
    if (!side) { store.saveLiveness(stored.project, pair.taskId, liveness); return; }

    const session = side === 'executor' ? pair.executor : pair.auditor;
    if (side === 'auditor' && (!session || session === TASK_PAIR_NO_AUDITOR)) {
      store.saveLiveness(stored.project, pair.taskId, liveness);
      await this.replaceAuditor(stored.project, pair.taskId, 'no auditor');
      return;
    }
    if (!session) { store.saveLiveness(stored.project, pair.taskId, liveness); return; }

    // A usage-limited auditor is replaced at once. A usage-limited executor
    // holds the work, so it is neither nudged (it cannot answer) nor handed to
    // Brain while the limit may clear; it escalates only once the limit has
    // lasted as long as the silence limit, and nudging resumes after it clears.
    if (this.#limited(session)) {
      if (side === 'auditor') {
        store.saveLiveness(stored.project, pair.taskId, liveness);
        await this.replaceAuditor(stored.project, pair.taskId, 'auditor hit a provider usage limit');
        return;
      }
      liveness.limitedExecutor = (liveness.limitedExecutor ?? 0) + 1;
      store.saveLiveness(stored.project, pair.taskId, liveness);
      if (liveness.limitedExecutor === TASK_PAIR_SILENCE_LIMIT) {
        this.#escalateExecutor(stored.project, pair.taskId, `executor hit a provider usage limit for ${TASK_PAIR_SILENCE_LIMIT} heartbeats`);
      }
      return;
    }
    if (side === 'executor' && liveness.limitedExecutor) liveness.limitedExecutor = 0;

    const progressAt = side === 'executor' ? liveness.progressExecutorAt : liveness.progressAuditorAt;
    // An escalated executor that is working on this pair again can be escalated
    // again if it later goes silent.
    if (side === 'executor' && progressAt > previousTick && pair.flags.includes('executor_silent')) {
      store.savePair(stored.project, { ...pair, flags: pair.flags.filter((flag) => flag !== 'executor_silent'), updatedAt: now }, { liveness });
    }
    const flagSide = pair.flagSides.blocked === side || pair.flagSides.needs_input === side;
    const flagged = flagSide && (pair.flags.includes('blocked') || pair.flags.includes('needs_input'));
    if (this.#busy(session) || progressAt > previousTick || flagged) {
      store.saveLiveness(stored.project, pair.taskId, liveness);
      return;
    }

    const silence = (side === 'executor' ? liveness.silenceExecutor : liveness.silenceAuditor) + 1;
    if (side === 'executor') liveness.silenceExecutor = silence;
    else liveness.silenceAuditor = silence;
    store.saveLiveness(stored.project, pair.taskId, liveness);

    if (silence < TASK_PAIR_SILENCE_LIMIT) {
      await sendTaskPairMessage(session, pair.taskId, `nudge-${side}`, buildNudgeMessage(pair, side));
      return;
    }
    if (silence === TASK_PAIR_SILENCE_LIMIT) {
      if (side === 'auditor') await this.replaceAuditor(stored.project, pair.taskId, `auditor silent for ${TASK_PAIR_SILENCE_LIMIT} heartbeats`);
      else this.#escalateExecutor(stored.project, pair.taskId, `executor silent for ${TASK_PAIR_SILENCE_LIMIT} heartbeats`);
    }
    // Past the limit: no more nudges until that side makes progress or is reassigned.
  }

  #escalateExecutor(project: string, taskId: string, reason: string): void {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    if (!stored || stored.state.flags.includes('executor_silent')) return;
    const state = { ...stored.state, flags: [...stored.state.flags, 'executor_silent' as TaskPairFlag], updatedAt: this.#now() };
    store.savePair(project, state);
    logger.info({ taskId, reason }, 'task-pair: executor escalated to Brain');
    void sendTaskPairMessage(state.brain, taskId, 'brain-executor_silent', buildBrainNoticeMessage(state, 'executor_silent'));
  }

  // ---- auditor replacement ------------------------------------------------

  async replaceAuditor(project: string, taskId: string, reason: string): Promise<boolean> {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    if (!stored || isTerminalTaskPairStatus(stored.state.status) || stored.state.auditor === TASK_PAIR_NO_AUDITOR) return false;
    const pair = stored.state;
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
    const exclude = new Set<string>([pair.brain, ...(pair.executor ? [pair.executor] : []), ...(pair.auditor ? [pair.auditor] : []), ...pair.previousAuditors]);
    const pickInput = { brain: pair.brain, role: 'auditor' as const, pool: 'primary' as const, exclude, project };
    const next = this.#pick(pickInput) ?? await this.#provision({ ...pickInput, taskId });
    if (!next || exclude.has(next)) {
      const key = `needs_auditor:${pair.round}`;
      if (stored.liveness.notified.includes(key)) return false;
      const state = pair.flags.includes('needs_auditor') ? pair : { ...pair, flags: [...pair.flags, 'needs_auditor' as TaskPairFlag], updatedAt: this.#now() };
      store.savePair(project, state, { liveness: { ...stored.liveness, notified: [...stored.liveness.notified, key] } });
      const gap = describeAuditorAllowlistGap({ brain: pair.brain, allowlist: resolveTaskPairAllowlist(project) });
      await sendTaskPairMessage(pair.brain, taskId, 'brain-needs_auditor', buildBrainNoticeMessage(state, 'needs_auditor', gap));
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
    if (auditorPool || updated.flags.includes('waiting_for_capacity')) {
      store.savePair(project, {
        ...updated,
        ...(auditorPool ? { auditorPool } : {}),
        flags: updated.flags.filter((flag) => flag !== 'waiting_for_capacity'),
      });
    }
    await sendTaskPairMessage(next, taskId, 'handoff', buildAuditorHandoffMessage(updated));
    if (updated.executor) await sendTaskPairMessage(updated.executor, taskId, 'resend', buildExecutorResendMessage(updated, previousAuditor));
    await sendTaskPairMessage(updated.brain, taskId, 'brain-line-reassign', buildBrainLine(updated, `auditor ${previousAuditor ?? '(none)'} → ${next}: ${reason}.`));
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
    const pool = pair.executorPool === 'economy' ? 'economy' : 'primary';
    const exclude = new Set<string>([pair.brain, ...(pair.auditor ? [pair.auditor] : [])]);
    const next = this.#pick({ brain: pair.brain, role: 'executor', pool, exclude, project })
      ?? await this.#provision({ brain: pair.brain, role: 'executor', pool, project, taskId });
    if (!next) {
      this.#flagOnce(project, taskId, 'waiting_for_capacity');
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

  #flagOnce(project: string, taskId: string, flag: TaskPairFlag): void {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    if (!stored || stored.state.flags.includes(flag)) return;
    const state = { ...stored.state, flags: [...stored.state.flags, flag], updatedAt: this.#now() };
    store.savePair(project, state);
    void sendTaskPairMessage(state.brain, taskId, `brain-${flag}`, buildBrainNoticeMessage(state, flag));
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
    const queued = pairs.filter((pair) => pair.state.status === 'queued').sort((a, b) => a.queueOrder - b.queueOrder);
    for (const stored of queued) {
      if (open >= max) return;
      const pair = stored.state;
      if (pair.brief === undefined) {
        this.#flagOnceWithKey(stored, 'no_brief', `queued without a brief: write QUEUE ${pair.taskId} … <!-- IMCODES_TASK_END ${pair.taskId} --> or DISPATCH it yourself.`);
        continue;
      }
      const pool = pair.executorPool === 'economy' ? 'economy' : 'primary';
      const executor = pair.executor
        ?? this.#pick({ brain, role: 'executor', pool, exclude: new Set([brain, ...(pair.auditor ? [pair.auditor] : [])]), project })
        ?? await this.#provision({ brain, role: 'executor', pool, project, taskId: pair.taskId });
      const auditor = pair.auditor
        ?? (executor
          ? this.#pick({ brain, role: 'auditor', pool: 'primary', exclude: new Set([brain, executor]), project })
            ?? await this.#provision({ brain, role: 'auditor', pool: 'primary', project, taskId: pair.taskId })
          : undefined);
      if (!executor || !auditor || executor === auditor) {
        this.#flagOnce(project, pair.taskId, 'waiting_for_capacity');
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
      const cleaned = { ...dispatched, flags: dispatched.flags.filter((flag) => flag !== 'waiting_for_capacity') };
      store.savePair(project, cleaned);
      open += 1;
      // The executor's worktree exists before the brief that names it is sent.
      const withWorkspace = await taskPairService.ensureWorkspace(project, pair.taskId) ?? cleaned;
      await sendTaskPairMessage(executor, pair.taskId, 'dispatch', `${pair.brief}${buildDispatchTrailer(withWorkspace)}`);
      if (auditor !== TASK_PAIR_NO_AUDITOR) await sendTaskPairMessage(auditor, pair.taskId, 'auditor-assigned', buildAuditorAssignmentMessage(cleaned));
      await sendTaskPairMessage(brain, pair.taskId, 'brain-line-dispatch', buildBrainLine(cleaned, `dispatched from the queue: executor ${executor}, auditor ${auditor}.`));
    }
  }

  #flagOnceWithKey(stored: StoredTaskPair, key: string, text: string): void {
    if (stored.liveness.notified.includes(key)) return;
    getTaskPairStore().saveLiveness(stored.project, stored.state.taskId, { ...stored.liveness, notified: [...stored.liveness.notified, key] });
    void sendTaskPairMessage(stored.state.brain, stored.state.taskId, `brain-${key}`, buildBrainLine(stored.state, text));
  }
}

export const taskPairAutomation = new TaskPairAutomation();
