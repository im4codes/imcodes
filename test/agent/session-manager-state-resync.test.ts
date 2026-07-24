/**
 * ServerLink reconnect state resync — regression for the deck_sub_26624c1t
 * incident (2026-07-24 23:46 → 01:43):
 *
 * Live `timeline.event` relays are control-plane and are silently DROPPED by
 * `ServerLink.trySend` while the socket is not OPEN. CC2's turn settled during
 * a link outage, so its authoritative `session.state: idle` (seq 2271,
 * decisionReason `activity_reconciler_clear`) never reached the server — every
 * browser kept rendering "Agent working…" for two hours and held queued
 * composer sends, while the daemon-local store/timeline were idle all along.
 *
 * `resyncTransportSessionStatesAfterLinkRestore()` re-broadcasts each transport
 * session's CURRENT authoritative state after the link comes back. These tests
 * pin: (1) the resync idle payload satisfies the shared authoritative-idle
 * shape validator (a weak idle would be overridden client-side and NOT heal the
 * stuck "working" footer); (2) running sessions re-broadcast running with
 * activity evidence; (3) the session record is re-pushed through the persist
 * callback so a store PUT lost in the same outage heals too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  resyncTransportSessionStatesAfterLinkRestore,
  setSessionPersistCallback,
} from '../../src/agent/session-manager.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { isAuthoritativeIdlePayloadShape } from '../../shared/session-activity-types.js';
import { upsertSession, removeSession } from '../../src/store/session-store.js';
import type { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';

const IDLE_SESSION = 'deck_storecheckresync_w1';
const RUNNING_SESSION = 'deck_storecheckresync_w2';

function makeRuntime(overrides: {
  status: string;
  blockingWorkCount?: number;
  activeToolCount?: number;
  busyReasons?: string[];
}): TransportSessionRuntime {
  return {
    getStatus: () => overrides.status,
    getDiagnosticSnapshot: () => ({
      activityGeneration: { scope: 'session', sessionName: IDLE_SESSION, generation: 3 },
      blockingWorkCount: overrides.blockingWorkCount ?? 0,
      activeToolCount: overrides.activeToolCount ?? 0,
      busyReasons: overrides.busyReasons ?? [],
    }),
    lastProviderError: undefined,
  } as unknown as TransportSessionRuntime;
}

describe('resyncTransportSessionStatesAfterLinkRestore', () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Intercept BEFORE any emit so nothing is persisted to timeline JSONL and
    // nothing leaves this test (hygiene: shared/test-session-guard.ts names
    // are used anyway as belt-and-braces).
    emitSpy = vi.spyOn(timelineEmitter, 'emit').mockImplementation(() => null as never);
  });

  afterEach(() => {
    emitSpy.mockRestore();
    setSessionPersistCallback(async () => {});
    removeSession(IDLE_SESSION);
    removeSession(RUNNING_SESSION);
  });

  it('re-broadcasts an idle transport session as a FULL authoritative idle (not a weak idle)', () => {
    const emitted = resyncTransportSessionStatesAfterLinkRestore([
      [IDLE_SESSION, makeRuntime({ status: 'idle' })],
    ]);

    expect(emitted).toBe(1);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    const [sessionName, type, payload, opts] = emitSpy.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
      { eventId?: string },
    ];
    expect(sessionName).toBe(IDLE_SESSION);
    expect(type).toBe('session.state');
    expect(payload.state).toBe('idle');
    expect(payload.decisionReason).toBe('server_link_resync');
    // The critical contract: a resync idle MUST satisfy the shared
    // authoritative-idle validator. A weak idle is demoted client-side
    // (isWeakIdlePayload) and cannot un-stick a "working" footer.
    expect(isAuthoritativeIdlePayloadShape(payload)).toBe(true);
    // Stable per-epoch eventId so a double-fired resync updates in place.
    expect(opts.eventId).toMatch(new RegExp(`^transport-state-resync:${IDLE_SESSION}:\\d+$`));
  });

  it('re-broadcasts a running transport session as running with activity evidence', () => {
    const emitted = resyncTransportSessionStatesAfterLinkRestore([
      [RUNNING_SESSION, makeRuntime({ status: 'streaming', blockingWorkCount: 2, busyReasons: ['runtime_dispatch'] })],
    ]);

    expect(emitted).toBe(1);
    const [, , payload] = emitSpy.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(payload.state).toBe('running');
    expect(payload.blockingWorkCount).toBe(2);
    expect(payload.busyReasons).toEqual(['runtime_dispatch']);
  });

  it('treats idle-with-blocking-work as running (same override as the live path)', () => {
    resyncTransportSessionStatesAfterLinkRestore([
      [RUNNING_SESSION, makeRuntime({ status: 'idle', blockingWorkCount: 1 })],
    ]);
    const [, , payload] = emitSpy.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(payload.state).toBe('running');
  });

  it('re-pushes the session record through the persist callback so a lost store PUT heals', async () => {
    upsertSession({
      name: IDLE_SESSION,
      projectName: 'storecheckresync',
      role: 'w1',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'idle',
    } as never);
    const persisted: string[] = [];
    setSessionPersistCallback(async (_record, name) => {
      persisted.push(name);
    });

    resyncTransportSessionStatesAfterLinkRestore([
      [IDLE_SESSION, makeRuntime({ status: 'idle' })],
    ]);

    expect(persisted).toEqual([IDLE_SESSION]);
  });

  it('keeps going when one runtime throws and reports only successful sessions', () => {
    const broken = {
      getStatus: () => {
        throw new Error('boom');
      },
    } as unknown as TransportSessionRuntime;
    const emitted = resyncTransportSessionStatesAfterLinkRestore([
      ['deck_storecheckresync_w3', broken],
      [IDLE_SESSION, makeRuntime({ status: 'idle' })],
    ]);
    expect(emitted).toBe(1);
  });

  it('is a no-op with no live transport runtimes', () => {
    expect(resyncTransportSessionStatesAfterLinkRestore([])).toBe(0);
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
