import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { TASK_PAIR_TERMINAL_STATUSES } from '@shared/task-pair.js';
import { readPairScheduling, taskPairWaitKind } from '@shared/task-pair-suspension.js';
import { TASK_PAIR_DECISION_KIND, TASK_PAIR_DECISION_MSG, TASK_PAIR_DECISION_LIMITS, type TaskPairDecisionRecord } from '@shared/task-pair-decision.js';
import type { SupervisionConsolePairInfo } from '@shared/supervision-task-console.js';
import { requestTaskPairDecision } from '../task-pair-decisions.js';
import { ExpandableTaskObjective } from './ExpandableTaskObjective.js';

/** A reply is persisted feedback to Brain, never PASS, resume or a lifecycle transition. */
export function TaskPairDecisionPanel(props: { taskId: string; pair: SupervisionConsolePairInfo }) {
  const { taskId, pair } = props;
  // Remount all local state on a new task/question/ruling. A string comparison
  // alone cannot isolate late replies when navigation goes A → B → A.
  // A live feedback event may precede its ack: keep that in-flight reply locked.
  const rulingId = pair.latestDecision?.kind === TASK_PAIR_DECISION_KIND.DECISION ? pair.latestDecision.id : undefined;
  const context = JSON.stringify([taskId, pair.decisionRevision, pair.decisionRequest?.id, rulingId]);
  return <DecisionPanel key={context} {...props} context={context} />;
}

function DecisionPanel({ taskId, pair, context }: { taskId: string; pair: SupervisionConsolePairInfo; context: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [history, setHistory] = useState<TaskPairDecisionRecord[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const busy = useRef(false);
  const retrySignature = useRef('');
  const retryId = useRef<string | null>(null);
  const active = useRef(true);
  useEffect(() => () => { active.current = false; }, []);
  const question = pair.decisionRequest;
  const latest = history?.[0] ?? pair.latestDecision;
  const resolved = !!question && latest?.kind === TASK_PAIR_DECISION_KIND.DECISION && (latest.requestId === question.id || latest.round === question.round && latest.at >= question.at);
  const waiting = !TASK_PAIR_TERMINAL_STATUSES.includes(pair.status) && !!(taskPairWaitKind(pair)
    || (question && !resolved) || pair.status === 'awaiting_brain_decision' || pair.flags?.some((flag) => flag === 'blocked' || flag === 'needs_input'));
  const reason = question?.question || question?.summary || pair.blockedNote || readPairScheduling(pair.scheduling)?.note;
  const decisionText = [
    reason || t('taskPair.decision.missing'),
    question?.recommendation ? `${t('taskPair.decision.recommendation')}: ${question.recommendation}` : '',
    latest?.kind === TASK_PAIR_DECISION_KIND.DECISION ? `${t('taskPair.decision.ruling')}: ${latest.conclusion} — ${latest.summary}` : '',
  ].filter(Boolean).join('\n');
  if (!waiting && !question && !latest) return null;
  const submit = async (optionId?: string, feedbackOverride?: string) => {
    const feedback = feedbackOverride ? [feedbackOverride, text].filter(Boolean).join('\n') : text;
    if (busy.current) return;
    busy.current = true; setPending(true); setError('');
    const signature = JSON.stringify([context, optionId, feedback]);
    if (retrySignature.current !== signature) { retryId.current = null; retrySignature.current = signature; }
    retryId.current ??= crypto.randomUUID();
    try {
      const result = await requestTaskPairDecision({ type: TASK_PAIR_DECISION_MSG.FEEDBACK,
        taskId, round: Math.max(1, pair.round), revision: pair.decisionRevision,
        questionId: question?.id ?? null, ...(optionId ? { optionId } : {}), feedback }, retryId.current);
      if (!active.current) return;
      setHistory(result.decisions); setSent(true); setText(''); retryId.current = null;
    } catch (cause) { if (active.current) setError(String(cause)); }
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
    <strong>{t(resolved ? 'taskPair.decision.resolved' : 'taskPair.decision.title')}</strong>
    {latest?.kind === TASK_PAIR_DECISION_KIND.DECISION && <small class="task-pair-decision-time">
      {t('taskPair.decision.time')}: <time dateTime={new Date(latest.at).toISOString()}>{new Date(latest.at).toLocaleString()}</time>
    </small>}
    <ExpandableTaskObjective key={`${context}:${latest?.id ?? ''}`} text={decisionText} className="task-pair-decision-copy" />
    {waiting && !resolved && <>
      <div class="task-pair-decision-options">{question?.options?.map((option) => <button type="button" key={option.id}
        disabled={pending || !pair.decisionRevision} onClick={() => void submit(option.id)}>{option.label}</button>)}</div>
      {!question?.options?.length && <div class="task-pair-decision-options">
        {!reason && <button type="button" disabled={pending || !pair.decisionRevision}
          onClick={() => void submit(undefined, t('taskPair.decision.ask_message'))}>{t('taskPair.decision.ask')}</button>}
        <button type="button" disabled={pending || !pair.decisionRevision}
          onClick={() => void submit(undefined, t('taskPair.decision.ready_message'))}>{t('taskPair.decision.ready')}</button>
        <button type="button" disabled={pending || !pair.decisionRevision}
          onClick={() => void submit(undefined, t('taskPair.decision.wait_message'))}>{t('taskPair.decision.wait')}</button>
      </div>}
      <textarea value={text} maxLength={TASK_PAIR_DECISION_LIMITS.SUMMARY} disabled={pending}
        aria-label={t('taskPair.decision.feedback')} placeholder={t('taskPair.decision.placeholder')}
        onInput={(event) => { setText(event.currentTarget.value); retryId.current = null; setSent(false); }} />
      <button type="button" disabled={pending || !text.trim() || !pair.decisionRevision} onClick={() => void submit()}>
        {t(pending ? 'taskPair.decision.sending' : 'taskPair.decision.send')}</button>
      {!pair.decisionRevision && <small>{t('taskPair.decision.upgrade')}</small>}
    </>}
    {(sent || latest?.kind === TASK_PAIR_DECISION_KIND.FEEDBACK) && <p role="status">{t('taskPair.decision.sent')}</p>}
    {error && <p role="alert">{t('taskPair.decision.failed')}: {error}</p>}
    <details onToggle={(event) => { if (event.currentTarget.open && history === null) void loadHistory(); }}>
      <summary>{t('taskPair.decision.history')}</summary>
      <ol class="task-pair-decision-records">{history?.map((entry, index) => <li key={entry.id} value={index + 1}><article><b>{t(`taskPair.decision.kind.${entry.kind}`)}</b>
        <small> {entry.author} · <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleString()}</time> · {t('taskPair.round', { round: entry.round })}</small>
        <p>{entry.conclusion} — {entry.summary}</p>
        {entry.question && <p>{entry.question}</p>}
      </article></li>)}</ol>
    </details>
  </section>;
}
