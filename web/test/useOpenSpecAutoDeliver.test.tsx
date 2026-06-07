/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOpenSpecAutoDeliver } from '../src/hooks/useOpenSpecAutoDeliver.js';
import type { ServerMessage, WsClient } from '../src/ws-client.js';

function makeWs(): WsClient & { send: ReturnType<typeof vi.fn>; emit: (msg: ServerMessage) => void } {
  const send = vi.fn();
  let handler: ((msg: ServerMessage) => void) | null = null;
  return {
    send,
    onMessage: (nextHandler: (msg: ServerMessage) => void) => {
      handler = nextHandler;
      return () => {
        handler = null;
      };
    },
    emit: (msg: ServerMessage) => {
      handler?.(msg);
    },
  } as unknown as WsClient & { send: ReturnType<typeof vi.fn>; emit: (msg: ServerMessage) => void };
}

describe('useOpenSpecAutoDeliver', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears launch pending on timeout and allows retry with the same selection', () => {
    vi.useFakeTimers();
    const ws = makeWs();
    const { result } = renderHook(() => useOpenSpecAutoDeliver({
      ws,
      serverId: 'server-1',
      sessionName: 'deck_sub_worker',
    }));

    act(() => {
      const requestId = result.current.launch({
        changeName: 'openspec-auto-delivery',
        selectedTeamComboId: 'audit>review>plan',
        materializedLimits: {
          specAuditRepairRounds: 1,
          implementationAuditRepairRounds: 2,
        },
      });
      expect(requestId).toBeTruthy();
    });

    expect(result.current.launchPending).toBe(true);
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'openspec_auto_deliver.launch',
      changeName: 'openspec-auto-delivery',
      selectedTeamComboId: 'audit>review>plan',
      materializedLimits: {
        specAuditRepairRounds: 1,
        implementationAuditRepairRounds: 2,
      },
    }));

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(result.current.launchPending).toBe(false);
    expect(result.current.lastError).toBe('openspec.auto.error.launch_timeout');

    act(() => {
      result.current.launch({
        changeName: 'openspec-auto-delivery',
        selectedTeamComboId: 'audit>review>plan',
        materializedLimits: {
          specAuditRepairRounds: 1,
          implementationAuditRepairRounds: 2,
        },
      });
    });

    expect(result.current.launchPending).toBe(true);
    expect(result.current.lastError).toBeNull();
    expect(ws.send.mock.calls.filter(([payload]) => (
      (payload as { type?: string }).type === 'openspec_auto_deliver.launch'
    ))).toHaveLength(2);
  });

  it('stops the projected target session even when the active tab differs', () => {
    const ws = makeWs();
    const { result } = renderHook(() => useOpenSpecAutoDeliver({
      ws,
      serverId: 'server-1',
      sessionName: 'deck_main_brain',
    }));

    act(() => {
      ws.emit({
        type: 'openspec_auto_deliver.projection',
        projection: {
          runId: 'auto-run-1',
          changeName: 'openspec-auto-delivery',
          status: 'implementation_task_loop',
          stage: 'implementation_task_loop',
          projectionVersion: 1,
          owningMainSessionName: 'deck_main_brain',
          launchedFromSessionName: 'deck_sub_launcher',
          targetImplementationSessionName: 'deck_sub_worker',
        },
      } as ServerMessage);
    });

    act(() => {
      result.current.stop();
    });

    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'openspec_auto_deliver.stop',
      runId: 'auto-run-1',
      sessionName: 'deck_sub_worker',
    }));
  });

  it('surfaces Stop ACK errors instead of leaving the stop button silently pending', () => {
    const ws = makeWs();
    const { result } = renderHook(() => useOpenSpecAutoDeliver({
      ws,
      serverId: 'server-1',
      sessionName: 'deck_main_brain',
    }));

    act(() => {
      result.current.stop('auto-run-1');
    });
    expect(result.current.stopPending).toBe(true);

    act(() => {
      ws.emit({
        type: 'openspec_auto_deliver.stop_ack',
        requestId: 'stop-1',
        ok: false,
        error: 'unauthorized_session',
      } as ServerMessage);
    });

    expect(result.current.stopPending).toBe(false);
    expect(result.current.lastError).toBe('openspec.auto.error.launch_failed');
  });
});
