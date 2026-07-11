import { isUserVisible } from './util/isUserVisible.js';

export interface TrailingAskQuestion {
  toolUseId: string;
  questions: unknown[];
  waitMs?: number;
}

interface MinimalEvent {
  type: string;
  hidden?: boolean;
  payload?: Record<string, unknown> & { streaming?: boolean };
}

/**
 * Find an ask.question the agent is still waiting on, by looking at the TAIL of
 * the timeline: if the most recent user-visible event is an `ask.question` (with
 * questions), the agent asked and nothing has followed — it's still pending. Any
 * later visible message (the user's answer, or the model self-continuing) means
 * it's no longer awaiting input, so return null.
 *
 * Used to re-surface the question dialog from history (e.g. after opening the app
 * from a push notification, a reload, or on another device) — `pendingQuestion`
 * is otherwise only set from live WS events and would be lost.
 */
export function findTrailingAskQuestion(events: readonly MinimalEvent[]): TrailingAskQuestion | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.hidden) continue;
    if (!isUserVisible(event)) continue;
    if (event.type !== 'ask.question') return null; // a later visible message → not waiting
    const questions = Array.isArray(event.payload?.questions) ? event.payload!.questions as unknown[] : [];
    if (questions.length === 0) return null;
    return {
      toolUseId: String(event.payload?.toolUseId ?? ''),
      questions,
      ...(typeof event.payload?.waitMs === 'number' ? { waitMs: event.payload.waitMs } : {}),
    };
  }
  return null;
}
