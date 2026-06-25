import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { ASK_QUESTION_WAIT_MS, ASK_QUESTION_RETENTION_MS } from '@shared/ask-question-timing.js';

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestionItem {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: AskOption[];
}

export interface PendingQuestion {
  sessionName: string;
  toolUseId: string;
  questions: AskQuestionItem[];
  /** ms the model pauses for an answer before self-continuing (drives the countdown). */
  waitMs?: number;
}

interface Props {
  pending: PendingQuestion;
  onSubmit: (answer: string) => void;
  onDismiss: () => void;
}

const AUTO_DELIVER_HEADER = 'OpenSpec Auto Deliver';
const AUTO_DELIVER_REASON_RE = /Auto Deliver stopped with reason "([^"]+)"/;

function humanizeMachineReason(reason: string): string {
  return reason.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function localizeAskQuestionItem(q: AskQuestionItem, t: (key: string, options?: Record<string, unknown>) => string): AskQuestionItem {
  const match = q.question.match(AUTO_DELIVER_REASON_RE);
  const isAutoDeliverQuestion = q.header === AUTO_DELIVER_HEADER || match !== null;
  if (!isAutoDeliverQuestion) return q;

  const reasonCode = match?.[1] ?? '';
  const reason = reasonCode
    ? t(`openspec.auto.reason.${reasonCode}`, { defaultValue: humanizeMachineReason(reasonCode) })
    : q.question;

  return {
    ...q,
    header: t('openspec.auto.ask.header', { defaultValue: AUTO_DELIVER_HEADER }),
    question: reasonCode
      ? t('openspec.auto.ask.needs_human_question', {
        reason,
        defaultValue: `Auto Deliver needs human input: ${reason}`,
      })
      : q.question,
    options: q.options?.map((opt) => {
      if (opt.label === 'Review the failure and continue manually') {
        return {
          label: t('openspec.auto.ask.review_continue', { defaultValue: opt.label }),
          description: t('openspec.auto.ask.review_continue_desc', { defaultValue: opt.description ?? '' }),
        };
      }
      if (opt.label === 'Stop here and summarize the current state') {
        return {
          label: t('openspec.auto.ask.stop_summarize', { defaultValue: opt.label }),
          description: t('openspec.auto.ask.stop_summarize_desc', { defaultValue: opt.description ?? '' }),
        };
      }
      return opt;
    }),
  };
}

export function AskQuestionDialog({ pending, onSubmit, onDismiss }: Props) {
  const { t } = useTranslation();
  const { questions } = pending;
  const displayQuestions = useMemo(
    () => questions.map((q) => localizeAskQuestionItem(q, t)),
    [questions, t]
  );

  // ── Countdown / retention phases ──────────────────────────────────────────
  // Phase 1 (≤ waitMs): the model is PAUSED waiting — answering steers it in the
  // same turn. Phase 2 (next ASK_QUESTION_RETENTION_MS): the model self-continued
  // but the card lingers so the user can force-interrupt with a different choice.
  // After that, the card auto-dismisses.
  const waitMs = typeof pending.waitMs === 'number' && pending.waitMs > 0 ? pending.waitMs : ASK_QUESTION_WAIT_MS;
  const totalMs = waitMs + ASK_QUESTION_RETENTION_MS;
  const startedAtRef = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    startedAtRef.current = Date.now();
    setNow(Date.now());
  }, [pending.toolUseId]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = now - startedAtRef.current;
  const expired = elapsed >= totalMs;
  useEffect(() => {
    if (expired) onDismiss();
  }, [expired]); // eslint-disable-line react-hooks/exhaustive-deps
  const inWaitPhase = elapsed < waitMs;
  const waitRemainSec = Math.max(0, Math.ceil((waitMs - elapsed) / 1000));
  const retentionRemainSec = Math.max(0, Math.ceil((totalMs - elapsed) / 1000));

  // State: for each question, either selected indices (multiSelect) or text value
  const [selections, setSelections] = useState<Array<Set<number>>>(() =>
    displayQuestions.map(() => new Set<number>())
  );
  const [texts, setTexts] = useState<string[]>(() => displayQuestions.map(() => ''));

  useEffect(() => {
    setSelections(displayQuestions.map(() => new Set<number>()));
    setTexts(displayQuestions.map(() => ''));
  }, [pending.toolUseId, displayQuestions.length]);

  function toggleOption(qi: number, oi: number) {
    setSelections((prev) => {
      const next = prev.map((s) => new Set(s));
      if (next[qi].has(oi)) next[qi].delete(oi);
      else next[qi].add(oi);
      return next;
    });
  }

  function buildAnswer(): string {
    return displayQuestions.map((q, qi) => {
      const parts: string[] = [];
      if (q.options && q.options.length > 0) {
        const selected = [...selections[qi]].sort().map((i) => q.options![i].label);
        if (selected.length > 0) parts.push(...selected);
      }
      if (texts[qi].trim()) parts.push(texts[qi].trim());
      const ans = parts.length > 0 ? parts.join(', ') : 'skip';
      return q.header ? `[${q.header}] ${ans}` : ans;
    }).join('\n');
  }

  return (
    <div class="ask-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onDismiss(); }}>
      <div class="ask-dialog">
        <div class={`ask-status ${inWaitPhase ? 'ask-status-waiting' : 'ask-status-retained'}`}>
          {inWaitPhase
            ? t('askQuestion.waiting', {
              seconds: waitRemainSec,
              defaultValue: `Waiting for your answer — the model continues on its own in ${waitRemainSec}s`,
            })
            : t('askQuestion.retained', {
              seconds: retentionRemainSec,
              defaultValue: `The model already continued — you can still interrupt it (${retentionRemainSec}s)`,
            })}
        </div>
        {displayQuestions.map((q, qi) => (
          <div key={qi} class="ask-question-block">
            {q.header && <div class="ask-header">{q.header}</div>}
            <div class="ask-question">{q.question}</div>
            {q.options && q.options.length > 0 && (
              <div class="ask-options">
                {q.options.map((opt, oi) => (
                  <label key={oi} class={`ask-option ${selections[qi].has(oi) ? 'ask-option-selected' : ''}`}>
                    <input
                      type={q.multiSelect ? 'checkbox' : 'radio'}
                      checked={selections[qi].has(oi)}
                      onChange={() => {
                        if (q.multiSelect) {
                          toggleOption(qi, oi);
                        } else {
                          setSelections((prev) => {
                            const next = prev.map((s) => new Set(s));
                            next[qi] = new Set([oi]);
                            return next;
                          });
                        }
                      }}
                    />
                    <span class="ask-option-label">{opt.label}</span>
                    {opt.description && <span class="ask-option-desc">{opt.description}</span>}
                  </label>
                ))}
              </div>
            )}
            <input
              class="ask-custom-input"
              type="text"
              placeholder={q.options && q.options.length > 0
                ? t('askQuestion.customPlaceholder', { defaultValue: 'Custom / extra (optional)' })
                : t('askQuestion.answerPlaceholder', { defaultValue: 'Your answer' })}
              value={texts[qi]}
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                setTexts((prev) => prev.map((t, i) => i === qi ? v : t));
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSubmit(buildAnswer()); } }}
            />
          </div>
        ))}
        <div class="ask-actions">
          <button class="ask-btn-cancel" onClick={onDismiss}>
            {t('askQuestion.dismiss', { defaultValue: 'Dismiss' })}
          </button>
          <button class="ask-btn-submit" onClick={() => onSubmit(buildAnswer())}>
            {inWaitPhase
              ? t('askQuestion.answer', { defaultValue: 'Answer' })
              : t('askQuestion.interrupt', { defaultValue: 'Interrupt with this' })}
          </button>
        </div>
      </div>
    </div>
  );
}
