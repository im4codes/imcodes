/**
 * E2E for Qwen transport-backed sessions.
 *
 * Uses:
 * - real session-manager transport launch flow
 * - real provider-registry wiring into transport-relay
 * - real command-handler session.send path
 * - mocked Qwen provider (no external CLI required)
 *
 * Verifies:
 * - main qwen sessions launch as transport sessions
 * - providerSessionId is persisted
 * - session.send produces immediate thinking state, then streaming + final assistant timeline events
 * - streaming and final events reuse the same stable eventId (typewriter path)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderContextPayload } from '../../shared/context-types.js';
import { COMMAND_ACK_ERROR_DUPLICATE_COMMAND_ID } from '../../shared/ack-protocol.js';

const SESSION = `deck_qwene2e_${Math.random().toString(36).slice(2, 8)}_brain`;

const flushAsync = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => process.nextTick(resolve));
};

const mocks = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  const emitted: Array<{ session: string; type: string; payload: Record<string, unknown>; opts?: Record<string, unknown> }> = [];

  class MockQwenProvider {
    readonly id = 'qwen';
    readonly connectionMode = 'local-sdk';
    readonly sessionOwnership = 'shared';
    readonly capabilities = {
      streaming: true,
      toolCalling: false,
      approval: false,
      sessionRestore: true,
      multiTurn: true,
      attachments: false,
    };

    deltaCallbacks: Array<(sid: string, delta: any) => void> = [];
    completeCallbacks: Array<(sid: string, msg: any) => void> = [];
    errorCallbacks: Array<(sid: string, err: any) => void> = [];
    created: Array<Record<string, unknown>> = [];
    modelBySession = new Map<string, string | undefined>();
    pendingCompletes = new Map<string, () => void>();

    async connect() {}
    async disconnect() {}
    async createSession(config: Record<string, unknown>) {
      this.created.push(config);
      const id = String(config.bindExistingKey ?? config.sessionKey);
      this.modelBySession.set(id, typeof config.agentId === 'string' ? config.agentId : undefined);
      return id;
    }
    async endSession() {}
    onDelta(cb: (sid: string, delta: any) => void) { this.deltaCallbacks.push(cb); return () => {}; }
    onComplete(cb: (sid: string, msg: any) => void) { this.completeCallbacks.push(cb); return () => {}; }
    onError(cb: (sid: string, err: any) => void) { this.errorCallbacks.push(cb); return () => {}; }
    setSessionAgentId(sessionId: string, agentId: string) { this.modelBySession.set(sessionId, agentId); }
    async send(sessionId: string, payloadOrMessage: string | ProviderContextPayload) {
      const message = typeof payloadOrMessage === 'string'
        ? payloadOrMessage
        : payloadOrMessage.assembledMessage;
      if (message === 'fail') {
        this.deltaCallbacks.forEach((cb) => cb(sessionId, {
          messageId: 'msg-qwen-e2e-error',
          type: 'text',
          delta: 'partial failure',
          role: 'assistant',
        }));
        this.errorCallbacks.forEach((cb) => cb(sessionId, {
          code: 'PROVIDER_ERROR',
          message: 'provider exploded',
          recoverable: true,
        }));
        return;
      }
      if (message === 'slow first') {
        this.deltaCallbacks.forEach((cb) => cb(sessionId, {
          messageId: 'msg-qwen-e2e-slow',
          type: 'text',
          delta: 'Qwen',
          role: 'assistant',
        }));
        this.pendingCompletes.set(sessionId, () => {
          this.deltaCallbacks.forEach((cb) => cb(sessionId, {
            messageId: 'msg-qwen-e2e-slow',
            type: 'text',
            delta: 'Qwen: slow first',
            role: 'assistant',
          }));
          this.completeCallbacks.forEach((cb) => cb(sessionId, {
            id: 'msg-qwen-e2e-slow',
            sessionId,
            kind: 'text',
            role: 'assistant',
            content: 'Qwen: slow first',
            timestamp: Date.now(),
            status: 'complete',
            metadata: { model: this.modelBySession.get(sessionId), usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 1 } },
          }));
        });
        return;
      }
      this.deltaCallbacks.forEach((cb) => cb(sessionId, {
        messageId: 'msg-qwen-e2e',
        type: 'text',
        delta: 'Qwen',
        role: 'assistant',
      }));
      this.deltaCallbacks.forEach((cb) => cb(sessionId, {
        messageId: 'msg-qwen-e2e',
        type: 'text',
        delta: `Qwen: ${message}`,
        role: 'assistant',
      }));
      this.completeCallbacks.forEach((cb) => cb(sessionId, {
        id: 'msg-qwen-e2e',
        sessionId,
        kind: 'text',
        role: 'assistant',
        content: `Qwen: ${message}`,
        timestamp: Date.now(),
        status: 'complete',
        metadata: { model: this.modelBySession.get(sessionId), usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 1 } },
      }));
    }

    flushPending(sessionId: string) {
      const flush = this.pendingCompletes.get(sessionId);
      this.pendingCompletes.delete(sessionId);
      flush?.();
    }
  }

  return {
    store,
    emitted,
    MockQwenProvider,
    nextUuid: vi.fn(() => '11111111-1111-4111-8111-111111111111'),
  };
});

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: mocks.nextUuid,
  };
});

vi.mock('../../src/agent/providers/qwen.js', () => ({
  QwenProvider: mocks.MockQwenProvider,
}));

vi.mock('../../src/agent/qwen-runtime-config.js', () => ({
  getQwenRuntimeConfig: vi.fn(async () => ({
    authType: 'coding-plan',
    availableModels: ['qwen3.5-plus', 'qwen3-coder-plus', 'qwen3-coder-next'],
  })),
}));

vi.mock('../../src/daemon/cc-presets.js', () => ({
  getQwenPresetTransportConfig: vi.fn(async (presetName: string) => presetName === 'MiniMax' ? ({
    env: {
      ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
      ANTHROPIC_API_KEY: 'test-token',
      ANTHROPIC_MODEL: 'MiniMax-M2.7',
      OPENAI_BASE_URL: 'https://api.minimax.io/anthropic',
      OPENAI_API_KEY: 'test-token',
    },
    model: 'MiniMax-M2.7',
    availableModels: ['MiniMax-M2.7'],
    contextWindow: 200000,
    settings: {
      security: { auth: { selectedType: 'anthropic' } },
      model: { name: 'MiniMax-M2.7' },
      modelProviders: {
        anthropic: [
          {
            id: 'MiniMax-M2.7',
            name: 'minimax',
            envKey: 'ANTHROPIC_API_KEY',
            baseUrl: 'https://api.minimax.io/anthropic',
          },
        ],
      },
    },
  }) : { env: {} }),
  getPreset: vi.fn(async (presetName: string) => presetName === 'MiniMax' ? ({
    name: 'MiniMax',
    env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' },
    defaultModel: 'MiniMax-M2.7',
    availableModels: [{ id: 'MiniMax-M2.7', name: 'minimax' }],
    contextWindow: 200000,
  }) : null),
  getPresetEffectiveModel: vi.fn((preset: { defaultModel?: string; env?: Record<string, string> }) => preset.defaultModel ?? preset.env?.ANTHROPIC_MODEL),
  getPresetAvailableModelIds: vi.fn((preset: { availableModels?: Array<{ id: string }>; defaultModel?: string; env?: Record<string, string> }) => {
    const discovered = preset.availableModels?.map((item) => item.id) ?? [];
    return discovered.length > 0 ? discovered : (preset.defaultModel ?? preset.env?.ANTHROPIC_MODEL ? [preset.defaultModel ?? String(preset.env?.ANTHROPIC_MODEL)] : []);
  }),
  getCachedPresetContextWindow: vi.fn((presetName: string) => presetName === 'MiniMax' ? 200000 : undefined),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => [...mocks.store.values()]),
  getSession: vi.fn((name: string) => mocks.store.get(name) ?? null),
  upsertSession: vi.fn((record: Record<string, unknown>) => {
    if (typeof record.name === 'string') mocks.store.set(record.name, record);
  }),
  removeSession: vi.fn((name: string) => { mocks.store.delete(name); }),
  updateSessionState: vi.fn((name: string, state: string) => {
    const existing = mocks.store.get(name);
    if (existing) mocks.store.set(name, { ...existing, state });
  }),
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: vi.fn((session: string, type: string, payload: Record<string, unknown>, opts?: Record<string, unknown>) => {
      mocks.emitted.push({ session, type, payload, opts });
    }),
    on: vi.fn(() => () => {}),
    epoch: 0,
    replay: vi.fn(() => ({ events: [], truncated: false })),
  },
}));

vi.mock('../../src/daemon/transport-history.js', () => ({
  appendTransportEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/agent-version.js', () => ({
  getAgentVersion: vi.fn().mockResolvedValue('test-version'),
}));

vi.mock('../../src/repo/cache.js', () => ({
  repoCache: { invalidate: vi.fn() },
}));

vi.mock('../../src/agent/signal.js', () => ({
  setupCCStopHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/notify-setup.js', () => ({
  setupCodexNotify: vi.fn().mockResolvedValue(undefined),
  setupOpenCodePlugin: vi.fn().mockResolvedValue(undefined),
}));

import { launchSession } from '../../src/agent/session-manager.js';
import { connectProvider, disconnectAll } from '../../src/agent/provider-registry.js';
import { handleWebCommand } from '../../src/daemon/command-handler.js';
import { restoreTransportSessions } from '../../src/agent/session-manager.js';

describe('qwen transport flow e2e', () => {
  afterEach(async () => {
    await disconnectAll();
    mocks.store.clear();
    mocks.emitted.length = 0;
    vi.clearAllMocks();
  });

  it('launches qwen main session and emits typewriter-friendly timeline events on send', async () => {
    await launchSession({
      name: SESSION,
      projectName: 'qwene2e',
      role: 'brain',
      agentType: 'qwen',
      projectDir: '/tmp/qwen-e2e',
    });

    const record = mocks.store.get(SESSION);
    expect(record).toBeDefined();
    expect(record?.runtimeType).toBe('transport');
    expect(record?.providerId).toBe('qwen');
    expect(record?.providerSessionId).toBe('11111111-1111-4111-8111-111111111111');

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({
      type: 'session.send',
      session: SESSION,
      text: 'hello',
      commandId: 'cmd-qwen-e2e',
    }, serverLink);
    await flushAsync();
    const running = mocks.emitted.find((e) => e.session === SESSION && e.type === 'session.state' && e.payload.state === 'running');
    const thinking = mocks.emitted.find((e) => e.session === SESSION && e.type === 'assistant.thinking');
    const user = mocks.emitted.find((e) => e.session === SESSION && e.type === 'user.message');
    const streaming = mocks.emitted.filter((e) => e.session === SESSION && e.type === 'assistant.text' && e.payload.streaming === true);
    const final = mocks.emitted.find((e) => e.session === SESSION && e.type === 'assistant.text' && e.payload.streaming === false);
    const ack = mocks.emitted.find((e) => e.session === SESSION && e.type === 'command.ack');
    const stableEventId = `transport:${SESSION}:msg-qwen-e2e`;

    expect(user?.payload.text).toBe('hello');
    expect(running).toBeDefined();
    expect(thinking?.payload.text).toBe('');
    expect(streaming.map((e) => e.payload.text)).toEqual(['Qwen']);
    expect(streaming[0]?.opts?.eventId).toBe(stableEventId);
    expect(final?.payload.text).toBe('Qwen: hello');
    expect(final?.opts?.eventId).toBe(stableEventId);
    const usage = mocks.emitted.find((e) => e.session === SESSION && e.type === 'usage.update');
    expect(usage?.payload.model).toBe('qwen3.5-plus');
    expect(usage?.payload.inputTokens).toBe(10);
    expect(ack?.payload.status).toBe('accepted');
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'command.ack',
      commandId: 'cmd-qwen-e2e',
      status: 'accepted',
      session: SESSION,
    });
  });

  it('switches qwen model via /model and applies it to later sends', async () => {
    await launchSession({
      name: SESSION,
      projectName: 'qwene2e',
      role: 'brain',
      agentType: 'qwen',
      projectDir: '/tmp/qwen-e2e',
    });

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({
      type: 'session.send',
      session: SESSION,
      text: '/model qwen3-coder-plus',
      commandId: 'cmd-qwen-model',
    }, serverLink);
    await flushAsync();

    const usage = mocks.emitted.find((e) => e.session === SESSION && e.type === 'usage.update' && e.payload.model === 'qwen3-coder-plus');
    const switched = mocks.emitted.find((e) => e.session === SESSION && e.type === 'assistant.text' && String(e.payload.text).includes('Switched model'));
    expect(usage).toBeDefined();
    expect(switched).toBeDefined();

    mocks.emitted.length = 0;
    handleWebCommand({
      type: 'session.send',
      session: SESSION,
      text: 'hello after switch',
      commandId: 'cmd-qwen-after-switch',
    }, serverLink);
    await flushAsync();

    const laterUsage = mocks.emitted.find((e) => e.session === SESSION && e.type === 'usage.update');
    expect(laterUsage?.payload.model).toBe('qwen3-coder-plus');
  });

  it('applies qwen preset env, settings, and model on launch', async () => {
    await launchSession({
      name: SESSION,
      projectName: 'qwene2e',
      role: 'brain',
      agentType: 'qwen',
      projectDir: '/tmp/qwen-e2e',
      ccPreset: 'MiniMax',
    });

    const provider = (await import('../../src/agent/provider-registry.js')).getProvider('qwen') as InstanceType<typeof mocks.MockQwenProvider> | undefined;
    const created = provider?.created[0];
    expect(created).toEqual(expect.objectContaining({
      agentId: 'MiniMax-M2.7',
      env: expect.objectContaining({
        ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
        ANTHROPIC_API_KEY: 'test-token',
        ANTHROPIC_MODEL: 'MiniMax-M2.7',
        OPENAI_BASE_URL: 'https://api.minimax.io/anthropic',
        OPENAI_API_KEY: 'test-token',
      }),
      settings: expect.objectContaining({
        security: { auth: { selectedType: 'anthropic' } },
        model: { name: 'MiniMax-M2.7' },
      }),
    }));

    const record = mocks.store.get(SESSION);
    expect(record?.ccPreset).toBe('MiniMax');
    expect(record?.requestedModel).toBe('MiniMax-M2.7');
    expect(record?.modelDisplay).toBe('MiniMax-M2.7');
    expect(record?.qwenModel).toBe('MiniMax-M2.7');
    expect(record?.presetContextWindow).toBe(200000);
  });

  it('uses preset context window for qwen preset usage updates', async () => {
    await launchSession({
      name: SESSION,
      projectName: 'qwene2e',
      role: 'brain',
      agentType: 'qwen',
      projectDir: '/tmp/qwen-e2e',
      ccPreset: 'MiniMax',
    });

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({
      type: 'session.send',
      session: SESSION,
      text: 'hello',
      commandId: 'cmd-qwen-preset-ctx',
    }, serverLink);
    await flushAsync();

    const usage = mocks.emitted.find((e) => e.session === SESSION && e.type === 'usage.update');
    expect(usage?.payload.model).toBe('MiniMax-M2.7');
    expect(usage?.payload.contextWindow).toBe(200000);
  });

  it('finalizes a streaming transport error onto the same eventId instead of appending a second message', async () => {
    await launchSession({
      name: SESSION,
      projectName: 'qwene2e',
      role: 'brain',
      agentType: 'qwen',
      projectDir: '/tmp/qwen-e2e',
    });

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({
      type: 'session.send',
      session: SESSION,
      text: 'fail',
      commandId: 'cmd-qwen-fail',
    }, serverLink);
    await flushAsync();

    const textEvents = mocks.emitted.filter((e) => e.session === SESSION && e.type === 'assistant.text');
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0]?.payload.streaming).toBe(true);
    expect(textEvents[0]?.opts?.eventId).toBe(`transport:${SESSION}:msg-qwen-e2e-error`);
    expect(textEvents[1]?.payload.streaming).toBe(false);
    expect(textEvents[1]?.opts?.eventId).toBe(`transport:${SESSION}:msg-qwen-e2e-error`);
    expect(textEvents[1]?.payload.text).toBe('partial failure\n\n⚠️ Error: provider exploded');
  });

  it('restarts qwen by reusing the persisted provider session id instead of creating a new session', async () => {
    mocks.nextUuid
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValue('22222222-2222-4222-8222-222222222222');

    await launchSession({
      name: SESSION,
      projectName: 'qwene2e',
      role: 'brain',
      agentType: 'qwen',
      projectDir: '/tmp/qwen-e2e',
    });

    const initial = mocks.store.get(SESSION);
    expect(initial?.providerSessionId).toBe('11111111-1111-4111-8111-111111111111');

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({
      type: 'session.restart',
      sessionName: SESSION,
      agentType: 'qwen',
    }, serverLink);
    await flushAsync();

    const restarted = mocks.store.get(SESSION);
    expect(restarted?.providerSessionId).toBe('11111111-1111-4111-8111-111111111111');

    mocks.emitted.length = 0;
    handleWebCommand({
      type: 'session.send',
      session: SESSION,
      text: 'hello after restart',
      commandId: 'cmd-qwen-after-restart',
    }, serverLink);
    await flushAsync();

    const final = mocks.emitted.find((e) => e.session === SESSION && e.type === 'assistant.text' && e.payload.streaming === false);
    expect(final?.payload.text).toBe('Qwen: hello after restart');
  });

  it('restores qwen preset sessions with preset model even when runtime catalog does not list it', async () => {
    const restoreSession = `${SESSION}_restore`;
    mocks.store.set(restoreSession, {
      name: restoreSession,
      projectName: 'qwene2e',
      role: 'brain',
      agentType: 'qwen',
      projectDir: '/tmp/qwen-e2e',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runtimeType: 'transport',
      providerId: 'qwen',
      providerSessionId: 'route-qwen-preset',
      ccPreset: 'MiniMax',
      requestedModel: 'MiniMax-M2.7',
      activeModel: 'MiniMax-M2.7',
      modelDisplay: 'MiniMax-M2.7',
    });

    await connectProvider('qwen', {});
    await restoreTransportSessions('qwen');

    const provider = (await import('../../src/agent/provider-registry.js')).getProvider('qwen') as InstanceType<typeof mocks.MockQwenProvider> | undefined;
    const restored = provider?.created.at(-1);
    expect(restored).toEqual(expect.objectContaining({
      bindExistingKey: 'route-qwen-preset',
      skipCreate: true,
      agentId: 'MiniMax-M2.7',
      env: expect.objectContaining({
        ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
        ANTHROPIC_API_KEY: 'test-token',
        ANTHROPIC_MODEL: 'MiniMax-M2.7',
        OPENAI_BASE_URL: 'https://api.minimax.io/anthropic',
        OPENAI_API_KEY: 'test-token',
      }),
      settings: expect.objectContaining({
        security: { auth: { selectedType: 'anthropic' } },
        model: { name: 'MiniMax-M2.7' },
      }),
    }));

    const record = mocks.store.get(restoreSession);
    expect(record?.requestedModel).toBe('MiniMax-M2.7');
    expect(record?.activeModel).toBe('MiniMax-M2.7');
    expect(record?.modelDisplay).toBe('MiniMax-M2.7');
  });

  it('allows /model switch to preset model when runtime catalog does not list it', async () => {
    // The Qwen CLI's availableModels list does NOT include MiniMax-M2.7
    // (mock returns only qwen3.5-plus etc.). A session with MiniMax preset
    // has qwenAvailableModels populated with MiniMax-M2.7 at launch. The
    // /model command must accept the preset model using the session record,
    // not reject it because runtimeConfig.availableModels is stale.
    const modelSession = `${SESSION}_model_switch`;
    mocks.store.set(modelSession, {
      name: modelSession,
      projectName: 'qwene2e',
      role: 'brain',
      agentType: 'qwen',
      projectDir: '/tmp/qwen-e2e',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runtimeType: 'transport',
      providerId: 'qwen',
      providerSessionId: 'route-qwen-model-switch',
      ccPreset: 'MiniMax',
      requestedModel: 'MiniMax-M2.7',
      activeModel: 'MiniMax-M2.7',
      modelDisplay: 'MiniMax-M2.7',
      qwenAvailableModels: ['MiniMax-M2.7'],
    });

    await connectProvider('qwen', {});
    await restoreTransportSessions('qwen');

    const serverLink = { send: vi.fn(), daemonVersion: 'test' } as any;
    handleWebCommand({
      type: 'session.send',
      session: modelSession,
      text: '/model MiniMax-M2.7',
      commandId: 'cmd-model-switch',
    }, serverLink);
    await flushAsync();

    // Must NOT emit unknown model error — session qwenAvailableModels is authoritative
    const errorEvent = mocks.emitted.find((e) =>
      e.session === modelSession && e.type === 'assistant.text'
      && (e.payload.text as string)?.includes('Unknown Qwen model'),
    );
    expect(errorEvent).toBeUndefined();

    // Model switch must be accepted
    const ack = mocks.emitted.find((e) =>
      e.session === modelSession && e.type === 'command.ack'
      && (e.payload as Record<string, unknown>).commandId === 'cmd-model-switch',
    );
    expect(ack).toEqual(expect.objectContaining({
      payload: expect.objectContaining({ status: 'accepted' }),
    }));

    const provider = (await import('../../src/agent/provider-registry.js')).getProvider('qwen') as InstanceType<typeof mocks.MockQwenProvider> | undefined;
    expect(provider?.modelBySession.get('route-qwen-model-switch')).toBe('MiniMax-M2.7');
  });

  it('keeps queued transport messages stable across timeline and session list updates', async () => {
    await launchSession({
      name: SESSION,
      projectName: 'qwene2e',
      role: 'brain',
      agentType: 'qwen',
      projectDir: '/tmp/qwen-e2e',
    });

    const serverLink = { send: vi.fn(), daemonVersion: 'test' } as any;
    handleWebCommand({
      type: 'session.send',
      session: SESSION,
      text: 'slow first',
      commandId: 'cmd-qwen-slow',
    }, serverLink);
    await flushAsync();

    handleWebCommand({
      type: 'session.send',
      session: SESSION,
      text: 'queued second',
      commandId: 'cmd-qwen-queued',
    }, serverLink);
    await flushAsync();

    const queuedState = mocks.emitted.find((e) =>
      e.session === SESSION
      && e.type === 'session.state'
      && e.payload.state === 'queued'
      && Array.isArray(e.payload.pendingMessageEntries)
      && e.payload.pendingMessageEntries.some((entry: { clientMessageId: string; text: string }) =>
        entry.clientMessageId === 'cmd-qwen-queued' && entry.text === 'queued second'),
    );
    expect(queuedState).toBeTruthy();
    const queuedUserBeforeDrain = mocks.emitted.find((e) =>
      e.session === SESSION
      && e.type === 'user.message'
      && e.payload.clientMessageId === 'cmd-qwen-queued'
    );
    expect(queuedUserBeforeDrain).toBeUndefined();
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'command.ack',
      commandId: 'cmd-qwen-queued',
      status: 'accepted',
      session: SESSION,
    });
    const queuedServerAcks = serverLink.send.mock.calls.filter(([msg]: [Record<string, unknown>]) =>
      msg.type === 'command.ack' && msg.commandId === 'cmd-qwen-queued',
    );
    expect(queuedServerAcks).toHaveLength(1);
    const queuedTimelineAck = mocks.emitted.find((e) =>
      e.session === SESSION
      && e.type === 'command.ack'
      && e.payload.commandId === 'cmd-qwen-queued'
      && e.payload.status === 'accepted'
    );
    expect(queuedTimelineAck).toBeDefined();

    handleWebCommand({ type: 'get_sessions' }, serverLink);
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session_list',
      sessions: expect.arrayContaining([
        expect.objectContaining({
          name: SESSION,
          state: 'running',
          transportPendingMessages: ['queued second'],
          transportPendingMessageEntries: [
            { clientMessageId: 'cmd-qwen-queued', text: 'queued second' },
          ],
        }),
      ]),
    }));

    const provider = (await import('../../src/agent/provider-registry.js')).getProvider('qwen') as InstanceType<typeof mocks.MockQwenProvider> | undefined;
    const stored = mocks.store.get(SESSION);
    const providerSessionId = typeof stored?.providerSessionId === 'string' ? stored.providerSessionId : '';
    expect(providerSessionId).toBeTruthy();
    const drainStartIndex = mocks.emitted.length;
    provider?.flushPending(providerSessionId);
    await flushAsync();

    const drainedEvents = mocks.emitted.slice(drainStartIndex);
    const drainedUsers = drainedEvents.filter((e) =>
      e.session === SESSION
      && e.type === 'user.message'
      && e.payload.clientMessageId === 'cmd-qwen-queued'
    );
    expect(drainedUsers).toHaveLength(1);
    expect(drainedUsers[0]?.payload.text).toBe('queued second');
    const allQueuedUsers = mocks.emitted.filter((e) =>
      e.session === SESSION
      && e.type === 'user.message'
      && e.payload.clientMessageId === 'cmd-qwen-queued'
    );
    expect(allQueuedUsers).toHaveLength(1);
    const queuedAssistantFinal = drainedEvents.find((e) =>
      e.session === SESSION
      && e.type === 'assistant.text'
      && e.payload.streaming === false
      && e.payload.text === 'Qwen: queued second'
    );
    expect(queuedAssistantFinal).toBeDefined();
    const queuedStateAfterDrain = drainedEvents.find((e) =>
      e.session === SESSION
      && e.type === 'session.state'
      && e.payload.state === 'queued'
    );
    expect(queuedStateAfterDrain).toBeUndefined();


    const idleStateEvents = mocks.emitted.filter((e) =>
      e.session === SESSION
      && e.type === 'session.state'
      && e.payload.state === 'idle'
    );
    expect(idleStateEvents.length).toBeGreaterThan(0);
    for (const event of idleStateEvents) {
      expect(Object.prototype.hasOwnProperty.call(event.payload, 'pendingMessages')).toBe(true);
    }
  });

  it('edits and deletes daemon queued transport messages before drain dispatches only the final queue state', async () => {
    await launchSession({
      name: SESSION,
      projectName: 'qwene2e',
      role: 'brain',
      agentType: 'qwen',
      projectDir: '/tmp/qwen-e2e',
    });

    const serverLink = { send: vi.fn(), daemonVersion: 'test' } as any;
    handleWebCommand({
      type: 'session.send',
      session: SESSION,
      text: 'slow first',
      commandId: 'cmd-qwen-edit-slow',
    }, serverLink);
    await flushAsync();

    handleWebCommand({
      type: 'session.send',
      session: SESSION,
      text: 'queued original',
      commandId: 'cmd-qwen-editable',
    }, serverLink);
    await flushAsync();
    handleWebCommand({
      type: 'session.send',
      session: SESSION,
      text: 'queued removed',
      commandId: 'cmd-qwen-removed',
    }, serverLink);
    await flushAsync();

    handleWebCommand({
      type: 'session.edit_queued_message',
      sessionName: SESSION,
      clientMessageId: 'cmd-qwen-editable',
      text: 'queued edited',
      commandId: 'cmd-qwen-edit-control',
    }, serverLink);
    await flushAsync();
    handleWebCommand({
      type: 'session.undo_queued_message',
      sessionName: SESSION,
      clientMessageId: 'cmd-qwen-removed',
      commandId: 'cmd-qwen-undo-control',
    }, serverLink);
    await flushAsync();

    handleWebCommand({ type: 'get_sessions' }, serverLink);
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session_list',
      sessions: expect.arrayContaining([
        expect.objectContaining({
          name: SESSION,
          transportPendingMessages: ['queued edited'],
          transportPendingMessageEntries: [
            { clientMessageId: 'cmd-qwen-editable', text: 'queued edited' },
          ],
        }),
      ]),
    }));
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'command.ack',
      commandId: 'cmd-qwen-edit-control',
      status: 'accepted',
      session: SESSION,
    });
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'command.ack',
      commandId: 'cmd-qwen-undo-control',
      status: 'accepted',
      session: SESSION,
    });

    const provider = (await import('../../src/agent/provider-registry.js')).getProvider('qwen') as InstanceType<typeof mocks.MockQwenProvider> | undefined;
    const providerSessionId = String(mocks.store.get(SESSION)?.providerSessionId ?? '');
    const drainStartIndex = mocks.emitted.length;
    provider?.flushPending(providerSessionId);
    await flushAsync();

    const drainedEvents = mocks.emitted.slice(drainStartIndex);
    expect(drainedEvents.filter((e) =>
      e.session === SESSION
      && e.type === 'user.message'
      && e.payload.clientMessageId === 'cmd-qwen-editable'
      && e.payload.text === 'queued edited',
    )).toHaveLength(1);
    expect(mocks.emitted.find((e) =>
      e.session === SESSION
      && e.type === 'user.message'
      && e.payload.clientMessageId === 'cmd-qwen-removed',
    )).toBeUndefined();
    expect(mocks.emitted.find((e) =>
      e.session === SESSION
      && e.type === 'user.message'
      && e.payload.text === 'queued original',
    )).toBeUndefined();
    expect(drainedEvents.find((e) =>
      e.session === SESSION
      && e.type === 'assistant.text'
      && e.payload.streaming === false
      && e.payload.text === 'Qwen: queued edited',
    )).toBeDefined();
  });

  it('rejects duplicate transport commandId without dispatching a second provider turn', async () => {
    await launchSession({
      name: SESSION,
      projectName: 'qwene2e',
      role: 'brain',
      agentType: 'qwen',
      projectDir: '/tmp/qwen-e2e',
    });

    const serverLink = { send: vi.fn(), daemonVersion: 'test' } as any;
    handleWebCommand({
      type: 'session.send',
      session: SESSION,
      text: 'dedupe once',
      commandId: 'cmd-qwen-dup',
    }, serverLink);
    await flushAsync();
    handleWebCommand({
      type: 'session.send',
      session: SESSION,
      text: 'dedupe twice',
      commandId: 'cmd-qwen-dup',
    }, serverLink);
    await flushAsync();

    const userMessages = mocks.emitted.filter((e) =>
      e.session === SESSION
      && e.type === 'user.message'
      && e.payload.clientMessageId === 'cmd-qwen-dup',
    );
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.payload.text).toBe('dedupe once');

    const duplicateTimelineAck = mocks.emitted.find((e) =>
      e.session === SESSION
      && e.type === 'command.ack'
      && e.payload.commandId === 'cmd-qwen-dup'
      && e.payload.status === 'error'
      && e.payload.error === COMMAND_ACK_ERROR_DUPLICATE_COMMAND_ID,
    );
    expect(duplicateTimelineAck).toBeDefined();
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'command.ack',
      commandId: 'cmd-qwen-dup',
      status: 'error',
      session: SESSION,
      error: COMMAND_ACK_ERROR_DUPLICATE_COMMAND_ID,
    });

    const assistantFinals = mocks.emitted.filter((e) =>
      e.session === SESSION
      && e.type === 'assistant.text'
      && e.payload.streaming === false
      && String(e.payload.text).includes('dedupe'),
    );
    expect(assistantFinals.map((e) => e.payload.text)).toEqual(['Qwen: dedupe once']);
  });

});
