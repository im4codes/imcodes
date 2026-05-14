import { describe, expect, it } from 'vitest';
import { isP2pDiscussionVisibleInSubSessionBar } from '../src/p2p-discussion-scope.js';

describe('isP2pDiscussionVisibleInSubSessionBar', () => {
  it('shows runs that only name a visible sub-session participant', () => {
    expect(isP2pDiscussionVisibleInSubSessionBar(
      {
        state: 'running',
        participantSessions: ['deck_sub_worker_1'],
      },
      {
        activeSession: 'deck_proj_brain',
        activeRootSession: 'deck_proj_brain',
        visibleSubSessionNames: ['deck_sub_worker_1'],
      },
    )).toBe(true);
  });

  it('matches initiator sessions directly', () => {
    expect(isP2pDiscussionVisibleInSubSessionBar(
      {
        state: 'running',
        initiatorSession: 'deck_sub_worker_1',
      },
      {
        activeSession: 'deck_proj_brain',
        activeRootSession: 'deck_proj_brain',
        visibleSubSessionNames: ['deck_sub_worker_1'],
      },
    )).toBe(true);
  });

  it('hides scoped runs from unrelated session views', () => {
    expect(isP2pDiscussionVisibleInSubSessionBar(
      {
        state: 'running',
        mainSession: 'deck_other_brain',
        participantSessions: ['deck_sub_other_1'],
      },
      {
        activeSession: 'deck_proj_brain',
        activeRootSession: 'deck_proj_brain',
        visibleSubSessionNames: ['deck_sub_worker_1'],
      },
    )).toBe(false);
  });

  it('keeps legacy unscoped active entries visible', () => {
    expect(isP2pDiscussionVisibleInSubSessionBar(
      { state: 'running' },
      {
        activeSession: 'deck_proj_brain',
        activeRootSession: 'deck_proj_brain',
        visibleSubSessionNames: [],
      },
    )).toBe(true);
  });

  it('hides completed runs', () => {
    expect(isP2pDiscussionVisibleInSubSessionBar(
      {
        state: 'done',
        mainSession: 'deck_proj_brain',
      },
      {
        activeSession: 'deck_proj_brain',
        activeRootSession: 'deck_proj_brain',
        visibleSubSessionNames: [],
      },
    )).toBe(false);
  });
});
