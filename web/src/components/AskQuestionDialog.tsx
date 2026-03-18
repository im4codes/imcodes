import { useState } from 'preact/hooks';

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
}

interface Props {
  pending: PendingQuestion;
  onSubmit: (answer: string) => void;
  onDismiss: () => void;
}

export function AskQuestionDialog({ pending, onSubmit, onDismiss }: Props) {
  const { questions } = pending;

  // State: for each question, either selected indices (multiSelect) or text value
  const [selections, setSelections] = useState<Array<Set<number>>>(() =>
    questions.map(() => new Set<number>())
  );
  const [texts, setTexts] = useState<string[]>(() => questions.map(() => ''));

  function toggleOption(qi: number, oi: number) {
    setSelections((prev) => {
      const next = prev.map((s) => new Set(s));
      if (next[qi].has(oi)) next[qi].delete(oi);
      else next[qi].add(oi);
      return next;
    });
  }

  function buildAnswer(): string {
    return questions.map((q, qi) => {
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
        {questions.map((q, qi) => (
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
              placeholder={q.options && q.options.length > 0 ? 'Custom / extra (optional)' : 'Your answer'}
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
          <button class="ask-btn-cancel" onClick={onDismiss}>Cancel</button>
          <button class="ask-btn-submit" onClick={() => onSubmit(buildAnswer())}>Send</button>
        </div>
      </div>
    </div>
  );
}
