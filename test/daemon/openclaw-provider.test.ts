import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock WebSocket ──────────────────────────────────────────────────────────

// Container for the last mock WS instance — must be declared before vi.mock
// since Vitest hoists vi.mock but keeps variable declarations in place.
const wsMeta: { last: any } = { last: null };

vi.mock('ws', () => {
  const { EventEmitter } = require('node:events') as typeof import('node:events');

  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    send(data: string) { this.sent.push(data); }
    close() {
      this.readyState = 3;
      this.emit('close', 1000, Buffer.from(''));
    }
    removeAllListeners() { super.removeAllListeners(); return this; }
    constructor(_url?: string) {
      super();
      wsMeta.last = this;
    }
  }

  return { default: MockWebSocket, __esModule: true };
});

/** Typed accessor for the last mock WebSocket instance. */
function lastWs(): any {
  return wsMeta.last;
}

import { OpenClawProvider } from '../../src/agent/providers/openclaw.js';
import type { ProviderError } from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Simulate the standard connect.challenge -> hello-ok handshake. */
function simulateHandshake(): void {
  const ws = lastWs();
  ws.emit(
    'message',
    JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'test-nonce' } }),
  );
  ws.emit(
    'message',
    JSON.stringify({ type: 'event', event: 'hello-ok' }),
  );
}

/** Start connect and complete handshake. */
async function connectProvider(provider: OpenClawProvider): Promise<void> {
  const p = provider.connect({ url: 'ws://test', token: 'tok' });
  simulateHandshake();
  await p;
}

/**
 * Parse the last sent frame from the mock WS and reply with a
 * successful RPC response carrying `payload`.
 */
function replyToLastRpc(payload: unknown = {}): void {
  const ws = lastWs();
  const raw = ws.sent[ws.sent.length - 1];
  const frame = JSON.parse(raw);
  ws.emit(
    'message',
    JSON.stringify({ type: 'res', id: frame.id, ok: true, payload }),
  );
}

/** Reply to the last sent RPC with an error response. */
function replyToLastRpcError(payload: unknown = { error: 'boom' }): void {
  const ws = lastWs();
  const raw = ws.sent[ws.sent.length - 1];
  const frame = JSON.parse(raw);
  ws.emit(
    'message',
    JSON.stringify({ type: 'res', id: frame.id, ok: false, payload }),
  );
}

