import { describe, expect, it } from 'vitest';

import {
  getSelectedServerName,
  hasSelectedServer,
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
  it('shows the gate only while the server list is still loading', () => {
    expect(shouldShowInitialConnectingGate(true, 'srv-1', false, false, false)).toBe(true);
    expect(shouldShowInitialConnectingGate(true, 'srv-1', false, false, true)).toBe(false);
  });

  it('does not show the gate without a selected server or after a connection is established', () => {
    expect(shouldShowInitialConnectingGate(true, null, false, false, false)).toBe(false);
    expect(shouldShowInitialConnectingGate(true, 'srv-1', true, false, false)).toBe(false);
    expect(shouldShowInitialConnectingGate(true, 'srv-1', false, true, false)).toBe(false);
  });
});
