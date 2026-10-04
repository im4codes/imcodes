/**
 * Daemon-authored messages to pair participants (nudges, reminders, handoffs,
 * dispatched briefs, Brain notices).
 *
 * Every message is an append-by-default inter-session send, never the priority
 * control path. Providers that cannot append retain the durable FIFO fallback,
 * and it is committed to the timeline once as an automation row. A message
 * for a pair is skipped while an earlier message for the same pair and reason
 * is still pending, so nothing piles up.
 */
import { CHAT_MESSAGE_ORIGINS } from '../../../shared/chat-message-origin.js';
import { randomUUID } from 'node:crypto';
import { getSession } from '../../store/session-store.js';
import { timelineEmitter } from '../timeline-emitter.js';
import { getTransportRuntime } from '../../agent/session-manager.js';
import { dispatchSessionMessage } from '../session-dispatch.js';
import { createSendDispatchId, type SendMessageId } from '../../../shared/send-message-id.js';
import { MEMORY_MCP_SEND_DELIVERY_MODES } from '../../../shared/memory-mcp-contracts.js';
import { TASK_PAIR_AUTOMATION_KIND, TASK_PAIR_NUDGE_ID_PREFIX, isTerminalTaskPairStatus } from '../../../shared/task-pair.js';
import { getTaskPairStore } from './store.js';
import { noteTaskPairFocus, resetTaskPairFocusForTests, taskPairFocusOf } from './focus.js';
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

export { noteTaskPairFocus, taskPairFocusOf, resetTaskPairFocusForTests };

export interface TaskPairDeliveryDeps {
  send?: (target: string, text: string, messageId: string) => Promise<void>;
}

let testDeps: TaskPairDeliveryDeps | undefined;

// A heartbeat/replay can reach the same reminder from two scheduler paths in
// one turn.  The transport queue is the durable authority, but it is only
// populated after dispatch starts; this small in-process gate closes that
// race without changing the queue's restart semantics.
const inFlightTaskPairMessages = new Set<string>();

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
  const dedupeKey = `${target}\u0000${taskId}\u0000${reason}`;
  if (inFlightTaskPairMessages.has(dedupeKey)) return 'skipped_pending';
  noteTaskPairFocus(target, taskId);
  // Keep the last actionable pair instruction durable so participant recovery
  // can resume the exact turn after a provider/process restart.  Aggregate
  // Brain notices and terminal pairs are intentionally excluded.
  if (!taskId.startsWith('__')) {
    const store = getTaskPairStore();
    for (const stored of store.listActivePairs().filter((item) => item.state.taskId === taskId && !isTerminalTaskPairStatus(item.state.status))) {
      const liveness = { ...stored.liveness };
      if (stored.state.executor === target) {
        liveness.lastInstructionExecutor = text;
        liveness.lastInstructionExecutorAt = Date.now();
      } else if (stored.state.auditor === target) {
        liveness.lastInstructionAuditor = text;
        liveness.lastInstructionAuditorAt = Date.now();
      } else {
        continue;
      }
      store.saveLiveness(stored.project, taskId, liveness);
    }
  }
  if (testDeps?.send) {
    inFlightTaskPairMessages.add(dedupeKey);
    try {
      await testDeps.send(target, text, messageId);
      return 'sent';
    } finally {
      inFlightTaskPairMessages.delete(dedupeKey);
    }
  }
  const record = getSession(target);
  if (!record) return 'no_session';
  // Check before emitting the timeline projection.  Previously a replay of a
  // queued message returned skipped_pending only after appending a fresh
  // automation row, which made the old reminder card reappear on every
  // reconnect even though no duplicate transport send occurred.
  if (hasPendingTaskPairMessage(target, taskId, reason)) return 'skipped_pending';
  inFlightTaskPairMessages.add(dedupeKey);
  try {
    timelineEmitter.emit(target, 'user.message', {
      text,
      clientMessageId: messageId,
      allowDuplicate: true,
      automation: true,
      automationKind: TASK_PAIR_AUTOMATION_KIND,
      memoryExcluded: true,
    }, { source: 'daemon', confidence: 'high', eventId: messageId });
    const result = await dispatchSessionMessage(record, text, {
      dispatchId: createSendDispatchId(),
      // Our own id prefix is what makes the pending-queue dedupe possible.
      messageId: messageId as SendMessageId,
      durableQueue: true,
      deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.APPEND,
      suppressTimeline: true,
      messageOrigin: CHAT_MESSAGE_ORIGINS.SYSTEM,
    });
    return result === 'queued' ? 'queued' : 'sent';
  } catch (error) {
    logger.warn({ err: error, target, taskId, reason }, 'task-pair: message delivery failed');
    return 'failed';
  } finally {
    inFlightTaskPairMessages.delete(dedupeKey);
  }
}
