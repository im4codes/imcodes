import { describe, expect, it } from 'vitest';
import { deriveSessionLiveStatus, isRunningSessionState, resolveTimelineBackedSessionState } from '../src/session-live-status.js';
import { SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL } from '@shared/session-control-commands.js';
import {
  createTransportQueueReducerState,
  reduceTransportQueueEvent,
} from '../../shared/transport-queue-reducer.js';

describe('session-live-status', () => {
  it('treats authoritative running state as busy even when timeline tail is settled', () => {
    const status = deriveSessionLiveStatus({ sessionState: 'running', activeTransportTurn: false });
    expect(status.mode).toBe('running');
    expect(status.visualMode).toBe('running');
    expect(status.busy).toBe(true);
    expect(status.sweep).toBe(true);
    expect(isRunningSessionState('running')).toBe(true);
  });

  it('treats a permission wait as busy rather than idle', () => {
    const status = deriveSessionLiveStatus({ sessionState: 'permission' });
    expect(isRunningSessionState('permission')).toBe(true);
    expect(status.mode).toBe('running');
    expect(status.busy).toBe(true);
    expect(status.sweep).toBe(true);
  });

  it('prioritizes live tool and thinking signals over idle snapshots', () => {
    expect(deriveSessionLiveStatus({ sessionState: 'idle', activeToolCall: true }).mode).toBe('tool');
    expect(deriveSessionLiveStatus({ sessionState: 'idle', activeThinking: true }).mode).toBe('thinking');
  });

  it('keeps scan sweep tied to authoritative visual state, not stale tail activity', () => {
    for (const input of [
      { sessionState: 'idle', activeThinking: true },
      { sessionState: 'idle', activeToolCall: true },
      { sessionState: 'idle', activeTransportTurn: true },
    ]) {
      const status = deriveSessionLiveStatus(input);
      expect(status.busy).toBe(true);
      expect(status.sweep).toBe(false);
      expect(status.visualMode).toBe('idle');
    }

    expect(deriveSessionLiveStatus({ sessionState: 'running' }).sweep).toBe(true);
    expect(deriveSessionLiveStatus({ sessionState: 'running' }).visualMode).toBe('running');
    expect(deriveSessionLiveStatus({ sessionState: 'stopping' }).sweep).toBe(true);
    expect(deriveSessionLiveStatus({ sessionState: 'stopping' }).visualMode).toBe('stopping');
    expect(deriveSessionLiveStatus({ sessionState: 'idle' }).sweep).toBe(false);
    expect(deriveSessionLiveStatus({ sessionState: 'idle' }).visualMode).toBe('idle');
  });


  it('lets authoritative idle override stale timeline running when no active work remains', () => {
    expect(resolveTimelineBackedSessionState({
      timelineState: 'running',
      sessionState: 'idle',
      activeThinking: false,
      activeToolCall: false,
      activeTransportTurn: false,
    })).toBe('idle');
  });

  it('lets authoritative idle override fresh but inactive timeline running evidence', () => {
    expect(resolveTimelineBackedSessionState({
      timelineState: 'running',
      sessionState: 'idle',
      activeThinking: false,
      activeToolCall: false,
      activeTransportTurn: false,
      timelineStateTs: 1_000,
      timelineLastEventTs: 55_000,
      now: 60_000,
    })).toBe('idle');
  });

  it('lets idle win once timeline running has gone stale without active evidence', () => {
    expect(resolveTimelineBackedSessionState({
      timelineState: 'running',
      sessionState: 'idle',
      activeThinking: false,
      activeToolCall: false,
      activeTransportTurn: false,
      timelineStateTs: 1_000,
      timelineLastEventTs: 30_000,
      now: 100_001,
    })).toBe('idle');
  });

  it('keeps timeline running when active work evidence is still present', () => {
    expect(resolveTimelineBackedSessionState({
      timelineState: 'running',
      sessionState: 'idle',
      activeTransportTurn: true,
    })).toBe('running');
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

  it('uses reducer live entries for queued status and ignores failed-only entries', () => {
    const liveQueueState = reduceTransportQueueEvent(createTransportQueueReducerState('deck'), {
      type: 'transport.queue.snapshot',
      sessionName: 'deck',
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-1',
      pendingMessageVersion: 1,
      pendingMessageEntries: [{
        clientMessageId: 'live',
        text: 'live',
        status: 'queued',
        placement: 'normal',
        ordinal: 0,
        createdAt: 1,
        updatedAt: 1,
      }],
      failedMessageEntries: [],
      source: 'test',
    });
    expect(deriveSessionLiveStatus({ sessionState: 'idle', transportQueueState: liveQueueState }).busy).toBe(true);

    const failedOnlyState = reduceTransportQueueEvent(createTransportQueueReducerState('deck'), {
      type: 'transport.queue.snapshot',
      sessionName: 'deck',
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-1',
      pendingMessageVersion: 1,
      pendingMessageEntries: [],
      failedMessageEntries: [{
        clientMessageId: 'failed',
        text: 'failed',
        status: 'failed',
        placement: 'normal',
        ordinal: 0,
        createdAt: 1,
        updatedAt: 1,
      }],
      source: 'test',
    });
    expect(deriveSessionLiveStatus({ sessionState: 'idle', transportQueueState: failedOnlyState }).busy).toBe(false);
  });

  it('does not treat diagnostic pendingCount or legacy text arrays as live queue authority', () => {
    const status = deriveSessionLiveStatus({
      sessionState: 'idle',
      pendingCount: 99,
      pendingMessages: ['legacy'],
      transportPendingMessages: ['legacy'],
    } as never);

    expect(status.mode).toBe('idle');
    expect(status.busy).toBe(false);
  });
});
