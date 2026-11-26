import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexSdkProvider } from '../../src/agent/providers/codex-sdk.js';

/**
 * Unit tests for the store-driven settle BACKSTOP
 * (settleCompletedTurnFromRolloutBackstop). This path exists because the 2s
 * primary rollout settle poll + its fs.watch are per-turn and torn down with the
 * turn, and the 12-minute active-turn watchdog only fires while the runtime
 * reports an ACTIVE turn — so a turn that genuinely completed (task_complete in
 * the rollout) but whose completion notification was lost, whose watch was
 * disarmed, or whose runningTurnId desynced stays "working" forever. The
 * backstop re-derives terminality from the rollout's LAST lifecycle marker,
 * independent of any per-turn timer or in-memory turn identity.
 *
 * These tests seed a minimal session state and spy on completeTurn so they
 * exercise the backstop's own decision logic (terminality read + grace gate +
 * "provider still running this turn" guard) without the full app-server harness
 * or the live fs.watch (which would race the assertion).
 */

const COMPLETE_TS = '2026-07-13T00:04:07.036Z';
const COMPLETE_MS = Date.parse(COMPLETE_TS);
const GRACE_MS = 90_000;
const GENERATION_4 = { scope: 'session' as const, sessionName: 'deck_sub_backstop', generation: 4 };
const GENERATION_5 = { scope: 'session' as const, sessionName: 'deck_sub_backstop', generation: 5 };

let codexHome: string;
let rolloutPath: string;

function makeState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    threadId: 'thread-x',
    rawChecklistRolloutPath: rolloutPath,
    runningTurnId: 'turn-1',
    cancelled: false,
    runningCompact: false,
    turnStartInFlight: false,
    currentText: '',
    currentMessageId: undefined,
    imcodesSessionName: 'deck_sub_backstop',
    activeToolItemIds: new Set(),
    activeCompactionItemIds: new Set(),
    openProviderToolCalls: new Map(),
    ...over,
  };
}

