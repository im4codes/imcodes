import { useTranslation } from 'react-i18next';
import type { AskAnswerFailure } from '../ask-answer-tracker.js';

interface Props {
  failure: AskAnswerFailure;
  /** Resend the preserved text as an ordinary chat message. */
  onSendAsMessage: (answer: string) => void;
  onDismiss: () => void;
}

/**
 * Shown when an AskUserQuestion answer was not confirmed. The user's text is kept
 * on screen so it is never lost, and (unless another device already answered the
 * question) can be sent as a normal message.
 */
export function AskAnswerFailedDialog({ failure, onSendAsMessage, onDismiss }: Props) {
  const { t } = useTranslation();
  const alreadyAnswered = failure.reason === 'already_answered';
  return (
    <div class="ask-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onDismiss(); }}>
      <div class="ask-dialog" data-testid="ask-answer-failed">
        <div class="ask-status ask-status-retained">
          {t(`askQuestion.answerFailed.${failure.reason}`)}
        </div>
        <div class="ask-question" style={{ whiteSpace: 'pre-wrap' }}>{failure.answer}</div>
        <div class="ask-actions">
          <button class="ask-btn-cancel" onClick={onDismiss}>
            {t('askQuestion.dismiss')}
          </button>
          {!alreadyAnswered && (
            <button class="ask-btn-submit" onClick={() => onSendAsMessage(failure.answer)}>
              {t('askQuestion.answerFailed.sendAsMessage')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
