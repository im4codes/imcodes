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
import { TASK_PAIR_AUTOMATION_KIND, TASK_PAIR_NUDGE_ID_PREFIX, isTerminalTaskPairStatus, type TaskPairDeliveryResult } from '../../../shared/task-pair.js';
import { recordBrainNoticeOutcome } from './brain-notice.js';
import { getTaskPairStore } from './store.js';
import { noteTaskPairFocus, resetTaskPairFocusForTests, taskPairFocusOf } from './focus.js';
import logger from '../../util/logger.js';

export type { TaskPairDeliveryResult };

export function taskPairMessageIdPrefix(taskId: string, reason: string, dedupeScope?: string): string {
  const prefix = `${TASK_PAIR_NUDGE_ID_PREFIX}${taskId}:${reason}:`;
  // Lifecycle-scoped notices must remain distinct in the durable queue as
  // well as in the in-process gate.  URI-encoding keeps arbitrary scope text
  // from introducing another prefix separator.  Callers without a scope keep
  // the historical prefix for replay and admission compatibility.
  return dedupeScope === undefined ? prefix : `${prefix}scope:${encodeURIComponent(dedupeScope)}:`;
}

/** True while a message for this pair and reason still waits in the session's queue. */
export function hasPendingTaskPairMessage(sessionName: string, taskId: string, reason?: string, dedupeScope?: string): boolean {
  const runtime = getTransportRuntime(sessionName);
  if (!runtime) return false;
  const prefix = reason ? taskPairMessageIdPrefix(taskId, reason, dedupeScope) : `${TASK_PAIR_NUDGE_ID_PREFIX}${taskId}:`;
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
  // A test transport is replaced between test cases.  Do not let a promise
  // from the previous case keep the process-wide coalescing gate closed in the
  // next one (the real transport owns its pending state independently).
  inFlightTaskPairMessages.clear();
}

/** Clear only the in-process coalescing gate in a test. */
export function resetTaskPairDeliveryInFlightForTests(): void {
  inFlightTaskPairMessages.clear();
}

export async function sendTaskPairMessage(
  target: string,
  taskId: string,
  reason: string,
  text: string,
  dedupeScope?: string,
): Promise<TaskPairDeliveryResult> {
  const result = await deliverTaskPairMessage(target, taskId, reason, text, dedupeScope);
  // Brain's side of a pair: remember what became of the notice. Aggregate
  // notices (`__...` ids) name no single pair; their senders record per pair.
  if (!taskId.startsWith('__')) {
    for (const stored of getTaskPairStore().pairsForSession(target)) {
      if (stored.state.taskId === taskId && stored.state.brain === target) recordBrainNoticeOutcome(stored, reason, result);
    }
  }
  return result;
}

async function deliverTaskPairMessage(
  target: string,
  taskId: string,
  reason: string,
  text: string,
  dedupeScope?: string,
): Promise<TaskPairDeliveryResult> {
  const messageId = `${taskPairMessageIdPrefix(taskId, reason, dedupeScope)}${randomUUID()}`;
  // Most reasons are once-pending per pair.  A few state-machine notices are
  // explicitly once per lifecycle scope (for example, one in-audit warning
  // per round); callers provide that scope without changing the durable
  // message-id prefix consumed by clients.
  const dedupeKey = `${target}\u0000${taskId}\u0000${reason}\u0000${dedupeScope ?? ''}`;
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
      // Test transports record delivery synchronously in every caller.  Drop
      // the in-flight marker immediately after invoking the fake so one test
      // cannot leak a pending key into the next test's fresh dependency
      // instance.  The real transport path below retains the await-backed
      // gate, which is the production concurrency protection.
      const send = testDeps.send(target, text, messageId);
      inFlightTaskPairMessages.delete(dedupeKey);
      await send;
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
  if (hasPendingTaskPairMessage(target, taskId, reason, dedupeScope)) return 'skipped_pending';
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
