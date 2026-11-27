import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';

interface MockOcInstance {
  index: number;
  disconnected: boolean;
  createSessionCalls: number;
  endSessionCalls: number;
  sendCalls: Array<{ sessionId: string; message: string }>;
  listSessionsCalls: number;
}

const state = vi.hoisted(() => {
  const store = new Map<string, SessionRecord>();
  const broadcastEvents: Array<{ providerId: string; connected: boolean }> = [];
  const instances: MockOcInstance[] = [];
  let listSessionsResult: Array<{ key: string; displayName?: string }> = [];
  let listSessionsHook: ((instance: MockOcInstance) => Promise<Array<{ key: string; displayName?: string }>> | Array<{ key: string; displayName?: string }>) | null = null;
  let onConnectHook: ((instance: MockOcInstance) => Promise<void>) | null = null;
  let onDisconnectHook: ((instance: MockOcInstance) => Promise<void>) | null = null;
  let identityHook: ((sessionName: string) => Promise<string | undefined>) | null = null;
  let releaseResourcesHook: (() => Promise<{ ok: number; failed: number }>) | null = null;
  let createSessionCalls = 0;

  return {
    store,
    broadcastEvents,
    instances,
    get listSessionsResult() { return listSessionsResult; },
    set listSessionsResult(v: Array<{ key: string; displayName?: string }>) { listSessionsResult = v; },
    get listSessionsHook() { return listSessionsHook; },
    set listSessionsHook(fn: typeof listSessionsHook) { listSessionsHook = fn; },
    get onConnectHook() { return onConnectHook; },
    set onConnectHook(fn: typeof onConnectHook) { onConnectHook = fn; },
    get onDisconnectHook() { return onDisconnectHook; },
    set onDisconnectHook(fn: typeof onDisconnectHook) { onDisconnectHook = fn; },
    get identityHook() { return identityHook; },
    set identityHook(fn: typeof identityHook) { identityHook = fn; },
    get releaseResourcesHook() { return releaseResourcesHook; },
    set releaseResourcesHook(fn: typeof releaseResourcesHook) { releaseResourcesHook = fn; },
    get createSessionCalls() { return createSessionCalls; },
    incCreateSessionCalls() { createSessionCalls += 1; },
    reset() {
      store.clear();
      broadcastEvents.length = 0;
      instances.length = 0;
      listSessionsResult = [];
      listSessionsHook = null;
      onConnectHook = null;
      onDisconnectHook = null;
      identityHook = null;
      releaseResourcesHook = null;
      createSessionCalls = 0;
    },
  };
});

const mocks = vi.hoisted(() => {
  const mockConnect = vi.fn();
  const mockDisconnect = vi.fn();
  const mockWireProviderToRelay = vi.fn();
  const mockBroadcastProviderStatus = vi.fn((providerId: string, connected: boolean) => {
    state.broadcastEvents.push({ providerId, connected });
  });

  const MockOpenClawProvider = vi.fn().mockImplementation(() => {
    const inst: MockOcInstance = {
      index: state.instances.length + 1,
      disconnected: false,
      createSessionCalls: 0,
      endSessionCalls: 0,
      sendCalls: [],
      listSessionsCalls: 0,
    };
    state.instances.push(inst);
    return {
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
      connect: async () => {
        inst.disconnected = false;
        mockConnect(inst.index);
        if (state.onConnectHook) await state.onConnectHook(inst);
      },
      disconnect: async () => {
        if (state.onDisconnectHook) await state.onDisconnectHook(inst);
        inst.disconnected = true;
        mockDisconnect(inst.index);
      },
      send: vi.fn(async (sessionId: string, message: unknown) => {
        if (inst.disconnected) throw new Error('WebSocket is not open: readyState 3 (CLOSED)');
        const text = typeof message === 'string'
          ? message
          : (typeof message === 'object' && message !== null && 'assembledMessage' in message
            ? String((message as { assembledMessage: unknown }).assembledMessage)
            : String(message));
        inst.sendCalls.push({ sessionId, message: text });
      }),
      onDelta: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
      listSessions: vi.fn(async () => {
        inst.listSessionsCalls += 1;
        if (state.listSessionsHook) return await state.listSessionsHook(inst);
        return state.listSessionsResult;
      }),
      createSession: vi.fn(async (opts: { sessionName?: string; skipCreate?: boolean; bindExistingKey?: string }) => {
        inst.createSessionCalls += 1;
        state.incCreateSessionCalls();
        if (inst.disconnected && !opts.skipCreate) {
          throw new Error('WebSocket is not open: readyState 3 (CLOSED)');
        }
        return opts.bindExistingKey ?? (opts.sessionName === 'deck_agent___main' ? 'agent___main___main' : `oc-${state.createSessionCalls}`);
      }),
      endSession: vi.fn(async () => {
        inst.endSessionCalls += 1;
      }),
    };
  });

  return {
    mockConnect,
    mockDisconnect,
    mockWireProviderToRelay,
    mockBroadcastProviderStatus,
    MockOpenClawProvider,
  };
});

