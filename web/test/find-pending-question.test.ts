import { describe, it, expect } from 'vitest';
import { findTrailingAskQuestion } from '../src/find-pending-question.js';

const ask = (over: Record<string, unknown> = {}) => ({
  type: 'ask.question',
  payload: { toolUseId: 't1', questions: [{ question: 'Pick one', options: [{ label: 'A' }] }], waitMs: 5000, ...over },
});
const text = (streaming = false) => ({ type: 'assistant.text', payload: { text: 'ok', streaming } });
const user = () => ({ type: 'user.message', payload: { text: 'A' } });
const usage = () => ({ type: 'usage.update', payload: { inputTokens: 1 } });
const state = () => ({ type: 'session.state', payload: { state: 'idle' } });

describe('findTrailingAskQuestion', () => {
  it('returns the question when it is the trailing visible event', () => {
    const q = findTrailingAskQuestion([user(), text(), ask()]);
    expect(q).toEqual({ toolUseId: 't1', questions: [{ question: 'Pick one', options: [{ label: 'A' }] }], waitMs: 5000 });
  });

  it('ignores trailing non-visible events (usage.update / session.state)', () => {
    const q = findTrailingAskQuestion([ask(), usage(), state()]);
    expect(q?.toolUseId).toBe('t1');
  });

  it('ignores a trailing streaming assistant.text (not a real message)', () => {
    const q = findTrailingAskQuestion([ask(), text(true)]);
    expect(q?.toolUseId).toBe('t1');
  });

  it('returns null when a user answer follows the question', () => {
    expect(findTrailingAskQuestion([ask(), user()])).toBeNull();
  });

  it('returns null when the model self-continued (final assistant.text after)', () => {
    expect(findTrailingAskQuestion([ask(), text(false)])).toBeNull();
  });

  it('returns null when there is no question, or it has no questions', () => {
    expect(findTrailingAskQuestion([user(), text()])).toBeNull();
    expect(findTrailingAskQuestion([ask({ questions: [] })])).toBeNull();
  });
});
