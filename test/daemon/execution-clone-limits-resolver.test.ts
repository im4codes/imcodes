import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DEFAULT_MAX_PARALLEL_CLONES,
  DEFAULT_MAX_QUEUED_CLONES,
  DEFAULT_CLONE_HARD_TIMEOUT_MS,
  DEFAULT_CLONE_RETENTION_MS,
  MAX_MAX_PARALLEL_CLONES,
  defaultDedicatedExecutionRoutingPreference,
  type DedicatedExecutionRoutingGlobalPreference,
} from '../../shared/execution-clone.js';

// ── Mocks ───────────────────────────────────────────────────────────────────
//
// The resolver imports the two run registries (P2P + auto-deliver). We mock both
// getters so we can drive registry-PRESENCE (a run with tighter limits) and
// registry-ABSENCE (no run) without spinning up real orchestrators. The fakes
// are hoisted so the vi.mock factories (also hoisted) can close over them
// without init-order errors.

const mocks = vi.hoisted(() => ({
  getP2pRun: vi.fn<(id: string) => { dedicatedExecutionRouting?: { limits?: unknown } } | undefined>(
    () => undefined,
  ),
  getOpenSpecAutoDeliverRun: vi.fn<(id: string) => { dedicatedExecutionRouting?: { limits?: unknown } } | undefined>(
    () => undefined,
  ),
}));

vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({
  getP2pRun: mocks.getP2pRun,
}));

vi.mock('../../src/daemon/openspec-auto-deliver-orchestrator.js', () => ({
  getOpenSpecAutoDeliverRun: mocks.getOpenSpecAutoDeliverRun,
}));

import { resolveExecutionCloneLimitsForParentRun } from '../../src/daemon/execution-clone-limits-resolver.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A run-authoritative limits record tighter than the defaults on every field. */
function tightLimits(
  overrides: Partial<DedicatedExecutionRoutingGlobalPreference> = {},
): DedicatedExecutionRoutingGlobalPreference {
  return {
    enabled: true,
    maxParallelClones: 1,
    maxQueuedClones: 2,
    cloneHardTimeoutMs: 30 * 60 * 1000, // 30 min — tighter than the 60 min default
    cloneRetentionMs: 60 * 1000, // 1 min — tighter than the 5 min default
    ...overrides,
  };
}

function runWithLimits(limits: DedicatedExecutionRoutingGlobalPreference) {
  return { dedicatedExecutionRouting: { limits } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getP2pRun.mockReturnValue(undefined);
  mocks.getOpenSpecAutoDeliverRun.mockReturnValue(undefined);
});

