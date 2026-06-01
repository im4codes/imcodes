import { describe, expect, it } from 'vitest';
import { shouldDismissPendingQuestion, ASK_QUESTION_STALE_GRACE_MS } from '../src/ask-question-dismiss.js';

const pending = { sessionName: 'deck_alpha_brain', askedAt: 1_000_000 };
const past = (ms: number) => pending.askedAt + ms;

describe('shouldDismissPendingQuestion', () => {
  it('dismisses on continuation output for the same session after the grace window', () => {
    for (const type of ['assistant.text', 'tool.call']) {
      expect(shouldDismissPendingQuestion(pending, { type, sessionId: 'deck_alpha_brain' }, past(2000))).toBe(true);
    }
  });

  it('does NOT dismiss within the grace window (the question\'s own trailing flush)', () => {
    expect(shouldDismissPendingQuestion(pending, { type: 'assistant.text', sessionId: 'deck_alpha_brain' }, past(0))).toBe(false);
    expect(shouldDismissPendingQuestion(pending, { type: 'assistant.text', sessionId: 'deck_alpha_brain' }, past(ASK_QUESTION_STALE_GRACE_MS))).toBe(false);
    expect(shouldDismissPendingQuestion(pending, { type: 'tool.call', sessionId: 'deck_alpha_brain' }, past(ASK_QUESTION_STALE_GRACE_MS + 1))).toBe(true);
  });

  it('does NOT dismiss for a different session', () => {
    expect(shouldDismissPendingQuestion(pending, { type: 'assistant.text', sessionId: 'deck_other_brain' }, past(5000))).toBe(false);
  });

  it('does NOT dismiss for non-continuation event types', () => {
    for (const type of ['session.state', 'tool.result', 'user.message', 'ask.question', 'usage.update']) {
      expect(shouldDismissPendingQuestion(pending, { type, sessionId: 'deck_alpha_brain' }, past(5000))).toBe(false);
    }
  });

  it('is a no-op when there is no pending question', () => {
    expect(shouldDismissPendingQuestion(null, { type: 'assistant.text', sessionId: 'deck_alpha_brain' }, past(5000))).toBe(false);
  });

  it('honors a custom grace window', () => {
    expect(shouldDismissPendingQuestion(pending, { type: 'assistant.text', sessionId: 'deck_alpha_brain' }, past(400), 300)).toBe(true);
    expect(shouldDismissPendingQuestion(pending, { type: 'assistant.text', sessionId: 'deck_alpha_brain' }, past(200), 300)).toBe(false);
  });
});
