import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  filterRecentlyInjected,
  recordRecentInjection,
  clearRecentInjectionHistory,
  resetAllRecentInjectionHistories,
  getRecentInjectionHistory,
  RECENT_INJECTION_HISTORY_SIZE,
} from '../../src/context/recent-injection-history.js';
import { getSession, upsertSession, removeSession } from '../../src/store/session-store.js';

function seedSession(name: string, extra: Record<string, unknown> = {}): void {
  upsertSession({
    name,
    projectName: 'proj',
    role: 'brain',
    agentType: 'claude-code-sdk',
    runtimeType: 'transport',
    state: 'running',
    ...extra,
  } as any);
}

describe('recent-injection-history', () => {
  beforeEach(() => {
    resetAllRecentInjectionHistories();
  });

  it('passes all ids through when no history exists yet', () => {
    const out = filterRecentlyInjected('deck_a_brain', ['mem-1', 'mem-2']);
    expect(out).toEqual(['mem-1', 'mem-2']);
  });

  it('drops ids injected on a previous turn of the same session', () => {
    recordRecentInjection('deck_a_brain', ['mem-1', 'mem-2']);
    const out = filterRecentlyInjected('deck_a_brain', ['mem-1', 'mem-2', 'mem-3']);
    expect(out).toEqual(['mem-3']);
  });

  it('isolates history per sessionKey — other sessions see a clean history', () => {
    recordRecentInjection('deck_a_brain', ['mem-1']);
    const sameSession = filterRecentlyInjected('deck_a_brain', ['mem-1', 'mem-2']);
    const differentSession = filterRecentlyInjected('deck_b_brain', ['mem-1', 'mem-2']);
    expect(sameSession).toEqual(['mem-2']);
    expect(differentSession).toEqual(['mem-1', 'mem-2']);
  });

  it('retains up to RECENT_INJECTION_HISTORY_SIZE (10) events per session', () => {
    expect(RECENT_INJECTION_HISTORY_SIZE).toBe(10);
    for (let i = 0; i < 12; i++) {
      recordRecentInjection('deck_a_brain', [`mem-${i}`]);
    }
    const hist = getRecentInjectionHistory('deck_a_brain');
    // Ring buffer keeps the 10 most recent — events 2..11.
    expect(hist).toHaveLength(10);
    expect(hist[0]).toEqual(['mem-11']); // most recent first
    expect(hist[9]).toEqual(['mem-2']); // oldest retained
  });

  it('evicts the oldest event when the 11th is recorded', () => {
    for (let i = 0; i < 10; i++) recordRecentInjection('deck_a_brain', [`mem-${i}`]);
    // mem-0..mem-9 are all in the history
    expect(filterRecentlyInjected('deck_a_brain', ['mem-0'])).toEqual([]);
    expect(filterRecentlyInjected('deck_a_brain', ['mem-9'])).toEqual([]);

    recordRecentInjection('deck_a_brain', ['mem-new']);
    // mem-0 (oldest) is evicted; mem-new replaces its slot
    expect(filterRecentlyInjected('deck_a_brain', ['mem-0'])).toEqual(['mem-0']);
    expect(filterRecentlyInjected('deck_a_brain', ['mem-9'])).toEqual([]);
    expect(filterRecentlyInjected('deck_a_brain', ['mem-new'])).toEqual([]);
  });

  it('treats one injection event as one slot, regardless of how many ids it contains', () => {
    recordRecentInjection('deck_a_brain', ['a', 'b', 'c', 'd', 'e']); // 1 event, 5 ids
    recordRecentInjection('deck_a_brain', ['f']); // 1 event, 1 id
    const hist = getRecentInjectionHistory('deck_a_brain');
    expect(hist).toHaveLength(2);
    // All 6 ids are still dedup-protected
    expect(filterRecentlyInjected('deck_a_brain', ['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual([
      'g',
    ]);
  });

  it('does not record empty injection events', () => {
    recordRecentInjection('deck_a_brain', []);
    expect(getRecentInjectionHistory('deck_a_brain')).toEqual([]);
  });

  it('clearRecentInjectionHistory wipes history for the given session only', () => {
    recordRecentInjection('deck_a_brain', ['mem-1']);
    recordRecentInjection('deck_b_brain', ['mem-1']);
    clearRecentInjectionHistory('deck_a_brain');
    expect(filterRecentlyInjected('deck_a_brain', ['mem-1'])).toEqual(['mem-1']);
    expect(filterRecentlyInjected('deck_b_brain', ['mem-1'])).toEqual([]);
  });

  it('no-ops for falsy sessionKey (passes all ids through)', () => {
    recordRecentInjection(undefined, ['mem-1']);
    expect(filterRecentlyInjected(undefined, ['mem-1', 'mem-2'])).toEqual(['mem-1', 'mem-2']);
    expect(filterRecentlyInjected('', ['mem-1'])).toEqual(['mem-1']);
  });

  describe('persistence across daemon restart', () => {
    // Simulating "daemon restart" here = reset the in-memory Map (what the
    // real process start does) without touching the SessionRecord. The
    // rehydration then has to rebuild the dedup state from the stored field.
    const SESSION = 'deck_persist_brain';

    beforeEach(() => {
      // Drop any SessionRecord a previous test may have left behind so the
      // hydration path starts from whatever the test itself seeds.
      try { removeSession(SESSION); } catch { /* store may not have it */ }
    });

    it('persists recorded injection events onto the SessionRecord', () => {
      seedSession(SESSION);
      recordRecentInjection(SESSION, ['mem-a', 'mem-b']);
      const record = getSession(SESSION);
      expect(record?.recentInjectionHistory).toEqual([['mem-a', 'mem-b']]);
    });

    it('rehydrates history from SessionRecord after the in-memory Map is wiped', () => {
      seedSession(SESSION);
      recordRecentInjection(SESSION, ['mem-a']);
      recordRecentInjection(SESSION, ['mem-b']);

      // Simulate daemon restart — in-memory Map gone, SessionRecord survived.
      resetAllRecentInjectionHistories();

      // After restart, the dedup still knows about mem-a and mem-b.
      expect(filterRecentlyInjected(SESSION, ['mem-a', 'mem-b', 'mem-c'])).toEqual(['mem-c']);
    });

    it('clearRecentInjectionHistory wipes the persisted field too', () => {
      seedSession(SESSION);
      recordRecentInjection(SESSION, ['mem-a']);
      expect(getSession(SESSION)?.recentInjectionHistory).toEqual([['mem-a']]);

      clearRecentInjectionHistory(SESSION);
      expect(getSession(SESSION)?.recentInjectionHistory).toEqual([]);

      // After a "restart" the clear must not un-clear from the stale record.
      resetAllRecentInjectionHistories();
      expect(filterRecentlyInjected(SESSION, ['mem-a', 'mem-b'])).toEqual(['mem-a', 'mem-b']);
    });

    it('tolerates missing SessionRecord — history still works in memory only', () => {
      // No seedSession call — simulating a transient/anonymous recall
      // target. The in-memory ring buffer must still work for the
      // lifetime of this daemon, even if there's nothing to persist to.
      recordRecentInjection('deck_ephemeral_brain', ['mem-x']);
      expect(filterRecentlyInjected('deck_ephemeral_brain', ['mem-x', 'mem-y'])).toEqual(['mem-y']);
    });

    it('ignores malformed persisted history gracefully', () => {
      // A prior crash could leave garbage in the record — the hydrator
      // must treat it as empty, not throw.
      seedSession(SESSION, { recentInjectionHistory: [null, 123, [null, 'mem-z']] });
      // Drop any in-memory state so the hydrator runs.
      resetAllRecentInjectionHistories();
      // Only the well-formed 'mem-z' survives the hydrator's filter.
      expect(filterRecentlyInjected(SESSION, ['mem-z', 'mem-other'])).toEqual(['mem-other']);
    });
  });
});
