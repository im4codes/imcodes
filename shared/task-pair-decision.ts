/** Durable task questions, human feedback and Brain rulings. Feedback never changes lifecycle. */
export const TASK_PAIR_DECISION_BRAIN_NOTICE_REASON = 'decision-brain-notice' as const;
export const TASK_PAIR_DECISION_KIND = { REQUEST: 'request', FEEDBACK: 'feedback', DECISION: 'decision' } as const;
export const TASK_PAIR_DECISION_LIMITS = { OPTIONS: 8, LABEL: 300, QUESTION: 2000, SUMMARY: 4000, HISTORY: 20 } as const;
export const TASK_PAIR_DECISION_MSG = {
  HISTORY: 'supervision.task_console.decision_history',
  FEEDBACK: 'supervision.task_console.decision_feedback',
  RESPONSE: 'supervision.task_console.decision_response',
} as const;
export interface TaskPairDecisionOption { id: string; label: string; }
export interface TaskPairDecisionDetails {
  deliveryRound?: number;
  question?: string;
  options?: TaskPairDecisionOption[];
  recommendation?: string;
  requestId?: string;
  selectedOptionId?: string;
}
export interface TaskPairDecisionRecord extends TaskPairDecisionDetails {
  id: string; project: string; taskId: string; round: number;
  kind: typeof TASK_PAIR_DECISION_KIND[keyof typeof TASK_PAIR_DECISION_KIND];
  conclusion: string; summary: string; author: string; at: number;
  related?: string[]; idempotencyKey?: string;
}
/** Reject malformed/oversized choices rather than silently changing a decision. */
export function validateTaskPairDecisionDetails(input: TaskPairDecisionDetails): void {
  if (input.deliveryRound !== undefined && (!Number.isSafeInteger(input.deliveryRound) || input.deliveryRound < 1)) throw new Error('Invalid delivery round');
  for (const [key, limit] of [['question', 2000], ['recommendation', 2000], ['requestId', 300], ['selectedOptionId', 100]] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key]!.length > limit)) throw new Error(`Invalid ${key}`);
  }
  if (input.options !== undefined) {
    if (!Array.isArray(input.options) || input.options.length > TASK_PAIR_DECISION_LIMITS.OPTIONS) throw new Error('Invalid options');
    const seen = new Set<string>();
    for (const option of input.options) {
      if (!option || typeof option.id !== 'string' || !option.id.trim() || option.id.length > 100
        || typeof option.label !== 'string' || !option.label.trim() || option.label.length > TASK_PAIR_DECISION_LIMITS.LABEL
        || seen.has(option.id)) throw new Error('Invalid or duplicate option');
      seen.add(option.id);
    }
  }
}

/**
 * Checks whether a ruling decision record resolves a specific question record.
 * Rulings must match the project, task, delivery round (defaulting to 1),
 * audit round, and either have an explicit matching requestId or an unbound
 * timestamp greater than or equal to the question timestamp.
 */
export function isDecisionResolvingQuestion(
  decision?: TaskPairDecisionRecord | null,
  question?: TaskPairDecisionRecord | null,
): boolean {
  if (!decision || !question) return false;
  if (decision.kind !== TASK_PAIR_DECISION_KIND.DECISION) return false;
  if (decision.project && question.project && decision.project !== question.project) return false;
  if (decision.taskId && question.taskId && decision.taskId !== question.taskId) return false;
  const decisionDelivery = decision.deliveryRound ?? 1;
  const questionDelivery = question.deliveryRound ?? 1;
  if (decisionDelivery !== questionDelivery) return false;
  if (decision.round !== question.round) return false;

  if (decision.requestId) {
    return decision.requestId === question.id;
  }
  return decision.at >= question.at;
}

