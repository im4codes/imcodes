import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { TASK_PAIR_TERMINAL_STATUSES } from '@shared/task-pair.js';
import { formatTaskPairDependencyTasks, type TaskPairTitleLookup } from '@shared/task-pair-display.js';
import { readPairScheduling, taskPairWaitKind } from '@shared/task-pair-suspension.js';
import {
  TASK_PAIR_DECISION_ERROR,
  TASK_PAIR_DECISION_KIND,
  TASK_PAIR_DECISION_MSG,
  TASK_PAIR_DECISION_LIMITS,
  type TaskPairDecisionRecord,
  isDecisionResolvingQuestion,
} from '@shared/task-pair-decision.js';
import type { SupervisionConsolePairInfo } from '@shared/supervision-task-console.js';
import { requestTaskPairDecision, TaskPairDecisionError } from '../task-pair-decisions.js';
import { ExpandableTaskObjective } from './ExpandableTaskObjective.js';

export type TaskPairDecisionCategory =
  | 'request'
  | 'blocked'
  | 'wait_dependencies'
  | 'paused'
  | 'waiting_capacity'
  | 'completed_awaiting_brain'
  | 'legacy_unknown';

export function resolveDecisionCategory(
  pair: SupervisionConsolePairInfo,
  question?: TaskPairDecisionRecord,
  resolved?: boolean,
): TaskPairDecisionCategory {
  if (question && !resolved) {
    return 'request';
  }
  const wait = taskPairWaitKind(pair);
  if (wait === 'waiting_dependencies') {
    return 'wait_dependencies';
  }
  if (wait === 'paused') {
    return 'paused';
  }
  if (pair.flags?.some((flag) => flag === 'waiting_for_capacity' || flag === 'needs_auditor')) {
    return 'waiting_capacity';
  }
  if (pair.blockedNote?.trim()) {
    return 'blocked';
  }
  const isBlocked = pair.flags?.some((flag) => flag === 'blocked' || flag === 'needs_input');
  if (isBlocked) {
    return 'legacy_unknown';
  }
  if (
    pair.status === 'passed' ||
    pair.lastVerdict === 'PASS' ||
    pair.status === 'awaiting_brain_decision'
  ) {
    return 'completed_awaiting_brain';
  }
  return 'legacy_unknown';
}

const activeRulingCache = new Map<string, string>();

export function resetActiveRulingCacheForTests(): void {
  activeRulingCache.clear();
}

export function getScopedRulingId(
  taskId: string,
  revision: string | undefined,
  questionId: string | undefined,
  latestDecision?: TaskPairDecisionRecord | null,
): string | undefined {
  const scopeKey = `${taskId}:${revision ?? ''}:${questionId ?? ''}`;
  if (latestDecision?.kind === TASK_PAIR_DECISION_KIND.DECISION) {
    if (activeRulingCache.size > 200) {
      const oldestKey = activeRulingCache.keys().next().value;
      if (oldestKey) activeRulingCache.delete(oldestKey);
    }
    activeRulingCache.set(scopeKey, latestDecision.id);
    return latestDecision.id;
  }
  return activeRulingCache.get(scopeKey);
}

