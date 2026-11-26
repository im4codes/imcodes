import { describe, expect, it } from 'vitest';

import {
  markServerDaemonActivity,
  markServerLive,
  markServerOffline,
  SERVER_HEARTBEAT_TOUCH_MIN_INTERVAL_MS,
  touchServerHeartbeat,
} from '../src/server-online-state.js';

describe('markServerLive', () => {
  it('marks the selected server online and refreshes its heartbeat timestamp', () => {
    const servers = [
      { id: 'srv-1', name: 'one', status: 'offline', lastHeartbeatAt: null },
      { id: 'srv-2', name: 'two', status: 'offline', lastHeartbeatAt: null },
    ];

    expect(markServerLive(servers, 'srv-2', 123456)).toEqual([
      { id: 'srv-1', name: 'one', status: 'offline', lastHeartbeatAt: null },
      { id: 'srv-2', name: 'two', status: 'online', lastHeartbeatAt: 123456, statusObservedAt: 123456 },
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

    expect(markServerOffline(servers, 'srv-1', 555)).toEqual([
      { id: 'srv-1', name: 'one', status: 'offline', lastHeartbeatAt: 111, statusObservedAt: 555 },
      { id: 'srv-2', name: 'two', status: 'online', lastHeartbeatAt: 222 },
    ]);
  });
});

describe('markServerDaemonActivity', () => {
  it('promotes the selected server online because daemon-origin messages prove daemon liveness', () => {
    const servers = [
      { id: 'srv-1', name: 'one', status: 'offline', lastHeartbeatAt: 100 },
      { id: 'srv-2', name: 'two', status: 'online', lastHeartbeatAt: 200 },
    ];

    expect(markServerDaemonActivity(servers, 'srv-1', 999)).toEqual([
      { id: 'srv-1', name: 'one', status: 'online', lastHeartbeatAt: 999, statusObservedAt: 999 },
      { id: 'srv-2', name: 'two', status: 'online', lastHeartbeatAt: 200 },
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
    expect(touchServerHeartbeat(servers, null, 999)).toBe(servers);
  });

  it('returns the identical array reference when touched within minIntervalMs and refreshes once stale or null', () => {
    const servers = [
      { id: 'srv-1', name: 'one', status: 'online', lastHeartbeatAt: 100_000 },
    ];

    // Within 20s throttle window -> identical array reference (no React re-render).
    const withinWindow = touchServerHeartbeat(
      servers,
      'srv-1',
      110_000,
      SERVER_HEARTBEAT_TOUCH_MIN_INTERVAL_MS,
    );
    expect(withinWindow).toBe(servers);

    // At or past 20s -> clones and refreshes well ahead of the 60s expiry window.
    const refreshed = touchServerHeartbeat(
      servers,
      'srv-1',
      120_000,
      SERVER_HEARTBEAT_TOUCH_MIN_INTERVAL_MS,
    );
    expect(refreshed).not.toBe(servers);
    expect(refreshed[0]?.lastHeartbeatAt).toBe(120_000);

    // Null heartbeat or backward wall-clock jump refreshes immediately.
    const fromNull = touchServerHeartbeat(
      [{ id: 'srv-1', name: 'one', status: 'online', lastHeartbeatAt: null }],
      'srv-1',
      105_000,
      SERVER_HEARTBEAT_TOUCH_MIN_INTERVAL_MS,
    );
    expect(fromNull[0]?.lastHeartbeatAt).toBe(105_000);

    const backwardClock = touchServerHeartbeat(
      servers,
      'srv-1',
      90_000,
      SERVER_HEARTBEAT_TOUCH_MIN_INTERVAL_MS,
    );
    expect(backwardClock[0]?.lastHeartbeatAt).toBe(90_000);

    // Offline server always returns identical array reference.
    const offline = [{ id: 'srv-1', name: 'one', status: 'offline', lastHeartbeatAt: 100 }];
    expect(touchServerHeartbeat(offline, 'srv-1', 200_000, SERVER_HEARTBEAT_TOUCH_MIN_INTERVAL_MS)).toBe(offline);
  });
});