describe('resolveExecutionCloneLimitsForParentRun', () => {
  it('returns the canonical defaults when no run matches the parentRunId (registry-absence is NOT terminal)', () => {
    const result = resolveExecutionCloneLimitsForParentRun('run-unknown');

    expect(result).toEqual(defaultDedicatedExecutionRoutingPreference());
    expect(result.maxParallelClones).toBe(DEFAULT_MAX_PARALLEL_CLONES);
    expect(result.maxQueuedClones).toBe(DEFAULT_MAX_QUEUED_CLONES);
    expect(result.cloneHardTimeoutMs).toBe(DEFAULT_CLONE_HARD_TIMEOUT_MS);
    expect(result.cloneRetentionMs).toBe(DEFAULT_CLONE_RETENTION_MS);
  });

  it('tightens maxParallelClones to a configured run cap of 1 when a P2P run matches', () => {
    mocks.getP2pRun.mockReturnValue(runWithLimits(tightLimits({ maxParallelClones: 1 })));

    const result = resolveExecutionCloneLimitsForParentRun('run-p2p');

    expect(result.maxParallelClones).toBe(1);
    expect(mocks.getP2pRun).toHaveBeenCalledWith('run-p2p');
  });

  it('honors ALL FOUR bounded fields run-authoritatively (cap, queue, hard timeout, retention)', () => {
    // base defaults: parallel 3, queue 64, hardTimeout 60min, retention 5min.
    // run is tighter on every field — each is run-authoritative (here that means
    // tighter than the default), so the run value is used verbatim.
    mocks.getP2pRun.mockReturnValue(runWithLimits(tightLimits()));

    const result = resolveExecutionCloneLimitsForParentRun('run-p2p');

    expect(result.maxParallelClones).toBe(1);
    expect(result.maxQueuedClones).toBe(2);
    expect(result.cloneHardTimeoutMs).toBe(30 * 60 * 1000); // run 30min
    expect(result.cloneRetentionMs).toBe(60 * 1000); // run 1min
  });

  it('T-B: a run LOOSER than the default is honored run-authoritatively, NOT clamped to the default', () => {
    // The B-flip: a run config above the v1 default (but within the parser
    // bounds) is the per-parentRunId authority and must survive. `min(default,
    // run)` would have wrongly clamped these back down to the defaults.
    mocks.getP2pRun.mockReturnValue(
      runWithLimits({
        enabled: true,
        maxParallelClones: 5, // > default 3, <= MAX 16
        maxQueuedClones: 256, // > default 64, <= MAX 1024
        cloneHardTimeoutMs: 90 * 60 * 1000, // > default 60min, <= MAX 6h
        cloneRetentionMs: 30 * 60 * 1000, // > default 5min, <= MAX 1h
      }),
    );

    const result = resolveExecutionCloneLimitsForParentRun('run-loose');

    expect(result.maxParallelClones).toBe(5);
    expect(result.maxQueuedClones).toBe(256);
    expect(result.cloneHardTimeoutMs).toBe(90 * 60 * 1000);
    expect(result.cloneRetentionMs).toBe(30 * 60 * 1000);
  });

  it('mixes per-field run-authoritatively: tighter AND looser run values both survive', () => {
    mocks.getP2pRun.mockReturnValue(
      runWithLimits({
        enabled: true,
        maxParallelClones: 2, // tighter than 3 → 2 (run-authoritative)
        maxQueuedClones: 256, // looser than 64 → 256 (run-authoritative, within bounds)
        cloneHardTimeoutMs: 15 * 60 * 1000, // tighter than 60min → 15min
        cloneRetentionMs: 30 * 60 * 1000, // looser than 5min → 30min (within bounds)
      }),
    );

    const result = resolveExecutionCloneLimitsForParentRun('run-mixed');

    expect(result.maxParallelClones).toBe(2);
    expect(result.maxQueuedClones).toBe(256);
    expect(result.cloneHardTimeoutMs).toBe(15 * 60 * 1000);
    expect(result.cloneRetentionMs).toBe(30 * 60 * 1000);
  });

  it('T-A-bounds: a finite OUT-OF-BOUNDS run cap (99999) is CLAMPED to MAX (16), not passed through', () => {
    // Proves the parser (clampInt) is the correct primitive over a
    // `Number.isFinite`-only guard, which would pass 99999 through untouched.
    mocks.getP2pRun.mockReturnValue(
      runWithLimits({
        ...tightLimits(),
        maxParallelClones: 99999,
      }),
    );

    const result = resolveExecutionCloneLimitsForParentRun('run-overbounds');

    expect(result.maxParallelClones).toBe(MAX_MAX_PARALLEL_CLONES);
    expect(result.maxParallelClones).toBe(16);
  });

  it('T-A-mcp: a partial run.limits MISSING maxParallelClones resolves to the default cap, never NaN', () => {
    // The N2 NaN cap-bypass: a present-but-partial `limits` object must NOT yield
    // `NaN` (which would make `count >= NaN` always false → unbounded clones).
    // The parser falls the missing field back to the default.
    mocks.getP2pRun.mockReturnValue(
      runWithLimits({ enabled: true, maxQueuedClones: 8 } as unknown as DedicatedExecutionRoutingGlobalPreference),
    );

    const result = resolveExecutionCloneLimitsForParentRun('run-partial');

    expect(Number.isFinite(result.maxParallelClones)).toBe(true);
    expect(result.maxParallelClones).toBe(DEFAULT_MAX_PARALLEL_CLONES);
    // The present field is still honored (run-authoritative, within bounds).
    expect(result.maxQueuedClones).toBe(8);
    // Other missing fields fall back to their defaults — no NaN anywhere.
    expect(result.cloneHardTimeoutMs).toBe(DEFAULT_CLONE_HARD_TIMEOUT_MS);
    expect(result.cloneRetentionMs).toBe(DEFAULT_CLONE_RETENTION_MS);
  });

  it('falls back to the OpenSpec auto-deliver run when no P2P run matches', () => {
    mocks.getP2pRun.mockReturnValue(undefined);
    mocks.getOpenSpecAutoDeliverRun.mockReturnValue(
      runWithLimits(tightLimits({ maxParallelClones: 1 })),
    );

    const result = resolveExecutionCloneLimitsForParentRun('run-auto');

    expect(result.maxParallelClones).toBe(1);
    expect(mocks.getP2pRun).toHaveBeenCalledWith('run-auto');
    expect(mocks.getOpenSpecAutoDeliverRun).toHaveBeenCalledWith('run-auto');
  });

  it('prefers the P2P run over the auto-deliver run when both match', () => {
    mocks.getP2pRun.mockReturnValue(runWithLimits(tightLimits({ maxParallelClones: 1 })));
    mocks.getOpenSpecAutoDeliverRun.mockReturnValue(
      runWithLimits(tightLimits({ maxParallelClones: 5 })),
    );

    const result = resolveExecutionCloneLimitsForParentRun('run-both');

    // P2P (cap 1) wins; auto-deliver (cap 5) is not consulted for the value.
    expect(result.maxParallelClones).toBe(1);
  });

  it('returns the base default when a matching run carries no limits (v1 auto-deliver no-op shape)', () => {
    // The auto-deliver run shape does not declare `limits` in v1; a run object
    // with no limits must resolve to the base, not throw.
    mocks.getP2pRun.mockReturnValue({ dedicatedExecutionRouting: { enabled: true } } as never);

    const result = resolveExecutionCloneLimitsForParentRun('run-nolimits');

    expect(result).toEqual(defaultDedicatedExecutionRoutingPreference());
  });
});