/** A reply is persisted feedback to Brain, never PASS, resume or a lifecycle transition. */
export function TaskPairDecisionPanel(props: {
  taskId: string;
  pair: SupervisionConsolePairInfo;
  readOnly?: boolean;
  taskTitles?: TaskPairTitleLookup;
}) {
  const { taskId, pair } = props;
  const [recovery, setRecovery] = useState<{
    basis: string; context: string; pair: SupervisionConsolePairInfo;
    decisions: TaskPairDecisionRecord[]; text: string;
  } | null>(null);
  // Remount all local state on a new task/question/ruling. A string comparison
  // alone cannot isolate late replies when navigation goes A → B → A.
  // A live feedback event may precede its ack: keep that in-flight reply locked.
  const scopeKey = `${taskId}:${pair.decisionRevision ?? ''}:${pair.decisionRequest?.id ?? ''}`;
  const lastRulingRef = useRef<{ scope: string; rulingId: string | undefined } | null>(null);

  let rulingId: string | undefined;
  if (lastRulingRef.current?.scope === scopeKey) {
    if (pair.latestDecision?.kind === TASK_PAIR_DECISION_KIND.DECISION) {
      rulingId = pair.latestDecision.id;
      lastRulingRef.current.rulingId = rulingId;
      if (activeRulingCache.size > 200) {
        const oldestKey = activeRulingCache.keys().next().value;
        if (oldestKey) activeRulingCache.delete(oldestKey);
      }
      activeRulingCache.set(scopeKey, rulingId);
    } else {
      rulingId = lastRulingRef.current.rulingId;
    }
  } else {
    rulingId = getScopedRulingId(taskId, pair.decisionRevision, pair.decisionRequest?.id, pair.latestDecision);
    lastRulingRef.current = { scope: scopeKey, rulingId };
  }

  const context = JSON.stringify([taskId, pair.decisionRevision, pair.decisionRequest?.id, rulingId]);
  useEffect(() => {
    // Retire a recovery on real navigation/question changes, but not when the
    // live projection simply catches up to this same recovered context.
    if (recovery && context !== recovery.basis && context !== recovery.context) setRecovery(null);
  }, [context, recovery]);
  const recovered = recovery?.basis === context ? recovery : undefined;
  const effectiveContext = recovered?.context ?? context;
  // When the live stream catches up to the authoritative refresh, keep the
  // same keyed form (and its draft) rather than mounting an empty second form.
  return <DecisionPanel key={effectiveContext} {...props} pair={recovered?.pair ?? pair} context={effectiveContext}
    initialRecovery={recovery?.context === effectiveContext ? recovery : undefined}
    onRecover={(snapshot, decisions, text) => {
      const ruling = getScopedRulingId(taskId, snapshot.decisionRevision, snapshot.decisionRequest?.id, snapshot.latestDecision);
      setRecovery({ basis: context, context: JSON.stringify([taskId, snapshot.decisionRevision, snapshot.decisionRequest?.id, ruling]),
        pair: snapshot, decisions, text });
    }} />;
}

