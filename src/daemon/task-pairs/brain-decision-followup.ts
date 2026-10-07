/**
 * One short follow-up when Brain's turn ended without deciding a pair that
 * awaits its decision.
 *
 * The notice that asks Brain to decide is an ordinary message: Brain may take
 * a turn, work on something else, and finish with a plain reply (or a no-op
 * marker), leaving the pair open until the next cadence reminder (>= 10
 * minutes). That reads as "Brain did not react". So when the turn that received
 * the notice ends and the pair is still awaiting a decision and was not touched
 * in that turn, Brain is told once, at once, that a plain reply is not an
 * answer. Each notice earns at most one follow-up; after it the ordinary
 * reminder cadence and its minimum gap apply unchanged.
 *
 * Turn boundaries come from the timeline events the transport already emits
 * (`session.state` running/idle, `transport.queue.delivery` for the notice's own
 * message id); nothing here guesses when a turn ended.
 */
import { PAIR_BRAIN_ACTION_TOOL_NAMES } from '../../../shared/memory-mcp-contracts.js';
import {
  TASK_PAIR_BRAIN_DECISION_FOLLOWUP_REASON,
  TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION,
  type TaskPairDeliveryResult,
} from '../../../shared/task-pair.js';
import logger from '../../util/logger.js';
import { recordBrainNoticeOutcome } from './brain-notice.js';
import { buildBrainDecisionFollowUpMessage } from './messages.js';
import { getTaskPairStore, type StoredTaskPair } from './store.js';

/** The notice's turn may have started a moment before its delivery was recorded. */
const TURN_START_SLACK_MS = 5_000;
/** A notice whose turn never ends in a way we can see is dropped (the cadence reminder remains). */
const ARM_TTL_MS = 60 * 60_000;
const MAX_ARMED_PER_BRAIN = 50;

interface ArmedNotice {
  /** Message-id prefix of the notice (`taskPairMessageIdPrefix`), matched against `transport.queue.delivery`. */
  prefix: string;
  taskIds: readonly string[];
  armedAt: number;
  /** When the notice reached the model: the queue delivery fact, else the send time of an immediate send. */
  deliveredAt: number | undefined;
  /** Pairs Brain acted on through a pair tool during the turn that received the notice. */
  touched: Set<string>;
}

export interface BrainDecisionFollowUpDeps {
  now(): number;
  send(brain: string, reason: string, text: string): Promise<TaskPairDeliveryResult>;
}

export interface ArmBrainDecisionFollowUp {
  brain: string;
  taskIds: readonly string[];
  messageIdPrefix: string;
  /** Result of the notice's own send: only a notice that reached (or queued for) Brain is armed. */
  result: TaskPairDeliveryResult;
}

export class BrainDecisionFollowUps {
  readonly #deps: BrainDecisionFollowUpDeps;
  readonly #armed = new Map<string, ArmedNotice[]>();
  readonly #turnStartedAt = new Map<string, number>();

  constructor(deps: BrainDecisionFollowUpDeps) {
    this.#deps = deps;
  }

