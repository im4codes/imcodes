import { describe, it, expect, vi } from 'vitest';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';

/**
 * Shared-layer guard for `ProviderActiveWorkSnapshot.backgroundWorkCount`.
 *
 * The runtime gates every send on hasActiveTurnWork() === blockingWorkCount > 0,
 * so a provider reporting a still-running Claude subagent as active work made the
 * runtime queue every new message behind it — the "cannot send while a subagent
 * runs" bug. Turn work is now `activeWorkCount - backgroundWorkCount`.
 *
 * The second test is the one that matters for Codex: a provider that does NOT
 * report backgroundWorkCount (Codex, Qwen, Kimi …) must keep blocking exactly as
 * before, so its just-stabilised idle detection cannot move.
 */
function runtimeWithSnapshot(snapshot: Record<string, unknown> | null) {
  const provider = {
    id: 'test-provider',
    connectionMode: 'local-sdk',
    sessionOwnership: 'shared',
    capabilities: { streaming: true, toolCalling: true },
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    onDelta: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
    getActiveWorkSnapshot: () => snapshot,
  } as any;
  const rt = new TransportSessionRuntime(provider, 'deck_bg');
  (rt as any)._providerSessionId = 'sess-1';
  return rt;
}

const baseSnapshot = {
  status: 'current',
  activeToolCount: 0,
  busyReasons: ['background_monitor'],
  updatedAt: Date.now(),
};

describe('transport runtime — background work does not gate dispatch', () => {
  it('treats work reported as background as NOT turn work (runtime dispatches instead of queueing)', () => {
    // Claude subagent-only window: 1 unit of work, all of it background.
    const rt = runtimeWithSnapshot({ ...baseSnapshot, activeWorkCount: 1, backgroundWorkCount: 1 });

    const snapshot = (rt as any).getActivitySnapshot();

    expect(snapshot.blockingWorkCount).toBe(0); // hasActiveTurnWork() === false → send dispatches
    // The subagent is still surfaced so the UI can show it running.
    expect(snapshot.busyReasons).toContain('background_monitor');
  });

  it('keeps blocking for providers that do not report backgroundWorkCount (Codex/Qwen/Kimi unchanged)', () => {
    // Exactly the shape every other provider emits today — no backgroundWorkCount.
    const rt = runtimeWithSnapshot({ ...baseSnapshot, activeWorkCount: 1 });

    expect((rt as any).getActivitySnapshot().blockingWorkCount).toBeGreaterThan(0);
  });

  it('still blocks on the turn-work remainder when only part of the work is background', () => {
    // e.g. a live tool call (turn work) alongside a backgrounded subagent.
    const rt = runtimeWithSnapshot({ ...baseSnapshot, activeWorkCount: 3, backgroundWorkCount: 1 });

    expect((rt as any).getActivitySnapshot().blockingWorkCount).toBeGreaterThan(0);
  });
});