/** Emit an agent event frame on the mock WS. */
function emitAgentEvent(payload: Record<string, unknown>): void {
  lastWs().emit(
    'message',
    JSON.stringify({ type: 'event', event: 'agent', payload }),
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('OpenClawProvider', () => {
  let provider: OpenClawProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new OpenClawProvider();
  });

  afterEach(async () => {
    await provider.disconnect();
    vi.useRealTimers();
  });

  // 1. Static properties
  it('has correct id, connectionMode, sessionOwnership, and capabilities', () => {
    expect(provider.id).toBe('openclaw');
    expect(provider.connectionMode).toBe('persistent');
    expect(provider.sessionOwnership).toBe('provider');
    expect(provider.capabilities).toEqual({
      streaming: true,
      toolCalling: false,
      approval: false,
      sessionRestore: true,
      multiTurn: true,
      attachments: false,
    });
  });

  // 2. Handshake flow
  describe('connect() handshake', () => {
    it('completes the challenge -> connect -> hello-ok handshake', async () => {
      const connectPromise = provider.connect({ url: 'ws://test', token: 'tok' });
      const ws = lastWs();

      // Gateway sends connect.challenge
      ws.emit(
        'message',
        JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'abc' } }),
      );

      // Provider should have sent a connect request frame
      expect(ws.sent.length).toBe(1);
      const connectFrame = JSON.parse(ws.sent[0]);
      expect(connectFrame.type).toBe('req');
      expect(connectFrame.method).toBe('connect');
      expect(connectFrame.params.auth).toEqual({ token: 'tok' });
      expect(connectFrame.params.role).toBe('operator');
      expect(connectFrame.params.minProtocol).toBe(3);
      expect(connectFrame.params.maxProtocol).toBe(3);
      expect(connectFrame.params.client.id).toBe('gateway-client');

      // Gateway sends hello-ok
      ws.emit(
        'message',
        JSON.stringify({ type: 'event', event: 'hello-ok' }),
      );

      // Promise should resolve without error
      await expect(connectPromise).resolves.toBeUndefined();
    });

    it('rejects when gateway sends error res during handshake', async () => {
      const connectPromise = provider.connect({ url: 'ws://test', token: 'tok' });
      const ws = lastWs();

      ws.emit(
        'message',
        JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'x' } }),
      );

      // Gateway rejects connect
      ws.emit(
        'message',
        JSON.stringify({ type: 'res', ok: false, payload: { error: 'bad token' } }),
      );

      await expect(connectPromise).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    });
  });

  // 3. createSession
  describe('createSession()', () => {
    it('sends sessions.create RPC and returns session key', async () => {
      await connectProvider(provider);

      const createPromise = provider.createSession({
        sessionKey: 'my-session',
        agentId: 'main',
        label: 'Test Session',
      });

      const ws = lastWs();
      const rpcFrame = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(rpcFrame.type).toBe('req');
      expect(rpcFrame.method).toBe('sessions.create');
      expect(rpcFrame.params).toMatchObject({
        key: 'my-session',
        agentId: 'main',
        label: 'Test Session',
      });

      replyToLastRpc({ ok: true });

      const key = await createPromise;
      expect(key).toBe('my-session');
    });

    it('uses bindExistingKey over sessionKey when provided', async () => {
      await connectProvider(provider);

      const createPromise = provider.createSession({
        sessionKey: 'local-key',
        bindExistingKey: 'remote-key',
      });

      const ws = lastWs();
      const rpcFrame = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(rpcFrame.params.key).toBe('remote-key');

      replyToLastRpc();
      const key = await createPromise;
      expect(key).toBe('remote-key');
    });
  });

  // 4. send()
  describe('send()', () => {
    it('sends sessions.send RPC with correct params', async () => {
      await connectProvider(provider);

      const sendPromise = provider.send('sess-1', 'Hello agent');

      const ws = lastWs();
      const rpcFrame = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(rpcFrame.type).toBe('req');
      expect(rpcFrame.method).toBe('sessions.send');
      expect(rpcFrame.params.key).toBe('sess-1');
      expect(rpcFrame.params.message).toBe('Hello agent');
      expect(rpcFrame.params.thinking).toBe('off');
      expect(rpcFrame.params.idempotencyKey).toBeDefined();

      replyToLastRpc();
      await sendPromise;
    });
  });

  // 5. Assistant stream -> fires onDelta
  describe('agent event: assistant stream', () => {
    it('fires onDelta callback with text delta', async () => {
      await connectProvider(provider);

      const deltas: Array<{ sessionId: string; delta: MessageDelta }> = [];
      provider.onDelta((sessionId, delta) => deltas.push({ sessionId, delta }));

      const runId = 'run-1';

      // lifecycle start
      emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'start' }, key: 'sess-1' });

      // assistant delta
      emitAgentEvent({ runId, stream: 'assistant', data: { delta: 'Hello' }, key: 'sess-1' });

      expect(deltas).toHaveLength(1);
      expect(deltas[0].sessionId).toBe('sess-1');
      expect(deltas[0].delta.type).toBe('text');
      expect(deltas[0].delta.delta).toBe('Hello');
      expect(deltas[0].delta.role).toBe('assistant');
    });

    it('creates accumulator on the fly if delta arrives before lifecycle start', async () => {
      await connectProvider(provider);

      const deltas: Array<{ sessionId: string; delta: MessageDelta }> = [];
      provider.onDelta((sessionId, delta) => deltas.push({ sessionId, delta }));

      // assistant delta without prior lifecycle start
      emitAgentEvent({ runId: 'run-x', stream: 'assistant', data: { delta: 'Hi' }, key: 'sess-2' });

      expect(deltas).toHaveLength(1);
      expect(deltas[0].sessionId).toBe('sess-2');
      expect(deltas[0].delta.delta).toBe('Hi');
    });
  });

  // 6. lifecycle start + deltas + lifecycle end -> fires onComplete
  describe('agent event: full lifecycle -> onComplete', () => {
    it('accumulates deltas and fires onComplete with full text on lifecycle end', async () => {
      await connectProvider(provider);

      const completes: Array<{ sessionId: string; message: AgentMessage }> = [];
      provider.onComplete((sessionId, message) => completes.push({ sessionId, message }));

      const runId = 'run-2';

      emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'start' }, key: 'sess-3' });
      emitAgentEvent({ runId, stream: 'assistant', data: { delta: 'Hello ' }, key: 'sess-3' });
      emitAgentEvent({ runId, stream: 'assistant', data: { delta: 'World' }, key: 'sess-3' });
      emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'end' }, key: 'sess-3' });

      expect(completes).toHaveLength(1);
      expect(completes[0].sessionId).toBe('sess-3');
      expect(completes[0].message.content).toBe('Hello World');
      expect(completes[0].message.role).toBe('assistant');
      expect(completes[0].message.kind).toBe('text');
      expect(completes[0].message.status).toBe('complete');
      expect(completes[0].message.sessionId).toBe('sess-3');
    });

    it('uses cumulative text field when provided instead of appending delta', async () => {
      await connectProvider(provider);

      const completes: Array<{ sessionId: string; message: AgentMessage }> = [];
      provider.onComplete((sessionId, message) => completes.push({ sessionId, message }));

      const runId = 'run-cum';

      emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'start' }, key: 'sess-c' });
      // Use cumulative `text` field
      emitAgentEvent({ runId, stream: 'assistant', data: { text: 'Full text', delta: 'text' }, key: 'sess-c' });
      emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'end' }, key: 'sess-c' });

      expect(completes[0].message.content).toBe('Full text');
    });
  });

  // 7. lifecycle error -> fires onError
  describe('agent event: lifecycle error', () => {
    it('fires onError callback on lifecycle error phase', async () => {
      await connectProvider(provider);

      const errors: Array<{ sessionId: string; error: ProviderError }> = [];
      provider.onError((sessionId, error) => errors.push({ sessionId, error }));

      const runId = 'run-err';

      emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'start' }, key: 'sess-e' });
      emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'error', reason: 'OOM' }, key: 'sess-e' });

      expect(errors).toHaveLength(1);
      expect(errors[0].sessionId).toBe('sess-e');
      expect(errors[0].error.code).toBe('PROVIDER_ERROR');
      expect(errors[0].error.recoverable).toBe(true);
    });

    it('fires onError even without a prior lifecycle start', async () => {
      await connectProvider(provider);

      const errors: Array<{ sessionId: string; error: ProviderError }> = [];
      provider.onError((sessionId, error) => errors.push({ sessionId, error }));

      emitAgentEvent({
        runId: 'run-no-start', stream: 'lifecycle', data: { phase: 'error' }, key: 'sess-ns',
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].sessionId).toBe('sess-ns');
    });
  });

  // 8. disconnect()
  describe('disconnect()', () => {
    it('closes WebSocket and clears state', async () => {
      await connectProvider(provider);

      const ws = lastWs();
      await provider.disconnect();

      expect(ws.readyState).toBe(3); // closed
    });

    it('rejects pending RPCs on disconnect', async () => {
      await connectProvider(provider);

      const sendPromise = provider.send('sess-1', 'msg');
      await provider.disconnect();

      await expect(sendPromise).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    });
  });

  // 9. RPC failure (res with ok:false) -> rejects pending promise
  describe('RPC error response', () => {
    it('rejects pending RPC promise when response has ok:false', async () => {
      await connectProvider(provider);

      const ws = lastWs();
      const sentBefore = ws.sent.length;
      const sendPromise = provider.send('sess-1', 'msg');

      // send() tries sessions.send first
      replyToLastRpcError({ error: 'rate limited' });

      // Wait for fallback agent RPC to be sent
      await vi.waitFor(() => {
        expect(ws.sent.length).toBeGreaterThan(sentBefore + 1);
      }, { timeout: 1000 });

      // Reject the fallback agent RPC too
      replyToLastRpcError({ error: 'rate limited' });

      await expect(sendPromise).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
        recoverable: true,
      });
    });
  });

  // 10. listSessions() filters out cron sessions
  describe('listSessions()', () => {
    it('returns sessions excluding those with :cron: in the key', async () => {
      await connectProvider(provider);

      const listPromise = provider.listSessions();

      replyToLastRpc({
        sessions: [
          { key: 'sess-a', label: 'Alpha', agentId: 'main', updatedAt: 1000, percentUsed: 10 },
          { key: 'proj:cron:daily', label: 'Cron Job', agentId: 'cron' },
          { key: 'sess-b', label: 'Beta' },
        ],
      });

      const sessions = await listPromise;
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.key)).toEqual(['sess-a', 'sess-b']);
      expect(sessions[0]).toEqual({
        key: 'sess-a',
        displayName: 'Alpha',
        agentId: 'main',
        updatedAt: 1000,
        percentUsed: 10,
      });
    });

    it('returns empty array when response has no sessions', async () => {
      await connectProvider(provider);

      const listPromise = provider.listSessions();
      replyToLastRpc({});

      const sessions = await listPromise;
      expect(sessions).toEqual([]);
    });
  });
});
