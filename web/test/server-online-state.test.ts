import { describe, expect, it } from 'vitest';

import { markServerLive, markServerOffline, touchServerHeartbeat } from '../src/server-online-state.js';

describe('markServerLive', () => {
  it('marks the selected server online and refreshes its heartbeat timestamp', () => {
    const servers = [
      { id: 'srv-1', name: 'one', status: 'offline', lastHeartbeatAt: null },
      { id: 'srv-2', name: 'two', status: 'offline', lastHeartbeatAt: null },
    ];

    expect(markServerLive(servers, 'srv-2', 123456)).toEqual([
      { id: 'srv-1', name: 'one', status: 'offline', lastHeartbeatAt: null },
      { id: 'srv-2', name: 'two', status: 'online', lastHeartbeatAt: 123456 },
    ]);
  });

  it('leaves the list untouched when no server is selected', () => {
    const servers = [{ id: 'srv-1', name: 'one', status: 'offline', lastHeartbeatAt: null }];
    expect(markServerLive(servers, null, 1)).toEqual(servers);
  });
});

describe('markServerOffline', () => {
  it('marks the selected server offline without touching others', () => {
    const servers = [
      { id: 'srv-1', name: 'one', status: 'online', lastHeartbeatAt: 111 },
      { id: 'srv-2', name: 'two', status: 'online', lastHeartbeatAt: 222 },
    ];

    expect(markServerOffline(servers, 'srv-1')).toEqual([
      { id: 'srv-1', name: 'one', status: 'offline', lastHeartbeatAt: 111 },
      { id: 'srv-2', name: 'two', status: 'online', lastHeartbeatAt: 222 },
    ]);
  });
});

describe('touchServerHeartbeat', () => {
  it('refreshes lastHeartbeatAt for the selected non-offline server', () => {
    const servers = [
      { id: 'srv-1', name: 'one', status: 'online', lastHeartbeatAt: 100 },
      { id: 'srv-2', name: 'two', status: 'online', lastHeartbeatAt: 200 },
    ];

    expect(touchServerHeartbeat(servers, 'srv-2', 999)).toEqual([
      { id: 'srv-1', name: 'one', status: 'online', lastHeartbeatAt: 100 },
      { id: 'srv-2', name: 'two', status: 'online', lastHeartbeatAt: 999 },
    ]);
  });

  it('does not promote an explicitly offline server back online', () => {
    const servers = [
      { id: 'srv-1', name: 'one', status: 'offline', lastHeartbeatAt: 100 },
    ];

    expect(touchServerHeartbeat(servers, 'srv-1', 999)).toEqual(servers);
  });

  it('leaves the list untouched when no server is selected', () => {
    const servers = [{ id: 'srv-1', name: 'one', status: 'online', lastHeartbeatAt: 100 }];
    expect(touchServerHeartbeat(servers, null, 999)).toEqual(servers);
  });
});
