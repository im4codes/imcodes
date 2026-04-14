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
import { disconnectAll } from '../../src/agent/provider-registry.js';
import { handleWebCommand } from '../../src/daemon/command-handler.js';

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

    handleWebCommand({ type: 'get_sessions' }, serverLink);
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session_list',
      sessions: expect.arrayContaining([
        expect.objectContaining({
          name: SESSION,
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
    provider?.flushPending(providerSessionId);
    await flushAsync();

    const drainedUser = mocks.emitted.find((e) =>
      e.session === SESSION
      && e.type === 'user.message'
      && e.payload.clientMessageId === 'cmd-qwen-queued'
    );
    expect(drainedUser?.payload.text).toBe('queued second');
  });

});
