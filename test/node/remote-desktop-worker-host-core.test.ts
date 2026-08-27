import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_MODE_REASON,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_TERMINAL_REASON,
  type RemoteDesktopPrepare,
} from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_WORKER_WATCHDOG_STAGE,
  RemoteDesktopWorkerHostCore,
} from '../../src/node/remote-desktop-worker-host-core.js';

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
