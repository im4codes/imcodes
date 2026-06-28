import { describe, expect, it } from 'vitest';
import { deriveSessionLiveStatus, isRunningSessionState } from '../src/session-live-status.js';
import { SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL } from '@shared/session-control-commands.js';

describe('session-live-status', () => {
  it('treats authoritative running state as busy even when timeline tail is settled', () => {
    const status = deriveSessionLiveStatus({ sessionState: 'running', activeTransportTurn: false });
    expect(status.mode).toBe('running');
    expect(status.busy).toBe(true);
    expect(status.sweep).toBe(true);
    expect(isRunningSessionState('running')).toBe(true);
  });

  it('prioritizes live tool and thinking signals over idle snapshots', () => {
    expect(deriveSessionLiveStatus({ sessionState: 'idle', activeToolCall: true }).mode).toBe('tool');
    expect(deriveSessionLiveStatus({ sessionState: 'idle', activeThinking: true }).mode).toBe('thinking');
  });

  it('surfaces immediate stop feedback from optimistic and authoritative state', () => {
    expect(deriveSessionLiveStatus({ sessionState: 'running', stopRequested: true }).mode).toBe('stopping');
    expect(deriveSessionLiveStatus({ sessionState: 'stopping' }).controlFeedback).toBe('stop_requested');
    expect(deriveSessionLiveStatus({ sessionState: 'stopping', sessionStateReason: SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL }).mode).toBe('stopping');
  });

  it('classifies idle cancel details separately from generic idle', () => {
    const status = deriveSessionLiveStatus({ sessionState: 'idle', sessionStateError: 'Turn cancelled by user stop' });
    expect(status.mode).toBe('cancelled');
    expect(status.controlFeedback).toBe('cancelled');
    expect(status.errorDetail).toBe('Turn cancelled by user stop');
  });

  it('keeps agentless sessions out of live agent status', () => {
    const status = deriveSessionLiveStatus({ sessionState: 'running', isAgentless: true, activeThinking: true });
    expect(status.mode).toBeNull();
    expect(status.busy).toBe(false);
  });
});
