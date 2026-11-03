import { useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { TASK_PAIR_DECISION_KIND, TASK_PAIR_DECISION_MSG } from '@shared/task-pair-decision.js';
import type { TaskPairStatus } from '@shared/task-pair.js';
import { requestTaskPairDecision, type TaskPairDecisionReply } from '../task-pair-decisions.js';
import { TaskPairDecisionPanel } from './TaskPairDecisionPanel.js';

/** Mounted only for an open event detail: never poll or load history per timeline row/chunk.
 * Event status may be historical, so this surface is read-only; live feedback stays in the task panel. */
export function TaskPairEventDecisions({ taskId, status }: { taskId: string; status: TaskPairStatus }) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<{ taskId: string; reply: TaskPairDecisionReply | null }>();
  const reply = loaded?.taskId === taskId ? loaded.reply : undefined;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoaded(undefined);
    void requestTaskPairDecision({ taskId, type: TASK_PAIR_DECISION_MSG.HISTORY }).then(
      (result) => { if (active) setLoaded({ taskId, reply: result }); },
      () => { if (active) setLoaded({ taskId, reply: null }); },
    );
    return () => { active = false; };
  }, [taskId, attempt]);
  if (reply === undefined) return <small class="task-pair-card-decision-loading">{t('common.loading')}</small>;
  if (reply === null) return <div class="task-pair-card-decision-error" role="status">
    <span>{t('taskPair.decision.history_failed')}</span>
    <button type="button" onClick={() => setAttempt((value) => value + 1)}>{t('taskPair.decision.retry')}</button>
  </div>;
  if (!reply.decisions.length) return null;
  return <TaskPairDecisionPanel readOnly taskId={taskId} pair={{
    status, flags: [], round: reply.decisions[0].round, blocking: [],
    decisionRevision: reply.revision,
    decisionRequest: reply.decisions.find((entry) => entry.kind === TASK_PAIR_DECISION_KIND.REQUEST),
    latestDecision: reply.decisions.find((entry) => entry.kind === TASK_PAIR_DECISION_KIND.DECISION) ?? reply.decisions[0],
  }} />;
}
