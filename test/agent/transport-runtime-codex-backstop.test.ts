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

  it('delegates to the codex backstop with the bound session id + opts, returning its result', async () => {
    const settle = vi.fn().mockResolvedValue(true);
    const rt = new TransportSessionRuntime(fakeProvider({ settleCompletedTurnFromRolloutBackstop: settle }), 'deck_x');
    (rt as any)._providerSessionId = 'sess-1';

    const out = await rt.reconcileCompletedCodexTurnFromRollout({ nowMs: 123 });

    expect(out).toBe(true);
    expect(settle).toHaveBeenCalledWith('sess-1', { nowMs: 123 });
  });
});
