import { describe, expect, it } from 'vitest';

import {
  getDaemonBadgeState,
  getSelectedServerName,
  hasResolvedActiveSession,
  hasSelectedServer,
  isServerOnline,
  shouldResetSelectedServer,
  shouldShowInitialConnectingGate,
} from '../src/server-selection.js';

describe('getSelectedServerName', () => {
  it('uses the persisted fallback before the server list is loaded', () => {
    expect(getSelectedServerName('srv-2', [], 'Server Two')).toBe('Server Two');
  });

  it('switches to the current server name once the server list is available', () => {
    expect(getSelectedServerName(
      'srv-2',
      [
        { id: 'srv-1', name: 'Server One' },
        { id: 'srv-2', name: 'Server Two' },
      ],
      'Server One',
    )).toBe('Server Two');
  });

  it('drops a stale fallback when the selected server is not in the loaded list', () => {
    expect(getSelectedServerName(
      'srv-2',
      [{ id: 'srv-1', name: 'Server One' }],
      'Server One',
    )).toBeNull();
  });
});

describe('hasSelectedServer', () => {
  it('returns true when the selected server exists in the loaded list', () => {
    expect(hasSelectedServer('srv-2', [
      { id: 'srv-1', name: 'Server One' },
      { id: 'srv-2', name: 'Server Two' },
    ])).toBe(true);
  });

  it('returns false when the selected server is missing', () => {
    expect(hasSelectedServer('srv-2', [{ id: 'srv-1', name: 'Server One' }])).toBe(false);
  });
});

describe('shouldResetSelectedServer', () => {
  it('does not clear the selection before the server list has loaded', () => {
    expect(shouldResetSelectedServer('srv-2', [], false)).toBe(false);
  });

  it('clears a stale selected server once the server list has loaded', () => {
    expect(shouldResetSelectedServer('srv-2', [{ id: 'srv-1', name: 'Server One' }], true)).toBe(true);
  });

  it('clears the selection when there are no servers after loading', () => {
    expect(shouldResetSelectedServer('srv-2', [], true)).toBe(true);
  });
});

describe('shouldShowInitialConnectingGate', () => {
  it('keeps the gate visible until websocket or session data resolves', () => {
    expect(shouldShowInitialConnectingGate(true, 'srv-1', false, false)).toBe(true);
    expect(shouldShowInitialConnectingGate(true, 'srv-1', true, false)).toBe(false);
    expect(shouldShowInitialConnectingGate(true, 'srv-1', false, true)).toBe(false);
  });

  it('does not show the gate without a selected server or after a connection is established', () => {
    expect(shouldShowInitialConnectingGate(true, null, false, false)).toBe(false);
    expect(shouldShowInitialConnectingGate(false, 'srv-1', false, false)).toBe(false);
  });
});

describe('hasResolvedActiveSession', () => {
  it('returns false for a stale active session restored before the session list arrives', () => {
    expect(hasResolvedActiveSession('deck_proj_brain', [])).toBe(false);
  });

  it('returns true once the active session exists in the current session list', () => {
    expect(hasResolvedActiveSession('deck_proj_brain', [
      { name: 'deck_proj_brain' },
      { name: 'deck_proj_w1' },
    ])).toBe(true);
  });
});

describe('isServerOnline', () => {
  it('returns true for a recent non-offline heartbeat', () => {
    expect(isServerOnline({
      id: 'srv-1',
      name: 'Server One',
      status: 'online',
      lastHeartbeatAt: Date.now() - 5_000,
    })).toBe(true);
  });

  it('returns false for explicit offline or stale heartbeats', () => {
    expect(isServerOnline({
      id: 'srv-1',
      name: 'Server One',
      status: 'offline',
      lastHeartbeatAt: Date.now(),
    })).toBe(false);
    expect(isServerOnline({
      id: 'srv-1',
      name: 'Server One',
      status: 'online',
      lastHeartbeatAt: Date.now() - 61_000,
    })).toBe(false);
  });
});

describe('getDaemonBadgeState', () => {
  it('stays online when the selected server heartbeat still proves the daemon is up', () => {
    expect(getDaemonBadgeState(true, false, false, {
      id: 'srv-1',
      name: 'Server One',
      status: 'online',
      lastHeartbeatAt: Date.now() - 5_000,
    })).toBe('online');
  });

  it('falls back to offline only when both websocket state and server heartbeat say offline', () => {
    expect(getDaemonBadgeState(true, false, false, {
      id: 'srv-1',
      name: 'Server One',
      status: 'offline',
      lastHeartbeatAt: Date.now() - 61_000,
    })).toBe('offline');
  });

  it('uses connecting when the browser websocket itself is still reconnecting', () => {
    expect(getDaemonBadgeState(false, true, false, null)).toBe('connecting');
  });
});