  get armedCount(): number {
    let count = 0;
    for (const list of this.#armed.values()) count += list.length;
    return count;
  }

  arm(input: ArmBrainDecisionFollowUp): void {
    if (input.result !== 'sent' && input.result !== 'queued') return;
    if (input.taskIds.length === 0) return;
    const now = this.#deps.now();
    const list = (this.#armed.get(input.brain) ?? []).filter((entry) => now - entry.armedAt < ARM_TTL_MS);
    list.push({
      prefix: input.messageIdPrefix,
      taskIds: [...input.taskIds],
      armedAt: now,
      deliveredAt: input.result === 'sent' ? now : undefined,
      touched: new Set(),
    });
    this.#armed.set(input.brain, list.slice(-MAX_ARMED_PER_BRAIN));
  }

  /** Feed one timeline event of any session; only an armed Brain's events do anything. */
  observe(event: { sessionId: string; type: string; payload: Record<string, unknown> }): void {
    const entries = this.#armed.get(event.sessionId);
    if (!entries) return;
    const now = this.#deps.now();
    if (event.type === 'transport.queue.delivery') {
      const id = String(event.payload.clientMessageId ?? '');
      for (const entry of entries) if (id.startsWith(entry.prefix)) entry.deliveredAt = now;
      return;
    }
    if (event.type === 'tool.call') {
      // Only a pair tool that acts on a pair counts. A shell command or a free-text
      // message that merely contains the task id is not a decision, and reading a
      // pair (pair_get) is not one either.
      const tool = String(event.payload.tool ?? event.payload.name ?? '').split('__').pop() ?? '';
      if (!PAIR_BRAIN_ACTION_TOOL_NAMES.includes(tool)) return;
      const input = event.payload.input;
      const taskId = input && typeof input === 'object' ? (input as Record<string, unknown>).taskId : undefined;
      if (typeof taskId !== 'string') return;
      for (const entry of entries) {
        if (entry.deliveredAt !== undefined && entry.taskIds.includes(taskId)) entry.touched.add(taskId);
      }
      return;
    }
    if (event.type !== 'session.state') return;
    const state = String(event.payload.state ?? '').toLowerCase();
    if (state === 'running') {
      if (!this.#turnStartedAt.has(event.sessionId)) this.#turnStartedAt.set(event.sessionId, now);
      return;
    }
    if (state !== 'idle') return;
    const turnStartedAt = this.#turnStartedAt.get(event.sessionId);
    this.#turnStartedAt.delete(event.sessionId);
    void this.#turnEnded(event.sessionId, turnStartedAt, now).catch((error) => {
      logger.warn({ err: error, brain: event.sessionId }, 'task-pair: Brain decision follow-up failed');
    });
  }

  async #turnEnded(brain: string, turnStartedAt: number | undefined, now: number): Promise<void> {
    const entries = this.#armed.get(brain);
    if (!entries || turnStartedAt === undefined) return;
    const expired = (entry: ArmedNotice) => now - entry.armedAt >= ARM_TTL_MS;
    // Only the turn that received a notice counts as its answer; a notice still
    // queued behind a different turn waits for its own.
    const answered = entries.filter((entry) => entry.deliveredAt !== undefined && entry.deliveredAt >= turnStartedAt - TURN_START_SLACK_MS);
    const remaining = entries.filter((entry) => !answered.includes(entry) && !expired(entry));
    if (remaining.length > 0) this.#armed.set(brain, remaining);
    else this.#armed.delete(brain);
    if (answered.length === 0) return;

    const store = getTaskPairStore();
    const owned = new Map<string, StoredTaskPair>();
    for (const stored of store.pairsForSession(brain)) if (stored.state.brain === brain) owned.set(stored.state.taskId, stored);
    const undecided = new Map<string, StoredTaskPair>();
    for (const entry of answered) {
      for (const taskId of entry.taskIds) {
        const stored = owned.get(taskId);
        if (!stored || stored.state.status !== TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION) continue;
        if (entry.touched.has(taskId)) continue;
        // An action on the pair this turn (a lifecycle marker or its MCP twin) is on the event log.
        const since = entry.deliveredAt ?? entry.armedAt;
        if (store.listEvents(stored.project, taskId, 30).some((event) => event.writer === brain && event.at >= since)) continue;
        undecided.set(taskId, stored);
      }
    }
    if (undecided.size === 0) return;
    const pairs = [...undecided.values()];
    const result = await this.#deps.send(brain, TASK_PAIR_BRAIN_DECISION_FOLLOWUP_REASON, buildBrainDecisionFollowUpMessage(pairs.map((stored) => stored.state)));
    for (const stored of pairs) recordBrainNoticeOutcome(stored, TASK_PAIR_BRAIN_DECISION_FOLLOWUP_REASON, result, this.#deps.now());
    if (result !== 'sent' && result !== 'queued') return;
    // The follow-up is a Brain delivery: the shared minimum gap keeps the ordinary reminder from piling on.
    const at = this.#deps.now();
    for (const stored of store.listActivePairs().filter((candidate) => candidate.state.brain === brain)) {
      store.saveLiveness(stored.project, stored.state.taskId, { ...stored.liveness, brainGlobalLastDeliveryAt: at });
    }
  }
}
