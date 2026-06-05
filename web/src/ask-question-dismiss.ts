// Decides whether a shown AskUserQuestion card has gone stale and should be
// auto-dismissed.
//
// The claude-code SDK self-continues (picks an answer on its own) if a question
// is left unanswered. We deliberately KEEP the card up while the model is still
// working on that auto-choice — answering is interrupt-based, so the user can
// still click an option to override the model mid-run if its auto-choice looks
// wrong. The card is only dismissed once the session's turn has actually
// finished (returns to idle); a short grace ignores an idle "blip" that can fire
// the instant the question's tool call pauses the turn.

export interface PendingQuestionDismissRef {
  sessionName: string;
  /** epoch ms when the question card was shown */
  askedAt: number;
}

/**
 * Grace after showing the question before a session-idle event can dismiss it.
 * Guards against an idle that fires the instant the AskUserQuestion tool call
 * pauses the turn (before the model self-continues).
 */
export const ASK_QUESTION_STALE_GRACE_MS = 3000;

export function shouldDismissPendingQuestion(
  pending: PendingQuestionDismissRef | null,
  event: { sessionId: string; sessionIdle: boolean },
  now: number,
  graceMs: number = ASK_QUESTION_STALE_GRACE_MS,
): boolean {
  if (!pending) return false;
  if (event.sessionId !== pending.sessionName) return false;
  // Keep the card up while the model is still working — the user can interrupt
  // with a different choice. Only dismiss once the turn is genuinely done.
  if (!event.sessionIdle) return false;
  return now - pending.askedAt > graceMs;
}
