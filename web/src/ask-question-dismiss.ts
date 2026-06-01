// Decides whether a shown AskUserQuestion card has gone stale and should be
// auto-dismissed. The claude-code SDK self-continues (picks an answer on its
// own) if the question is left unanswered, so once the model produces new
// output for the same session the card is moot. A grace window prevents the
// question's OWN message-completion flush — which lands in the same instant as
// the ask — from dismissing the card immediately.

export interface PendingQuestionDismissRef {
  sessionName: string;
  /** epoch ms when the question card was shown */
  askedAt: number;
}

/** Timeline event types that signal the model produced fresh output. */
const CONTINUATION_EVENT_TYPES = new Set(['assistant.text', 'tool.call']);

/** Default grace after showing the question before continuation output can dismiss it. */
export const ASK_QUESTION_STALE_GRACE_MS = 1500;

export function shouldDismissPendingQuestion(
  pending: PendingQuestionDismissRef | null,
  event: { type: string; sessionId: string },
  now: number,
  graceMs: number = ASK_QUESTION_STALE_GRACE_MS,
): boolean {
  if (!pending) return false;
  if (event.sessionId !== pending.sessionName) return false;
  if (!CONTINUATION_EVENT_TYPES.has(event.type)) return false;
  return now - pending.askedAt > graceMs;
}
