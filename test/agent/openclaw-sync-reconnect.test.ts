import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';

const state = vi.hoisted(() => {
  const store = new Map<string, SessionRecord>();
  const broadcastEvents: Array<{ providerId: string; connected: boolean }> = [];
  let listSessionsResult: Array<{ key: string; displayName?: string }> = [];
  let onConnectHook: (() => Promise<void>) | null = null;
  let createSessionCalls = 0;

  return {
    store,
    broadcastEvents,
    get listSessionsResult() { return listSessionsResult; },
    set listSessionsResult(v: Array<{ key: string; displayName?: string }>) { listSessionsResult = v; },
    get onConnectHook() { return onConnectHook; },
    set onConnectHook(fn: (() => Promise<void>) | null) { onConnectHook = fn; },
    get createSessionCalls() { return createSessionCalls; },
    incCreateSessionCalls() { createSessionCalls += 1; },
    reset() {
      store.clear();
      broadcastEvents.length = 0;
      listSessionsResult = [];
      onConnectHook = null;
      createSessionCalls = 0;
    },
  };
});

const mocks = vi.hoisted(() => {
  const mockConnect = vi.fn(async () => {
    if (state.onConnectHook) await state.onConnectHook();
  });
  const mockDisconnect = vi.fn().mockResolvedValue(undefined);
  const mockWireProviderToRelay = vi.fn();
  const mockBroadcastProviderStatus = vi.fn((providerId: string, connected: boolean) => {
    state.broadcastEvents.push({ providerId, connected });
  });

  const MockOpenClawProvider = vi.fn().mockImplementation(() => ({
    id: 'openclaw',
    connectionMode: 'persistent',
    sessionOwnership: 'provider',
    capabilities: {
      streaming: true,
      toolCalling: true,
      approval: true,
      sessionRestore: true,
      multiTurn: true,
      attachments: false,
    },
    connect: mockConnect,
    disconnect: mockDisconnect,
    send: vi.fn().mockResolvedValue(undefined),
    onDelta: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
    listSessions: vi.fn(async () => state.listSessionsResult),
    createSession: vi.fn(async (opts: { sessionName?: string }) => {
      state.incCreateSessionCalls();
      return opts.sessionName === 'deck_agent___main' ? 'agent___main___main' : `oc-${state.createSessionCalls}`;
    }),
    endSession: vi.fn().mockResolvedValue(undefined),
  }));

  return {
    mockConnect,
    mockDisconnect,
    mockWireProviderToRelay,
    mockBroadcastProviderStatus,
    MockOpenClawProvider,
  };
});

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: () => Array.from(state.store.values()),
  getSession: (name: string) => state.store.get(name),
  findSessionByProviderSessionId: (providerSessionId: string) =>
    Array.from(state.store.values()).find((rec) => rec.providerSessionId === providerSessionId),
  upsertSession: (rec: SessionRecord) => {
    state.store.set(rec.name, rec);
  },
  updateSessionState: (name: string, nextState: SessionRecord['state'], error?: string) => {
    const existing = state.store.get(name);
    if (existing) state.store.set(name, { ...existing, state: nextState, ...(error ? { error } : {}) });
  },
  removeSession: (name: string) => {
    state.store.delete(name);
  },
  createSessionInstanceId: () => 'oc-inst-1',
  createRuntimeEpoch: () => 'oc-epoch-1',
}));

vi.mock('../../src/agent/providers/openclaw.js', () => ({
  OpenClawProvider: mocks.MockOpenClawProvider,
}));

vi.mock('../../src/daemon/transport-relay.js', () => ({
  wireProviderToRelay: mocks.mockWireProviderToRelay,
  broadcastProviderStatus: mocks.mockBroadcastProviderStatus,
}));

