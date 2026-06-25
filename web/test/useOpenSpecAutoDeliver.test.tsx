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
          maxImplementationPrompts: 12,
          maxElapsedMinutes: 480,
        },
        locale: 'zh-CN',
        autoCommitPush: true,
      });
      expect(requestId).toBeTruthy();
    });

    expect(result.current.launchPending).toBe(true);
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'openspec_auto_deliver.launch',
      changeName: 'openspec-auto-delivery',
      selectedTeamComboId: 'audit>review>plan',
      locale: 'zh-CN',
      autoCommitPush: true,
      materializedLimits: {
        specAuditRepairRounds: 1,
        implementationAuditRepairRounds: 2,
        maxImplementationPrompts: 12,
        maxElapsedMinutes: 480,
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
          maxImplementationPrompts: 12,
          maxElapsedMinutes: 480,
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
          visibility: 'full',
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

    let stopRequestId: string | null = null;
    act(() => {
      stopRequestId = result.current.stop('auto-run-1');
    });
    expect(result.current.stopPending).toBe(true);
    expect(stopRequestId).toBeTruthy();

    act(() => {
      ws.emit({
        type: 'openspec_auto_deliver.stop_ack',
        requestId: stopRequestId,
        ok: false,
        error: 'unauthorized_session',
      } as ServerMessage);
    });

    expect(result.current.stopPending).toBe(false);
    expect(result.current.lastError).toBe('openspec.auto.error.launch_failed');
  });

  it('ignores stale Stop ACKs and terminal projections for other runs while stop is pending', () => {
    const ws = makeWs();
    const { result } = renderHook(() => useOpenSpecAutoDeliver({
      ws,
      serverId: 'server-1',
      sessionName: 'deck_main_brain',
    }));

    let stopRequestId: string | null = null;
    act(() => {
      stopRequestId = result.current.stop('auto-run-1');
    });
    expect(result.current.stopPending).toBe(true);

    act(() => {
      ws.emit({
        type: 'openspec_auto_deliver.stop_ack',
        requestId: 'openspec-auto-stop-stale',
        ok: false,
        error: 'unauthorized_session',
      } as ServerMessage);
    });
    expect(result.current.stopPending).toBe(true);
    expect(result.current.lastError).toBeNull();

    act(() => {
      ws.emit({
        type: 'openspec_auto_deliver.terminal',
        projection: {
          runId: 'auto-run-other',
          visibility: 'full',
          projectionVersion: 2,
          changeName: 'openspec-auto-delivery',
          status: 'stopped',
          stage: 'stopped',
          owningMainSessionName: 'deck_main_brain',
          terminal: true,
          canStop: false,
        },
      } as unknown as ServerMessage);
    });
    expect(result.current.stopPending).toBe(true);

    act(() => {
      ws.emit({
        type: 'openspec_auto_deliver.stop_ack',
        requestId: stopRequestId,
        ok: true,
      } as ServerMessage);
    });
    expect(result.current.stopPending).toBe(false);
    expect(result.current.lastError).toBeNull();
  });

  it('constructs conflict projection state from an allowlist and blocks Stop', () => {
    const ws = makeWs();
    const { result } = renderHook(() => useOpenSpecAutoDeliver({
      ws,
      serverId: 'server-1',
      sessionName: 'deck_sub_sibling',
    }));

    act(() => {
      ws.emit({
        type: 'openspec_auto_deliver.conflict_summary',
        projection: {
          runId: 'auto-conflict-1',
          visibility: 'conflict',
          projectionVersion: 7,
          owningMainSessionName: 'deck_main_brain',
          status: 'implementation_task_loop',
          stage: 'implementation_task_loop',
          busy: true,
          reason: 'auto_deliver_active',
          conflictReason: 'auto_deliver_active',
          canStop: true,
          changeName: 'private-change',
          evidence: [{ summary: 'secret evidence' }],
          validationOutput: 'npm test failed in /Users/k/private',
          rawPrompt: 'private prompt body',
          rawP2pInternals: { targetSessionName: 'deck_secret_worker' },
          apiToken: 'secret-token',
        },
      } as unknown as ServerMessage);
    });

    expect(result.current.projection).toMatchObject({
      visibility: 'conflict',
      runId: 'auto-conflict-1',
      owningMainSessionName: 'deck_main_brain',
      status: 'implementation_task_loop',
      stage: 'implementation_task_loop',
      conflictReason: 'auto_deliver_active',
      canStop: false,
    });
    expect(result.current.projection).not.toHaveProperty('changeName');
    expect(result.current.projection).not.toHaveProperty('evidence');
    expect(result.current.projection).not.toHaveProperty('validationOutput');
    expect(result.current.projection).not.toHaveProperty('rawPrompt');
    expect(result.current.projection).not.toHaveProperty('rawP2pInternals');
    expect(result.current.projection).not.toHaveProperty('apiToken');

    act(() => {
      expect(result.current.stop()).toBeNull();
    });

    expect(ws.send.mock.calls.some(([payload]) => (
      (payload as { type?: string }).type === 'openspec_auto_deliver.stop'
    ))).toBe(false);
    expect(result.current.stopPending).toBe(false);
  });

  it('rejects malformed projection metadata instead of inventing defaults', () => {
    const ws = makeWs();
    const { result } = renderHook(() => useOpenSpecAutoDeliver({
      ws,
      serverId: 'server-1',
      sessionName: 'deck_main_brain',
    }));

    for (const projection of [
      {
        runId: 'missing-visibility',
        projectionVersion: 1,
        changeName: 'private-change',
        status: 'implementation_task_loop',
        stage: 'implementation_task_loop',
      },
      {
        runId: 'bad-stage',
        visibility: 'full',
        projectionVersion: 1,
        changeName: 'private-change',
        status: 'implementation_task_loop',
        stage: 'active',
      },
      {
        runId: 'bad-status-object',
        visibility: 'full',
        projectionVersion: 1,
        changeName: 'private-change',
        status: {},
        stage: 'implementation_task_loop',
      },
      {
        runId: 'bad-status-active',
        visibility: 'full',
        projectionVersion: 1,
        changeName: 'private-change',
        status: 'active',
        stage: 'implementation_task_loop',
      },
      {
        runId: 'bad-status-running',
        visibility: 'full',
        projectionVersion: 1,
        changeName: 'private-change',
        status: 'running',
        stage: 'implementation_task_loop',
      },
      {
        runId: 'bad-version',
        visibility: 'conflict',
        projectionVersion: Number.POSITIVE_INFINITY,
        owningMainSessionName: 'deck_main_brain',
        status: 'implementation_task_loop',
        stage: 'implementation_task_loop',
        reason: 'auto_deliver_active',
      },
    ]) {
      act(() => {
        ws.emit({
          type: 'openspec_auto_deliver.projection',
          projection,
        } as unknown as ServerMessage);
      });
    }

    expect(result.current.projection).toBeNull();
  });

  it('continues a failed run through the projected target session and clears pending on ACK', () => {
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
          runId: 'auto-run-continue',
          visibility: 'full',
          projectionVersion: 1,
          changeName: 'openspec-auto-delivery',
          status: 'needs_human',
          stage: 'needs_human',
          owningMainSessionName: 'deck_main_brain',
          launchedFromSessionName: 'deck_sub_launcher',
          targetImplementationSessionName: 'deck_sub_worker',
          terminal: true,
          canContinue: true,
          canStop: false,
        },
      } as unknown as ServerMessage);
    });

    let continueRequestId: string | null = null;
    act(() => {
      continueRequestId = result.current.continueRun();
    });

    expect(continueRequestId).toBeTruthy();
    expect(result.current.continuePending).toBe(true);
    expect(result.current.lastError).toBeNull();
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'openspec_auto_deliver.continue',
      requestId: continueRequestId,
      serverId: 'server-1',
      sessionName: 'deck_sub_worker',
      runId: 'auto-run-continue',
    }));

    act(() => {
      ws.emit({
        type: 'openspec_auto_deliver.continue_ack',
        requestId: continueRequestId,
        ok: true,
        projection: {
          runId: 'auto-run-continue',
          visibility: 'full',
          projectionVersion: 2,
          changeName: 'openspec-auto-delivery',
          status: 'spec_audit_repair',
          stage: 'spec_audit_repair',
          owningMainSessionName: 'deck_main_brain',
          launchedFromSessionName: 'deck_sub_launcher',
          targetImplementationSessionName: 'deck_sub_worker',
          canContinue: false,
          canStop: true,
        },
      } as unknown as ServerMessage);
    });

    expect(result.current.continuePending).toBe(false);
    expect(result.current.lastError).toBeNull();
    expect(result.current.projection).toMatchObject({
      runId: 'auto-run-continue',
      status: 'spec_audit_repair',
      canContinue: false,
      canStop: true,
    });
  });

  it('does not continue conflicts, passed runs, or non-recoverable projections', () => {
    const ws = makeWs();
    const { result } = renderHook(() => useOpenSpecAutoDeliver({
      ws,
      serverId: 'server-1',
      sessionName: 'deck_sibling',
    }));

    act(() => {
      ws.emit({
        type: 'openspec_auto_deliver.conflict_summary',
        projection: {
          runId: 'auto-conflict',
          visibility: 'conflict',
          projectionVersion: 1,
          owningMainSessionName: 'deck_main_brain',
          status: 'needs_human',
          stage: 'needs_human',
          reason: 'auto_deliver_active',
          canContinue: true,
        },
      } as unknown as ServerMessage);
    });
    act(() => {
      expect(result.current.continueRun()).toBeNull();
    });

    act(() => {
      ws.emit({
        type: 'openspec_auto_deliver.projection',
        projection: {
          runId: 'auto-passed',
          visibility: 'full',
          projectionVersion: 1,
          changeName: 'openspec-auto-delivery',
          status: 'passed',
          stage: 'passed',
          owningMainSessionName: 'deck_sibling',
          terminal: true,
          canContinue: true,
        },
      } as unknown as ServerMessage);
    });
    act(() => {
      expect(result.current.continueRun()).toBeNull();
    });

    act(() => {
      ws.emit({
        type: 'openspec_auto_deliver.projection',
        projection: {
          runId: 'auto-not-recoverable',
          visibility: 'full',
          projectionVersion: 2,
          changeName: 'openspec-auto-delivery',
          status: 'failed',
          stage: 'failed',
          owningMainSessionName: 'deck_sibling',
          terminal: true,
          canContinue: false,
        },
      } as unknown as ServerMessage);
    });
    act(() => {
      expect(result.current.continueRun()).toBeNull();
    });

    expect(ws.send.mock.calls.some(([payload]) => (
      (payload as { type?: string }).type === 'openspec_auto_deliver.continue'
    ))).toBe(false);
    expect(result.current.continuePending).toBe(false);
  });

  it('clears continue pending on timeout with the localized continue timeout key', () => {
    vi.useFakeTimers();
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
          runId: 'auto-run-continue-timeout',
          visibility: 'full',
          projectionVersion: 1,
          changeName: 'openspec-auto-delivery',
          status: 'needs_human',
          stage: 'needs_human',
          owningMainSessionName: 'deck_main_brain',
          targetImplementationSessionName: 'deck_sub_worker',
          terminal: true,
          canContinue: true,
          canStop: false,
        },
      } as unknown as ServerMessage);
    });

    act(() => {
      result.current.continueRun();
    });
    expect(result.current.continuePending).toBe(true);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(result.current.continuePending).toBe(false);
    expect(result.current.lastError).toBe('openspec.auto.error.continue_timeout');
  });

  it('clears stop pending on terminal projection and disconnect', () => {
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
          runId: 'auto-run-stop',
          visibility: 'full',
          projectionVersion: 1,
          changeName: 'openspec-auto-delivery',
          status: 'implementation_task_loop',
          stage: 'implementation_task_loop',
          owningMainSessionName: 'deck_main_brain',
          launchedFromSessionName: 'deck_main_brain',
          targetImplementationSessionName: 'deck_main_brain',
          canStop: true,
        },
      } as unknown as ServerMessage);
    });

    act(() => {
      result.current.stop();
    });

    expect(result.current.stopPending).toBe(true);

    act(() => {
      ws.emit({
        type: 'openspec_auto_deliver.terminal',
        projection: {
          runId: 'auto-run-stop',
          visibility: 'full',
          projectionVersion: 2,
          changeName: 'openspec-auto-delivery',
          status: 'stopped',
          stage: 'stopped',
          owningMainSessionName: 'deck_main_brain',
          terminal: true,
          canStop: false,
        },
      } as unknown as ServerMessage);
    });

    expect(result.current.stopPending).toBe(false);

    act(() => {
      ws.emit({
        type: 'openspec_auto_deliver.projection',
        projection: {
          runId: 'auto-run-disconnect',
          visibility: 'full',
          projectionVersion: 1,
          changeName: 'openspec-auto-delivery',
          status: 'implementation_task_loop',
          stage: 'implementation_task_loop',
          owningMainSessionName: 'deck_main_brain',
          canStop: true,
        },
      } as unknown as ServerMessage);
    });

    act(() => {
      result.current.stop();
    });

    expect(result.current.stopPending).toBe(true);

    act(() => {
      ws.emit({
        type: 'daemon.offline',
      } as unknown as ServerMessage);
    });

    expect(result.current.stopPending).toBe(false);
  });

  it('clears stop pending on timeout with the localized stop timeout key', () => {
    vi.useFakeTimers();
    const ws = makeWs();
    const { result } = renderHook(() => useOpenSpecAutoDeliver({
      ws,
      serverId: 'server-1',
      sessionName: 'deck_main_brain',
    }));

    act(() => {
      result.current.stop('auto-run-timeout');
    });
    expect(result.current.stopPending).toBe(true);

    act(() => {
      vi.advanceTimersByTime(15_000);
    });

    expect(result.current.stopPending).toBe(false);
    expect(result.current.lastError).toBe('openspec.auto.error.stop_timeout');
  });

  it('does not leave stop pending when the websocket is not connected', () => {
    const ws = makeWs();
    const { result } = renderHook(() => useOpenSpecAutoDeliver({
      ws,
      serverId: 'server-1',
      sessionName: 'deck_main_brain',
    }));
    ws.send.mockImplementation(() => {
      throw new Error('WebSocket not connected');
    });

    act(() => {
      expect(result.current.stop('auto-run-offline')).toBeNull();
    });

    expect(result.current.stopPending).toBe(false);
    expect(result.current.lastError).toBe('openspec.auto.error.daemon_offline');
  });
});