async function writeRollout(lines: unknown[]): Promise<void> {
  await writeFile(rolloutPath, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
}

const TASK_STARTED = (turnId: string, ts = '2026-07-13T00:00:00.000Z') => ({
  timestamp: ts,
  type: 'event_msg',
  payload: { type: 'task_started', turn_id: turnId },
});
const TASK_COMPLETE = (turnId: string, message = 'Done', ts = COMPLETE_TS) => ({
  timestamp: ts,
  type: 'event_msg',
  payload: { type: 'task_complete', turn_id: turnId, last_agent_message: message, duration_ms: 1017409 },
});

function seededProvider(state: Record<string, unknown>): { provider: CodexSdkProvider; complete: ReturnType<typeof vi.fn> } {
  const provider = new CodexSdkProvider();
  (provider as any).sessions.set('sess-1', state);
  const complete = vi.fn().mockResolvedValue(undefined);
  (provider as any).completeTurn = complete;
  (provider as any).isClosedCodexTurn = () => false;
  return { provider, complete };
}

beforeEach(async () => {
  codexHome = await mkdtemp(join(tmpdir(), 'imcodes-codex-backstop-'));
  rolloutPath = join(codexHome, 'rollout-backstop.jsonl');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(codexHome, { recursive: true, force: true });
});

describe('codex settle backstop — rollout terminality', () => {
  it('settles the zombie turn once the completion has been durable past the grace window', async () => {
    await writeRollout([TASK_STARTED('turn-1'), TASK_COMPLETE('turn-1', 'Done')]);
    const state = makeState();
    const { provider, complete } = seededProvider(state);

    const settled = await provider.settleCompletedTurnFromRolloutBackstop('sess-1', { nowMs: COMPLETE_MS + GRACE_MS + 5_000 });

    expect(settled).toBe(true);
    expect(complete).toHaveBeenCalledWith('sess-1', state, 'turn-1', 'rollout_task_complete');
    // The rollout's final agent message is adopted as the settled text.
    expect(state.currentText).toBe('Done');
  });

  it('does NOT settle while the completion is younger than the grace window (never races the 2s primary path)', async () => {
    await writeRollout([TASK_STARTED('turn-1'), TASK_COMPLETE('turn-1')]);
    const { provider, complete } = seededProvider(makeState());

    const settled = await provider.settleCompletedTurnFromRolloutBackstop('sess-1', { nowMs: COMPLETE_MS + 1_000 });

    expect(settled).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('does NOT settle when the rollout tail ends on a newer task_started (a new turn is running)', async () => {
    // turn-1 completed, then turn-2 started and is still in flight → not terminal.
    await writeRollout([
      TASK_STARTED('turn-1'),
      TASK_COMPLETE('turn-1', 'Done'),
      TASK_STARTED('turn-2', '2026-07-13T00:10:00.000Z'),
    ]);
    const { provider, complete } = seededProvider(makeState({ runningTurnId: 'turn-2' }));

    const settled = await provider.settleCompletedTurnFromRolloutBackstop('sess-1', { nowMs: COMPLETE_MS + 3_600_000 });

    expect(settled).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('does NOT settle when the provider is running a DIFFERENT turn than the completed one', async () => {
    // The rollout tail is terminal for turn-1, but the provider believes turn-2
    // is in flight — re-firing completeTurn would kill live work.
    await writeRollout([TASK_STARTED('turn-1'), TASK_COMPLETE('turn-1', 'Done')]);
    const { provider, complete } = seededProvider(makeState({ runningTurnId: 'turn-2' }));

    const settled = await provider.settleCompletedTurnFromRolloutBackstop('sess-1', { nowMs: COMPLETE_MS + 3_600_000 });

    expect(settled).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('does NOT settle orphaned tool evidence without matching runtime ownership proof', async () => {
    await writeRollout([TASK_STARTED('turn-1'), TASK_COMPLETE('turn-1', 'Done')]);
    const state = makeState({
      runningTurnId: undefined,
      activeTurnLease: undefined,
      activeToolItemIds: new Set(['orphaned-tool-item']),
      openProviderToolCalls: new Map(),
      runtimeActivityGeneration: GENERATION_4,
    });
    const { provider, complete } = seededProvider(state);

    const settled = await provider.settleCompletedTurnFromRolloutBackstop('sess-1', { nowMs: COMPLETE_MS + 3_600_000 });

    expect(settled).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('settles the observed false-working shape: terminal rollout plus orphaned tool on the same started runtime generation', async () => {
    await writeRollout([TASK_STARTED('turn-1'), TASK_COMPLETE('turn-1', 'Done')]);
    const state = makeState({
      runningTurnId: undefined,
      activeTurnLease: undefined,
      activeToolItemIds: new Set(['orphaned-tool-item']),
      openProviderToolCalls: new Map(),
      runtimeActivityGeneration: GENERATION_4,
    });
    const { provider, complete } = seededProvider(state);

    const settled = await provider.settleCompletedTurnFromRolloutBackstop('sess-1', {
      nowMs: COMPLETE_MS + 2_001,
      minCompleteAgeMs: 2_000,
      runtimeActivityGeneration: GENERATION_4,
      runtimeHasActiveDispatchOwnership: true,
      runtimeActiveDispatchProviderStarted: true,
    });

    expect(settled).toBe(true);
    expect(complete).toHaveBeenCalledWith('sess-1', state, 'turn-1', 'rollout_task_complete');
    expect(state.currentText).toBe('Done');
  });

  it('protects a fresh dispatch when orphaned tool evidence belongs to the previous generation', async () => {
    await writeRollout([TASK_STARTED('turn-1'), TASK_COMPLETE('turn-1', 'Old')]);
    const state = makeState({
      runningTurnId: undefined,
      activeTurnLease: undefined,
      activeToolItemIds: new Set(['old-tool-item']),
      openProviderToolCalls: new Map(),
      runtimeActivityGeneration: GENERATION_4,
    });
    const { provider, complete } = seededProvider(state);

    const settled = await provider.settleCompletedTurnFromRolloutBackstop('sess-1', {
      nowMs: COMPLETE_MS + 3_600_000,
      runtimeActivityGeneration: GENERATION_5,
      runtimeHasActiveDispatchOwnership: true,
      runtimeActiveDispatchProviderStarted: true,
    });

    expect(settled).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('protects the pre-provider bootstrap window even if a restarted runtime generation number collides', async () => {
    await writeRollout([TASK_STARTED('turn-1'), TASK_COMPLETE('turn-1', 'Old')]);
    const state = makeState({
      runningTurnId: undefined,
      activeTurnLease: undefined,
      activeToolItemIds: new Set(['old-tool-item']),
      openProviderToolCalls: new Map(),
      runtimeActivityGeneration: GENERATION_4,
    });
    const { provider, complete } = seededProvider(state);

    const settled = await provider.settleCompletedTurnFromRolloutBackstop('sess-1', {
      nowMs: COMPLETE_MS + 3_600_000,
      runtimeActivityGeneration: GENERATION_4,
      runtimeHasActiveDispatchOwnership: true,
      runtimeActiveDispatchProviderStarted: false,
    });

    expect(settled).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('does NOT settle an old terminal rollout during a healthy pre-start window with no tool evidence', async () => {
    await writeRollout([TASK_STARTED('turn-1'), TASK_COMPLETE('turn-1', 'Old')]);
    const state = makeState({
      runningTurnId: undefined,
      activeTurnLease: undefined,
      turnStartInFlight: false,
      activeToolItemIds: new Set(),
      openProviderToolCalls: new Map(),
    });
    const { provider, complete } = seededProvider(state);

    const settled = await provider.settleCompletedTurnFromRolloutBackstop('sess-1', { nowMs: COMPLETE_MS + 3_600_000 });

    expect(settled).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('settles a terminal rollout when runtime proves its in-progress state has no dispatch owner', async () => {
    await writeRollout([TASK_STARTED('turn-1'), TASK_COMPLETE('turn-1', 'Done')]);
    const state = makeState({
      runningTurnId: undefined,
      activeTurnLease: undefined,
      turnStartInFlight: false,
      activeToolItemIds: new Set(),
      openProviderToolCalls: new Map(),
    });
    const { provider, complete } = seededProvider(state);

    const settled = await provider.settleCompletedTurnFromRolloutBackstop('sess-1', {
      nowMs: COMPLETE_MS + 3_600_000,
      runtimeHasNoDispatchOwnership: true,
    });

    expect(settled).toBe(true);
    expect(complete).toHaveBeenCalledWith('sess-1', state, 'turn-1', 'rollout_task_complete');
  });

  it('protects a different tracked turn even if runtime reports no dispatch ownership', async () => {
    await writeRollout([TASK_STARTED('turn-1'), TASK_COMPLETE('turn-1', 'Old')]);
    const state = makeState({ runningTurnId: 'turn-2' });
    const { provider, complete } = seededProvider(state);

    const settled = await provider.settleCompletedTurnFromRolloutBackstop('sess-1', {
      nowMs: COMPLETE_MS + 3_600_000,
      runtimeHasNoDispatchOwnership: true,
    });

    expect(settled).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('does NOT settle a cancelled or compacting session', async () => {
    await writeRollout([TASK_STARTED('turn-1'), TASK_COMPLETE('turn-1')]);
    const aged = { nowMs: COMPLETE_MS + 3_600_000 };

    const cancelled = seededProvider(makeState({ cancelled: true }));
    expect(await cancelled.provider.settleCompletedTurnFromRolloutBackstop('sess-1', aged)).toBe(false);
    expect(cancelled.complete).not.toHaveBeenCalled();

    const compacting = seededProvider(makeState({ runningCompact: true }));
    expect(await compacting.provider.settleCompletedTurnFromRolloutBackstop('sess-1', aged)).toBe(false);
    expect(compacting.complete).not.toHaveBeenCalled();
  });

  it('settles when the provider has no runningTurnId but the start RPC is still in flight (terminal-during-start)', async () => {
    await writeRollout([TASK_STARTED('turn-1'), TASK_COMPLETE('turn-1', 'Done')]);
    const state = makeState({
      runningTurnId: undefined,
      turnStartInFlight: true,
      activeTurnLease: { turnStartInFlightAtMs: COMPLETE_MS - 1_000 },
    });
    const { provider, complete } = seededProvider(state);

    const settled = await provider.settleCompletedTurnFromRolloutBackstop('sess-1', { nowMs: COMPLETE_MS + 3_600_000 });

    expect(settled).toBe(true);
    expect(complete).toHaveBeenCalledWith('sess-1', state, 'turn-1', 'rollout_task_complete');
  });

  it('does NOT settle a prior terminal rollout while a newer start RPC is in flight', async () => {
    await writeRollout([TASK_STARTED('turn-old'), TASK_COMPLETE('turn-old', 'Old')]);
    const state = makeState({
      runningTurnId: undefined,
      turnStartInFlight: true,
      activeTurnLease: { turnStartInFlightAtMs: COMPLETE_MS + 60_000 },
    });
    const { provider, complete } = seededProvider(state);

    const settled = await provider.settleCompletedTurnFromRolloutBackstop('sess-1', { nowMs: COMPLETE_MS + 3_600_000 });

    expect(settled).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('returns false for an unknown session', async () => {
    await writeRollout([TASK_COMPLETE('turn-1')]);
    const { provider, complete } = seededProvider(makeState());
    expect(await provider.settleCompletedTurnFromRolloutBackstop('nope', { nowMs: COMPLETE_MS + 3_600_000 })).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('returns false when the rollout tail has no terminal task_complete marker', async () => {
    await writeRollout([TASK_STARTED('turn-1')]);
    const { provider, complete } = seededProvider(makeState());
    expect(await provider.settleCompletedTurnFromRolloutBackstop('sess-1', { nowMs: COMPLETE_MS + 3_600_000 })).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('codex real-time authority check — turnId-agnostic desync settle', () => {
  it('settles a completed turn even when in-memory runningTurnId desynced from the rollout turn_id', async () => {
    // task_complete on disk is for "turn-real", but the runtime still tracks the
    // stale "turn-stale" id (turn/start result carried the wrong / no id). The
    // turnId-scoped match would never fire; the last-marker read + start-time
    // guard settles it anyway.
    await writeRollout([TASK_STARTED('turn-real'), TASK_COMPLETE('turn-real', 'Done')]);
    const state = makeState({
      runningTurnId: 'turn-stale',
      rolloutAuthorityTurnId: 'turn-stale',
      activeTurnLease: { startedAtMs: COMPLETE_MS - 60_000 },
    });
    const { provider, complete } = seededProvider(state);

    await (provider as any).runRolloutAuthorityCheck('sess-1');

    expect(complete).toHaveBeenCalledWith('sess-1', state, 'turn-real', 'rollout_task_complete');
    expect(state.currentText).toBe('Done');
  });

  it('does NOT settle on a desync when the terminal task_complete predates this turn start (stale prior-turn record)', async () => {
    // The tail's terminal record is a PRIOR turn's completion, written BEFORE the
    // current turn started (its own task_started not yet flushed). The start-time
    // guard must reject it so a fresh turn is not falsely settled.
    await writeRollout([TASK_STARTED('turn-old'), TASK_COMPLETE('turn-old', 'Old')]);
    const state = makeState({
      runningTurnId: 'turn-new',
      rolloutAuthorityTurnId: 'turn-new',
      activeTurnLease: { startedAtMs: COMPLETE_MS + 60_000 },
    });
    const { provider, complete } = seededProvider(state);

    await (provider as any).runRolloutAuthorityCheck('sess-1');

    expect(complete).not.toHaveBeenCalled();
  });

  it('settles without a start-time guard when the tracked turn id matches the terminal record (normal path)', async () => {
    await writeRollout([TASK_STARTED('turn-1'), TASK_COMPLETE('turn-1', 'Done')]);
    const state = makeState({ runningTurnId: 'turn-1', rolloutAuthorityTurnId: 'turn-1', activeTurnLease: undefined });
    const { provider, complete } = seededProvider(state);

    await (provider as any).runRolloutAuthorityCheck('sess-1');

    expect(complete).toHaveBeenCalledWith('sess-1', state, 'turn-1', 'rollout_task_complete');
  });

  it('does NOT settle while the tail ends on task_started (turn genuinely running)', async () => {
    await writeRollout([TASK_COMPLETE('turn-0', 'Prev'), TASK_STARTED('turn-1', '2026-07-13T00:10:00.000Z')]);
    const state = makeState({
      runningTurnId: 'turn-1',
      rolloutAuthorityTurnId: 'turn-1',
      activeTurnLease: { startedAtMs: COMPLETE_MS + 1_000 },
    });
    const { provider, complete } = seededProvider(state);

    await (provider as any).runRolloutAuthorityCheck('sess-1');

    expect(complete).not.toHaveBeenCalled();
  });
});
