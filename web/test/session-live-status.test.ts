import { describe, expect, it } from 'vitest';
import { deriveSessionLiveStatus, isActiveTurnFinishedError, isRunningSessionState, resolveTimelineBackedSessionState } from '../src/session-live-status.js';
import { hasActiveTimelineTurn } from '../src/timeline-running.js';
import { SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL } from '@shared/session-control-commands.js';
import {
  createTransportQueueReducerState,
  reduceTransportQueueEvent,
} from '../../shared/transport-queue-reducer.js';

describe('session-live-status', () => {
  it('recognizes the authoritative stale-turn acknowledgement used to clear a stuck queue', () => {
    expect(isActiveTurnFinishedError('The active turn already finished')).toBe(true);
    expect(isActiveTurnFinishedError(' the active turn already finished ')).toBe(true);
    expect(isActiveTurnFinishedError('Queued message not found')).toBe(false);
    expect(isActiveTurnFinishedError(undefined)).toBe(false);
  });

  it('treats authoritative running state as busy even when timeline tail is settled', () => {
    const status = deriveSessionLiveStatus({ sessionState: 'running', activeTransportTurn: false });
    expect(status.mode).toBe('running');
    expect(status.visualMode).toBe('running');
    expect(status.busy).toBe(true);
    expect(status.sweep).toBe(true);
    expect(isRunningSessionState('running')).toBe(true);
  });

  it('shows running immediately for a current optimistic send without trusting stale tail activity', () => {
    const status = deriveSessionLiveStatus({
      sessionState: 'idle',
      pendingUserSend: true,
      activeThinking: false,
      activeToolCall: false,
      activeTransportTurn: false,
    });
    expect(status.mode).toBe('running');
    expect(status.visualMode).toBe('running');
    expect(status.busy).toBe(true);
    expect(status.sweep).toBe(true);

    expect(deriveSessionLiveStatus({
      sessionState: 'idle',
      pendingUserSend: false,
      activeTransportTurn: true,
    }).visualMode).toBe('idle');
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

  it('lets a stale-turn idle acknowledgement override a stale active-turn hint', () => {
    expect(resolveTimelineBackedSessionState({
      timelineState: 'running',
      sessionState: 'idle',
      activeTransportTurn: true,
      timelineLastEventTs: 10_000,
      authoritativeIdleAt: 20_000,
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
    const liveStatus = deriveSessionLiveStatus({ sessionState: 'idle', transportQueueState: liveQueueState });
    expect(liveStatus.busy).toBe(true);
    expect(liveStatus.mode).toBe('idle');
    expect(liveStatus.visualMode).toBe('idle');

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

  it('clears the working indicator once a turn settles to error, then shows running again once the queued message actually dispatches as the next turn (session-queue-stuck-forever regression)', () => {
    // A turn that hit the provider send-start timeout, an unrecoverable
    // provider error, or was stopped settles to 'error'/'idle' on the
    // daemon side. The working indicator must clear immediately -- this is
    // exactly what used to stay stuck at "Agent 工作中…" forever because the
    // daemon kept re-broadcasting 'queued' for a queue it never drained.
    const afterSettlement = deriveSessionLiveStatus({ sessionState: 'error', activeTransportTurn: false });
    expect(afterSettlement.busy).toBe(false);
    expect(afterSettlement.sweep).toBe(false);
    expect(afterSettlement.visualMode).not.toBe('running');
    expect(isRunningSessionState('error')).toBe(false);

    // The daemon's fix then dispatches the previously-queued message as a
    // fresh turn: the client must show real working state again, not idle.
    const afterDrain = deriveSessionLiveStatus({ sessionState: 'running', activeTransportTurn: true });
    expect(afterDrain.busy).toBe(true);
    expect(afterDrain.sweep).toBe(true);
    expect(afterDrain.visualMode).toBe('running');
  });

  it('completed tail must not revive stale running over authoritative idle snapshot', () => {
    const events: any[] = [
      { type: 'session.state', ts: 1000, payload: { state: 'running' } },
      { type: 'user.message', ts: 2000, payload: { text: 'synthetic' } },
      { type: 'tool.call', ts: 3000, payload: { toolCallId: 'A', tool: 'synthetic' } },
      { type: 'tool.result', ts: 55000, payload: { toolCallId: 'A', terminalStatus: 'succeeded' } },
    ];
    const active = hasActiveTimelineTurn(events);
    expect(active).toBe(false);
    const resolvedState = resolveTimelineBackedSessionState({
      timelineState: 'running',
      sessionState: 'idle',
      activeThinking: false,
      activeToolCall: false,
      activeTransportTurn: active,
      timelineStateTs: 1000,
      timelineLastEventTs: 55000,
      now: 60000,
    });
    expect(resolvedState).toBe('idle');
    const liveStatus = deriveSessionLiveStatus({
      sessionState: resolvedState,
      activeTransportTurn: active,
      activeToolCall: false,
      activeThinking: false,
    });
    expect(liveStatus.visualMode).toBe('idle');
  });

  it('converges footer live status to idle after stopping (user_cancel) + command_handler_cancel_idle despite pre-stop open tool.call', async () => {
    const { getTailSessionStateInfo, hasActiveToolCall } = await import('../src/thinking-utils.js');
    const events = [
      { type: 'session.state', ts: 1000, payload: { state: 'running', activityGeneration: { scope: 'session', sessionName: 'deck_aip_brain', generation: 4 } } },
      { type: 'tool.call', ts: 2000, payload: { toolCallId: 'tool-open-stop', tool: 'Read' } },
      { type: 'session.state', ts: 3000, payload: { state: 'stopping', reason: SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL } },
      {
        type: 'session.state',
        ts: 3010,
        payload: {
          state: 'idle',
          pendingCount: 0,
          queueSnapshot: { source: 'command_handler_cancel_idle' },
        },
      },
    ];
    const activeToolCall = hasActiveToolCall(events as any);
    const tail = getTailSessionStateInfo(events as any);
    const activeTurn = hasActiveTimelineTurn(events as any);
    const resolvedState = resolveTimelineBackedSessionState({
      timelineState: tail.state,
      sessionState: 'idle',
      activeThinking: false,
      activeToolCall,
      activeTransportTurn: activeTurn,
      timelineStateTs: tail.ts,
      timelineLastEventTs: 3010,
    });
    const liveStatus = deriveSessionLiveStatus({
      sessionState: resolvedState,
      activeThinking: false,
      activeToolCall,
      activeTransportTurn: activeTurn,
    });

    expect(activeToolCall).toBe(false);
    expect(tail.state).toBe('idle');
    expect(activeTurn).toBe(false);
    expect(resolvedState).toBe('idle');
    expect(liveStatus.mode).toBe('idle');
    expect(liveStatus.visualMode).toBe('idle');
    expect(liveStatus.sweep).toBe(false);
  });
});
