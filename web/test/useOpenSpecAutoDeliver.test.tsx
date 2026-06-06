/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOpenSpecAutoDeliver } from '../src/hooks/useOpenSpecAutoDeliver.js';
import type { ServerMessage, WsClient } from '../src/ws-client.js';

function makeWs(): WsClient & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  return {
    send,
    onMessage: (_handler: (msg: ServerMessage) => void) => () => {},
  } as unknown as WsClient & { send: ReturnType<typeof vi.fn> };
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
});
