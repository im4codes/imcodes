import { beforeEach, describe, expect, it } from 'vitest';
import {
  filterRecentlyInjected,
  recordRecentInjection,
  clearRecentInjectionHistory,
  resetAllRecentInjectionHistories,
  getRecentInjectionHistory,
  RECENT_INJECTION_HISTORY_SIZE,
} from '../../src/context/recent-injection-history.js';

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
});
