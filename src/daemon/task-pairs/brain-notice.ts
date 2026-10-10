/**
 * What became of a daemon notice addressed to a pair's Brain.
 *
 * A pair card in Brain's timeline is only a projection; the notice is a
 * separate send that can be delivered, queued behind a busy turn, or fail. Each
 * outcome is recorded durably (one event row plus the pair's liveness) so a
 * stalled wait can be diagnosed afterwards and the card can say whether Brain
 * was actually told.
 */
import { randomUUID } from 'node:crypto';
import {
  TASK_PAIR_BRAIN_DECISION_FOLLOWUP_REASON,
  TASK_PAIR_BRAIN_DECISION_NOTICE_REASONS,
  TASK_PAIR_BRAIN_NOTICE_EVENT,
  TASK_PAIR_BRAIN_NOTICE_STATUSES,
  TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION,
  type TaskPairBrainNotice,
  type TaskPairBrainNoticeStatus,
  type TaskPairDeliveryResult,
} from '../../../shared/task-pair.js';
import logger from '../../util/logger.js';
import { getTaskPairStore, type StoredTaskPair } from './store.js';

function isRecordedStatus(result: TaskPairDeliveryResult): result is TaskPairBrainNoticeStatus {
  return (TASK_PAIR_BRAIN_NOTICE_STATUSES as readonly string[]).includes(result);
}

/** Record the outcome of one notice to `stored`'s Brain. A pending duplicate changes nothing. */
export function recordBrainNoticeOutcome(
  stored: StoredTaskPair,
  reason: string,
  result: TaskPairDeliveryResult,
  at: number = Date.now(),
): void {
  if (!isRecordedStatus(result)) return;
  const store = getTaskPairStore();
  const { taskId, status } = stored.state;
  if (result === 'no_session' || result === 'failed') {
    logger.warn({ taskId, brain: stored.state.brain, reason, result }, 'task-pair: Brain notice was not delivered');
  }
  store.recordEvent({
    id: `brain-notice:${stored.project}:${taskId}:${reason}:${at}:${randomUUID().slice(0, 8)}`,
    project: stored.project, taskId, writer: 'daemon', role: 'daemon', verb: TASK_PAIR_BRAIN_NOTICE_EVENT,
    attrs: { reason, status: result }, effect: result, unusual: false, source: 'daemon', fromStatus: status, toStatus: status, at,
  });
  // The pair card answers "was Brain told to decide?": only decision notices
  // (and their follow-up) update it, not an unrelated dispatch or workspace line.
  if (reason !== TASK_PAIR_BRAIN_DECISION_FOLLOWUP_REASON
    && !(TASK_PAIR_BRAIN_DECISION_NOTICE_REASONS as readonly string[]).includes(reason)) return;
  // Re-read: the caller's snapshot may predate a concurrent liveness write.
  const current = store.getPair(stored.project, taskId);
  if (!current) return;
  store.saveLiveness(stored.project, taskId, {
    ...current.liveness, brainNoticeStatus: result, brainNoticeAt: at, brainNoticeReason: reason,
  });
}

/**
 * The last Brain notice of the current decision wait, for the pair card; absent
 * unless the pair awaits Brain's decision and a notice was recorded during this wait.
 */
export function brainNoticeForCard(stored: StoredTaskPair | undefined): TaskPairBrainNotice | undefined {
  if (!stored || stored.state.status !== TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION) return undefined;
  const live = stored.liveness;
  if (!live.brainNoticeStatus || live.brainNoticeAt === undefined) return undefined;
  if (live.phaseStartedAt !== undefined && live.brainNoticeAt < live.phaseStartedAt) return undefined;
  return { status: live.brainNoticeStatus, at: live.brainNoticeAt, reason: live.brainNoticeReason ?? '' };
}
