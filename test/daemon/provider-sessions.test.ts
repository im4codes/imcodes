/**
 * Tests for provider remote session listing and sync.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TRANSPORT_MSG } from '../../shared/transport-events.js';
import { setTransportRelaySend, broadcastProviderStatus } from '../../src/daemon/transport-relay.js';

describe('provider session listing', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('TRANSPORT_MSG has LIST_SESSIONS and SESSIONS_RESPONSE constants', () => {
    expect(TRANSPORT_MSG.LIST_SESSIONS).toBe('provider.list_sessions');
    expect(TRANSPORT_MSG.SESSIONS_RESPONSE).toBe('provider.sessions_response');
  });

  it('listProviderSessions returns empty array when no provider connected', async () => {
    // Mock getProvider to return undefined (no provider connected)
    vi.doMock('../../src/agent/provider-registry.js', () => ({
      getProvider: () => undefined,
    }));
    const { listProviderSessions } = await import('../../src/daemon/provider-sessions.js');
    const sessions = await listProviderSessions('openclaw');
    expect(sessions).toEqual([]);
    vi.doUnmock('../../src/agent/provider-registry.js');
  });

  it('listProviderSessions returns empty array when provider lacks sessionRestore', async () => {
    vi.doMock('../../src/agent/provider-registry.js', () => ({
      getProvider: () => ({
        capabilities: { sessionRestore: false },
      }),
    }));
    const mod = await import('../../src/daemon/provider-sessions.js');
    // Re-import to pick up new mock
    const sessions = await mod.listProviderSessions('openclaw');
    expect(sessions).toEqual([]);
    vi.doUnmock('../../src/agent/provider-registry.js');
  });
});

describe('broadcastProviderStatus auto-push', () => {
  it('sends provider.status message to server', () => {
    const sent: Record<string, unknown>[] = [];
    setTransportRelaySend((msg) => sent.push(msg));

    broadcastProviderStatus('openclaw', true);

    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0]).toEqual({
      type: TRANSPORT_MSG.PROVIDER_STATUS,
      providerId: 'openclaw',
      connected: true,
    });
  });

  it('sends disconnect status', () => {
    const sent: Record<string, unknown>[] = [];
    setTransportRelaySend((msg) => sent.push(msg));

    broadcastProviderStatus('openclaw', false);

    expect(sent[0]).toEqual({
      type: TRANSPORT_MSG.PROVIDER_STATUS,
      providerId: 'openclaw',
      connected: false,
    });
  });

  afterEach(() => {
    setTransportRelaySend(() => {}); // reset
  });
});
