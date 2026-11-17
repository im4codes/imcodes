import { describe, expect, it } from 'vitest';
import { normalizeSharedEntrySummary } from '../src/api.js';
import { projectUnifiedServerList } from '../src/unified-server-projection.js';

describe('shared entry normalization and old-peer compatibility', () => {
  it('normalizes valid full-presence shared entry correctly', () => {
    const now = Date.now();
    const normalized = normalizeSharedEntrySummary({
      id: 'share-1',
      serverId: 'srv-1',
      serverName: 'Server One',
      role: 'participant',
      status: 'active',
      target: { kind: 'server', serverId: 'srv-1' },
      targetLabel: 'Main Server',
      serverStatus: 'online',
      lastHeartbeatAt: now - 5000,
      statusObservedAt: now - 4000,
    });

    expect(normalized).toEqual({
      id: 'share-1',
      serverId: 'srv-1',
      serverName: 'Server One',
      role: 'participant',
      status: 'active',
      target: { kind: 'server', serverId: 'srv-1' },
      targetLabel: 'Main Server',
      serverStatus: 'online',
      lastHeartbeatAt: now - 5000,
      statusObservedAt: now - 4000,
    });
  });

  it('normalizes legacy/old-peer entry with missing presence fields without inventing fake presence', () => {
    const legacy = normalizeSharedEntrySummary({
      id: 'share-legacy',
      serverId: 'srv-legacy',
      serverName: 'Legacy Server',
      role: 'viewer',
      status: 'active',
      target: { kind: 'server', serverId: 'srv-legacy' },
    });

    expect(legacy.serverStatus).toBeNull();
    expect(legacy.lastHeartbeatAt).toBeNull();
    expect(legacy.statusObservedAt).toBeNull();

    // Projected presence for legacy missing heartbeat must classify as 'unknown' (◌), never 'online'
    const projected = projectUnifiedServerList([], [legacy], new Set());
    expect(projected[0].presence).toBe('unknown');
    expect(projected[0].online).toBe(false);
  });

  it('sanitizes invalid, non-finite, negative, or malformed heartbeat values', () => {
    const invalidHeartbeats = [NaN, Infinity, -100, 0, '2026-11-03', null, undefined];
    for (const val of invalidHeartbeats) {
      const normalized = normalizeSharedEntrySummary({
        id: 'share-invalid',
        serverId: 'srv-invalid',
        lastHeartbeatAt: val as any,
      });
      expect(normalized.lastHeartbeatAt).toBeNull();
    }
  });

  it('safely handles missing or invalid target, role, and serverName', () => {
    const minimal = normalizeSharedEntrySummary({
      id: 'share-min',
      serverId: 'srv-min',
      role: 'invalid-role' as any,
    });

    expect(minimal.role).toBe('viewer');
    expect(minimal.serverName).toBe('srv-min');
    expect(minimal.target).toEqual({ kind: 'server', serverId: 'srv-min' });
    expect(minimal.status).toBe('active');
  });

  it('verifies integration baseline ebcd22fb counterexample: fresh discovery presence now renders online instead of hardcoded offline', () => {
    const now = Date.now();
    const freshGrant = normalizeSharedEntrySummary({
      id: 'share-fresh',
      serverId: 'srv-fresh',
      serverName: 'ai-207',
      role: 'participant',
      status: 'active',
      target: { kind: 'server', serverId: 'srv-fresh' },
      serverStatus: 'online',
      lastHeartbeatAt: now - 5000,
      statusObservedAt: now - 5000,
    });

    const projected = projectUnifiedServerList([], [freshGrant], new Set(), [], [], now);
    // On HEAD: fresh heartbeat within 60s classifies as online (●)
    expect(projected[0].presence).toBe('online');
    expect(projected[0].online).toBe(true);

    // On base ebcd22fb, discovery projection hardcoded:
    // status: 'active', lastHeartbeatAt: null, online: false
    // which caused ai-207 with fresh heartbeat to be displayed as false/grey (○).
  });
});
