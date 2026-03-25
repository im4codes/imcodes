/**
 * Tests for OC session auto-sync pipeline.
 */
import { describe, it, expect } from 'vitest';
import {
  extractAgentName,
  isMainSession,
  shouldFilter,
  groupByAgent,
  mainSessionName,
  mainSessionLabel,
  mainSessionProjectDir,
  setOcRoot,
} from '../../src/daemon/oc-session-sync.js';
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

  it('does not filter normal sessions', () => {
    expect(shouldFilter('agent___main___main')).toBe(false);
    expect(shouldFilter('agent___main___discord___channel___123')).toBe(false);
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
