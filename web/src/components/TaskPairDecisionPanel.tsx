import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { TASK_PAIR_TERMINAL_STATUSES } from '@shared/task-pair.js';
import { readPairScheduling, taskPairWaitKind } from '@shared/task-pair-suspension.js';
import { TASK_PAIR_DECISION_KIND, TASK_PAIR_DECISION_MSG, TASK_PAIR_DECISION_LIMITS, type TaskPairDecisionRecord } from '@shared/task-pair-decision.js';
import type { SupervisionConsolePairInfo } from '@shared/supervision-task-console.js';
import { requestTaskPairDecision } from '../task-pair-decisions.js';

/** A reply is persisted feedback to Brain, never PASS, resume or a lifecycle transition. */
export function TaskPairDecisionPanel({ taskId, pair }: { taskId: string; pair: SupervisionConsolePairInfo }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [history, setHistory] = useState<TaskPairDecisionRecord[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const busy = useRef(false);
  const retrySignature = useRef('');
  const retryId = useRef<string | null>(null);
  const context = `${taskId}:${pair.decisionRevision ?? ''}:${pair.decisionRequest?.id ?? ''}`;
  const activeContext = useRef(context);
  activeContext.current = context;
  useEffect(() => { busy.current = false; setPending(false); setText(''); setHistory(null); setSent(false); setError(''); retryId.current = null; }, [context]);
  const question = pair.decisionRequest;
  const latest = history?.[0] ?? pair.latestDecision;
  const resolved = !!question && latest?.kind === TASK_PAIR_DECISION_KIND.DECISION && (latest.requestId === question.id || latest.round === question.round && latest.at >= question.at);
  const waiting = !TASK_PAIR_TERMINAL_STATUSES.includes(pair.status) && !!(taskPairWaitKind(pair)
    || (question && !resolved) || pair.status === 'awaiting_brain_decision' || pair.flags?.some((flag) => flag === 'blocked' || flag === 'needs_input'));
  const reason = question?.question || question?.summary || pair.blockedNote || readPairScheduling(pair.scheduling)?.note;
  if (!waiting && !question && !latest) return null;
  const submit = async (optionId?: string, feedbackOverride?: string) => {
    const feedback = feedbackOverride ? [feedbackOverride, text].filter(Boolean).join('\n') : text;
    if (busy.current) return;
    const frozen = context;
    busy.current = true; setPending(true); setError('');
    const signature = JSON.stringify([context, optionId, feedback]);
    if (retrySignature.current !== signature) { retryId.current = null; retrySignature.current = signature; }
    retryId.current ??= crypto.randomUUID();
    try {
      const result = await requestTaskPairDecision({ type: TASK_PAIR_DECISION_MSG.FEEDBACK,
        taskId, round: Math.max(1, pair.round), revision: pair.decisionRevision,
        questionId: question?.id ?? null, ...(optionId ? { optionId } : {}), feedback }, retryId.current);
      if (activeContext.current !== frozen) return;
      setHistory(result.decisions); setSent(true); setText(''); retryId.current = null;
    } catch (cause) { if (activeContext.current === frozen) setError(String(cause)); }
    finally { if (activeContext.current === frozen) { busy.current = false; setPending(false); } }
  };
  const loadHistory = async () => {
    const frozen = context;
    setError('');
    try {
      const result = await requestTaskPairDecision({ type: TASK_PAIR_DECISION_MSG.HISTORY, taskId });
      if (activeContext.current === frozen) setHistory(result.decisions);
    } catch (cause) { if (activeContext.current === frozen) setError(String(cause)); }
  };
  return <section class="task-pair-decision" aria-label={t('taskPair.decision.title')}>
    <strong>{t(resolved ? 'taskPair.decision.resolved' : 'taskPair.decision.title')}</strong>
    <p class="task-pair-decision-question">{reason || t('taskPair.decision.missing')}</p>
    {question?.recommendation && <p>{t('taskPair.decision.recommendation')}: {question.recommendation}</p>}
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
    {latest?.kind === TASK_PAIR_DECISION_KIND.DECISION && <p>{t('taskPair.decision.ruling')}: {latest.conclusion} — {latest.summary}</p>}
    <details onToggle={(event) => { if (event.currentTarget.open && history === null) void loadHistory(); }}>
      <summary>{t('taskPair.decision.history')}</summary>
      {history?.map((entry) => <article key={entry.id}><b>{t(`taskPair.decision.kind.${entry.kind}`)}</b>
        <small> {entry.author} · {new Date(entry.at).toLocaleString()} · #{entry.round}</small>
        <p>{entry.conclusion} — {entry.summary}</p>
        {entry.question && <p>{entry.question}</p>}
      </article>)}
    </details>
  </section>;
}
