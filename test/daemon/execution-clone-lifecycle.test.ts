import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EXECUTION_CLONE_KIND,
  EXECUTION_CLONE_TIMELINE,
  DEFAULT_CLONE_RETENTION_MS,
  type ExecutionCloneMetadata,
} from '../../shared/execution-clone.js';
import type { SessionRecord } from '../../src/store/session-store.js';

// ── Why this file exists (audit repair, TEST-ONLY) ────────────────────────────
//
// Two paths that the multi-agent implementation audit could not cite a
// deterministic producing test for are locked here — NO behavior change:
//
//   #1  The PANE-DEATH retention path: a NON-transport execution clone whose
//       tmux pane dies (but whose tmux session still exists) is marked
//       `state:'stopped' / cleanupState:'collecting'` with a retention deadline
//       of `completedAt + resolveExecutionCloneRetentionMs(meta)` — NEVER
//       respawned. This is `completeExecutionCloneOnPaneDeath` reached THROUGH
//       the real `checkSessionHealth` clone branch (lifecycle.ts), distinct from
//       the runtime-exit retention cases already covered in
//       execution-clone.test.ts:1074-1176 (`completeExecutionCloneOnRuntimeExit`).
//
//   #2/C  The decisive non-terminal proof for a CREATOR SUB-SESSION: a creator
//       sub-session whose pane dies is RESPAWNED (recovers, never goes terminal),
//       and while that creator stays alive/running its execution clones are NOT
//       swept. A recoverable creator's clones survive — the exact case the audit
//       (CC1) could not point at a producing path for.
//
// The store is a mutable in-memory map so getSession/listSessions/upsertSession/
// removeSession behave like the real store. tmux + session-manager + subsession-
// manager + timeline-emitter + logger are mocked so the REAL lifecycle control
// flow (checkSessionHealth, completeExecutionCloneOnPaneDeath, runExecutionClone-
// Sweep → real sweepExecutionClones → real destroyExecutionClone) runs without
// touching a terminal backend. execution-clone.js is deliberately NOT mocked.

const mocks = vi.hoisted(() => {
  const sessions = new Map<string, SessionRecord>();
  return {
    sessions,
    getSession: vi.fn((name: string) => sessions.get(name)),
    listSessions: vi.fn(() => Array.from(sessions.values())),
    upsertSession: vi.fn((record: SessionRecord) => {
      sessions.set(record.name, { ...record });
    }),
    removeSession: vi.fn((name: string) => {
      sessions.delete(name);
    }),
    // tmux pane/session liveness — driven per test.
    sessionExists: vi.fn(async (_name: string) => true),
    isPaneAlive: vi.fn(async (_name: string) => true),
    // session-manager respawn/restart — spied so we can assert recovery vs terminal.
    respawnSession: vi.fn(async (_s: SessionRecord) => {}),
    restartSession: vi.fn(async (_s: SessionRecord) => {}),
    // subsession-manager stop — the real destroyExecutionClone calls this; a spy
    // here is the clean "was the clone actually torn down?" signal for #2/C.
    stopSubSession: vi.fn(async (_target: string) => ({ ok: true, closed: [], failed: [] })),
    emit: vi.fn((..._args: unknown[]) => {}),
  };
});

vi.mock('../../src/store/session-store.js', () => ({
  getSession: mocks.getSession,
  listSessions: mocks.listSessions,
  upsertSession: mocks.upsertSession,
  removeSession: mocks.removeSession,
}));

// Fully mocked: lifecycle.ts imports sessionExists/isPaneAlive/BACKEND/killSession/
// sendKeys from here. BACKEND is normally computed by a tmux-detecting side effect
// at module load — stub it so the test stays hermetic.
vi.mock('../../src/agent/tmux.js', () => ({
  sessionExists: mocks.sessionExists,
  isPaneAlive: mocks.isPaneAlive,
  BACKEND: 'tmux',
  killSession: vi.fn(async (_name: string) => {}),
  sendKeys: vi.fn(async (_name: string, _keys: string) => {}),
}));

// Partial mock: preserve every real session-manager export (lifecycle.ts imports
// ~15 of them; only restartSession/respawnSession are exercised by the tested
// paths) and override just the two we assert on.
vi.mock('../../src/agent/session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/agent/session-manager.js')>(
    '../../src/agent/session-manager.js',
  );
  return {
    ...actual,
    respawnSession: mocks.respawnSession,
    restartSession: mocks.restartSession,
  };
});

