/**
 * Daemon-authored messages to pair participants (nudges, reminders, handoffs,
 * dispatched briefs, Brain notices).
 *
 * Every message is an ordinary durable-FIFO send, never the priority control
 * path and never a mid-turn append, and it is committed to the timeline once
 * as an automation row. A message for a pair is skipped while an earlier
 * message for the same pair and reason is still queued, so nothing piles up.
 */
import { randomUUID } from 'node:crypto';
import { getSession } from '../../store/session-store.js';
import { timelineEmitter } from '../timeline-emitter.js';
import { getTransportRuntime } from '../../agent/session-manager.js';
import { dispatchSessionMessage } from '../session-dispatch.js';
import { createSendDispatchId, type SendMessageId } from '../../../shared/send-message-id.js';
import { TASK_PAIR_AUTOMATION_KIND, TASK_PAIR_NUDGE_ID_PREFIX } from '../../../shared/task-pair.js';
import logger from '../../util/logger.js';

export type TaskPairDeliveryResult = 'sent' | 'queued' | 'skipped_pending' | 'no_session' | 'failed';

export function taskPairMessageIdPrefix(taskId: string, reason: string): string {
  return `${TASK_PAIR_NUDGE_ID_PREFIX}${taskId}:${reason}:`;
}

/** True while a message for this pair and reason still waits in the session's queue. */
export function hasPendingTaskPairMessage(sessionName: string, taskId: string, reason?: string): boolean {
  const runtime = getTransportRuntime(sessionName);
  if (!runtime) return false;
  const prefix = reason ? taskPairMessageIdPrefix(taskId, reason) : `${TASK_PAIR_NUDGE_ID_PREFIX}${taskId}:`;
  return runtime.pendingEntries.some((entry) => entry.clientMessageId.startsWith(prefix));
}

/**
 * The pair each session was last messaged about (in memory). A session in
 * several pairs usually answers the message it just got, so its plain output
 * is progress on that pair and not on every pair it belongs to.
 */
const lastMessagedTask = new Map<string, string>();

export function noteTaskPairFocus(sessionName: string, taskId: string): void {
  lastMessagedTask.set(sessionName, taskId);
}

export function taskPairFocusOf(sessionName: string): string | undefined {
  return lastMessagedTask.get(sessionName);
}

export function resetTaskPairFocusForTests(): void {
  lastMessagedTask.clear();
}

export interface TaskPairDeliveryDeps {
  send?: (target: string, text: string, messageId: string) => Promise<void>;
}

let testDeps: TaskPairDeliveryDeps | undefined;

export function setTaskPairDeliveryDepsForTests(deps: TaskPairDeliveryDeps | undefined): void {
  testDeps = deps;
}

export async function sendTaskPairMessage(
  target: string,
  taskId: string,
  reason: string,
  text: string,
): Promise<TaskPairDeliveryResult> {
  const messageId = `${taskPairMessageIdPrefix(taskId, reason)}${randomUUID()}`;
  noteTaskPairFocus(target, taskId);
  if (testDeps?.send) {
    await testDeps.send(target, text, messageId);
    return 'sent';
  }
  const record = getSession(target);
  if (!record) return 'no_session';
  if (hasPendingTaskPairMessage(target, taskId, reason)) return 'skipped_pending';
  timelineEmitter.emit(target, 'user.message', {
    text,
    clientMessageId: messageId,
    allowDuplicate: true,
    automation: true,
    automationKind: TASK_PAIR_AUTOMATION_KIND,
    memoryExcluded: true,
  }, { source: 'daemon', confidence: 'high', eventId: messageId });
  try {
    const result = await dispatchSessionMessage(record, text, {
      dispatchId: createSendDispatchId(),
      // Our own id prefix is what makes the pending-queue dedupe possible.
      messageId: messageId as SendMessageId,
      durableQueue: true,
      suppressTimeline: true,
    });
    return result === 'queued' ? 'queued' : 'sent';
  } catch (error) {
    logger.warn({ err: error, target, taskId, reason }, 'task-pair: message delivery failed');
    return 'failed';
  }
}