function DecisionPanel({ taskId, pair, context, readOnly, taskTitles, initialRecovery, onRecover }: {
  taskId: string; pair: SupervisionConsolePairInfo; context: string; readOnly?: boolean;
  taskTitles?: TaskPairTitleLookup;
  initialRecovery?: { text: string; decisions: TaskPairDecisionRecord[] };
  onRecover(pair: SupervisionConsolePairInfo, decisions: TaskPairDecisionRecord[], text: string): void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialRecovery?.text ?? '');
  const [history, setHistory] = useState<TaskPairDecisionRecord[] | null>(initialRecovery?.decisions ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(initialRecovery ? t('taskPair.decision.context_refreshed') : '');
  const [sent, setSent] = useState(false);
  const busy = useRef(false);
  const retrySignature = useRef('');
  const retryId = useRef<string | null>(null);
  const active = useRef(true);
  useEffect(() => () => { active.current = false; }, []);
  const question = pair.decisionRequest;
  const latest = history?.[0] ?? pair.latestDecision;
  const relevantRuling = (
    history?.find((entry) => isDecisionResolvingQuestion(entry, question))
    ?? (isDecisionResolvingQuestion(pair.latestDecision, question) ? pair.latestDecision : undefined)
  );
  const resolved = !!relevantRuling;
  const rulingToShow = relevantRuling ?? (latest?.kind === TASK_PAIR_DECISION_KIND.DECISION ? latest : undefined);
  const hasActiveQuestion = !!(question && !resolved);
  const hasNewBlocker = !!(
    pair.blockedNote?.trim()
    || taskPairWaitKind(pair)
    || pair.flags?.some((flag) => flag === 'waiting_for_capacity' || flag === 'needs_auditor')
    || pair.status === 'awaiting_brain_decision'
    || pair.status === 'passed'
  );
  const waiting = !TASK_PAIR_TERMINAL_STATUSES.includes(pair.status) && (
    hasActiveQuestion
    || hasNewBlocker
    || (!resolved && !!pair.flags?.some((flag) => flag === 'blocked' || flag === 'needs_input'))
  );

  const category = resolveDecisionCategory(pair, question, resolved);

  const titleKey = (resolved && !hasNewBlocker)
    ? 'taskPair.decision.resolved'
    : category === 'request'
    ? 'taskPair.decision.title_request'
    : category === 'blocked'
    ? 'taskPair.decision.title_blocked'
    : category === 'wait_dependencies'
    ? 'taskPair.decision.title_dependencies'
    : category === 'paused'
    ? 'taskPair.decision.title_paused'
    : category === 'waiting_capacity'
    ? 'taskPair.decision.title_capacity'
    : category === 'completed_awaiting_brain'
    ? 'taskPair.decision.title_completed'
    : (!waiting && (resolved || rulingToShow !== undefined))
    ? 'taskPair.decision.resolved'
    : 'taskPair.decision.title';

  let reason = '';
  let responsible = '';

  switch (category) {
    case 'request': {
      reason = question?.question?.trim() || question?.summary?.trim() || '';
      if (question?.author) {
        responsible = t('taskPair.decision.responsible_executor', { name: question.author });
      }
      break;
    }
    case 'blocked': {
      const scheduling = readPairScheduling(pair.scheduling);
      reason = [pair.blockedNote, scheduling?.note].filter(Boolean).join('\n');
      const side = pair.flagSides?.blocked || pair.flagSides?.needs_input;
      const author = (side && (side === 'executor' ? pair.executor : pair.auditor)) || pair.executor || pair.auditor;
      if (author) {
        responsible = t('taskPair.decision.responsible_executor', { name: author });
      }
      break;
    }
    case 'wait_dependencies': {
      const scheduling = readPairScheduling(pair.scheduling);
      const note = scheduling?.note;
      const dependsOn = scheduling?.dependsOn ?? pair.scheduling?.dependsOn ?? [];
      const waitingTasksText = dependsOn.length > 0
        ? t('taskPair.decision.waiting_for_tasks', {
          tasks: formatTaskPairDependencyTasks(dependsOn, taskTitles, scheduling?.dependencyTitles),
        })
        : '';
      reason = [note, pair.blockedNote, waitingTasksText].filter(Boolean).join('\n');
      responsible = t('taskPair.decision.responsible_brain');
      break;
    }
    case 'paused': {
      const scheduling = readPairScheduling(pair.scheduling);
      const pauseReason = scheduling?.note || t('taskPair.decision.paused_reason');
      reason = [pauseReason, pair.blockedNote].filter(Boolean).join('\n');
      responsible = t('taskPair.decision.responsible_brain');
      break;
    }
    case 'waiting_capacity': {
      const capReason = pair.waitingReason
        || (pair.flags?.includes('needs_auditor')
          ? t('taskPair.decision.needs_auditor_reason')
          : t('taskPair.decision.waiting_capacity_reason'));
      reason = [capReason, pair.blockedNote].filter(Boolean).join('\n');
      responsible = t('taskPair.decision.responsible_scheduler');
      break;
    }
    case 'completed_awaiting_brain': {
      reason = t('taskPair.decision.completed_awaiting_brain_reason', {
        executor: pair.executor || 'executor',
        brain: pair.brain || 'Brain',
      });
      responsible = t('taskPair.decision.responsible_brain');
      break;
    }
    case 'legacy_unknown':
    default: {
      reason = (resolved && !hasNewBlocker && (question?.question?.trim() || question?.summary?.trim())) || pair.waitingReason?.trim() || '';
      if (resolved && !hasNewBlocker && question?.author) {
        responsible = t('taskPair.decision.responsible_executor', { name: question.author });
      }
      break;
    }
  }

  const rulingText = [rulingToShow?.conclusion?.trim(), rulingToShow?.summary?.trim()].filter(Boolean).join(' — ');
  const decisionText = [
    reason,
    reason.trim() ? responsible : '',
    (hasActiveQuestion || (!hasNewBlocker && resolved)) && question?.recommendation?.trim()
      ? `${t('taskPair.decision.recommendation')}: ${question.recommendation.trim()}`
      : '',
    !hasNewBlocker && rulingToShow && rulingText && (resolved || (!question && (rulingToShow.deliveryRound ?? 1) === (pair.deliveryRound ?? 1) && rulingToShow.round === pair.round))
      ? `${t('taskPair.decision.ruling')}: ${rulingText}`
      : '',
  ].map(part => part.trim()).filter(Boolean).join('\n');

  if (!error && !sent && (!waiting || (readOnly && !decisionText)) && !question && !latest) return null;

  const showFallbackOptions = category === 'legacy_unknown' || category === 'blocked' || category === 'paused' || category === 'wait_dependencies';
  const showAskButton = category === 'legacy_unknown';
  const showDirectFeedback = category !== 'completed_awaiting_brain' && category !== 'waiting_capacity';

  const submit = async (optionId?: string, feedbackOverride?: string) => {
    const feedback = feedbackOverride ? [feedbackOverride, text].filter(Boolean).join('\n') : text;
    if (busy.current) return;
    busy.current = true; setPending(true); setError('');
    const signature = JSON.stringify([context, pair.decisionRevision, pair.decisionRequest?.id, optionId, feedback]);
    if (retrySignature.current !== signature) { retryId.current = null; retrySignature.current = signature; }
    retryId.current ??= crypto.randomUUID();
    try {
      const result = await requestTaskPairDecision({ type: TASK_PAIR_DECISION_MSG.FEEDBACK,
        taskId, round: Math.max(1, pair.round), revision: pair.decisionRevision,
        questionId: hasActiveQuestion ? (question?.id ?? null) : null, ...(optionId ? { optionId } : {}), feedback }, retryId.current);
      if (!active.current) return;
      setHistory(result.decisions); setSent(true); setText(''); retryId.current = null;
    } catch (cause) {
      if (!active.current) return;
      setError(String(cause));
      // One read-only refresh per rejected stale submission, never an automatic
      // resend of a choice to a different question. Ordinary delivery failures
      // keep their retry ID so a lost ACK cannot duplicate persisted feedback.
      if (cause instanceof TaskPairDecisionError && cause.code === TASK_PAIR_DECISION_ERROR.CONTEXT_CHANGED) {
        try {
          const fresh = await requestTaskPairDecision({ type: TASK_PAIR_DECISION_MSG.HISTORY, taskId });
          if (!active.current || !fresh.pair) return;
          retryId.current = null;
          retrySignature.current = '';
          onRecover(fresh.pair, fresh.decisions, text);
        } catch { /* Keep the original failure and draft; no retry loop. */ }
      }
    }
    finally { if (active.current) { busy.current = false; setPending(false); } }
  };

  const loadHistory = async () => {
    setError('');
    try {
      const result = await requestTaskPairDecision({ type: TASK_PAIR_DECISION_MSG.HISTORY, taskId });
      if (active.current) setHistory(result.decisions);
    } catch (cause) { if (active.current) setError(String(cause)); }
  };

  return <section class="task-pair-decision" aria-label={t('taskPair.decision.title')}>
    <strong>{t(titleKey)}</strong>
    {!hasNewBlocker && rulingToShow && <small class="task-pair-decision-time">
      {t('taskPair.decision.time')}: <time dateTime={new Date(rulingToShow.at).toISOString()}>{new Date(rulingToShow.at).toLocaleString()}</time>
    </small>}
    {decisionText && <ExpandableTaskObjective key={`${context}:${latest?.id ?? ''}`} text={decisionText} className="task-pair-decision-copy" scrollLabel={t('taskPair.decision.title')} />}
    {!readOnly && waiting && <>
      {hasActiveQuestion && question?.options && question.options.length > 0 && (
        <div class="task-pair-decision-options">
          {question.options.map((option) => (
            <button
              type="button"
              key={option.id}
              disabled={pending || !pair.decisionRevision}
              onClick={() => void submit(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {(!hasActiveQuestion || !question?.options?.length) && showFallbackOptions && (
        <div class="task-pair-decision-options">
          {showAskButton && (
            <button
              type="button"
              disabled={pending || !pair.decisionRevision}
              onClick={() => void submit(undefined, t('taskPair.decision.ask_message'))}
            >
              {t('taskPair.decision.ask')}
            </button>
          )}
          <button
            type="button"
            disabled={pending || !pair.decisionRevision}
            onClick={() => void submit(undefined, t('taskPair.decision.ready_message'))}
          >
            {t('taskPair.decision.ready')}
          </button>
          <button
            type="button"
            disabled={pending || !pair.decisionRevision}
            onClick={() => void submit(undefined, t('taskPair.decision.wait_message'))}
          >
            {t('taskPair.decision.wait')}
          </button>
        </div>
      )}
      {showDirectFeedback && (
        <>
          <textarea
            value={text}
            maxLength={TASK_PAIR_DECISION_LIMITS.SUMMARY}
            disabled={pending}
            aria-label={t('taskPair.decision.feedback')}
            placeholder={t('taskPair.decision.placeholder')}
            onInput={(event) => {
              setText(event.currentTarget.value);
              retryId.current = null;
              setSent(false);
            }}
          />
          <button
            type="button"
            disabled={pending || !text.trim() || !pair.decisionRevision}
            onClick={() => void submit()}
          >
            {t(pending ? 'taskPair.decision.sending' : 'taskPair.decision.send')}
          </button>
        </>
      )}
      {!showDirectFeedback && (
        <details class="task-pair-decision-feedback-toggle">
          <summary>{t('taskPair.decision.feedback')}</summary>
          <textarea
            value={text}
            maxLength={TASK_PAIR_DECISION_LIMITS.SUMMARY}
            disabled={pending}
            aria-label={t('taskPair.decision.feedback')}
            placeholder={t('taskPair.decision.placeholder')}
            onInput={(event) => {
              setText(event.currentTarget.value);
              retryId.current = null;
              setSent(false);
            }}
          />
          <button
            type="button"
            disabled={pending || !text.trim() || !pair.decisionRevision}
            onClick={() => void submit()}
          >
            {t(pending ? 'taskPair.decision.sending' : 'taskPair.decision.send')}
          </button>
        </details>
      )}
      {!pair.decisionRevision && <small>{t('taskPair.decision.upgrade')}</small>}
    </>}
    {!readOnly && (sent || latest?.kind === TASK_PAIR_DECISION_KIND.FEEDBACK) && <p role="status">{t('taskPair.decision.sent')}</p>}
    {error && <p role="alert">{t(readOnly ? 'taskPair.decision.history_failed' : 'taskPair.decision.failed')}: {error}</p>}
    <details onToggle={(event) => { if (event.currentTarget.open && history === null) void loadHistory(); }}>
      <summary>{t('taskPair.decision.history')}</summary>
      <ol class="task-pair-decision-records">{history?.map((entry, index) => <li key={entry.id} value={index + 1}><article><b>{t(`taskPair.decision.kind.${entry.kind}`)}</b>
        <small> {entry.author} · <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleString()}</time> · {t('taskPair.round', { round: entry.round })}</small>
        {(entry.conclusion?.trim() || entry.summary?.trim()) && <p>{[entry.conclusion?.trim(), entry.summary?.trim()].filter(Boolean).join(' — ')}</p>}
        {entry.question?.trim() && <p>{entry.question}</p>}
      </article></li>)}</ol>
    </details>
  </section>;
}