// subsession-manager: stub the side-effecting launch/stop entry points + the name
// helper. The REAL destroyExecutionClone (execution-clone.js, unmocked) calls
// stopSubSession, so this spy is what proves a clone was / was not destroyed.
vi.mock('../../src/daemon/subsession-manager.js', () => ({
  subSessionName: (id: string) => `deck_sub_${id}`,
  startSubSession: vi.fn(async (_sub: { id: string; fresh?: boolean }) => {}),
  stopSubSession: mocks.stopSubSession,
  normalizeShellBinForHost: (shellBin?: string | null) => shellBin ?? undefined,
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: mocks.emit, on: vi.fn(() => () => {}), getBufferedEvents: vi.fn(() => []) },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { checkSessionHealth, runExecutionCloneSweep } from '../../src/daemon/lifecycle.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function baseRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: 'deck_sub_clone',
    projectName: 'proj',
    role: 'clone',
    agentType: 'claude-code',
    projectDir: '/work/proj',
    state: 'running',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  } as SessionRecord;
}

function cloneMeta(overrides: Partial<ExecutionCloneMetadata> = {}): ExecutionCloneMetadata {
  return {
    kind: EXECUTION_CLONE_KIND,
    ephemeral: true,
    cloneOfSessionName: 'deck_proj_w2',
    parentRunId: 'run-1',
    parentStage: 'generic_execution',
    createdBySessionName: 'deck_proj_brain',
    createdAt: 1000,
    hardTimeoutAt: 9_000_000_000_000, // far future — never the trigger here
    retentionExpiresAt: null,
    cleanupState: 'active',
    autoDestroy: true,
    ...overrides,
  };
}

/** Latest upsert recorded for `name`, regardless of interleaving with others. */
function lastUpsertFor(name: string): SessionRecord | undefined {
  for (let i = mocks.upsertSession.mock.calls.length - 1; i >= 0; i--) {
    const rec = mocks.upsertSession.mock.calls[i]?.[0] as SessionRecord | undefined;
    if (rec?.name === name) return rec;
  }
  return undefined;
}

/** Did ANY upsert for `name` set state:'stopped'? (used to prove a creator never went terminal) */
function anyUpsertSetStopped(name: string): boolean {
  return mocks.upsertSession.mock.calls.some((c) => {
    const rec = c[0] as SessionRecord | undefined;
    return rec?.name === name && rec.state === 'stopped';
  });
}

beforeEach(() => {
  mocks.sessions.clear();
  mocks.getSession.mockClear();
  mocks.listSessions.mockClear();
  mocks.upsertSession.mockClear();
  mocks.removeSession.mockClear();
  mocks.respawnSession.mockClear();
  mocks.restartSession.mockClear();
  mocks.stopSubSession.mockClear();
  mocks.emit.mockClear();
  mocks.sessionExists.mockReset().mockResolvedValue(true);
  mocks.isPaneAlive.mockReset().mockResolvedValue(true);
});

// ── #1: pane-death retention path (through the real checkSessionHealth clone branch) ──

describe('checkSessionHealth — execution-clone pane-death retention', () => {
  it('T-pane-retention-custom: a non-transport clone whose pane dies is marked collecting with completedAt + custom cloneRetentionMs, NOT respawned', async () => {
    const clone = baseRecord({
      name: 'deck_sub_clone',
      agentType: 'shell', // NON-transport: has a tmux pane
      state: 'running',
      executionCloneMetadata: cloneMeta({ cleanupState: 'active', cloneRetentionMs: 60_000 }),
    });
    mocks.sessions.set(clone.name, clone);

    // tmux session alive, pane DEAD → pane-death completion (not the tmux-gone branch).
    mocks.sessionExists.mockResolvedValue(true);
    mocks.isPaneAlive.mockResolvedValue(false);

    await checkSessionHealth(clone);

    const upserted = lastUpsertFor('deck_sub_clone');
    expect(upserted).toBeDefined();
    expect(upserted!.state).toBe('stopped');
    const meta = upserted!.executionCloneMetadata!;
    expect(meta.cleanupState).toBe('collecting');
    expect(typeof meta.completedAt).toBe('number');
    expect(meta.retentionExpiresAt).toBe((meta.completedAt ?? 0) + 60_000);
    // Decisive: a clone is NEVER respawned on pane death.
    expect(mocks.respawnSession).not.toHaveBeenCalled();
    expect(mocks.restartSession).not.toHaveBeenCalled();
    // The pane-death terminal event fires with reason 'pane_death' (lifecycle.ts).
    expect(mocks.emit).toHaveBeenCalledWith(
      'deck_sub_clone',
      EXECUTION_CLONE_TIMELINE.TERMINAL,
      expect.objectContaining({ sessionName: 'deck_sub_clone', parentRunId: 'run-1', reason: 'pane_death' }),
    );
  });

  it('T-pane-retention-default: missing cloneRetentionMs (old/rolling record) falls back to DEFAULT_CLONE_RETENTION_MS', async () => {
    const clone = baseRecord({
      name: 'deck_sub_clone',
      agentType: 'claude-code', // NON-transport
      state: 'running',
      executionCloneMetadata: cloneMeta({ cleanupState: 'active' }), // NO cloneRetentionMs
    });
    mocks.sessions.set(clone.name, clone);

    mocks.sessionExists.mockResolvedValue(true);
    mocks.isPaneAlive.mockResolvedValue(false);

    await checkSessionHealth(clone);

    const upserted = lastUpsertFor('deck_sub_clone');
    expect(upserted).toBeDefined();
    expect(upserted!.state).toBe('stopped');
    const meta = upserted!.executionCloneMetadata!;
    expect(meta.cleanupState).toBe('collecting');
    expect(typeof meta.completedAt).toBe('number');
    expect(meta.retentionExpiresAt).toBe((meta.completedAt ?? 0) + DEFAULT_CLONE_RETENTION_MS);
    expect(mocks.respawnSession).not.toHaveBeenCalled();
    expect(mocks.restartSession).not.toHaveBeenCalled();
  });
});

