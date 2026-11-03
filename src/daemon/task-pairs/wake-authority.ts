import { TASK_PAIR_DECISION_BRAIN_NOTICE_REASON } from '../../../shared/task-pair-decision.js';
import { isTerminalTaskPairStatus, TASK_PAIR_ENDED_PAIR_NOTICE_REASONS, TASK_PAIR_NUDGE_ID_PREFIX } from '../../../shared/task-pair.js';
import { isTaskPairSuspended, TASK_PAIR_DEPENDENCY_FAILURE_REASON, TASK_PAIR_RESUME_REASON, TASK_PAIR_WAKE_BINDING_TAG, type TaskPairWakeBinding } from '../../../shared/task-pair-suspension.js';
import { getTaskPairStore } from './store.js';
import { isTaskPairMissingExplanation, taskPairMissingExplanationKey } from './decision-context.js';

export function pairWakeBindings(target: string, taskId: string): TaskPairWakeBinding[] {
  return getTaskPairStore().pairsForSession(target)
    .filter((p) => taskId.startsWith('__') ? p.state.brain === target && !isTerminalTaskPairStatus(p.state.status) && !isTaskPairSuspended(p.state) : p.state.taskId === taskId)
    .map((p) => ({ project: p.project, taskId: p.state.taskId, epoch: p.state.scheduling?.epoch ?? 0 }));
}
export function pairWakeAllowed(bindings: TaskPairWakeBinding[], reason: string, target?: string): boolean {
  return bindings.every((b) => {
    const state = getTaskPairStore().getPair(b.project, b.taskId)?.state;
    if (!state || (state.scheduling?.epoch ?? 0) !== b.epoch) return false;
    if (TASK_PAIR_ENDED_PAIR_NOTICE_REASONS.includes(reason)) return true;
    if (isTerminalTaskPairStatus(state.status)) return false;
    // Explicit human/decision input may reach Brain while workers stay suspended.
    if (reason === TASK_PAIR_DECISION_BRAIN_NOTICE_REASON) return target === state.brain;
    if (reason === TASK_PAIR_DEPENDENCY_FAILURE_REASON) return true;
    if (reason === TASK_PAIR_RESUME_REASON) return !state.scheduling?.manual && !state.scheduling?.dependsOn.length;
    if (reason === 'missing-explanation-request') {
      const stored = getTaskPairStore().getPair(b.project, b.taskId);
      if (!stored || !isTaskPairMissingExplanation(stored)) return false;
      const side = state.flagSides?.blocked || state.flagSides?.needs_input;
      const currentTarget = (side === 'auditor' ? state.auditor : state.executor) || state.executor || state.brain;
      if (target && currentTarget !== target) return false;
    }
    return !isTaskPairSuspended(state);
  });
}
export function encodePairWake(bindings: TaskPairWakeBinding[], reason: string, contextId?: string): string {
  return `${TASK_PAIR_WAKE_BINDING_TAG}${encodeURIComponent(JSON.stringify({
    bindings,
    reason,
    ...(contextId ? { contextId } : {}),
  }))}:`;
}
/** Durable queue admission. A pre-pause message remains stale even after resume/restart. */
export function queuedPairWakeAllowed(sessionName: string, id: string): boolean {
  if (!id.startsWith(TASK_PAIR_NUDGE_ID_PREFIX)) return true;
  const at = id.lastIndexOf(TASK_PAIR_WAKE_BINDING_TAG);
  if (at < 0) return true; // legacy ids are checked by the existing task-liveness guard
  try {
    const encoded = id.slice(at + TASK_PAIR_WAKE_BINDING_TAG.length).split(':', 1)[0]!;
    const data = JSON.parse(decodeURIComponent(encoded)) as { bindings: TaskPairWakeBinding[]; reason: string; contextId?: string };
    if (!Array.isArray(data.bindings) || !data.bindings.length || typeof data.reason !== 'string') return false;
    for (const binding of data.bindings) {
      if (typeof binding.project !== 'string' || typeof binding.taskId !== 'string' || !Number.isSafeInteger(binding.epoch)) return false;
      const s = getTaskPairStore().getPair(binding.project, binding.taskId)?.state;
      if (!s || ![s.brain, s.executor, s.auditor].includes(sessionName)) return false;
    }
    if (data.reason === 'missing-explanation-request') {
      for (const binding of data.bindings) {
        const stored = getTaskPairStore().getPair(binding.project, binding.taskId);
        if (!stored || !isTaskPairMissingExplanation(stored)) return false;
        if (!data.contextId || taskPairMissingExplanationKey(stored) !== data.contextId) return false;
        const side = stored.state.flagSides?.blocked || stored.state.flagSides?.needs_input;
        const currentTarget = (side === 'auditor' ? stored.state.auditor : stored.state.executor) || stored.state.executor || stored.state.brain;
        if (currentTarget !== sessionName) return false;
      }
    }
    return pairWakeAllowed(data.bindings, data.reason, sessionName);
  } catch { return false; }
}
