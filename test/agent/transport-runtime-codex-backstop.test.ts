import { describe, it, expect, vi } from 'vitest';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';

/**
 * The runtime passthrough is intentionally thin + structurally feature-detected
 * (no codex-provider type import): it forwards to a codex provider's
 * settleCompletedTurnFromRolloutBackstop only when a provider session is bound
 * and the provider actually exposes the capability.
 */
function fakeProvider(over: Record<string, unknown> = {}): any {
  return {
    id: 'codex-sdk',
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    onDelta: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
    ...over,
  };
}

describe('TransportSessionRuntime.reconcileCompletedCodexTurnFromRollout', () => {
  it('returns false when no provider session is bound yet', async () => {
    const rt = new TransportSessionRuntime(fakeProvider({ settleCompletedTurnFromRolloutBackstop: vi.fn() }), 'deck_x');
    expect(await rt.reconcileCompletedCodexTurnFromRollout()).toBe(false);
  });

  it('returns false for a provider without the backstop capability (non-codex)', async () => {
    const rt = new TransportSessionRuntime(fakeProvider(), 'deck_x');
    (rt as any)._providerSessionId = 'sess-1';
    expect(await rt.reconcileCompletedCodexTurnFromRollout()).toBe(false);
  });

  it('delegates with runtime ownership evidence and returns the provider result', async () => {
    const settle = vi.fn().mockResolvedValue(true);
    const rt = new TransportSessionRuntime(fakeProvider({ settleCompletedTurnFromRolloutBackstop: settle }), 'deck_x');
    (rt as any)._providerSessionId = 'sess-1';

    const out = await rt.reconcileCompletedCodexTurnFromRollout({ nowMs: 123 });

    expect(out).toBe(true);
    expect(settle).toHaveBeenCalledWith('sess-1', {
      nowMs: 123,
      runtimeHasNoDispatchOwnership: false,
      runtimeActivityGeneration: { scope: 'session', sessionName: 'deck_x', generation: 0 },
      runtimeHasActiveDispatchOwnership: false,
      runtimeActiveDispatchProviderStarted: false,
    });
  });

  it('proves no runtime dispatch ownership only for an orphaned in-progress status', async () => {
    const settle = vi.fn().mockResolvedValue(true);
    const rt = new TransportSessionRuntime(fakeProvider({ settleCompletedTurnFromRolloutBackstop: settle }), 'deck_x');
    (rt as any)._providerSessionId = 'sess-1';
    (rt as any)._status = 'streaming';
    (rt as any)._sending = false;
    (rt as any)._activeDispatchEntries = [];
    (rt as any)._activeTurn = null;

    await rt.reconcileCompletedCodexTurnFromRollout({ nowMs: 456 });

    expect(settle).toHaveBeenCalledWith('sess-1', {
      nowMs: 456,
      runtimeHasNoDispatchOwnership: true,
      runtimeActivityGeneration: { scope: 'session', sessionName: 'deck_x', generation: 0 },
      runtimeHasActiveDispatchOwnership: false,
      runtimeActiveDispatchProviderStarted: false,
    });
  });

  it('does not claim an orphan while a fresh dispatch entry is in bootstrap', async () => {
    const settle = vi.fn().mockResolvedValue(true);
    const rt = new TransportSessionRuntime(fakeProvider({ settleCompletedTurnFromRolloutBackstop: settle }), 'deck_x');
    (rt as any)._providerSessionId = 'sess-1';
    (rt as any)._status = 'thinking';
    (rt as any)._sending = false;
    (rt as any)._activeDispatchEntries = [{ clientMessageId: 'fresh', text: 'new turn' }];

    await rt.reconcileCompletedCodexTurnFromRollout({ nowMs: 789 });

    expect(settle).toHaveBeenCalledWith('sess-1', {
      nowMs: 789,
      runtimeHasNoDispatchOwnership: false,
      runtimeActivityGeneration: { scope: 'session', sessionName: 'deck_x', generation: 0 },
      runtimeHasActiveDispatchOwnership: true,
      runtimeActiveDispatchProviderStarted: false,
    });
  });

  it('forwards same-generation ownership only after the dispatch crossed provider.send()', async () => {
    const settle = vi.fn().mockResolvedValue(true);
    const rt = new TransportSessionRuntime(fakeProvider({ settleCompletedTurnFromRolloutBackstop: settle }), 'deck_x');
    (rt as any)._providerSessionId = 'sess-1';
    (rt as any)._status = 'streaming';
    (rt as any)._activityGeneration = 4;
    (rt as any)._sending = true;
    (rt as any)._activeDispatchEntries = [{ clientMessageId: 'stuck', text: 'old turn' }];
    (rt as any)._activeDispatchProviderStarted = true;

    await rt.reconcileCompletedCodexTurnFromRollout({ minCompleteAgeMs: 2_000 });

    expect(settle).toHaveBeenCalledWith('sess-1', {
      minCompleteAgeMs: 2_000,
      runtimeHasNoDispatchOwnership: false,
      runtimeActivityGeneration: { scope: 'session', sessionName: 'deck_x', generation: 4 },
      runtimeHasActiveDispatchOwnership: true,
      runtimeActiveDispatchProviderStarted: true,
    });
  });

  it('keeps an independent 2s runtime poll alive while a Codex dispatch still looks active', async () => {
    vi.useFakeTimers();
    try {
      const settle = vi.fn().mockResolvedValue(false);
      const rt = new TransportSessionRuntime(fakeProvider({ settleCompletedTurnFromRolloutBackstop: settle }), 'deck_x');
      (rt as any)._providerSessionId = 'sess-1';
      (rt as any)._status = 'streaming';
      (rt as any)._activityGeneration = 4;
      (rt as any)._sending = true;
      (rt as any)._activeDispatchEntries = [{ clientMessageId: 'stuck', text: 'old turn' }];
      (rt as any)._activeDispatchProviderStarted = true;

      (rt as any).startCodexRolloutBackstop();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(settle).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledWith('sess-1', expect.objectContaining({
        minCompleteAgeMs: 2_000,
        runtimeActivityGeneration: { scope: 'session', sessionName: 'deck_x', generation: 4 },
        runtimeHasActiveDispatchOwnership: true,
        runtimeActiveDispatchProviderStarted: true,
      }));
      (rt as any).stopCodexRolloutBackstop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
