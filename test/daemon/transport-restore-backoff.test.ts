import { beforeEach, describe, expect, it } from 'vitest';
import {
  TRANSPORT_RESTORE_BACKOFF_STEPS_MS,
  clearTransportRestoreBackoff,
  clearTransportRestoreBackoffForProvider,
  isTransportRestoreBackedOff,
  noteTransportRestoreUnbound,
  pruneTransportRestoreBackoff,
  resetTransportRestoreBackoffForTests,
  transportRestoreBackoffSize,
  transportRestoreFingerprint,
} from '../../src/agent/transport-restore-backoff.js';
import { classifyQueueSweepCandidate } from '../../src/daemon/transport-queue-store.js';

const REASON = 'provider_cannot_list_sessions' as const;

beforeEach(() => resetTransportRestoreBackoffForTests());

describe('transport restore backoff state', () => {
  it('walks 5s -> 60s -> 300s and holds at the 300s cap', () => {
    expect(TRANSPORT_RESTORE_BACKOFF_STEPS_MS).toEqual([5_000, 60_000, 300_000]);
    let now = 1_000_000;
    const windows: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const note = noteTransportRestoreUnbound('s', 'cursor-headless', 'fp', REASON, now);
      expect(note.logNow).toBe(true);
      expect(note.attempts).toBe(attempt + 1);
      windows.push(note.retryInMs);
      now += note.retryInMs;
    }
    expect(windows).toEqual([5_000, 60_000, 300_000, 300_000, 300_000, 300_000]);
  });

  it('is backed off only inside the window, for the same fingerprint', () => {
    noteTransportRestoreUnbound('s', 'p', 'fp', REASON, 10_000);
    expect(isTransportRestoreBackedOff('s', 'fp', 10_001)).toBe(true);
    expect(isTransportRestoreBackedOff('s', 'fp', 14_999)).toBe(true);
    expect(isTransportRestoreBackedOff('s', 'fp', 15_000)).toBe(false);
    expect(isTransportRestoreBackedOff('other', 'fp', 10_001)).toBe(false);
  });

  it('a note made inside the open window (a bypassing send) neither advances the schedule nor asks for another warn', () => {
    noteTransportRestoreUnbound('s', 'p', 'fp', REASON, 0);
    const inside = noteTransportRestoreUnbound('s', 'p', 'fp', REASON, 2_000);
    expect(inside).toEqual({ logNow: false, attempts: 1, retryInMs: 3_000 });
    expect(isTransportRestoreBackedOff('s', 'fp', 4_999)).toBe(true);
    // The schedule is still where it was: the next real attempt is step 2.
    const next = noteTransportRestoreUnbound('s', 'p', 'fp', REASON, 5_000);
    expect(next).toEqual({ logNow: true, attempts: 2, retryInMs: 60_000 });
  });

  it('a changed fingerprint (provider id bound, relaunch, dir/config edit) invalidates the entry and restarts at step 1', () => {
    noteTransportRestoreUnbound('s', 'p', 'fp1', REASON, 0);
    noteTransportRestoreUnbound('s', 'p', 'fp1', REASON, 5_000); // step 2
    expect(isTransportRestoreBackedOff('s', 'fp2', 5_001)).toBe(false);
    expect(transportRestoreBackoffSize()).toBe(0);
    const fresh = noteTransportRestoreUnbound('s', 'p', 'fp2', REASON, 5_002);
    expect(fresh.attempts).toBe(1);
  });

  it('fingerprint covers every field a permanent outcome depends on', () => {
    const base = {
      sessionInstanceId: 'i1', runtimeEpoch: 'e1', providerId: 'cursor-headless', agentType: 'cursor-headless',
      providerSessionId: 'ps', providerResumeId: undefined, projectDir: '/tmp/work', transportConfig: undefined,
    } as Parameters<typeof transportRestoreFingerprint>[0];
    const fp = transportRestoreFingerprint(base);
    expect(transportRestoreFingerprint({ ...base })).toBe(fp);
    for (const change of [
      { sessionInstanceId: 'i2' }, { runtimeEpoch: 'e2' }, { providerId: 'other' }, { providerSessionId: 'ps2' },
      { providerResumeId: 'resume-1' }, { projectDir: '/tmp/elsewhere' }, { transportConfig: { a: 1 } },
    ]) {
      expect(transportRestoreFingerprint({ ...base, ...change } as typeof base), JSON.stringify(change)).not.toBe(fp);
    }
  });

  it('clear(session) and clear(provider) drop entries; prune drops sessions that no longer exist', () => {
    noteTransportRestoreUnbound('a', 'cursor-headless', 'fp', REASON, 0);
    noteTransportRestoreUnbound('b', 'cursor-headless', 'fp', REASON, 0);
    noteTransportRestoreUnbound('c', 'copilot-sdk', 'fp', REASON, 0);
    clearTransportRestoreBackoff('a');
    expect(isTransportRestoreBackedOff('a', 'fp', 1)).toBe(false);
    clearTransportRestoreBackoffForProvider('cursor-headless');
    expect(isTransportRestoreBackedOff('b', 'fp', 1)).toBe(false);
    expect(isTransportRestoreBackedOff('c', 'fp', 1)).toBe(true);
    pruneTransportRestoreBackoff((name) => name !== 'c'); // session c was deleted
    expect(transportRestoreBackoffSize()).toBe(0);
  });

  it('many sessions back off independently and pruning bounds the map', () => {
    for (let i = 0; i < 500; i += 1) noteTransportRestoreUnbound(`s${i}`, 'cursor-headless', 'fp', REASON, 0);
    expect(transportRestoreBackoffSize()).toBe(500);
    expect(isTransportRestoreBackedOff('s7', 'fp', 1_000)).toBe(true);
    clearTransportRestoreBackoff('s7');
    expect(isTransportRestoreBackedOff('s7', 'fp', 1_000)).toBe(false);
    expect(isTransportRestoreBackedOff('s8', 'fp', 1_000)).toBe(true);
    pruneTransportRestoreBackoff(() => false);
    expect(transportRestoreBackoffSize()).toBe(0);
  });
});

describe('durable queue sweep candidate classification', () => {
  it('keeps the original decisions and skips a restore when only terminal rows remain', () => {
    expect(classifyQueueSweepCandidate({ hasLiveRows: true, hasBoundRuntime: true, restorableSession: true })).toBe('rehydrate_bound_runtime');
    expect(classifyQueueSweepCandidate({ hasLiveRows: true, hasBoundRuntime: false, restorableSession: true })).toBe('restore_runtime');
    // Ownerless sessions are still counted toward quarantine, with or without live rows.
    expect(classifyQueueSweepCandidate({ hasLiveRows: true, hasBoundRuntime: false, restorableSession: false })).toBe('count_orphan_attempt');
    expect(classifyQueueSweepCandidate({ hasLiveRows: false, hasBoundRuntime: false, restorableSession: false })).toBe('count_orphan_attempt');
    // The bug: a restorable-looking session whose rows are all terminal was re-restored every 5 s.
    expect(classifyQueueSweepCandidate({ hasLiveRows: false, hasBoundRuntime: false, restorableSession: true })).toBe('skip_no_live_rows');
  });
});
