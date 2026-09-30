import { describe, expect, it } from 'vitest';
import { markSessionRunningIfNeeded, updateSessionIfChanged } from '../src/session-state-updates.js';
import type { SessionInfo } from '../src/types.js';

function makeSession(name: string, state: SessionInfo['state']): SessionInfo {
  return {
    name,
    project: 'deck',
    role: 'brain',
    agentType: 'codex-sdk',
    state,
  };
}

describe('session state update helpers', () => {
  it('returns the same sessions array when a running timeline event is already reflected', () => {
    const sessions = [
      makeSession('deck_main_brain', 'running'),
      makeSession('deck_other_brain', 'idle'),
    ];

    expect(markSessionRunningIfNeeded(sessions, 'deck_main_brain')).toBe(sessions);
  });

  it('returns the same sessions array when the timeline session is not in the list', () => {
    const sessions = [makeSession('deck_main_brain', 'idle')];

    expect(markSessionRunningIfNeeded(sessions, 'deck_missing_brain')).toBe(sessions);
  });

  it('only changes the target session when it transitions to running', () => {
    const idle = makeSession('deck_main_brain', 'idle');
    const other = makeSession('deck_other_brain', 'idle');
    const sessions = [idle, other];
    const result = markSessionRunningIfNeeded(sessions, 'deck_main_brain');

    expect(result).not.toBe(sessions);
    expect(result[0]).toEqual({ ...idle, state: 'running' });
    expect(result[1]).toBe(other);
  });
});


describe('updateSessionIfChanged (frames that repeat the record must not re-render the app)', () => {
  it('returns the SAME array when the rebuilt session equals the current one', () => {
    const sessions = [makeSession('a', 'idle'), makeSession('b', 'running')];
    expect(updateSessionIfChanged(sessions, 'a', (s) => ({ ...s, state: 'idle' }))).toBe(sessions);
    expect(updateSessionIfChanged(sessions, 'missing', (s) => ({ ...s, state: 'idle' }))).toBe(sessions);
  });

  it('treats an equal-but-new queue snapshot (fresh arrays/objects) as unchanged', () => {
    const sessions = [{ ...makeSession('a', 'running'), transportPendingMessages: ['x'], transportPendingMessageEntries: [{ clientMessageId: 'c1', text: 'x' }] } as SessionInfo];
    const same = updateSessionIfChanged(sessions, 'a', (s) => ({
      ...s, state: 'running',
      transportPendingMessages: ['x'],
      transportPendingMessageEntries: [{ clientMessageId: 'c1', text: 'x' }],
    } as SessionInfo));
    expect(same).toBe(sessions);
  });

  // Counterexample: a real change still produces a new array and a new record for ONLY that session.
  it('a real change replaces only that session and leaves siblings identical', () => {
    const sessions = [makeSession('a', 'idle'), makeSession('b', 'idle')];
    const next = updateSessionIfChanged(sessions, 'a', (s) => ({ ...s, state: 'running' }));
    expect(next).not.toBe(sessions);
    expect(next[0]!.state).toBe('running');
    expect(next[1]).toBe(sessions[1]);
    const queued = updateSessionIfChanged(next, 'a', (s) => ({ ...s, transportPendingMessages: ['hello'] } as SessionInfo));
    expect(queued).not.toBe(next);
    expect((queued[0] as SessionInfo & { transportPendingMessages?: string[] }).transportPendingMessages).toEqual(['hello']);
  });
});
