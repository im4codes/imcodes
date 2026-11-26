import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG_COMMAND_ACK, MSG_COMMAND_FAILED } from '@shared/ack-protocol.js';
import { ASK_ANSWER_ACK_ERRORS } from '@shared/ask-answer.js';
import { AskAnswerTracker, readAskAnswerSignal, type AskAnswerFailure } from '../src/ask-answer-tracker.js';

const pending = { commandId: 'ans-1', sessionName: 'deck_brain', toolUseId: 'toolu_1', answer: 'Option A\nsecond line' };

describe('readAskAnswerSignal', () => {
  it('reads accepted / refused acks, command.failed and the answer timeline echo', () => {
    expect(readAskAnswerSignal({ type: MSG_COMMAND_ACK, commandId: 'c', status: 'accepted' })).toEqual({ commandId: 'c', kind: 'confirmed' });
    expect(readAskAnswerSignal({ type: MSG_COMMAND_ACK, commandId: 'c', status: 'error', error: ASK_ANSWER_ACK_ERRORS.DELIVERY_FAILED }))
      .toEqual({ commandId: 'c', kind: 'failed', reason: 'failed' });
    expect(readAskAnswerSignal({ type: MSG_COMMAND_ACK, commandId: 'c', status: 'error', error: ASK_ANSWER_ACK_ERRORS.ALREADY_ANSWERED }))
      .toEqual({ commandId: 'c', kind: 'failed', reason: 'already_answered' });
    expect(readAskAnswerSignal({ type: MSG_COMMAND_FAILED, commandId: 'c', session: 's', reason: 'daemon_offline', retryable: true }))
      .toEqual({ commandId: 'c', kind: 'failed', reason: 'failed' });
    expect(readAskAnswerSignal({ type: 'timeline.event', event: { type: 'user.message', payload: { askAnswerCommandId: 'c' } } }))
      .toEqual({ commandId: 'c', kind: 'confirmed' });
  });

  it('ignores unrelated frames', () => {
    expect(readAskAnswerSignal(null)).toBeNull();
    expect(readAskAnswerSignal({ type: 'session.event' })).toBeNull();
    expect(readAskAnswerSignal({ type: MSG_COMMAND_ACK, commandId: 'c', status: 'queued' })).toBeNull();
    expect(readAskAnswerSignal({ type: 'timeline.event', event: { type: 'user.message', payload: { text: 'hi' } } })).toBeNull();
  });
});

describe('AskAnswerTracker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps quiet when the daemon confirms the answer', () => {
    const onFailure = vi.fn();
    const tracker = new AskAnswerTracker(1000, onFailure);
    tracker.track(pending);
    expect(tracker.handle({ type: MSG_COMMAND_ACK, commandId: 'ans-1', status: 'accepted' })).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('surfaces a refused answer with the user text intact (no fake success)', () => {
    const onFailure = vi.fn<(failure: AskAnswerFailure) => void>();
    const tracker = new AskAnswerTracker(1000, onFailure);
    tracker.track(pending);
    tracker.handle({ type: MSG_COMMAND_ACK, commandId: 'ans-1', status: 'error', error: ASK_ANSWER_ACK_ERRORS.DELIVERY_FAILED });
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({ sessionName: 'deck_brain', toolUseId: 'toolu_1', answer: 'Option A\nsecond line', reason: 'failed' });
    // A late confirmation cannot resurrect or double-report the answer.
    vi.advanceTimersByTime(5000);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('reports an unconfirmed answer when nothing arrives in time', () => {
    const onFailure = vi.fn<(failure: AskAnswerFailure) => void>();
    const tracker = new AskAnswerTracker(1000, onFailure);
    tracker.track(pending);
    vi.advanceTimersByTime(999);
    expect(onFailure).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ reason: 'unconfirmed', answer: 'Option A\nsecond line' }));
  });

  it('treats the answer timeline echo as confirmation when the ack was lost', () => {
    const onFailure = vi.fn();
    const tracker = new AskAnswerTracker(1000, onFailure);
    tracker.track(pending);
    tracker.handle({ type: 'timeline.event', event: { type: 'user.message', payload: { askAnswerCommandId: 'ans-1' } } });
    vi.advanceTimersByTime(5000);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('tracks concurrent answers independently and ignores frames for other commands', () => {
    const onFailure = vi.fn<(failure: AskAnswerFailure) => void>();
    const tracker = new AskAnswerTracker(1000, onFailure);
    tracker.track(pending);
    tracker.track({ ...pending, commandId: 'ans-2', toolUseId: 'toolu_2', answer: 'B' });
    expect(tracker.handle({ type: MSG_COMMAND_ACK, commandId: 'someone-else', status: 'error' })).toBe(false);
    tracker.handle({ type: MSG_COMMAND_FAILED, commandId: 'ans-2', session: 's', reason: 'ack_timeout', retryable: true });
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0]![0]).toMatchObject({ toolUseId: 'toolu_2', answer: 'B' });
    tracker.dispose();
    vi.advanceTimersByTime(5000);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});
