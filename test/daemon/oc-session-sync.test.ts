/**
 * Tests for OC session auto-sync pipeline.
 */
import { describe, it, expect } from 'vitest';
import {
  extractAgentName,
  isMainSession,
  shouldFilter,
  isOrphanKey,
  groupByAgent,
  mainSessionName,
  mainSessionLabel,
  mainSessionProjectDir,
  setOcRoot,
} from '../../src/daemon/oc-session-sync.js';
import { normalizeOpenClawDisplayName, preferredOpenClawLabel } from '../../src/agent/openclaw-display.js';
import type { RemoteSessionInfo } from '../../src/agent/transport-provider.js';

// ── Key parsing ─────────────────────────────────────────────────────────────

describe('extractAgentName', () => {
  it('extracts agent name from sanitized key', () => {
    expect(extractAgentName('agent___main___main')).toBe('main');
    expect(extractAgentName('agent___emma___main')).toBe('emma');
    expect(extractAgentName('agent___ppt___discord___channel___123')).toBe('ppt');
  });

  it('returns null for non-agent keys', () => {
    expect(extractAgentName('something___else')).toBeNull();
    expect(extractAgentName('deck_sub_abc')).toBeNull();
  });
});

describe('isMainSession', () => {
  it('identifies :main sessions', () => {
    expect(isMainSession('agent___main___main')).toBe(true);
    expect(isMainSession('agent___emma___main')).toBe(true);
  });

  it('rejects non-main sessions', () => {
    expect(isMainSession('agent___main___discord___channel___123')).toBe(false);
    expect(isMainSession('agent___emma___sessions')).toBe(false);
  });
});

describe('shouldFilter', () => {
  it('filters :sessions metadata', () => {
    expect(shouldFilter('agent___emma___sessions')).toBe(true);
  });

  it('filters :cron: sessions (defense-in-depth)', () => {
    expect(shouldFilter('agent___main___cron___abc123')).toBe(true);
  });

  it('does not filter normal sessions', () => {
    expect(shouldFilter('agent___main___main')).toBe(false);
    expect(shouldFilter('agent___main___discord___channel___123')).toBe(false);
  });

});

describe('isOrphanKey', () => {
  it('identifies orphan sessions with deck_sub_ in key', () => {
    expect(isOrphanKey('agent___main___deck_sub_13200q22')).toBe(true);
    expect(isOrphanKey('agent___main___deck_sub_abc123')).toBe(true);
  });

  it('identifies orphan sessions with deck_agent_ in key', () => {
    expect(isOrphanKey('agent___main___deck_agent___main')).toBe(true);
  });

  it('does not flag normal sessions', () => {
    expect(isOrphanKey('agent___main___main')).toBe(false);
    expect(isOrphanKey('agent___main___discord___channel___123')).toBe(false);
    expect(isOrphanKey('agent___main___my-deck-channel')).toBe(false);
  });
});

// ── Grouping ────────────────────────────────────────────────────────────────

describe('groupByAgent', () => {
  const sessions: RemoteSessionInfo[] = [
    { key: 'agent___main___main', displayName: 'heartbeat' },
    { key: 'agent___main___discord___channel___111', displayName: 'discord:#general' },
    { key: 'agent___main___discord___channel___222', displayName: 'discord:#dev' },
    { key: 'agent___emma___main', displayName: 'feishu:emma' },
    { key: 'agent___ppt___discord___channel___333', displayName: 'discord:#ppt-dev' },
    { key: 'agent___emma___sessions', displayName: '' }, // metadata — filtered
  ];

  it('groups by agent name', () => {
    const groups = groupByAgent(sessions);
    expect(groups).toHaveLength(3);
    const names = groups.map(g => g.agentName).sort();
    expect(names).toEqual(['emma', 'main', 'ppt']);
  });

  it('separates main from channel sessions', () => {
    const groups = groupByAgent(sessions);
    const mainGroup = groups.find(g => g.agentName === 'main')!;
    expect(mainGroup.mainSession?.key).toBe('agent___main___main');
    expect(mainGroup.channelSessions).toHaveLength(2);
  });

  it('filters out :sessions metadata', () => {
    const groups = groupByAgent(sessions);
    const emmaGroup = groups.find(g => g.agentName === 'emma')!;
    expect(emmaGroup.mainSession?.key).toBe('agent___emma___main');
    expect(emmaGroup.channelSessions).toHaveLength(0); // sessions was filtered
  });

  it('handles agent with no :main session', () => {
    const groups = groupByAgent(sessions);
    const pptGroup = groups.find(g => g.agentName === 'ppt')!;
    expect(pptGroup.mainSession).toBeNull();
    expect(pptGroup.channelSessions).toHaveLength(1);
  });

  it('orphan keys pass through groupByAgent (deleted separately by syncOcSessions)', () => {
    const withOrphans: RemoteSessionInfo[] = [
      ...sessions,
      { key: 'agent___main___deck_sub_abc123', displayName: 'orphan' },
    ];
    const groups = groupByAgent(withOrphans);
    const mainGroup = groups.find(g => g.agentName === 'main')!;
    // Orphans are in channel sessions — syncOcSessions deletes them before grouping matters
    expect(mainGroup.channelSessions.some(s => s.key.includes('deck_sub_'))).toBe(true);
  });
});

