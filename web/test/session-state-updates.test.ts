import { describe, expect, it } from 'vitest';
import { markSessionRunningIfNeeded } from '../src/session-state-updates.js';
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
