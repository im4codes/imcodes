/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach } from 'vitest';

import {
  getDaemonBadgeState,
  getSelectedServerName,
  hasResolvedActiveSession,
  hasSelectedServer,
  isServerOnline,
  pickAutoEntryServer,
  pickMostRecentMainSession,
  resolveServerSessionSnapshot,
  shouldResetSelectedServer,
  shouldShowInitialConnectingGate,
} from '../src/server-selection.js';
import { readServerSession, serverSessionStorageKey, writeServerSession } from '../src/server-tab-state.js';

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

describe('server-scoped tab snapshots', () => {
  beforeEach(() => localStorage.clear());
  it('keeps each server tab independent, including same-named sessions', () => {
    localStorage.clear();
    writeServerSession('server-a', 'deck_shared_brain');
    writeServerSession('server-b', 'deck_shared_brain');
    expect(serverSessionStorageKey('server-a')).not.toBe(serverSessionStorageKey('server-b'));
    expect(readServerSession('server-a')).toBe('deck_shared_brain');
    expect(readServerSession('server-b')).toBe('deck_shared_brain');
    writeServerSession('server-a', 'deck_other_brain');
    expect(readServerSession('server-a')).toBe('deck_other_brain');
    expect(readServerSession('server-b')).toBe('deck_shared_brain');
  });

  it('drops invalid or removed snapshots instead of restoring them', () => {
    localStorage.clear();
    writeServerSession('server-a', '');
    expect(readServerSession('server-a')).toBeNull();
    localStorage.setItem(serverSessionStorageKey('server-a'), 'x'.repeat(1025));
    expect(readServerSession('server-a')).toBeNull();
    writeServerSession('server-a', null);
    expect(localStorage.getItem(serverSessionStorageKey('server-a'))).toBeNull();
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

describe('pickMostRecentMainSession', () => {
  it('chooses the main session with the latest preview timestamp', () => {
    expect(pickMostRecentMainSession([
      { serverId: 'srv-1', sessionName: 'deck_old_brain', previewUpdatedAt: 10 },
      { serverId: 'srv-2', sessionName: 'deck_new_brain', previewUpdatedAt: 30 },
      { serverId: 'srv-1', sessionName: 'deck_sub_child', previewUpdatedAt: 50, isSubSession: true },
    ])).toEqual({ serverId: 'srv-2', sessionName: 'deck_new_brain' });
  });

  it('returns null when only sub-sessions are present', () => {
    expect(pickMostRecentMainSession([
      { serverId: 'srv-1', sessionName: 'deck_sub_child', previewUpdatedAt: 50, isSubSession: true },
    ])).toBeNull();
  });

  it('does not auto-enter worker sessions as independent main windows', () => {
    expect(pickMostRecentMainSession([
      { serverId: 'srv-1', sessionName: 'deck_proj_w1', previewUpdatedAt: 50 },
      { serverId: 'srv-1', sessionName: 'deck_proj_brain', previewUpdatedAt: 20 },
    ])).toEqual({ serverId: 'srv-1', sessionName: 'deck_proj_brain' });
  });
});

describe('pickAutoEntryServer', () => {
  it('prefers a saved server that still exists', () => {
    expect(pickAutoEntryServer([
      { id: 'srv-1', name: 'Server One', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 1 },
      { id: 'srv-2', name: 'Server Two', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 2 },
    ], 'srv-1')).toEqual({ serverId: 'srv-1', sessionName: null });
  });

  it('falls back to online newest server', () => {
    expect(pickAutoEntryServer([
      { id: 'srv-off', name: 'Offline', status: 'offline', lastHeartbeatAt: Date.now(), createdAt: 100 },
      { id: 'srv-on', name: 'Online', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 1 },
    ], null)).toEqual({ serverId: 'srv-on', sessionName: null });
  });
});

describe('resolveServerSessionSnapshot', () => {
  it('falls back when the saved tab was deleted or is no longer navigable', () => {
    const sessions = [
      { serverId: 'srv-a', sessionName: 'deck_deleted_brain', isSubSession: true, previewUpdatedAt: 100 },
      { serverId: 'srv-a', sessionName: 'deck_project_w1', previewUpdatedAt: 90 },
      { serverId: 'srv-a', sessionName: 'deck_project_brain', previewUpdatedAt: 10 },
      { serverId: 'srv-b', sessionName: 'deck_other_brain', previewUpdatedAt: 999 },
    ];

    expect(resolveServerSessionSnapshot('srv-a', 'deck_deleted_brain', sessions)).toBe('deck_project_brain');
    expect(resolveServerSessionSnapshot('srv-a', 'deck_missing_brain', sessions)).toBe('deck_project_brain');
    expect(resolveServerSessionSnapshot('srv-a', 'deck_other_brain', sessions)).toBe('deck_project_brain');
  });

  it('restores a valid snapshot only for its own server', () => {
    const sessions = [
      { serverId: 'srv-a', sessionName: 'deck_shared_brain', previewUpdatedAt: 10 },
      { serverId: 'srv-b', sessionName: 'deck_shared_brain', previewUpdatedAt: 20 },
    ];
    expect(resolveServerSessionSnapshot('srv-a', 'deck_shared_brain', sessions)).toBe('deck_shared_brain');
    expect(resolveServerSessionSnapshot('srv-a', 'deck_missing_brain', sessions)).toBe('deck_shared_brain');
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
