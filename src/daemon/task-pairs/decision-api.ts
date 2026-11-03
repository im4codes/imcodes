import { TASK_PAIR_TERMINAL_STATUSES } from '../../../shared/task-pair.js';
import { TASK_PAIR_DECISION_KIND, TASK_PAIR_DECISION_MSG, TASK_PAIR_DECISION_LIMITS } from '../../../shared/task-pair-decision.js';
import { readPairScheduling } from '../../../shared/task-pair-suspension.js';
import type { SupervisionTaskConsoleScope } from '../../../shared/supervision-task-console.js';
import { getTaskPairStore } from './store.js';
import { taskPairService } from './service.js';
import { taskPairDecisionRevision } from './decision-context.js';

/** Called only behind the authenticated, active console scope; never accepts a caller-supplied Brain. */
export function taskPairDecisionApi(scope: SupervisionTaskConsoleScope, input: Record<string, unknown>) {
  const store = getTaskPairStore();
  const taskId = typeof input.taskId === 'string' ? input.taskId : '';
  const stored = store.getPair(scope.projectName, taskId);
  if (!stored || stored.state.brain !== scope.coordinatorSessionName) throw new Error('Task is not in this Brain scope');
  const pair = stored.state;
  if (input.type === TASK_PAIR_DECISION_MSG.FEEDBACK) {
    if (typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 160) throw new Error('Invalid request id');
    const retry = store.decisionByRetryKey(scope.projectName, taskId, `human:${input.requestId}`);
    if (!retry) {
      if (TASK_PAIR_TERMINAL_STATUSES.includes(pair.status) || input.round !== Math.max(1, pair.round)
        || input.revision !== taskPairDecisionRevision(pair)) throw new Error('The task question changed; refresh before replying');
      const rawQuestion = store.latestDecisionRequest(scope.projectName, taskId, Math.max(1, pair.round), pair.deliveryRound ?? 1);
      const isResolved = rawQuestion ? store.isDecisionResolved(rawQuestion) : false;
      if (rawQuestion && input.questionId === rawQuestion.id) {
        if (isResolved) throw new Error('This question is already resolved');
      } else if (input.questionId !== null && input.questionId !== undefined) {
        throw new Error('The decision question changed; refresh before replying');
      } else if (rawQuestion && !isResolved) {
        throw new Error('The decision question changed; refresh before replying');
      }
      const activeQuestion = (rawQuestion && !isResolved) ? rawQuestion : undefined;
      const feedback = typeof input.feedback === 'string' ? input.feedback.trim() : '';
      const choice = typeof input.optionId === 'string' ? activeQuestion?.options?.find((option) => option.id === input.optionId) : undefined;
      if (input.optionId && !choice) throw new Error('Unknown choice');
      if ((!feedback && !choice) || feedback.length > TASK_PAIR_DECISION_LIMITS.SUMMARY) throw new Error('Feedback is empty or too long');
      const reason = activeQuestion?.question || activeQuestion?.summary || pair.blockedNote || readPairScheduling(pair.scheduling)?.note || 'Please clarify the blocking condition and available options.';
      taskPairService.recordDecision({
        project: scope.projectName, taskId, round: Math.max(1, pair.round), kind: TASK_PAIR_DECISION_KIND.FEEDBACK,
        conclusion: choice?.label || 'Human feedback', summary: feedback || choice!.label,
        question: reason.slice(0, TASK_PAIR_DECISION_LIMITS.QUESTION), ...(activeQuestion ? { requestId: activeQuestion.id } : {}),
        ...(choice ? { selectedOptionId: choice.id } : {}),
        author: 'human', idempotencyKey: `human:${input.requestId}`,
        at: Math.max(Date.now(), (rawQuestion?.at ?? 0) + 1),
      });
    }
  }
  return { decisions: store.listDecisions(scope.projectName, [taskId], TASK_PAIR_DECISION_LIMITS.HISTORY), revision: taskPairDecisionRevision(pair) };
}