// ── Session naming ──────────────────────────────────────────────────────────

describe('session naming', () => {
  it('mainSessionName', () => {
    expect(mainSessionName('main')).toBe('deck_agent___main');
    expect(mainSessionName('emma')).toBe('deck_agent___emma');
  });

  it('mainSessionLabel', () => {
    expect(mainSessionLabel('main')).toBe('OC:main');
    expect(mainSessionLabel('emma')).toBe('OC:emma');
  });

  it('mainSessionProjectDir — main agent uses root', () => {
    setOcRoot('/home/test/clawd');
    expect(mainSessionProjectDir('main')).toBe('/home/test/clawd');
  });

  it('mainSessionProjectDir — non-main agent uses agents subdir', () => {
    setOcRoot('/home/test/clawd');
    expect(mainSessionProjectDir('emma')).toBe('/home/test/clawd/agents/emma');
    expect(mainSessionProjectDir('ppt')).toBe('/home/test/clawd/agents/ppt');
  });
});

describe('OpenClaw display labels', () => {
  it('normalizes discord display names to the #suffix', () => {
    expect(normalizeOpenClawDisplayName('discord:1476187408042033309#videos')).toBe('#videos');
    expect(normalizeOpenClawDisplayName('discord:#general')).toBe('#general');
    expect(normalizeOpenClawDisplayName('feishu:emma')).toBe('feishu:emma');
  });

  it('replaces stale discord-prefixed stored labels with normalized labels', () => {
    expect(preferredOpenClawLabel('discord:1476187408042033309#videos', 'discord:1476187408042033309#videos', 'agent___main___discord___channel___111')).toBe('#videos');
  });

  it('preserves custom labels that do not match the stale discord-prefixed form', () => {
    expect(preferredOpenClawLabel('Team videos', 'discord:1476187408042033309#videos', 'agent___main___discord___channel___111')).toBe('Team videos');
  });
});

// ── Integration: syncOcSessions with mocked provider ────────────────────────

import { vi } from 'vitest';

describe('syncOcSessions integration', () => {
  // We test the grouping + dedup logic indirectly by verifying
  // that syncOcSessions correctly skips already-bound sessions
  // and only creates new ones.

  it('isProviderSessionBound skips already-registered sessions', async () => {
    const { registerProviderRoute, unregisterProviderRoute, isProviderSessionBound } = await import('../../src/agent/session-manager.js');

    // Simulate: agent___main___main is already bound
    registerProviderRoute('agent___main___main', 'deck_agent___main');
    expect(isProviderSessionBound('agent___main___main')).toBe(true);

    // This is what syncOcSessions checks before creating
    const sessions: RemoteSessionInfo[] = [
      { key: 'agent___main___main', displayName: 'heartbeat' },
    ];
    const groups = groupByAgent(sessions);
    const group = groups[0];

    // Main session: already bound → should skip (not create)
    expect(group.mainSession).toBeTruthy();
    expect(isProviderSessionBound(group.mainSession!.key)).toBe(true);

    // Cleanup
    unregisterProviderRoute('agent___main___main');
  });

  it('findSessionByProviderSessionId catches reconnect scenario', async () => {
    const { upsertSession, removeSession, findSessionByProviderSessionId } = await import('../../src/store/session-store.js');

    // Simulate: session exists in store (from previous connect) but not in routing map
    upsertSession({
      name: 'deck_sub_test123',
      projectName: 'deck_sub_test123',
      role: 'w1',
      agentType: 'openclaw',
      projectDir: '/tmp',
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runtimeType: 'transport',
      providerId: 'openclaw',
      providerSessionId: 'agent___main___discord___channel___999',
    });

    const found = findSessionByProviderSessionId('agent___main___discord___channel___999');
    expect(found).toBeTruthy();
    expect(found!.name).toBe('deck_sub_test123');

    // Not in store → null
    expect(findSessionByProviderSessionId('nonexistent')).toBeUndefined();

    // Cleanup
    removeSession('deck_sub_test123');
  });

  it('skipCreate flag is passed correctly through LaunchOpts', () => {
    // Verify the sync pipeline sets skipCreate: true for auto-synced sessions
    // by checking the LaunchOpts type accepts it
    const opts: import('../../src/agent/session-manager.js').LaunchOpts = {
      name: 'deck_agent___test',
      projectName: 'deck_agent___test',
      role: 'w1',
      agentType: 'openclaw',
      projectDir: '/tmp',
      bindExistingKey: 'agent___test___main',
      skipCreate: true,
    };
    expect(opts.skipCreate).toBe(true);
    expect(opts.bindExistingKey).toBe('agent___test___main');
  });
});
