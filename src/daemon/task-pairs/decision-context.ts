import { createHash } from 'node:crypto';
import type { TaskPairState } from '../../../shared/task-pair.js';
import { readPairScheduling } from '../../../shared/task-pair-suspension.js';
/** Changes when the question/wait changes, not on liveness heartbeats. */
export function taskPairDecisionRevision(pair: TaskPairState): string {
  const wait = readPairScheduling(pair.scheduling);
  return createHash('sha256').update(JSON.stringify([
    pair.taskId, pair.deliveryRound ?? 1, pair.round, pair.status, pair.blockedNote ?? '',
    wait?.manual, wait?.note, wait?.dependsOn,
  ])).digest('hex').slice(0, 24);
}
