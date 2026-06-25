import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EXECUTION_CLONE_KIND,
  EXECUTION_CLONE_ERROR_CODES,
  defaultDedicatedExecutionRoutingPreference,
  parseDedicatedExecutionRoutingPreference,
  type DedicatedExecutionRoutingGlobalPreference,
} from '../../shared/execution-clone.js';
import type { SessionRecord } from '../../src/store/session-store.js';

// ── Mocks ───────────────────────────────────────────────────────────────────
//
// This is the N2 cap-integrity end-to-end-ish test. It drives the REAL
// `createExecutionClone` against an in-memory store (so the per-parent-run cap
// check / first upsert / count run for real) while:
//   - mocking subsession-manager + timeline + logger (no tmux / no live emitter),
//   - mocking the two run registries the limits-resolver reads from, so the
//     resolver returns a run-tightened `maxParallelClones = 1` for a specific
//     parentRunId.
// The `pref` passed to createExecutionClone is the RESOLVER OUTPUT — exactly the
// value the MCP send-tool path now threads through (memory-mcp-server injection
// → dispatchExecutionCloneSend → createExecutionClone). All fakes are hoisted so
// the vi.mock factories can close over them without init-order errors.

const mocks = vi.hoisted(() => {
  const sessions = new Map<string, SessionRecord>();
  return {
    sessions,
    getSession: vi.fn((name: string) => sessions.get(name)),
    listSessions: vi.fn(() => Array.from(sessions.values())),
    upsertSession: vi.fn((record: SessionRecord) => {
      sessions.set(record.name, { ...record, updatedAt: Date.now() });
    }),
    removeSession: vi.fn((name: string) => {
      sessions.delete(name);
    }),
    startSubSession: vi.fn(async (_sub: { id: string; fresh?: boolean }) => {}),
    stopSubSession: vi.fn(async (_target: string) => ({ ok: true, closed: [], failed: [] })),
    emit: vi.fn((..._args: unknown[]) => {}),
    getP2pRun: vi.fn<(id: string) => { dedicatedExecutionRouting?: { limits?: unknown } } | undefined>(
      () => undefined,
    ),
    getOpenSpecAutoDeliverRun: vi.fn<(id: string) => { dedicatedExecutionRouting?: { limits?: unknown } } | undefined>(
      () => undefined,
    ),
  };
});

vi.mock('../../src/store/session-store.js', () => ({
  getSession: mocks.getSession,
  listSessions: mocks.listSessions,
  upsertSession: mocks.upsertSession,
  removeSession: mocks.removeSession,
}));

