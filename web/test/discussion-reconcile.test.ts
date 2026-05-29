import { describe, it, expect } from 'vitest';
import {
  matchDiscussionIndex,
  reconcileDiscussionEntry,
  reconcileClassicList,
  isBarActiveDiscussion,
  isTerminalDiscussionUiState,
} from '../src/discussion-reconcile.js';

type Entry = {
  id: string;
  requestId?: string;
  pending?: boolean;
  state?: string;
  topic?: string;
  maxRounds?: number;
  currentRound?: number;
  currentSpeaker?: string | null;
  startedAt?: number;
  displayReasonKey?: string;
  rawError?: string;
};

const mk = (e: Partial<Entry> & { id: string }): Entry => ({ ...e });

describe('matchDiscussionIndex', () => {
  it('matches by requestId before id', () => {
    const list: Entry[] = [
      mk({ id: 'pending_r1', requestId: 'r1', pending: true }),
      mk({ id: 'real-2' }),
    ];
    expect(matchDiscussionIndex(list, { requestId: 'r1', discussionId: 'real-2' })).toBe(0);
  });
  it('falls back to discussionId/id', () => {
    const list: Entry[] = [mk({ id: 'real-2' })];
    expect(matchDiscussionIndex(list, { discussionId: 'real-2' })).toBe(0);
    expect(matchDiscussionIndex(list, { id: 'real-2' })).toBe(0);
  });
  it('returns -1 when nothing matches', () => {
    expect(matchDiscussionIndex([mk({ id: 'a' })], { requestId: 'x', discussionId: 'y' })).toBe(-1);
  });
});

describe('reconcileDiscussionEntry', () => {
  it('swaps pending id for the real discussionId and clears pending (C3)', () => {
    const pending = mk({ id: 'pending_r1', requestId: 'r1', pending: true, state: 'setup', topic: 'T' });
    const merged = reconcileDiscussionEntry(pending, { id: 'real-1', state: 'setup', maxRounds: 3 });
    expect(merged.id).toBe('real-1');
    expect(merged.pending).toBe(false);
    expect(merged.requestId).toBe('r1'); // local-only preserved
    expect(merged.topic).toBe('T');
    expect(merged.maxRounds).toBe(3);
  });

  it('does not overwrite an existing field with undefined (C11)', () => {
    const existing = mk({ id: 'd', state: 'setup', maxRounds: 5, currentRound: 2 });
    const merged = reconcileDiscussionEntry(existing, { state: 'running', maxRounds: undefined, currentRound: undefined });
    expect(merged.state).toBe('running');
    expect(merged.maxRounds).toBe(5); // preserved (undefined skipped)
    expect(merged.currentRound).toBe(2);
  });

  it('keeps terminal state monotonic (no regression)', () => {
    const done = mk({ id: 'd', state: 'done' });
    const merged = reconcileDiscussionEntry(done, { state: 'running' });
    expect(merged.state).toBe('done');
  });

  it('preserves local-only fields when a list item lacks them', () => {
    const existing = mk({ id: 'd', requestId: 'r', startedAt: 123, displayReasonKey: 'k', rawError: 'boom' });
    const merged = reconcileDiscussionEntry(existing, { state: 'running' });
    expect(merged.requestId).toBe('r');
    expect(merged.startedAt).toBe(123);
    expect(merged.displayReasonKey).toBe('k');
    expect(merged.rawError).toBe('boom');
  });
});

describe('reconcileClassicList', () => {
  const make = (item: Record<string, unknown> & { id: string }): Entry => ({
    id: item.id,
    requestId: item.requestId as string | undefined,
    topic: (item.topic as string) ?? '',
    state: (item.state as string) ?? 'setup',
  });

  it('preserves an unresolved pending entry absent from the live list (C1)', () => {
    const prev: Entry[] = [mk({ id: 'pending_r1', requestId: 'r1', pending: true, state: 'setup' })];
    const next = reconcileClassicList(prev, [], make);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('pending_r1');
    expect(next[0].pending).toBe(true);
  });

  it('reconciles a pending entry when the list item carries the same requestId (E1, started missed)', () => {
    const prev: Entry[] = [mk({ id: 'pending_r1', requestId: 'r1', pending: true, state: 'setup', startedAt: 9 })];
    const next = reconcileClassicList(prev, [{ id: 'real-1', requestId: 'r1', state: 'running', topic: 'T' }], make);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('real-1');
    expect(next[0].pending).toBe(false);
    expect(next[0].requestId).toBe('r1');
    expect(next[0].startedAt).toBe(9); // local-only preserved (merge, not replace) (C2)
  });

  it('drops a resolved active classic entry absent from the live set', () => {
    const prev: Entry[] = [mk({ id: 'real-1', state: 'running' })];
    const next = reconcileClassicList(prev, [], make);
    expect(next).toHaveLength(0);
  });

  it('keeps terminal history and p2p_ entries, appends new live items', () => {
    const prev: Entry[] = [
      mk({ id: 'real-done', state: 'done' }),
      mk({ id: 'p2p_x', state: 'running' }),
    ];
    const next = reconcileClassicList(prev, [{ id: 'real-new', state: 'running', topic: 'N' }], make);
    const ids = next.map((d) => d.id).sort();
    expect(ids).toEqual(['p2p_x', 'real-done', 'real-new']);
  });

  it('matches the right pending among several concurrent ones (U3)', () => {
    const prev: Entry[] = [
      mk({ id: 'pending_r1', requestId: 'r1', pending: true, state: 'setup' }),
      mk({ id: 'pending_r2', requestId: 'r2', pending: true, state: 'setup' }),
    ];
    const next = reconcileClassicList(prev, [{ id: 'real-2', requestId: 'r2', state: 'running' }], make);
    const byReq = Object.fromEntries(next.map((d) => [d.requestId, d]));
    expect(byReq['r1'].id).toBe('pending_r1');   // untouched
    expect(byReq['r1'].pending).toBe(true);
    expect(byReq['r2'].id).toBe('real-2');        // reconciled
    expect(byReq['r2'].pending).toBe(false);
  });
});

describe('terminal / active helpers', () => {
  it('treats done and failed as terminal/inactive', () => {
    expect(isTerminalDiscussionUiState('done')).toBe(true);
    expect(isTerminalDiscussionUiState('failed')).toBe(true);
    expect(isTerminalDiscussionUiState('running')).toBe(false);
    expect(isBarActiveDiscussion({ state: 'failed' })).toBe(false);
    expect(isBarActiveDiscussion({ state: 'setup' })).toBe(true);
    expect(isBarActiveDiscussion({ state: 'running' })).toBe(true);
  });
});
