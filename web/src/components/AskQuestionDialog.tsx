import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { ASK_QUESTION_WAIT_MS, ASK_QUESTION_RETENTION_MS } from '@shared/ask-question-timing.js';
import type { AskOption, AskQuestionItem } from '@shared/ask-question-normalize.js';
import { fallbackReadableSessionDisplay, isInternalSessionDisplayValue, pickReadableSessionDisplay } from '@shared/session-display.js';
import { isSubSessionName } from '../session-list-merge.js';

export type { AskOption, AskQuestionItem };

export interface PendingQuestion {
  sessionName: string;
  toolUseId: string;
  questions: AskQuestionItem[];
  /** ms the model pauses for an answer before self-continuing (drives the countdown). */
  waitMs?: number;
}

export interface AskQuestionSourceInfo {
  kind: 'tab' | 'subsession';
  label: string;
  parentLabel?: string;
}

function readableSessionFallback(sessionName: string): string {
  const trimmed = sessionName.trim();
  if (!trimmed) return '';
  return !isInternalSessionDisplayValue(trimmed)
    ? trimmed
    : fallbackReadableSessionDisplay(trimmed);
}

/** Resolve human-readable tab/sub-session source identity for AskQuestionDialog. */
export function resolveAskQuestionSource(
  sessionName: string,
  sessions: ReadonlyArray<{ name: string; label?: string | null; project?: string | null }>,
  subSessions: ReadonlyArray<{ sessionName: string; label?: string | null; parentSession?: string | null }>,
): AskQuestionSourceInfo {
  if (isSubSessionName(sessionName)) {
    const sub = subSessions.find((s) => s.sessionName === sessionName);
    const label = pickReadableSessionDisplay([sub?.label], sessionName)
      ?? readableSessionFallback(sessionName);
    const parent = sub?.parentSession
      ? sessions.find((s) => s.name === sub.parentSession)
      : undefined;
    const parentLabel = parent
      ? (pickReadableSessionDisplay([parent.label, parent.project], parent.name)
        ?? readableSessionFallback(parent.name))
      : undefined;
    return parentLabel
      ? { kind: 'subsession', label, parentLabel }
      : { kind: 'subsession', label };
  }
  const main = sessions.find((s) => s.name === sessionName);
  const label = pickReadableSessionDisplay([main?.label, main?.project], sessionName)
    ?? readableSessionFallback(sessionName);
  return { kind: 'tab', label };
}

interface Props {
  pending: PendingQuestion;
  onSubmit: (answer: string) => void;
  onDismiss: () => void;
  sourceLabel?: string;
  sourceParentLabel?: string;
  sourceKind?: 'tab' | 'subsession';
  onJumpToSession?: () => void;
}

const AUTO_DELIVER_HEADER = 'OpenSpec Auto Deliver';
const AUTO_DELIVER_REASON_RE = /Auto Deliver stopped with reason "([^"]+)"/;

function humanizeMachineReason(reason: string): string {
  return reason.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function localizeAskQuestionItem(q: AskQuestionItem, t: (key: string, options?: Record<string, unknown>) => string): AskQuestionItem {
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

export function buildAskQuestionAnswer(
  questions: readonly AskQuestionItem[],
  selections: readonly ReadonlySet<number>[],
  texts: readonly string[],
): string {
  return questions.map((q, qi) => {
    const parts: string[] = [];
    const selectedSet = selections[qi];
    if (q.options && q.options.length > 0 && selectedSet) {
      const selected = [...selectedSet]
        .sort((a, b) => a - b)
        .map((i) => q.options![i]?.label)
        .filter((label): label is string => Boolean(label));
      if (selected.length > 0) parts.push(...selected);
    }
    const customText = texts[qi]?.trim() ?? '';
    if (customText) parts.push(customText);
    const ans = parts.length > 0 ? parts.join(', ') : 'skip';
    return q.header ? `[${q.header}] ${ans}` : ans;
  }).join('\n');
}

export interface AskQuestionOptionProps {
  label: string;
  description?: string;
  multiSelect?: boolean;
  name: string;
  selected: boolean;
  optionClassName?: string;
  onChange: () => void;
}

/** Shared accessible option row for both modal dialogs and inline timeline cards. */
export function AskQuestionOption({
  label,
  description,
  multiSelect,
  name,
  selected,
  optionClassName,
  onChange,
}: AskQuestionOptionProps) {
  const classes = ['ask-option', optionClassName, selected ? 'ask-option-selected' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <label class={classes}>
      <input
        type={multiSelect ? 'checkbox' : 'radio'}
        name={name}
        checked={selected}
        onChange={onChange}
      />
      <span
        class={`ask-option-indicator${multiSelect ? ' is-checkbox' : ' is-radio'}`}
        aria-hidden="true"
      />
      <span class="ask-option-content">
        <span class="ask-option-label">{label}</span>
        {description && <span class="ask-option-desc">{description}</span>}
      </span>
    </label>
  );
}

export function AskQuestionDialog({
  pending,
  onSubmit,
  onDismiss,
  sourceLabel,
  sourceParentLabel,
  sourceKind,
  onJumpToSession,
}: Props) {
  const { t } = useTranslation();
  const { questions } = pending;
  const resolvedKind = sourceKind ?? (isSubSessionName(pending.sessionName) ? 'subsession' : 'tab');
  const displaySourceLabel = sourceLabel?.trim() || readableSessionFallback(pending.sessionName) || undefined;
  const displayParentLabel = sourceParentLabel?.trim() || undefined;
  const fullSourceName = displaySourceLabel
    ? (displayParentLabel ? `${displayParentLabel} › ${displaySourceLabel}` : displaySourceLabel)
    : undefined;
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
    return buildAskQuestionAnswer(displayQuestions, selections, texts);
  }

  return (
    <div class="ask-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onDismiss(); }}>
      <div class="ask-dialog">
        {(fullSourceName || onJumpToSession) && (
          <div class="ask-source-bar">
            {fullSourceName && (
              <div class="ask-source-info">
                <span class={`ask-source-kind${resolvedKind === 'subsession' ? ' is-subsession' : ''}`}>
                  {resolvedKind === 'subsession'
                    ? t('askQuestion.fromSubSession', { defaultValue: 'From sub-session' })
                    : t('askQuestion.fromTab', { defaultValue: 'From tab' })}
                </span>
                <span class="ask-source-name" title={fullSourceName}>
                  {fullSourceName}
                </span>
              </div>
            )}
            {onJumpToSession && (
              <button type="button" class="ask-btn-jump" onClick={onJumpToSession}>
                {t('askQuestion.goToSession', { defaultValue: 'Go to chat' })}
              </button>
            )}
          </div>
        )}
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
                  <AskQuestionOption
                    key={oi}
                    label={opt.label}
                    description={opt.description}
                    multiSelect={q.multiSelect}
                    name={`ask-modal-${pending.toolUseId}-${qi}`}
                    selected={selections[qi].has(oi)}
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
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
                  e.preventDefault();
                  onSubmit(buildAnswer());
                }
              }}
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
