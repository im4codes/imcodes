import { isEndedSupervisionTaskStatus } from '../../shared/supervision-config.js';
import { isTerminalTaskPairStatus, parseTaskPairBindingId } from '../../shared/task-pair.js';
import type { QueueSupervisionAdmission } from '../../shared/transport-queue-types.js';
import { getSession } from '../store/session-store.js';
import logger from '../util/logger.js';
import { getDelegationReplyStore } from './delegation-reply-store.js';
import { resolveQueuedSupervisionHeartbeatDelivery } from './supervision-participant-delivery.js';
import { getSupervisionTaskRegistry } from './supervision-state-store.js';
import { getTaskPairStore } from './task-pairs/store.js';

/**
 * Whether the task a task-bound delegation reply belongs to has ENDED.
 *
 * Production incident (2026-09-25): replies from Cx8/Cx6/Cx4 about tasks that
 * had been cancelled or finalized four to twelve days earlier reached the
 * Brain right after an auto-upgrade restart. A task-bound reply never expires
 * by time (task authority governs it) and stays pending while its origin
 * identity does not match; the only thing that ever retries it is the next
 * startup resume. Nothing asked whether the task was still alive, so the first
 * restart whose origin matched delivered them as fresh work.
 *
 * Deliberately conservative -- a wrongly retired reply loses real work:
 *   - legacy tasks end only at `finalized` / `cancelled`
 *     ({@link isEndedSupervisionTaskStatus}), never at `blocked` / `pushed`;
 *   - pairs-engine tasks (assignment `pair:<taskId>:<role>`, or a legacy task
 *     imported into a pair) end at the pair's terminal status;
 *   - an unknown task, an unresolvable pair or a failing lookup is NOT ended.
 */
export interface EndedDelegationReplyTask {
  taskId: string;
  engine: 'legacy' | 'pairs';
  status: string;
}

export function endedTaskOfDelegationReply(record: {
  taskId?: string;
  assignmentId?: string;
  origin?: { sessionName: string };
}): EndedDelegationReplyTask | undefined {
  const taskId = record.taskId?.trim();
  if (!taskId) return undefined;
  try {
    const binding = parseTaskPairBindingId(record.assignmentId);
    if (binding) {
      const project = record.origin ? getSession(record.origin.sessionName)?.projectName : undefined;
      const pair = project ? getTaskPairStore().getPair(project, binding.taskId) : undefined;
      return pair && isTerminalTaskPairStatus(pair.state.status)
        ? { taskId: binding.taskId, engine: 'pairs', status: pair.state.status }
        : undefined;
    }
    const task = getSupervisionTaskRegistry().getTaskRecord(taskId);
    if (task && isEndedSupervisionTaskStatus(task.status)) {
      return { taskId, engine: 'legacy', status: task.status };
    }
    // A legacy task imported into the pairs engine keeps its registry status;
    // the pair is the live authority from then on.
    const imported = getTaskPairStore().getPairByLegacyTaskId(taskId);
    if (imported && isTerminalTaskPairStatus(imported.state.status)) {
      return { taskId, engine: 'pairs', status: imported.state.status };
    }
    return undefined;
  } catch (error) {
    logger.warn({ error, taskId }, 'delegation reply task liveness lookup failed; treating the task as live');
    return undefined;
  }
}

/**
 * The last edge before a queued delegation reply reaches a provider: the
 * durable transport FIFO / resend queue can outlive the task too.
 */
export function resolveQueuedDelegationReplyAdmission(delegationId: string): QueueSupervisionAdmission {
  const id = delegationId.trim();
  if (!id) return 'authorized';
  let record;
  try {
    record = getDelegationReplyStore().get(id);
  } catch (error) {
    logger.warn({ error, delegationId: id }, 'queued delegation reply lookup failed; admitting it');
    return 'authorized';
  }
  if (!record) return 'authorized';
  const ended = endedTaskOfDelegationReply(record);
  if (!ended) return 'authorized';
  logger.info({ delegationId: id, ...ended }, 'dropping a queued delegation reply: its task already ended');
  return 'stale';
}

/**
 * One admission for a queued transport entry, shared by the restart resend
 * drain and the runtime's own pending drain. The supervision heartbeat check
 * applies to every entry; a queued delegation reply must additionally still
 * belong to a task that has not ended (the durable queue can outlive it).
 */
export function resolveTransportQueueEntryAdmission(sessionName: string, entry: {
  clientMessageId?: string;
  commandId?: string;
  text: string;
  supervisionReference?: Parameters<typeof resolveQueuedSupervisionHeartbeatDelivery>[0]['supervisionReference'];
  delegationReply?: { delegationId: string };
}): QueueSupervisionAdmission {
  const supervision = resolveQueuedSupervisionHeartbeatDelivery({
    targetSessionName: sessionName,
    clientMessageId: entry.clientMessageId ?? entry.commandId ?? '',
    text: entry.text,
    supervisionReference: entry.supervisionReference,
  });
  if (supervision !== 'authorized' || !entry.delegationReply) return supervision;
  return resolveQueuedDelegationReplyAdmission(entry.delegationReply.delegationId);
}
