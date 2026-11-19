import { TASK_PAIR_DECISION_BRAIN_NOTICE_REASON } from '../../../shared/task-pair-decision.js';
import {
  candidateTaskIdsFromNudgeId,
  isTerminalTaskPairStatus,
  matchTaskPairNudgeTarget,
  parseTaskPairNudgeWakePayload,
  TASK_PAIR_ENDED_PAIR_NOTICE_REASONS,
  TASK_PAIR_NON_GIT_FINISH_NOTICE_REASON,
  TASK_PAIR_NUDGE_ID_PREFIX,
  TASK_PAIR_PASS_DONE_NOTICE_REASON,
  type TaskPairState,
} from '../../../shared/task-pair.js';
import { isTaskPairSuspended, TASK_PAIR_DEPENDENCY_FAILURE_REASON, TASK_PAIR_RESUME_REASON, TASK_PAIR_WAKE_BINDING_TAG, type TaskPairWakeBinding } from '../../../shared/task-pair-suspension.js';
import { getTaskPairStore, type StoredTaskPair } from './store.js';
import { isTaskPairMissingExplanation, taskPairMissingExplanationKey } from './decision-context.js';

export function isDoneBrainCompletionNoticeAllowed(
  state: Pick<TaskPairState, 'brain' | 'status' | 'integrationDismissedAt' | 'scheduling'>,
  reason: string,
  target?: string,
): boolean | undefined {
  if (reason === TASK_PAIR_PASS_DONE_NOTICE_REASON) {
    if (target !== state.brain) return false;
    if (state.integrationDismissedAt !== undefined) return false;
    if (state.status === 'done') return true;
    if (isTerminalTaskPairStatus(state.status)) return false;
    return !isTaskPairSuspended(state);
  }
  if (reason === TASK_PAIR_NON_GIT_FINISH_NOTICE_REASON) {
    return target === state.brain && state.status === 'done';
  }
  return undefined;
}

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
    const completionAllowed = isDoneBrainCompletionNoticeAllowed(state, reason, target);
    if (completionAllowed !== undefined) return completionAllowed;
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

export interface TaskPairNudgeAttribution {
  pair?: StoredTaskPair;
  taskId?: string;
  project?: string;
  reason?: string;
  ambiguous?: boolean;
  aggregate?: boolean;
}

/**
 * Build a bounded, one-query index of known task pairs (active and terminal)
 * covering every candidate `taskId` referenced by `rawIds`.
 */
export function buildTaskPairNudgeIndex(rawIds: readonly (string | undefined)[]): Map<string, StoredTaskPair[]> {
  const candidates = new Set<string>();
  for (const id of rawIds) {
    for (const candidate of candidateTaskIdsFromNudgeId(id)) {
      candidates.add(candidate);
    }
  }
  const byTaskId = new Map<string, StoredTaskPair[]>();
  if (candidates.size === 0) return byTaskId;
  for (const pair of getTaskPairStore().findPairsByTaskIds([...candidates])) {
    const bucket = byTaskId.get(pair.state.taskId);
    if (bucket) bucket.push(pair);
    else byTaskId.set(pair.state.taskId, [pair]);
  }
  return byTaskId;
}

function isPairParticipant(pair: StoredTaskPair, sessionName: string): boolean {
  return pair.state.brain === sessionName
    || pair.state.executor === sessionName
    || pair.state.auditor === sessionName;
}

/**
 * Centrally attribute a daemon-authored `task-pair-nudge:` entry to at most one
 * stored pair and extract its `reason` after the full matched task prefix.
 * Fails closed (`ambiguous: true` or `pair: undefined`) whenever ownership cannot
 * be uniquely confirmed.
 */
export function resolveTaskPairNudgeFromIndex(
  rawId: string | undefined,
  pairsByTaskId: ReadonlyMap<string, readonly StoredTaskPair[]>,
  sessionName: string,
  preferredProject?: string,
): TaskPairNudgeAttribution | undefined {
  if (!rawId?.startsWith(TASK_PAIR_NUDGE_ID_PREFIX)) return undefined;

  const wake = parseTaskPairNudgeWakePayload(rawId);
  if (wake) {
    if (wake.bindings.length !== 1) {
      return { reason: wake.reason, aggregate: true, ambiguous: true };
    }
    const binding = wake.bindings[0]!;
    const pair = (pairsByTaskId.get(binding.taskId) ?? []).find((item) => item.project === binding.project);
    return {
      pair,
      taskId: binding.taskId,
      project: binding.project,
      reason: wake.reason,
      ambiguous: false,
    };
  }
  if (rawId.includes(TASK_PAIR_WAKE_BINDING_TAG)) {
    return { ambiguous: true };
  }

  let matchedTaskId: string | undefined;
  for (const candidateTaskId of pairsByTaskId.keys()) {
    if (
      rawId.startsWith(`${TASK_PAIR_NUDGE_ID_PREFIX}${candidateTaskId}:`)
      && (!matchedTaskId || candidateTaskId.length > matchedTaskId.length)
    ) {
      matchedTaskId = candidateTaskId;
    }
  }
  if (!matchedTaskId) return undefined;

  const targetMatch = matchTaskPairNudgeTarget(rawId, matchedTaskId);
  if (!targetMatch.matches) {
    return { ambiguous: true };
  }

  const candidates = pairsByTaskId.get(matchedTaskId) ?? [];
  const participantMatches = candidates.filter((pair) => isPairParticipant(pair, sessionName));

  let resolved: StoredTaskPair | undefined;
  if (participantMatches.length === 1) {
    resolved = participantMatches[0];
  } else if (participantMatches.length === 0 && candidates.length === 1) {
    resolved = candidates[0];
  } else {
    return { taskId: matchedTaskId, reason: targetMatch.reason, ambiguous: true };
  }

  if (preferredProject && resolved && resolved.project !== preferredProject) {
    return { taskId: matchedTaskId, reason: targetMatch.reason, ambiguous: true };
  }

  return {
    pair: resolved,
    taskId: matchedTaskId,
    project: resolved?.project,
    reason: targetMatch.reason,
    ambiguous: false,
  };
}