// ── #2/C: a recoverable CREATOR sub-session's clones survive ──────────────────

describe('checkSessionHealth + runExecutionCloneSweep — recoverable creator sub-session keeps its clones', () => {
  it('T-C-sub-pane-respawn: a creator sub-session whose pane dies is respawned (never terminal), and the sweep does NOT destroy its clone while it stays running', async () => {
    // Creator is a SUB-session (deck_sub_*), not a main session — the case the
    // audit (CC1) could not cite a producing path for.
    const worker = baseRecord({
      name: 'deck_sub_worker',
      agentType: 'claude-code',
      role: 'worker',
      state: 'running',
      // NOT an execution clone itself — a plain creator sub-session.
    });
    const orphanCandidate = baseRecord({
      name: 'deck_sub_orphan',
      agentType: 'claude-code',
      role: 'orphan',
      state: 'running',
      executionCloneMetadata: cloneMeta({
        cleanupState: 'active',
        createdBySessionName: 'deck_sub_worker', // creator = the worker above
        hardTimeoutAt: 9_000_000_000_000, // far future → hard-timeout never the trigger
        retentionExpiresAt: null, // running clone → retention not the trigger
      }),
    });
    mocks.sessions.set(worker.name, worker);
    mocks.sessions.set(orphanCandidate.name, orphanCandidate);

    // Worker's tmux session alive, pane DEAD → sub-session respawn branch.
    mocks.sessionExists.mockResolvedValue(true);
    mocks.isPaneAlive.mockResolvedValue(false);

    await checkSessionHealth(worker);

    // Creator RECOVERS: respawned, and NEVER written terminal (state:'stopped').
    expect(mocks.respawnSession).toHaveBeenCalledTimes(1);
    expect(mocks.respawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'deck_sub_worker' }),
    );
    expect(anyUpsertSetStopped('deck_sub_worker')).toBe(false);

    // The worker remains alive + running for the sweep (it was never marked stopped).
    expect(mocks.getSession('deck_sub_worker')?.state).toBe('running');

    // Now sweep with the creator still alive/running: the creator-liveness
    // predicate must NOT treat it as terminal, so the clone survives.
    mocks.stopSubSession.mockClear();
    mocks.upsertSession.mockClear();
    await runExecutionCloneSweep(2_000_000); // far below hardTimeoutAt; clone running

    // The clone was NOT destroyed: no teardown stop, and its cleanupState stays 'active'.
    expect(mocks.stopSubSession).not.toHaveBeenCalled();
    const orphanAfter = mocks.getSession('deck_sub_orphan');
    expect(orphanAfter).toBeDefined();
    expect(orphanAfter!.executionCloneMetadata?.cleanupState).toBe('active');
    // No upsert flipped the clone into the destroying state machine.
    const destroyingWrite = mocks.upsertSession.mock.calls.some((c) => {
      const rec = c[0] as SessionRecord | undefined;
      return rec?.name === 'deck_sub_orphan' && rec.executionCloneMetadata?.cleanupState === 'destroying';
    });
    expect(destroyingWrite).toBe(false);
  });
});