vi.mock('../../src/daemon/subsession-manager.js', () => ({
  subSessionName: (id: string) => `deck_sub_${id}`,
  startSubSession: mocks.startSubSession,
  stopSubSession: mocks.stopSubSession,
  // execution-clone.ts imports normalizeShellBinForHost from this module.
  normalizeShellBinForHost: (bin: string | null | undefined) => bin ?? null,
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: mocks.emit, on: vi.fn(() => () => {}) },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({
  getP2pRun: mocks.getP2pRun,
}));

vi.mock('../../src/daemon/openspec-auto-deliver-orchestrator.js', () => ({
  getOpenSpecAutoDeliverRun: mocks.getOpenSpecAutoDeliverRun,
}));

import { createExecutionClone, type ExecutionCloneRequest } from '../../src/daemon/execution-clone.js';
import { resolveExecutionCloneLimitsForParentRun } from '../../src/daemon/execution-clone-limits-resolver.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function baseRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: 'deck_proj_w1',
    projectName: 'proj',
    role: 'w1',
    agentType: 'claude-code',
    projectDir: '/work/proj',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/** Seed the owner/owning-main (`deck_proj_brain`) + a valid template. */
function seedOwnerAndTemplate(): void {
  mocks.sessions.set('deck_proj_brain', baseRecord({
    name: 'deck_proj_brain',
    role: 'brain',
    state: 'running',
  }));
  mocks.sessions.set('deck_proj_w2', baseRecord({ name: 'deck_proj_w2', role: 'w2' }));
}

function req(parentRunId: string, pref: DedicatedExecutionRoutingGlobalPreference): ExecutionCloneRequest {
  return {
    templateSessionName: 'deck_proj_w2',
    parentRunId,
    parentStage: 'generic_execution',
    ownerSessionName: 'deck_proj_brain',
    owningMainSessionName: 'deck_proj_brain',
    pref,
  };
}

/** A run-authoritative limits record with a tight per-run cap of 1. */
function runWithCap1(): { dedicatedExecutionRouting: { limits: DedicatedExecutionRoutingGlobalPreference } } {
  return {
    dedicatedExecutionRouting: {
      limits: { ...defaultDedicatedExecutionRoutingPreference(), enabled: true, maxParallelClones: 1 },
    },
  };
}

/**
 * A run-authoritative limits record with a LOOSER-than-default cap of 5 (default
 * is 3, MAX is 16). Drives the B/F fix: the configured cap must be honored
 * run-authoritatively, identically on the MCP-resolved and programmatic paths.
 */
function runWithCap5(): { dedicatedExecutionRouting: { limits: DedicatedExecutionRoutingGlobalPreference } } {
  return {
    dedicatedExecutionRouting: {
      limits: { ...defaultDedicatedExecutionRoutingPreference(), enabled: true, maxParallelClones: 5 },
    },
  };
}

beforeEach(() => {
  mocks.sessions.clear();
  vi.clearAllMocks();
  mocks.getP2pRun.mockReturnValue(undefined);
  mocks.getOpenSpecAutoDeliverRun.mockReturnValue(undefined);
});

describe('execution-clone cap integrity (N2 — MCP cannot bypass a tighter per-run cap)', () => {
  it('rejects a 2nd clone for the same parentRunId when the resolver yields maxParallelClones=1 and one is already active', async () => {
    seedOwnerAndTemplate();
    // The run registry reports a tighter cap of 1 for this parentRunId, so the
    // resolver (the value the MCP path threads to createExecutionClone) is cap=1.
    mocks.getP2pRun.mockImplementation((id) => (id === 'run-tight' ? runWithCap1() : undefined));

    const pref = resolveExecutionCloneLimitsForParentRun('run-tight');
    expect(pref.maxParallelClones).toBe(1);

    // 1st create succeeds and leaves an ACTIVE clone record for run-tight.
    const first = await createExecutionClone(req('run-tight', pref));
    expect(first.sessionName).toMatch(/^deck_sub_[0-9a-f]{12}$/);
    expect(mocks.sessions.get(first.sessionName)?.executionCloneMetadata?.kind).toBe(EXECUTION_CLONE_KIND);
    expect(mocks.startSubSession).toHaveBeenCalledTimes(1);

    // 2nd create for the SAME parentRunId is rejected by the cap (count 1 >= 1).
    await expect(createExecutionClone(req('run-tight', pref))).rejects.toMatchObject({
      code: EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL,
    });
    // The rejected create never launched a second worker.
    expect(mocks.startSubSession).toHaveBeenCalledTimes(1);
  });

  it('N3 contract: two DIFFERENT parentRunIds each reach their cap independently — both succeed', async () => {
    seedOwnerAndTemplate();
    // BOTH parent runs carry a tighter cap of 1 (per-parent-run is the spec
    // semantics: distinct runs each get their own slot budget, not a bug).
    mocks.getP2pRun.mockImplementation((id) =>
      id === 'run-A' || id === 'run-B' ? runWithCap1() : undefined,
    );

    const prefA = resolveExecutionCloneLimitsForParentRun('run-A');
    const prefB = resolveExecutionCloneLimitsForParentRun('run-B');
    expect(prefA.maxParallelClones).toBe(1);
    expect(prefB.maxParallelClones).toBe(1);

    // run-A reaches its cap of 1.
    const a1 = await createExecutionClone(req('run-A', prefA));
    expect(a1.sessionName).toMatch(/^deck_sub_/);

    // run-B independently reaches its OWN cap of 1 — must NOT be blocked by run-A.
    const b1 = await createExecutionClone(req('run-B', prefB));
    expect(b1.sessionName).toMatch(/^deck_sub_/);
    expect(b1.sessionName).not.toBe(a1.sessionName);

    expect(mocks.startSubSession).toHaveBeenCalledTimes(2);

    // Sanity: a 2nd clone on EITHER run is still capped at 1.
    await expect(createExecutionClone(req('run-A', prefA))).rejects.toMatchObject({
      code: EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL,
    });
    await expect(createExecutionClone(req('run-B', prefB))).rejects.toMatchObject({
      code: EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL,
    });
  });

  it('a run with no tighter limit (registry-absence) uses the default cap of 3 — absence is not terminal', async () => {
    seedOwnerAndTemplate();
    // No run matches → resolver returns defaults (cap 3). Three clones for the
    // same parentRunId all succeed; the 4th is capped.
    const pref = resolveExecutionCloneLimitsForParentRun('run-default');
    expect(pref.maxParallelClones).toBe(3);

    for (let i = 0; i < 3; i++) {
      const r = await createExecutionClone(req('run-default', pref));
      expect(r.sessionName).toMatch(/^deck_sub_/);
    }
    expect(mocks.startSubSession).toHaveBeenCalledTimes(3);

    await expect(createExecutionClone(req('run-default', pref))).rejects.toMatchObject({
      code: EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL,
    });
  });

  // ── T-F: cross-path agreement on a LOOSER-than-default shared parentRunId ──

  it('T-F: a run configured looser than default (cap 5) is honored cap=5 on BOTH the MCP-resolved and programmatic paths for the SAME parentRunId', async () => {
    seedOwnerAndTemplate();
    // The run registry reports a LOOSER cap of 5 (> default 3) for this run.
    mocks.getP2pRun.mockImplementation((id) => (id === 'run-loose' ? runWithCap5() : undefined));

    // MCP-resolved path: the resolver yields the run-authoritative 5 — NOT
    // clamped to the hardcoded default 3 (the B/F fix). The programmatic path
    // passes run.limits directly; both yield 5.
    const mcpPref = resolveExecutionCloneLimitsForParentRun('run-loose');
    expect(mcpPref.maxParallelClones).toBe(5);
    const programmaticPref = parseDedicatedExecutionRoutingPreference(runWithCap5().dedicatedExecutionRouting.limits);
    expect(programmaticPref.maxParallelClones).toBe(5);

    // Interleave the two paths against the SAME parentRunId (shared counter): 3
    // via MCP, then 2 via programmatic — all 5 must be admitted, none clamped at
    // 3 (which is exactly the old asymmetry/clamp bug).
    for (let i = 0; i < 3; i++) {
      const r = await createExecutionClone(req('run-loose', mcpPref));
      expect(r.sessionName).toMatch(/^deck_sub_/);
    }
    for (let i = 0; i < 2; i++) {
      const r = await createExecutionClone(req('run-loose', programmaticPref));
      expect(r.sessionName).toMatch(/^deck_sub_/);
    }
    expect(mocks.startSubSession).toHaveBeenCalledTimes(5);

    // The 6th create on EITHER path is rejected — cap 5 binds both paths equally.
    await expect(createExecutionClone(req('run-loose', mcpPref))).rejects.toMatchObject({
      code: EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL,
    });
    await expect(createExecutionClone(req('run-loose', programmaticPref))).rejects.toMatchObject({
      code: EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL,
    });
    expect(mocks.startSubSession).toHaveBeenCalledTimes(5);
  });
});
