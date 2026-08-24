/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readHashState, writeHashState } from '../src/hooks/useHashState.js';

describe('tab-local hash state', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/');
  });

  it('round-trips the exact shared entry across a page reload URL', () => {
    writeHashState('srv/shared', 'deck_beta_brain', 'share/exact?1');

    expect(window.location.hash).toBe('#/srv%2Fshared/deck_beta_brain?shared=share%2Fexact%3F1');
    expect(readHashState()).toEqual({
      serverId: 'srv/shared',
      sessionName: 'deck_beta_brain',
      sharedEntryId: 'share/exact?1',
    });
  });

  it('keeps legacy owned-session hashes compatible and rejects malformed paths', () => {
    history.replaceState(null, '', '/#/srv-1/deck_alpha_brain');
    expect(readHashState()).toEqual({
      serverId: 'srv-1',
      sessionName: 'deck_alpha_brain',
      sharedEntryId: null,
    });

    history.replaceState(null, '', '/#/%E0%A4%A');
    expect(readHashState()).toEqual({
      serverId: null,
      sessionName: null,
      sharedEntryId: null,
    });
  });
});
