/**
 * Tests for providerSessionId → sessionName routing map.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProviderRoute,
  unregisterProviderRoute,
  resolveSessionName,
  isProviderSessionBound,
  rebuildProviderRoutes,
} from '../../src/agent/session-manager.js';
import { upsertSession, removeSession, listSessions } from '../../src/store/session-store.js';

describe('provider routing map', () => {
  beforeEach(() => {
    // Clean up any routes from previous tests
    for (const s of listSessions()) {
      if (s.providerSessionId) unregisterProviderRoute(s.providerSessionId);
      removeSession(s.name);
    }
  });

  it('registerProviderRoute + resolveSessionName', () => {
    registerProviderRoute('agent___main___main', 'deck_agent___main');
    expect(resolveSessionName('agent___main___main')).toBe('deck_agent___main');
  });

  it('unregisterProviderRoute removes the mapping', () => {
    registerProviderRoute('agent___main___main', 'deck_agent___main');
    unregisterProviderRoute('agent___main___main');
    expect(resolveSessionName('agent___main___main')).toBeUndefined();
  });

  it('isProviderSessionBound returns correct status', () => {
    expect(isProviderSessionBound('agent___emma___main')).toBe(false);
    registerProviderRoute('agent___emma___main', 'deck_agent___emma');
    expect(isProviderSessionBound('agent___emma___main')).toBe(true);
    unregisterProviderRoute('agent___emma___main');
    expect(isProviderSessionBound('agent___emma___main')).toBe(false);
  });

  it('resolveSessionName returns undefined for unknown ID', () => {
    expect(resolveSessionName('nonexistent')).toBeUndefined();
  });

  it('rebuildProviderRoutes populates map from session store', () => {
    // Seed store with a transport session
    upsertSession({
      name: 'deck_agent___main',
      projectName: 'deck_agent___main',
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
      providerSessionId: 'agent___main___main',
    });

    // Clear any existing route
    unregisterProviderRoute('agent___main___main');
    expect(resolveSessionName('agent___main___main')).toBeUndefined();

    // Rebuild
    rebuildProviderRoutes();
    expect(resolveSessionName('agent___main___main')).toBe('deck_agent___main');

    // Cleanup
    unregisterProviderRoute('agent___main___main');
    removeSession('deck_agent___main');
  });

  it('rebuildProviderRoutes ignores non-transport sessions', () => {
    upsertSession({
      name: 'deck_proj_brain',
      projectName: 'deck_proj_brain',
      role: 'brain',
      agentType: 'claude-code',
      projectDir: '/tmp',
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // No runtimeType or providerSessionId
    });

    rebuildProviderRoutes();
    // Should not have any route for this session
    expect(resolveSessionName('deck_proj_brain')).toBeUndefined();

    removeSession('deck_proj_brain');
  });
});
