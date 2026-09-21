import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_MODE_REASON,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_STATE,
  REMOTE_DESKTOP_TERMINAL_REASON,
  type RemoteDesktopDaemonCommand,
  type RemoteDesktopPrepare,
} from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_WORKER_WATCHDOG_STAGE,
  RemoteDesktopWorkerHostCore,
} from '../../src/node/remote-desktop-worker-host-core.js';
import {
  stopAllLocalRemoteDesktopConnections,
  stopLocalRemoteDesktopConnection,
} from '../../src/node/remote-desktop-local-worker-control.js';

const requestId = 'request_core_12345678';
const sessionId = 'session_core_12345678';
const capability = 'a'.repeat(43);
const prepare: RemoteDesktopPrepare = {
  type: REMOTE_DESKTOP_MSG.PREPARE,
  requestId,
  sessionId,
  capability,
  expiresAt: 4_000_000_000_000,
  leaseExpiresAt: 4_000_000_000_000,
  daemonGeneration: 17,
  mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
  inputEpoch: 0,
  iceServers: [],
};

afterEach(() => {
  vi.useRealTimers();
});

function modeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: REMOTE_DESKTOP_MSG.MODE_STATE,
    requestId,
    sessionId,
    capability,
    mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
    inputEpoch: 0,
    reason: REMOTE_DESKTOP_MODE_REASON.INITIAL,
    ...overrides,
  };
}

