/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  readHashState,
  readTabRouteState,
  resolveInitialRouteState,
  resolveInitialSessionName,
  writeHashState,
} from '../src/hooks/useHashState.js';

describe('tab-local hash state', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/');
    localStorage.clear();
    sessionStorage.clear();
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

  it('does not combine an explicit hashed server with another tab\'s fallback session', () => {
    localStorage.setItem('rcc_server', 'srv-other');
    localStorage.setItem('rcc_session', 'deck_other_brain');
    history.replaceState(null, '', '/#/srv-current');

    expect(resolveInitialRouteState()).toEqual({
      serverId: 'srv-current',
      sessionName: null,
      sharedEntryId: null,
    });
    expect(resolveInitialSessionName()).toBeNull();
  });

  it('restores this tab\'s coherent route before the cross-tab localStorage fallback', () => {
    writeHashState('srv-current', 'deck_current_brain', null);
    expect(readTabRouteState()).toEqual({
      serverId: 'srv-current',
      sessionName: 'deck_current_brain',
      sharedEntryId: null,
    });

    // Model a refresh path that reaches the SPA without its hash while another
    // browser tab has most recently changed the shared fallback keys.
    history.replaceState(null, '', '/');
    localStorage.setItem('rcc_server', 'srv-other');
    localStorage.setItem('rcc_session', 'deck_other_brain');

    expect(resolveInitialRouteState()).toEqual({
      serverId: 'srv-current',
      sessionName: 'deck_current_brain',
      sharedEntryId: null,
    });
  });

  it('fails closed for malformed or over-bounded tab snapshots', () => {
    sessionStorage.setItem('rcc_tab_route_v1', '{not-json');
    expect(readTabRouteState()).toEqual({ serverId: null, sessionName: null, sharedEntryId: null });

    sessionStorage.setItem('rcc_tab_route_v1', JSON.stringify({
      version: 2,
      serverId: 'srv-current',
      sessionName: 'deck_current_brain',
      sharedEntryId: null,
    }));
    expect(readTabRouteState()).toEqual({ serverId: null, sessionName: null, sharedEntryId: null });

    sessionStorage.setItem('rcc_tab_route_v1', JSON.stringify({
      version: 1,
      serverId: 's'.repeat(513),
      sessionName: 'deck_current_brain',
      sharedEntryId: null,
    }));
    expect(readTabRouteState()).toEqual({ serverId: null, sessionName: null, sharedEntryId: null });
  });

  it('clears the tab snapshot when navigation returns home', () => {
    writeHashState('srv-current', 'deck_current_brain', null);
    expect(readTabRouteState().serverId).toBe('srv-current');

    writeHashState(null, null, null);

    expect(readTabRouteState()).toEqual({ serverId: null, sessionName: null, sharedEntryId: null });
    expect(sessionStorage.getItem('rcc_tab_route_v1')).toBeNull();
  });
});
