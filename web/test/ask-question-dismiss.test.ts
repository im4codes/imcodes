import { describe, expect, it } from 'vitest';
import { shouldDismissPendingQuestion, ASK_QUESTION_STALE_GRACE_MS } from '../src/ask-question-dismiss.js';

const pending = { sessionName: 'deck_alpha_brain', askedAt: 1_000_000 };
const at = (ms: number) => pending.askedAt + ms;

describe('shouldDismissPendingQuestion (idle-driven)', () => {
  it('dismisses when the session goes idle after the grace window', () => {
    expect(shouldDismissPendingQuestion(pending, { sessionId: 'deck_alpha_brain', sessionIdle: true }, at(5000))).toBe(true);
  });

  it('does NOT dismiss while the model is still working (not idle)', () => {
    expect(shouldDismissPendingQuestion(pending, { sessionId: 'deck_alpha_brain', sessionIdle: false }, at(60_000))).toBe(false);
  });

  it('does NOT dismiss on an idle "blip" inside the grace window', () => {
    expect(shouldDismissPendingQuestion(pending, { sessionId: 'deck_alpha_brain', sessionIdle: true }, at(0))).toBe(false);
    expect(shouldDismissPendingQuestion(pending, { sessionId: 'deck_alpha_brain', sessionIdle: true }, at(ASK_QUESTION_STALE_GRACE_MS))).toBe(false);
    expect(shouldDismissPendingQuestion(pending, { sessionId: 'deck_alpha_brain', sessionIdle: true }, at(ASK_QUESTION_STALE_GRACE_MS + 1))).toBe(true);
  });

  it('does NOT dismiss for a different session going idle', () => {
    expect(shouldDismissPendingQuestion(pending, { sessionId: 'deck_other_brain', sessionIdle: true }, at(60_000))).toBe(false);
  });

  it('is a no-op when there is no pending question', () => {
    expect(shouldDismissPendingQuestion(null, { sessionId: 'deck_alpha_brain', sessionIdle: true }, at(60_000))).toBe(false);
  });

  it('honors a custom grace window', () => {
    expect(shouldDismissPendingQuestion(pending, { sessionId: 'deck_alpha_brain', sessionIdle: true }, at(400), 300)).toBe(true);
    expect(shouldDismissPendingQuestion(pending, { sessionId: 'deck_alpha_brain', sessionIdle: true }, at(200), 300)).toBe(false);
  });
});
