import { createHash } from 'node:crypto';
import type { TaskPairState } from '../../../shared/task-pair.js';
import { isTerminalTaskPairStatus, TASK_PAIR_NO_AUDITOR } from '../../../shared/task-pair.js';
import { readPairScheduling, isTaskPairSuspended } from '../../../shared/task-pair-suspension.js';
import { getTaskPairStore, type StoredTaskPair } from './store.js';

/** Changes when the question/wait changes, not on liveness heartbeats. */
export function taskPairDecisionRevision(pair: TaskPairState): string {
  const wait = readPairScheduling(pair.scheduling);
  const flagsKey = pair.flags.filter((flag) => flag === 'blocked' || flag === 'needs_input').sort().join(',') || pair.status;
  return createHash('sha256').update(JSON.stringify([
    pair.taskId, pair.deliveryRound ?? 1, pair.round, pair.status, pair.blockedNote ?? '',
    flagsKey, wait?.manual, wait?.note, wait?.dependsOn,
  ])).digest('hex').slice(0, 24);
}

/**
 * Checks whether an active task pair is genuinely blocked without an authoritative
 * explanation, scheduling context, or pending decision request for the current delivery round.
 */
export function isTaskPairMissingExplanation(stored: StoredTaskPair): boolean {
  const pair = stored.state;
  if (isTerminalTaskPairStatus(pair.status)) return false;
  // Exclude scheduling waits (dependencies, manual pause).
  if (isTaskPairSuspended(pair)) return false;
  // Exclude capacity or auditor waits.
  if (pair.flags.some((flag) => flag === 'waiting_for_capacity' || flag === 'needs_auditor')) return false;
  // Authoritative note already exists: no explanation missing.
  if (pair.blockedNote) return false;

  // Must have an active blocker flag (blocked / needs_input).
  const isBlocked = pair.flags.some((flag) => flag === 'blocked' || flag === 'needs_input');
  if (!isBlocked) return false;

  const store = getTaskPairStore();
  const deliveryRound = pair.deliveryRound ?? 1;
  const currentReq = store.latestDecisionRequest(stored.project, pair.taskId, pair.round, deliveryRound);
  if (currentReq && !store.isDecisionResolved(currentReq)) return false;

  const side = pair.flagSides?.blocked || pair.flagSides?.needs_input;
  const target = (side === 'auditor' ? pair.auditor : pair.executor) || pair.executor || pair.brain;
  if (!target || target === TASK_PAIR_NO_AUDITOR) return false;

  return true;
}

/**
 * Canonical context key for a missing-explanation episode.
 * Derived from semantic state (project, task, delivery round, round, flags, revision, persistent blocker transition event);
 * routine heartbeats, checklist progress, and liveness sweeps never mutate the key.
 */
export function taskPairMissingExplanationKey(stored: StoredTaskPair): string {
  const pair = stored.state;
  const flagsKey = pair.flags.filter((flag) => flag === 'blocked' || flag === 'needs_input').sort().join(',') || pair.status;
  const rev = taskPairDecisionRevision(pair);
  let blockerEventId = '';
  try {
    const store = getTaskPairStore();
    blockerEventId = store.latestBlockerEventId?.(stored.project, pair.taskId) ?? '';
  } catch {
    // ignore
  }
  return `missing-explanation:${stored.project}:${pair.taskId}:${pair.deliveryRound ?? 1}:${pair.round}:${flagsKey}:${rev}${blockerEventId ? ':' + blockerEventId : ''}`;
}