describe('RemoteDesktopWorkerHostCore', () => {
  it('projects only real connected peers through opaque local handles and retires them independently', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const core = new RemoteDesktopWorkerHostCore<null>({
      nonce: 'nonce-core-12345678',
      onWatchdogTimeout: () => {},
    });
    const generation = core.beginConnection();
    core.track(prepare, null);
    const secondPrepare = {
      ...prepare,
      requestId: 'request_core_second_1234',
      sessionId: 'session_core_second_1234',
      capability: 'z'.repeat(43),
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 2,
    };
    core.track(secondPrepare, null);

    const status = (value: RemoteDesktopPrepare, peerConnected: boolean) => ({
      type: REMOTE_DESKTOP_MSG.STATUS,
      requestId: value.requestId,
      sessionId: value.sessionId,
      capability: value.capability,
      mode: value.mode,
      inputEpoch: value.inputEpoch,
      state: REMOTE_DESKTOP_STATE.DIRECT,
      inputEnabled: value.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      peerConnected,
    });
    core.pushInbound(`${JSON.stringify(status(prepare, false))}\n`, generation);
    expect(core.activeConnections()).toEqual([]);
    core.pushInbound(`${JSON.stringify(status(prepare, true))}\n`, generation);
    vi.advanceTimersByTime(2_000);
    core.pushInbound(`${JSON.stringify(status(secondPrepare, true))}\n`, generation);

    const connections = core.activeConnections();
    expect(connections).toEqual([
      expect.objectContaining({ label: '#1', connectedAt: 1_700_000_000_000, mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW }),
      expect.objectContaining({ label: '#2', connectedAt: 1_700_000_002_000, mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL }),
    ]);
    expect(connections[0]?.id).not.toContain(sessionId);
    expect(core.sessionIdForLocalConnection(connections[0]!.id)).toBe(sessionId);

    core.untrack(sessionId);
    expect(core.activeConnections()).toEqual([expect.objectContaining({ label: '#2' })]);
  });

  it('maps one opaque handle to one STOP and keeps every other connected route alive', async () => {
    const core = new RemoteDesktopWorkerHostCore<null>({
      nonce: 'nonce-core-12345678',
      onWatchdogTimeout: () => {},
    });
    const generation = core.beginConnection();
    const second = {
      ...prepare,
      requestId: 'request_core_second_1234',
      sessionId: 'session_core_second_1234',
      capability: 'z'.repeat(43),
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 2,
    };
    core.track(prepare, null);
    core.track(second, null);
    for (const current of [prepare, second]) {
      core.pushInbound(`${JSON.stringify({
        type: REMOTE_DESKTOP_MSG.STATUS,
        requestId: current.requestId,
        sessionId: current.sessionId,
        capability: current.capability,
        mode: current.mode,
        inputEpoch: current.inputEpoch,
        state: REMOTE_DESKTOP_STATE.DIRECT,
        inputEnabled: current.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        peerConnected: true,
      })}\n`, generation);
    }
    const [firstConnection] = core.activeConnections();
    const commands: RemoteDesktopDaemonCommand[] = [];
    const handle = vi.fn(async (command: RemoteDesktopDaemonCommand) => {
      commands.push(command);
      core.untrack(command.sessionId);
      return true;
    });

    expect(await stopLocalRemoteDesktopConnection(core, handle, firstConnection!.id)).toBe(true);
    expect(commands).toEqual([expect.objectContaining({
      type: REMOTE_DESKTOP_MSG.STOP,
      sessionId,
    })]);
    expect(core.activeConnections()).toEqual([expect.objectContaining({ label: '#2' })]);

    await stopAllLocalRemoteDesktopConnections(core, handle);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(expect.objectContaining({ sessionId: second.sessionId }));
    expect(core.activeConnections()).toEqual([]);
  });
  it('reports PREPARE_READY, OFFER_SENT, and ANSWER from authenticated protocol transitions', () => {
    const stages: string[] = [];
    const core = new RemoteDesktopWorkerHostCore<null>({
      nonce: 'nonce-core-12345678',
      onWatchdogTimeout: () => {},
      onPrepareReady: () => stages.push('prepare_ready'),
      onOfferSent: () => stages.push('offer_sent'),
      onAnswer: () => stages.push('answer'),
    });
    const generation = core.beginConnection();
    core.track(prepare, null);

    core.pushInbound(`${JSON.stringify(modeState())}\n`, generation);
    core.markOfferPending(sessionId, {
      connectionGeneration: generation,
      workerPid: 41,
    });
    core.pushInbound(`${JSON.stringify({
      type: REMOTE_DESKTOP_MSG.ANSWER,
      requestId,
      sessionId,
      capability,
      sdp: 'redacted-by-the-host-diagnostic-schema',
    })}\n`, generation);

    expect(stages).toEqual(['prepare_ready', 'offer_sent', 'answer']);
  });

  it('frames split envelopes and authenticates them against the tracked authority', () => {
    const core = new RemoteDesktopWorkerHostCore<{ platform: string }>({
      nonce: 'nonce-core-12345678',
      onWatchdogTimeout: () => {},
    });
    const generation = core.beginConnection();
    core.track(prepare, { platform: 'fake' });
    expect(core.frameOutbound(prepare)).toBe(`${JSON.stringify(prepare)}\n`);

    const forged = `${JSON.stringify(modeState({ capability: 'b'.repeat(43) }))}\n`;
    const valid = `${JSON.stringify(modeState())}\n`;
    expect(core.pushInbound(`not-json\n${forged}${valid.slice(0, 19)}`, generation))
      .toEqual({ overflow: false, events: [] });
    const result = core.pushInbound(valid.slice(19), generation);

    expect(result.overflow).toBe(false);
    expect(result.events).toEqual([expect.objectContaining({
      kind: 'message',
      value: expect.objectContaining({ type: REMOTE_DESKTOP_MSG.MODE_STATE, sessionId }),
      authority: expect.objectContaining({ sessionId, metadata: { platform: 'fake' } }),
    })]);
    expect(core.get(sessionId)?.prepareReady).toBe(true);
  });

  it('ignores stale connection generations without consuming their bytes or watchdogs', () => {
    vi.useFakeTimers();
    const timeouts = vi.fn();
    const core = new RemoteDesktopWorkerHostCore<null>({
      nonce: 'nonce-core-12345678',
      prepareReadyTimeoutMs: 10,
      onWatchdogTimeout: timeouts,
    });
    const staleGeneration = core.beginConnection();
    core.track(prepare, null);
    core.armPrepareReadyTimer(sessionId, {
      connectionGeneration: staleGeneration,
      workerPid: 41,
    });

    const currentGeneration = core.beginConnection();
    expect(core.pushInbound(`${JSON.stringify(modeState())}\n`, staleGeneration).events).toEqual([]);
    vi.advanceTimersByTime(20);

    expect(timeouts).not.toHaveBeenCalled();
    expect(core.has(sessionId)).toBe(true);
    expect(core.pushInbound(`${JSON.stringify(modeState())}\n`, currentGeneration).events)
      .toHaveLength(1);
  });

  it('zeroizes every authority and cancels both timers on terminal cleanup', () => {
    vi.useFakeTimers();
    const timeouts = vi.fn();
    const removed = vi.fn();
    const terminals: unknown[] = [];
    const core = new RemoteDesktopWorkerHostCore<null>({
      nonce: 'nonce-core-12345678',
      prepareReadyTimeoutMs: 10,
      offerAnswerTimeoutMs: 10,
      onWatchdogTimeout: timeouts,
      onAuthorityRemoved: removed,
    });
    const generation = core.beginConnection();
    const first = core.track(prepare, null);
    const second = core.track({
      ...prepare,
      requestId: 'request_core_87654321',
      sessionId: 'session_core_87654321',
      capability: 'c'.repeat(43),
    }, null);
    core.armPrepareReadyTimer(first.sessionId, {
      connectionGeneration: generation,
      workerPid: 42,
    });
    first.prepareReady = true;
    core.markOfferPending(first.sessionId, {
      connectionGeneration: generation,
      workerPid: 42,
    });
    core.armPrepareReadyTimer(second.sessionId, {
      connectionGeneration: generation,
      workerPid: 42,
    });

    core.failAll(REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED, (message) => {
      terminals.push(message);
    });
    vi.advanceTimersByTime(20);

    expect(core.size).toBe(0);
    expect(terminals).toEqual([
      expect.objectContaining({ sessionId, reason: REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED }),
      expect.objectContaining({
        sessionId: 'session_core_87654321',
        reason: REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED,
      }),
    ]);
    expect([...first.capability]).toEqual(new Array(first.capability.length).fill(0));
    expect([...second.capability]).toEqual(new Array(second.capability.length).fill(0));
    expect(first.prepareReadyTimer).toBeNull();
    expect(first.offerAnswerTimer).toBeNull();
    expect(second.prepareReadyTimer).toBeNull();
    expect(timeouts).not.toHaveBeenCalled();
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it('cancels a retired authority watchdog and rejects the stale timer callback', () => {
    vi.useFakeTimers();
    const timeouts = vi.fn();
    const core = new RemoteDesktopWorkerHostCore<null>({
      nonce: 'nonce-core-12345678',
      prepareReadyTimeoutMs: 10,
      onWatchdogTimeout: timeouts,
    });
    const generation = core.beginConnection();
    const authority = core.track(prepare, null);
    core.armPrepareReadyTimer(sessionId, {
      connectionGeneration: generation,
      workerPid: 43,
    });

    core.untrack(sessionId);
    vi.advanceTimersByTime(20);

    expect(timeouts).not.toHaveBeenCalled();
    expect(core.has(sessionId)).toBe(false);
    expect(authority.prepareReadyTimer).toBeNull();
    expect([...authority.capability]).toEqual(new Array(authority.capability.length).fill(0));
  });

  it('retires a live watchdog exactly once with generation and terminal evidence', () => {
    vi.useFakeTimers();
    const events: unknown[] = [];
    const core = new RemoteDesktopWorkerHostCore<null>({
      nonce: 'nonce-core-12345678',
      prepareReadyTimeoutMs: 10,
      onWatchdogTimeout: (event) => events.push(event),
    });
    const generation = core.beginConnection();
    core.track(prepare, null);
    core.armPrepareReadyTimer(sessionId, {
      connectionGeneration: generation,
      workerPid: 44,
    });

    vi.advanceTimersByTime(20);

    expect(events).toEqual([expect.objectContaining({
      stage: REMOTE_DESKTOP_WORKER_WATCHDOG_STAGE.PREPARE_READY,
      connectionGeneration: generation,
      workerPid: 44,
      terminal: expect.objectContaining({
        type: REMOTE_DESKTOP_MSG.TERMINAL,
        sessionId,
        reason: REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED,
      }),
    })]);
    expect(core.size).toBe(0);
  });
});
