import { useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { TASK_PAIR_DECISION_KIND, TASK_PAIR_DECISION_MSG } from '@shared/task-pair-decision.js';
import { TASK_PAIR_SNAPSHOT_EVENT, type TaskPairStatus } from '@shared/task-pair.js';
import type { TaskPairScheduling } from '@shared/task-pair-suspension.js';
import { collectTaskPairTitlesFromSnapshot, taskPairDisplayTitle, type TaskPairTitleLookup } from '@shared/task-pair-display.js';
import { requestTaskPairDecision, type TaskPairDecisionReply } from '../task-pair-decisions.js';
import { TaskPairDecisionPanel } from './TaskPairDecisionPanel.js';

type SnapshotWindow = Window & {
  __imcodesTaskPairSnapshot?: {
    scopeReset?: unknown;
    authorityUnavailable?: unknown;
    taskTitles?: Readonly<Record<string, string | undefined>>;
    tasks?: readonly { taskId?: unknown; title?: unknown; brief?: unknown; pair?: { brief?: unknown } }[];
  };
};

function mergeEventTaskTitles(base: ReadonlyMap<string, string>, extra?: TaskPairTitleLookup): TaskPairTitleLookup {
  if (!extra) return base;
  const merged = new Map(base);
  if (typeof (extra as ReadonlyMap<string, string>).forEach === 'function') {
    (extra as ReadonlyMap<string, string>).forEach((value, id) => {
      const display = taskPairDisplayTitle(value, id);
      if (display) merged.set(id, display);
    });
  } else {
    for (const [id, value] of Object.entries(extra as Readonly<Record<string, string | undefined>>)) {
      const display = taskPairDisplayTitle(value, id);
      if (display) merged.set(id, display);
    }
  }
  return merged;
}

/** Mounted only for an open event detail: never poll or load history per timeline row/chunk.
 * Event status may be historical, so this surface is read-only; live feedback stays in the task panel. */
export function TaskPairEventDecisions({ taskId, status, scheduling, taskTitles }: { taskId: string; status: TaskPairStatus; scheduling?: TaskPairScheduling; taskTitles?: TaskPairTitleLookup }) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<{ taskId: string; reply: TaskPairDecisionReply | null }>();
  const [snapshotTitles, setSnapshotTitles] = useState<Map<string, string>>(() => collectTaskPairTitlesFromSnapshot((window as SnapshotWindow).__imcodesTaskPairSnapshot));
  const reply = loaded?.taskId === taskId ? loaded.reply : undefined;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const onSnapshot = (event: Event) => {
      setSnapshotTitles(collectTaskPairTitlesFromSnapshot((event as CustomEvent).detail as SnapshotWindow['__imcodesTaskPairSnapshot']));
    };
    window.addEventListener(TASK_PAIR_SNAPSHOT_EVENT, onSnapshot);
    return () => window.removeEventListener(TASK_PAIR_SNAPSHOT_EVENT, onSnapshot);
  }, []);
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
  const resolvedTitles = mergeEventTaskTitles(snapshotTitles, taskTitles);
  return <TaskPairDecisionPanel readOnly taskId={taskId} taskTitles={resolvedTitles} pair={{
    status, flags: [], round: reply.decisions[0].round, blocking: [],
    ...(scheduling ? { scheduling } : {}),
    decisionRevision: reply.revision,
    decisionRequest: reply.decisions.find((entry) => entry.kind === TASK_PAIR_DECISION_KIND.REQUEST),
    latestDecision: reply.decisions.find((entry) => entry.kind === TASK_PAIR_DECISION_KIND.DECISION) ?? reply.decisions[0],
  }} />;
}