vi.mock('../../src/daemon/session-identity-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/daemon/session-identity-resolver.js')>(
    '../../src/daemon/session-identity-resolver.js',
  );
  return {
    ...actual,
    resolveEffectiveIdentityPrompt: vi.fn(async (input: Parameters<typeof actual.resolveEffectiveIdentityPrompt>[0]) => {
      if (state.identityHook) return await state.identityHook(input.name);
      return await actual.resolveEffectiveIdentityPrompt(input);
    }),
  };
});

vi.mock('../../src/daemon/session-resource-service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/daemon/session-resource-service.js')>(
    '../../src/daemon/session-resource-service.js',
  );
  return {
    ...actual,
    releaseSessionChildResources: vi.fn(async (record: Parameters<typeof actual.releaseSessionChildResources>[0], opts: Parameters<typeof actual.releaseSessionChildResources>[1]) => {
      if (state.releaseResourcesHook) return await state.releaseResourcesHook();
      return await actual.releaseSessionChildResources(record, opts);
    }),
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
  isCurrentProvider,
  setProviderRegistryServerLink,
} from '../../src/agent/provider-registry.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import {
  getTransportRuntime,
  launchTransportSession,
  resolveSessionName,
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
    delete process.env.IMCODES_TRANSPORT_LAUNCH_INFLIGHT_WAIT_MS;
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
    await vi.waitFor(() => {
      expect(mocks.mockBroadcastProviderStatus).toHaveBeenCalledWith('openclaw', true);
    });

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

  it('completes promptly without timeout when explicit connectProvider sync encounters an in-flight launch suspended on identity prefetch', async () => {
    process.env.IMCODES_TRANSPORT_LAUNCH_INFLIGHT_WAIT_MS = '150';
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

    let identityEnteredResolve!: () => void;
    const identityEntered = new Promise<void>((res) => { identityEnteredResolve = res; });
    let identityGateResolve!: () => void;
    const identityGate = new Promise<void>((res) => { identityGateResolve = res; });
    state.identityHook = async () => {
      identityEnteredResolve();
      await identityGate;
      return undefined;
    };

    const outerLaunch = launchTransportSession({
      name: 'deck_agent___main',
      projectName: 'deck_agent___main',
      role: 'w1',
      agentType: 'openclaw',
      projectDir: '/tmp/oc-main',
      bindExistingKey: 'agent___main___main',
      skipCreate: true,
    });
    await identityEntered;

    // While outerLaunch is suspended at identity prefetch (before ensureProviderConnected),
    // explicit connectProvider enters syncOcSessions and joins the same-name launch.
    let syncEnteredResolve!: () => void;
    const syncEntered = new Promise<void>((res) => { syncEnteredResolve = res; });
    state.listSessionsHook = async () => {
      syncEnteredResolve();
      return state.listSessionsResult;
    };
    const explicitConnect = connectProvider('openclaw', { url: 'ws://127.0.0.1:18789', token: 'tok' });
    await syncEntered;
    // Allow syncOcSessions to enter launchTransportSession('deck_agent___main') while identityGate is held.
    await new Promise((res) => setTimeout(res, 20));

    identityGateResolve();
    await Promise.all([outerLaunch, explicitConnect]);

    expect(getTransportRuntime('deck_agent___main')).toBeDefined();
    expect(state.createSessionCalls).toBe(1);
    expect(mocks.mockBroadcastProviderStatus).toHaveBeenCalledWith('openclaw', true);
  });

  it('does not treat a failed in-flight launch as a successful syncOcSessions recovery', async () => {
    process.env.IMCODES_TRANSPORT_LAUNCH_INFLIGHT_WAIT_MS = '150';
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

    let identityEnteredResolve!: () => void;
    const identityEntered = new Promise<void>((res) => { identityEnteredResolve = res; });
    let identityGateResolve!: () => void;
    const identityGate = new Promise<void>((res) => { identityGateResolve = res; });
    state.identityHook = async () => {
      identityEnteredResolve();
      await identityGate;
      return undefined;
    };
    // Cleanup consistently fails -> neither launch can build a runtime.
    state.releaseResourcesHook = async () => ({ ok: 0, failed: 1 });

    const outerLaunch = launchTransportSession({
      name: 'deck_agent___main',
      projectName: 'deck_agent___main',
      role: 'w1',
      agentType: 'openclaw',
      projectDir: '/tmp/oc-main',
      bindExistingKey: 'agent___main___main',
      skipCreate: true,
    });
    await identityEntered;

    const explicitConnect = connectProvider('openclaw', { url: 'ws://127.0.0.1:18789', token: 'tok' });
    await new Promise((res) => setTimeout(res, 20));
    identityGateResolve();

    await expect(outerLaunch).rejects.toThrow('session resource cleanup failed');
    await explicitConnect;

    expect(getTransportRuntime('deck_agent___main')).toBeUndefined();
    expect(state.store.get('deck_agent___main')?.state).toBe('stopped');
  });

  it('prevents ordinary provider.list_sessions refresh from binding a runtime onto disconnected provider A when concurrent reconnect installs B', async () => {
    const serverLink = { send: vi.fn() };
    await connectProvider('openclaw', { url: 'ws://127.0.0.1:18789', token: 'tok-a' });
    const instanceA = state.instances[0]!;
    expect(instanceA.index).toBe(1);

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

    let identityEnteredResolve!: () => void;
    const identityEntered = new Promise<void>((res) => { identityEnteredResolve = res; });
    let identityGateResolve!: () => void;
    const identityGate = new Promise<void>((res) => { identityGateResolve = res; });
    let gatedOnce = false;
    state.identityHook = async () => {
      if (!gatedOnce) {
        gatedOnce = true;
        identityEnteredResolve();
        await identityGate;
      }
      return undefined;
    };

    const { syncOcSessions } = await import('../../src/daemon/oc-session-sync.js');
    // Ordinary refresh (no connectTimeProvider) lists from A and yields in identity prefetch.
    const refreshPromise = syncOcSessions(serverLink as any);
    await identityEntered;

    // Concurrent reconnect disconnects A and connects B.
    const reconnectPromise = connectProvider('openclaw', { url: 'ws://127.0.0.1:18790', token: 'tok-b' });
    await vi.waitFor(() => {
      expect(instanceA.disconnected).toBe(true);
      expect(state.instances.length).toBe(2);
    });
    const instanceB = state.instances[1]!;

    identityGateResolve();
    await Promise.all([refreshPromise, reconnectPromise]);

    const runtime = getTransportRuntime('deck_agent___main');
    expect(runtime).toBeDefined();
    expect(instanceA.createSessionCalls).toBe(0);
    expect(instanceB.createSessionCalls).toBe(1);

    const sendOutcome = runtime!.send('hello after reconnect');
    expect(sendOutcome).toBe('sent');
    await vi.waitFor(() => {
      expect(instanceB.sendCalls).toHaveLength(1);
    });
    expect(instanceA.sendCalls).toHaveLength(0);
  });

  it('aborts ordinary syncOcSessions when provider disconnects/reconnects during listSessions', async () => {
    const serverLink = { send: vi.fn() };
    await connectProvider('openclaw', { url: 'ws://127.0.0.1:18789', token: 'tok-a' });
    const instanceA = state.instances[0]!;

    let listEnteredResolve!: () => void;
    const listEntered = new Promise<void>((res) => { listEnteredResolve = res; });
    let listGateResolve!: () => void;
    const listGate = new Promise<void>((res) => { listGateResolve = res; });

    state.listSessionsHook = async (inst) => {
      if (inst === instanceA && inst.listSessionsCalls === 2) {
        listEnteredResolve();
        await listGate;
        return [
          { key: 'agent___main___deck_sub_orphan' },
          { key: 'agent___main___main', displayName: 'Stale A Only' },
        ];
      }
      return [];
    };

    const { syncOcSessions } = await import('../../src/daemon/oc-session-sync.js');
    const staleRefresh = syncOcSessions(serverLink as any);
    await listEntered;

    await connectProvider('openclaw', { url: 'ws://127.0.0.1:18790', token: 'tok-b' });
    expect(instanceA.disconnected).toBe(true);

    listGateResolve();
    await staleRefresh;

    // Stale A results must neither delete orphans on A nor materialize sessions from A.
    expect(instanceA.endSessionCalls).toBe(0);
    expect(instanceA.createSessionCalls).toBe(0);
    expect(getTransportRuntime('deck_agent___main')).toBeUndefined();
  });

  it('aborts ordinary refresh materialization when gateway B replaces A and B returns an empty session list', async () => {
    const serverLink = { send: vi.fn() };
    state.listSessionsHook = (inst) => (
      inst.index === 1
        ? [{ key: 'agent___main___main', displayName: 'A Only Main' }]
        : []
    );
    await connectProvider('openclaw', { url: 'ws://127.0.0.1:18789', token: 'tok-a' });
    const instanceA = state.instances[0]!;
    // Reset A calls after initial connectProvider materialized nothing (wait: let's ensure clean unmaterialized state before refresh).
    await stopTransportRuntimeSession('deck_agent___main').catch(() => {});
    unregisterProviderRoute('agent___main___main');
    state.store.delete('deck_agent___main');
    instanceA.createSessionCalls = 0;

    let identityEnteredResolve!: () => void;
    const identityEntered = new Promise<void>((res) => { identityEnteredResolve = res; });
    let identityGateResolve!: () => void;
    const identityGate = new Promise<void>((res) => { identityGateResolve = res; });
    let gatedOnce = false;
    state.identityHook = async () => {
      if (!gatedOnce) {
        gatedOnce = true;
        identityEnteredResolve();
        await identityGate;
      }
      return undefined;
    };

    const { syncOcSessions } = await import('../../src/daemon/oc-session-sync.js');
    // Ordinary refresh lists A-only main session (no local record yet) and blocks on identity prefetch.
    const refreshPromise = syncOcSessions(serverLink as any);
    await identityEntered;

    // Concurrent reconnect disconnects A and connects B, which returns an empty list [].
    const reconnectPromise = connectProvider('openclaw', { url: 'ws://127.0.0.1:18790', token: 'tok-b' });
    await vi.waitFor(() => {
      expect(instanceA.disconnected).toBe(true);
      expect(state.instances.length).toBe(2);
    });
    const instanceB = state.instances[1]!;

    identityGateResolve();
    await Promise.all([refreshPromise, reconnectPromise]);

    // Stale A session MUST NOT be materialized onto replacement gateway B.
    expect(instanceA.createSessionCalls).toBe(0);
    expect(instanceB.createSessionCalls).toBe(0);
    expect(getTransportRuntime('deck_agent___main')).toBeUndefined();
    expect(state.store.get('deck_agent___main')).toBeUndefined();
    expect(resolveSessionName('agent___main___main')).toBeUndefined();
  });

  it('does not reuse a timed-out connectTimeProvider handoff after disconnectProvider before identity completes', async () => {
    process.env.IMCODES_TRANSPORT_LAUNCH_INFLIGHT_WAIT_MS = '80';
    state.listSessionsResult = [{ key: 'agent___main___main', displayName: 'OpenClaw Main' }];

    let identityEnteredResolve!: () => void;
    const identityEntered = new Promise<void>((res) => { identityEnteredResolve = res; });
    let identityGateResolve!: () => void;
    const identityGate = new Promise<void>((res) => { identityGateResolve = res; });
    let gatedOnce = false;
    state.identityHook = async () => {
      if (!gatedOnce) {
        gatedOnce = true;
        identityEnteredResolve();
        await identityGate;
      }
      return undefined;
    };

    const outerLaunch = launchTransportSession({
      name: 'deck_agent___main',
      projectName: 'deck_agent___main',
      role: 'w1',
      agentType: 'openclaw',
      projectDir: '/tmp/oc-main',
      bindExistingKey: 'agent___main___main',
      skipCreate: true,
    });
    await identityEntered;

    // connectProvider hands P1 to outerLaunch, waits 80ms timeout in syncOcSessions, and finishes.
    await connectProvider('openclaw', { url: 'ws://127.0.0.1:18789', token: 'tok-1' });
    const instance1 = state.instances[0]!;

    // Disconnect removes P1 BEFORE identityGate releases.
    await disconnectProvider('openclaw');
    expect(instance1.disconnected).toBe(true);
    expect(getProvider('openclaw')).toBeUndefined();

    identityGateResolve();
    await outerLaunch;

    // outerLaunch MUST NOT touch disconnected P1; it must connect fresh P2 via ensureProviderConnected.
    expect(instance1.createSessionCalls).toBe(0);
    expect(state.instances.length).toBe(2);
    const instance2 = state.instances[1]!;
    expect(instance2.disconnected).toBe(false);
    expect(instance2.createSessionCalls).toBe(1);

    const runtime = getTransportRuntime('deck_agent___main');
    expect(runtime).toBeDefined();
    expect(runtime!.send('hello on fresh P2')).toBe('sent');
    await vi.waitFor(() => {
      expect(instance2.sendCalls).toHaveLength(1);
    });
    expect(instance1.sendCalls).toHaveLength(0);
  });

  it('refuses to publish runtime, store, or route when disconnectProvider starts retiring A after real runtime.initialize completes', async () => {
    const serverLink = { send: vi.fn() };
    state.listSessionsResult = [];
    await connectProvider('openclaw', { url: 'ws://127.0.0.1:18789', token: 'tok-a' });
    const providerA = getProvider('openclaw')!;
    expect(isCurrentProvider('openclaw', providerA)).toBe(true);

    // Ordinary refresh will see an unmaterialized A session.
    state.listSessionsResult = [{ key: 'agent___main___main', displayName: 'Retiring A Main' }];

    let postInitEnteredResolve!: () => void;
    const postInitEntered = new Promise<void>((res) => { postInitEnteredResolve = res; });
    let postInitGateResolve!: () => void;
    const postInitGate = new Promise<void>((res) => { postInitGateResolve = res; });
    const origInitialize = TransportSessionRuntime.prototype.initialize;
    const initSpy = vi.spyOn(TransportSessionRuntime.prototype, 'initialize').mockImplementation(async function (this: TransportSessionRuntime, ...args) {
      await origInitialize.apply(this, args);
      postInitEnteredResolve();
      await postInitGate;
    });

    let disconnectEnteredResolve!: () => void;
    const disconnectEntered = new Promise<void>((res) => { disconnectEnteredResolve = res; });
    let disconnectGateResolve!: () => void;
    const disconnectGate = new Promise<void>((res) => { disconnectGateResolve = res; });
    state.onDisconnectHook = async () => {
      disconnectEnteredResolve();
      await disconnectGate;
    };

    try {
      const { syncOcSessions } = await import('../../src/daemon/oc-session-sync.js');
      const refreshPromise = syncOcSessions(serverLink as any);
      await postInitEntered;

      // Start disconnecting A while real initialize is paused right before returning.
      const disconnectPromise = disconnectProvider('openclaw');
      await disconnectEntered;

      // Even before A.disconnect() resolves (and while getProvider still holds A),
      // A is synchronously retired for publish.
      expect(getProvider('openclaw')).toBe(providerA);
      expect(isCurrentProvider('openclaw', providerA)).toBe(false);

      // Release initialize so launch attempts the synchronous publish check while disconnect is still pending.
      postInitGateResolve();
      await refreshPromise;

      expect(getTransportRuntime('deck_agent___main')).toBeUndefined();
      expect(state.store.get('deck_agent___main')).toBeUndefined();
      expect(resolveSessionName('agent___main___main')).toBeUndefined();

      disconnectGateResolve();
      await disconnectPromise;

      expect(getProvider('openclaw')).toBeUndefined();
      expect(getTransportRuntime('deck_agent___main')).toBeUndefined();
      expect(state.store.get('deck_agent___main')).toBeUndefined();
      expect(resolveSessionName('agent___main___main')).toBeUndefined();
    } finally {
      initSpy.mockRestore();
    }
  });
});