vi.mock('../../src/daemon/openclaw-config.js', () => ({
  saveConfig: vi.fn(),
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  connectProvider,
  disconnectAll,
  disconnectProvider,
  ensureProviderConnected,
  getProvider,
  setProviderRegistryServerLink,
} from '../../src/agent/provider-registry.js';
import {
  getTransportRuntime,
  launchTransportSession,
  stopTransportRuntimeSession,
  unregisterProviderRoute,
} from '../../src/agent/session-manager.js';

describe('OpenClaw reconnect syncOcSessions + registry serialization', () => {
  beforeEach(async () => {
    await stopTransportRuntimeSession('deck_agent___main').catch(() => {});
    unregisterProviderRoute('agent___main___main');
    await disconnectAll();
    state.reset();
    vi.clearAllMocks();
    setProviderRegistryServerLink({ send: vi.fn() });
  });

  afterEach(async () => {
    await stopTransportRuntimeSession('deck_agent___main').catch(() => {});
    unregisterProviderRoute('agent___main___main');
    await disconnectAll();
  });

  it('restores missing runtime during ensureProviderConnected(openclaw) without deadlocking syncOcSessions, broadcasts connected, and completes trailing disconnect', async () => {
    state.store.set('deck_agent___main', {
      name: 'deck_agent___main',
      projectName: 'deck_agent___main',
      role: 'w1',
      agentType: 'openclaw',
      projectDir: '/tmp/oc-main',
      state: 'stopped',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
      runtimeType: 'transport',
      providerId: 'openclaw',
      providerSessionId: 'agent___main___main',
    });
    state.listSessionsResult = [{ key: 'agent___main___main', displayName: 'OpenClaw Main' }];

    let connectGateResolve!: () => void;
    const connectGate = new Promise<void>((res) => { connectGateResolve = res; });
    state.onConnectHook = () => connectGate;

    const ensurePromise = ensureProviderConnected('openclaw', { url: 'ws://127.0.0.1:18789', token: 'tok' });
    await vi.waitFor(() => {
      expect(mocks.mockConnect).toHaveBeenCalledTimes(1);
    });

    const trailingDisconnect = disconnectProvider('openclaw');
    connectGateResolve();

    // Must complete promptly without deadlocking on syncOcSessions -> launchTransportSession -> ensureProviderConnected.
    const [connectedProvider] = await Promise.all([ensurePromise, trailingDisconnect]);
    expect(connectedProvider.id).toBe('openclaw');
    expect(getTransportRuntime('deck_agent___main')).toBeDefined();
    expect(mocks.mockBroadcastProviderStatus).toHaveBeenNthCalledWith(1, 'openclaw', true);
    expect(mocks.mockBroadcastProviderStatus).toHaveBeenNthCalledWith(2, 'openclaw', false);
    expect(mocks.mockDisconnect).toHaveBeenCalledTimes(1);
    expect(getProvider('openclaw')).toBeUndefined();
  });

  it('breaks indirect launchTransportSession -> ensureProviderConnected(openclaw) -> syncOcSessions -> launchTransportSession wait without 45s timeout', async () => {
    state.store.set('deck_agent___main', {
      name: 'deck_agent___main',
      projectName: 'deck_agent___main',
      role: 'w1',
      agentType: 'openclaw',
      projectDir: '/tmp/oc-main',
      state: 'stopped',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
      runtimeType: 'transport',
      providerId: 'openclaw',
      providerSessionId: 'agent___main___main',
    });
    state.listSessionsResult = [{ key: 'agent___main___main', displayName: 'OpenClaw Main' }];

    // First launch enters launchTransportSession('deck_agent___main'), then calls ensureProviderConnected('openclaw')
    // -> connectProvider('openclaw') -> syncOcSessions() -> launchTransportSession('deck_agent___main')!
    await launchTransportSession({
      name: 'deck_agent___main',
      projectName: 'deck_agent___main',
      role: 'w1',
      agentType: 'openclaw',
      projectDir: '/tmp/oc-main',
      bindExistingKey: 'agent___main___main',
      skipCreate: true,
    });

    expect(getTransportRuntime('deck_agent___main')).toBeDefined();
    expect(getProvider('openclaw')).toBeDefined();
    expect(state.createSessionCalls).toBe(1);
    expect(mocks.mockBroadcastProviderStatus).toHaveBeenCalledWith('openclaw', true);

    await disconnectProvider('openclaw');
    expect(getProvider('openclaw')).toBeUndefined();
  });

  it('runs connectProvider(openclaw) with runtime rebuild BEFORE broadcasting connected status', async () => {
    state.store.set('deck_agent___main', {
      name: 'deck_agent___main',
      projectName: 'deck_agent___main',
      role: 'w1',
      agentType: 'openclaw',
      projectDir: '/tmp/oc-main',
      state: 'stopped',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
      runtimeType: 'transport',
      providerId: 'openclaw',
      providerSessionId: 'agent___main___main',
    });
    state.listSessionsResult = [{ key: 'agent___main___main', displayName: 'OpenClaw Main' }];

    let runtimeExistsAtStatusBroadcast = false;
    mocks.mockBroadcastProviderStatus.mockImplementationOnce((providerId: string, connected: boolean) => {
      if (providerId === 'openclaw' && connected) {
        runtimeExistsAtStatusBroadcast = Boolean(getTransportRuntime('deck_agent___main'));
      }
    });

    await connectProvider('openclaw', { url: 'ws://127.0.0.1:18789', token: 'tok' });
    expect(runtimeExistsAtStatusBroadcast).toBe(true);
    expect(getTransportRuntime('deck_agent___main')).toBeDefined();
  });
});
