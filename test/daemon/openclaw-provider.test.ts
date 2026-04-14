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
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../shared/agent-message.js';

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
      toolCalling: true,
      approval: false,
      sessionRestore: true,
      multiTurn: true,
      attachments: false,
      reasoningEffort: true,
      supportedEffortLevels: ['off', 'minimal', 'low', 'medium', 'high', 'adaptive'],
      contextSupport: 'full-normalized-context-injection',
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
      // New sessions get canonical OC key: agent:{agentId}:{sessionKey}
      expect(key).toBe('agent___main___my-session');
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

  it('stores and patches the current thinking level', async () => {
    await connectProvider(provider);

    const infos: Array<Record<string, unknown>> = [];
    provider.onSessionInfo?.((_sid, info) => infos.push(info as Record<string, unknown>));
    provider.setSessionEffort('agent___main___sess-1', 'high');

    const ws = lastWs();
    const rpcFrame = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(rpcFrame.method).toBe('sessions.patch');
    expect(rpcFrame.params).toMatchObject({ key: 'agent:main:sess-1', thinkingLevel: 'high' });
    expect(infos).toContainEqual({ effort: 'high' });

    replyToLastRpc();
    await Promise.resolve();
  });

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

    it('passes extraSystemPrompt when provided', async () => {
      await connectProvider(provider);

      const sendPromise = provider.send('sess-1', 'Hello', undefined, 'You are a frontend expert');

      const ws = lastWs();
      const rpcFrame = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(rpcFrame.params.extraSystemPrompt).toBe('You are a frontend expert');

      replyToLastRpc();
      await sendPromise;
    });

    it('sends normalized payload message/system text without caller-side raw fields', async () => {
      await connectProvider(provider);

      const sendPromise = provider.send('sess-1', {
        userMessage: 'ship it',
        assembledMessage: 'Context block\n\nship it',
        systemText: 'Normalized system text',
        messagePreamble: 'Context block',
        attachments: [],
        context: {
          systemText: 'Normalized system text',
          messagePreamble: 'Context block',
          requiredAuthoredContext: [],
          advisoryAuthoredContext: [],
          appliedDocumentVersionIds: [],
          diagnostics: [],
        },
        authority: {
          namespace: { scope: 'personal', projectId: 'sess-1' },
          authoritySource: 'none',
          freshness: 'missing',
          fallbackAllowed: true,
          retryScheduled: false,
          diagnostics: [],
        },
        supportClass: 'full-normalized-context-injection',
        diagnostics: [],
      });

      const ws = lastWs();
      const rpcFrame = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(rpcFrame.params.message).toBe('Context block\n\nship it');
      expect(rpcFrame.params.extraSystemPrompt).toBe('Normalized system text');

      replyToLastRpc();
      await sendPromise;
    });

    it('omits extraSystemPrompt when undefined', async () => {
      await connectProvider(provider);

      const sendPromise = provider.send('sess-1', 'Hello');

      const ws = lastWs();
      const rpcFrame = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(rpcFrame.params.extraSystemPrompt).toBeUndefined();

      replyToLastRpc();
      await sendPromise;
    });

    it('accepts a normalized provider payload', async () => {
      await connectProvider(provider);

      const sendPromise = provider.send('sess-1', {
        userMessage: 'Hello',
        assembledMessage: 'Shared summary\n\nHello',
        systemText: 'Enterprise standard',
        messagePreamble: 'Shared summary',
        attachments: undefined,
        context: {
          systemText: 'Enterprise standard',
          messagePreamble: 'Shared summary',
          requiredAuthoredContext: [],
          advisoryAuthoredContext: [],
          appliedDocumentVersionIds: [],
          diagnostics: [],
        },
        authority: {
          namespace: { scope: 'project_shared', projectId: 'repo' },
          authoritySource: 'processed_remote',
          freshness: 'fresh',
          fallbackAllowed: false,
          retryScheduled: false,
          diagnostics: [],
        },
        supportClass: 'full-normalized-context-injection',
        diagnostics: [],
      });

      const ws = lastWs();
      const rpcFrame = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(rpcFrame.params.message).toBe('Shared summary\n\nHello');
      expect(rpcFrame.params.extraSystemPrompt).toBe('Enterprise standard');

      replyToLastRpc();
      await sendPromise;
    });

    it('rejects normalized payloads combined with legacy extraSystemPrompt', async () => {
      await connectProvider(provider);

      await expect(provider.send('sess-1', {
        userMessage: 'Hello',
        assembledMessage: 'Shared summary\n\nHello',
        systemText: 'Enterprise standard',
        messagePreamble: 'Shared summary',
        attachments: undefined,
        context: {
          systemText: 'Enterprise standard',
          messagePreamble: 'Shared summary',
          requiredAuthoredContext: [],
          advisoryAuthoredContext: [],
          appliedDocumentVersionIds: [],
          diagnostics: [],
        },
        authority: {
          namespace: { scope: 'project_shared', projectId: 'repo' },
          authoritySource: 'processed_remote',
          freshness: 'fresh',
          fallbackAllowed: false,
          retryScheduled: false,
          diagnostics: [],
        },
        supportClass: 'full-normalized-context-injection',
        diagnostics: [],
      }, undefined, 'legacy raw context')).rejects.toThrow(/legacy extraSystemPrompt/i);
    });
  });

  // 4b. endSession()
  describe('endSession()', () => {
    it('sends sessions.delete RPC with unsanitized key', async () => {
      await connectProvider(provider);

      const endPromise = provider.endSession('agent___main___my-channel');

      const ws = lastWs();
      const rpcFrame = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(rpcFrame.type).toBe('req');
      expect(rpcFrame.method).toBe('sessions.delete');
      expect(rpcFrame.params.key).toBe('agent:main:my-channel');

      replyToLastRpc();
      await endPromise;
    });

    it('does not throw when sessions.delete fails', async () => {
      await connectProvider(provider);

      const endPromise = provider.endSession('sess-1');

      replyToLastRpc({ ok: false, error: 'not_found' });
      await expect(endPromise).resolves.toBeUndefined();
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

    it('emits cumulative text in delta (not incremental) for typewriter replacement', async () => {
      await connectProvider(provider);

      const deltas: Array<{ sessionId: string; delta: MessageDelta }> = [];
      provider.onDelta((sessionId, delta) => deltas.push({ sessionId, delta }));

      const runId = 'run-cum-delta';

      // lifecycle start
      emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'start' }, key: 'sess-cd' });

      // 4 incremental deltas (OC sends only `delta` field, no `text`)
      emitAgentEvent({ runId, stream: 'assistant', data: { delta: '收' }, key: 'sess-cd' });
      emitAgentEvent({ runId, stream: 'assistant', data: { delta: '到' }, key: 'sess-cd' });
      emitAgentEvent({ runId, stream: 'assistant', data: { delta: '主' }, key: 'sess-cd' });
      emitAgentEvent({ runId, stream: 'assistant', data: { delta: '人' }, key: 'sess-cd' });

      expect(deltas).toHaveLength(4);
      // Each delta.delta should be cumulative (growing), not just the latest char
      expect(deltas[0].delta.delta).toBe('收');
      expect(deltas[1].delta.delta).toBe('收到');
      expect(deltas[2].delta.delta).toBe('收到主');
      expect(deltas[3].delta.delta).toBe('收到主人');
    });

    it('emits cumulative text when OC provides both text and delta fields', async () => {
      await connectProvider(provider);

      const deltas: Array<{ sessionId: string; delta: MessageDelta }> = [];
      provider.onDelta((sessionId, delta) => deltas.push({ sessionId, delta }));

      const runId = 'run-both-fields';

      emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'start' }, key: 'sess-bf' });

      // OC sends cumulative `text` + incremental `delta`
      emitAgentEvent({ runId, stream: 'assistant', data: { text: 'Hello', delta: 'Hello' }, key: 'sess-bf' });
      emitAgentEvent({ runId, stream: 'assistant', data: { text: 'Hello World', delta: ' World' }, key: 'sess-bf' });

      expect(deltas).toHaveLength(2);
      // delta.delta should be the cumulative acc.text, not the incremental delta
      expect(deltas[0].delta.delta).toBe('Hello');
      expect(deltas[1].delta.delta).toBe('Hello World');
    });

    it('handles non-cumulative text field from OC (same as delta, not growing)', async () => {
      await connectProvider(provider);

      const deltas: Array<{ sessionId: string; delta: MessageDelta }> = [];
      provider.onDelta((sessionId, delta) => deltas.push({ sessionId, delta }));

      const completes: Array<{ sessionId: string; message: AgentMessage }> = [];
      provider.onComplete((sessionId, message) => completes.push({ sessionId, message }));

      const runId = 'run-non-cum';

      emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'start' }, key: 'sess-nc' });

      // OC sends text=delta (non-cumulative text field, same as delta)
      emitAgentEvent({ runId, stream: 'assistant', data: { text: '收到主人，', delta: '收到主人，' }, key: 'sess-nc' });
      emitAgentEvent({ runId, stream: 'assistant', data: { text: '刚查完天气', delta: '刚查完天气' }, key: 'sess-nc' });
      emitAgentEvent({ runId, stream: 'assistant', data: { text: '有事叫我', delta: '有事叫我' }, key: 'sess-nc' });

      expect(deltas).toHaveLength(3);
      // Despite text field not being cumulative, delta.delta should still be cumulative
      expect(deltas[0].delta.delta).toBe('收到主人，');
      expect(deltas[1].delta.delta).toBe('收到主人，刚查完天气');
      expect(deltas[2].delta.delta).toBe('收到主人，刚查完天气有事叫我');

      emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'end' }, key: 'sess-nc' });

      // onComplete should have the full accumulated text
      expect(completes[0].message.content).toBe('收到主人，刚查完天气有事叫我');
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

    it('does not replace messageId if lifecycle.start arrives after assistant output', async () => {
      await connectProvider(provider);

      const deltas: Array<{ sessionId: string; delta: MessageDelta }> = [];
      const completes: Array<{ sessionId: string; message: AgentMessage }> = [];
      provider.onDelta((sessionId, delta) => deltas.push({ sessionId, delta }));
      provider.onComplete((sessionId, message) => completes.push({ sessionId, message }));

      const runId = 'run-late-start';

      emitAgentEvent({ runId, stream: 'assistant', data: { delta: 'Hello' }, key: 'sess-late' });
      const firstMessageId = deltas[0]?.delta.messageId;
      expect(firstMessageId).toBeTruthy();

      emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'start' }, key: 'sess-late' });
      emitAgentEvent({ runId, stream: 'assistant', data: { delta: ' World' }, key: 'sess-late' });
      emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'end' }, key: 'sess-late' });

      expect(deltas).toHaveLength(2);
      expect(deltas[0].delta.messageId).toBe(firstMessageId);
      expect(deltas[1].delta.messageId).toBe(firstMessageId);
      expect(deltas[1].delta.delta).toBe('Hello World');
      expect(completes).toHaveLength(1);
      expect(completes[0].message.id).toBe(firstMessageId);
      expect(completes[0].message.content).toBe('Hello World');
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

  describe('agent event: tool stream', () => {
    it('fires running and result tool callbacks with preserved args/result payloads', async () => {
      await connectProvider(provider);

      const tools: Array<{ sessionId: string; tool: ToolCallEvent }> = [];
      provider.onToolCall((sessionId, tool) => tools.push({ sessionId, tool }));

      const runId = 'run-tool-1';
      emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'start' }, key: 'sess-tool' });
      emitAgentEvent({
        runId,
        stream: 'tool',
        key: 'sess-tool',
        data: {
          phase: 'start',
          name: 'bash',
          toolCallId: 'tool-1',
          args: { command: 'pwd' },
          meta: { mutatingAction: false },
        },
      });
      emitAgentEvent({
        runId,
        stream: 'tool',
        key: 'sess-tool',
        data: {
          phase: 'result',
          name: 'bash',
          toolCallId: 'tool-1',
          result: { stdout: '/tmp/project\n' },
          meta: { exitCode: 0 },
        },
      });

      expect(tools).toHaveLength(2);
      expect(tools[0].sessionId).toBe('sess-tool');
      expect(tools[0].tool).toMatchObject({
        id: 'run-tool-1:tool-1',
        name: 'bash',
        status: 'running',
        input: { command: 'pwd' },
      });
      expect(tools[0].tool.detail).toMatchObject({
        kind: 'openclaw.tool',
        input: { command: 'pwd' },
        meta: { mutatingAction: false },
      });
      expect(tools[1].tool).toMatchObject({
        id: 'run-tool-1:tool-1',
        name: 'bash',
        status: 'complete',
        input: { command: 'pwd' },
        output: JSON.stringify({ stdout: '/tmp/project\n' }),
      });
      expect(tools[1].tool.detail).toMatchObject({
        kind: 'openclaw.tool',
        input: { command: 'pwd' },
        output: { stdout: '/tmp/project\n' },
        meta: { exitCode: 0 },
      });
    });

    it('emits tool update events for realistic sessions_send payloads before final result', async () => {
      await connectProvider(provider);

      const tools: Array<{ sessionId: string; tool: ToolCallEvent }> = [];
      provider.onToolCall((sessionId, tool) => tools.push({ sessionId, tool }));

      const runId = 'run-tool-update';
      emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'start' }, key: 'agent:main:discord:channel:123' });
      emitAgentEvent({
        runId,
        stream: 'tool',
        key: 'agent:main:discord:channel:123',
        data: {
          phase: 'start',
          name: 'sessions_send',
          toolCallId: 'tool-3',
          args: { sessionKey: 'agent:emma:main', message: 'hello from openclaw' },
          meta: { mutatingAction: true },
        },
      });
      emitAgentEvent({
        runId,
        stream: 'tool',
        key: 'agent:main:discord:channel:123',
        data: {
          phase: 'update',
          name: 'sessions_send',
          toolCallId: 'tool-3',
          partialResult: { delivered: false, stage: 'queued' },
        },
      });
      emitAgentEvent({
        runId,
        stream: 'tool',
        key: 'agent:main:discord:channel:123',
        data: {
          phase: 'result',
          name: 'sessions_send',
          toolCallId: 'tool-3',
          result: { delivered: true, target: 'agent:emma:main' },
          meta: { durationMs: 42 },
        },
      });

      expect(tools).toHaveLength(3);
      expect(tools[0].sessionId).toBe('agent___main___discord___channel___123');
      expect(tools[0].tool).toMatchObject({
        id: 'run-tool-update:tool-3',
        name: 'sessions_send',
        status: 'running',
        input: { sessionKey: 'agent:emma:main', message: 'hello from openclaw' },
      });
      expect(tools[1].tool).toMatchObject({
        id: 'run-tool-update:tool-3',
        name: 'sessions_send',
        status: 'running',
        output: JSON.stringify({ delivered: false, stage: 'queued' }),
      });
      expect(tools[2].tool).toMatchObject({
        id: 'run-tool-update:tool-3',
        name: 'sessions_send',
        status: 'complete',
        output: JSON.stringify({ delivered: true, target: 'agent:emma:main' }),
      });
      expect(tools[2].tool.detail).toMatchObject({
        kind: 'openclaw.tool',
        meta: { durationMs: 42 },
      });
    });

    it('marks error tool results as error and falls back to payload session key without lifecycle accumulator', async () => {
      await connectProvider(provider);

      const tools: Array<{ sessionId: string; tool: ToolCallEvent }> = [];
      provider.onToolCall((sessionId, tool) => tools.push({ sessionId, tool }));

      emitAgentEvent({
        runId: 'run-tool-err',
        stream: 'tool',
        key: 'agent:main:test:room',
        data: {
          phase: 'result',
          name: 'sessions_send',
          toolCallId: 'tool-2',
          isError: true,
          result: { error: 'target not found' },
        },
      });

      expect(tools).toHaveLength(1);
      expect(tools[0].sessionId).toBe('agent___main___test___room');
      expect(tools[0].tool).toMatchObject({
        id: 'run-tool-err:tool-2',
        name: 'sessions_send',
        status: 'error',
        output: JSON.stringify({ error: 'target not found' }),
      });
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

    it('extracts error message from data.error field', async () => {
      await connectProvider(provider);

      const errors: Array<{ sessionId: string; error: ProviderError }> = [];
      provider.onError((sessionId, error) => errors.push({ sessionId, error }));

      emitAgentEvent({
        runId: 'run-err-field', stream: 'lifecycle',
        data: { phase: 'error', error: 'AI service overloaded' },
        key: 'sess-ef',
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].error.message).toBe('AI service overloaded');
      expect(errors[0].error.code).toBe('PROVIDER_ERROR');
      expect(errors[0].error.recoverable).toBe(true);
    });

    it('extracts error message from data.message field as fallback', async () => {
      await connectProvider(provider);

      const errors: Array<{ sessionId: string; error: ProviderError }> = [];
      provider.onError((sessionId, error) => errors.push({ sessionId, error }));

      emitAgentEvent({
        runId: 'run-msg-field', stream: 'lifecycle',
        data: { phase: 'error', message: 'OAuth token expired' },
        key: 'sess-mf',
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].error.message).toBe('OAuth token expired');
    });

    it('prefers data.error over data.message when both are present', async () => {
      await connectProvider(provider);

      const errors: Array<{ sessionId: string; error: ProviderError }> = [];
      provider.onError((sessionId, error) => errors.push({ sessionId, error }));

      emitAgentEvent({
        runId: 'run-both-err', stream: 'lifecycle',
        data: { phase: 'error', error: 'primary error', message: 'secondary message' },
        key: 'sess-be',
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].error.message).toBe('primary error');
    });

    it('falls back to generic message when data has no error or message fields', async () => {
      await connectProvider(provider);

      const errors: Array<{ sessionId: string; error: ProviderError }> = [];
      provider.onError((sessionId, error) => errors.push({ sessionId, error }));

      emitAgentEvent({
        runId: 'run-no-msg', stream: 'lifecycle',
        data: { phase: 'error' },
        key: 'sess-nm',
      });

      expect(errors).toHaveLength(1);
      // Should contain a generic fallback message mentioning the session
      expect(errors[0].error.message).toContain('sess-nm');
      expect(errors[0].error.message).toContain('error');
    });
  });

  // 7b. stream: 'error' events (distinct from lifecycle.error)
  describe('agent event: stream error', () => {
    it('fires onError with extracted data.error message on stream error event', async () => {
      await connectProvider(provider);

      const errors: Array<{ sessionId: string; error: ProviderError }> = [];
      provider.onError((sessionId, error) => errors.push({ sessionId, error }));

      emitAgentEvent({
        runId: 'run-stream-err', stream: 'error',
        data: { error: 'Rate limit exceeded' },
        key: 'sess-se',
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].sessionId).toBe('sess-se');
      expect(errors[0].error.message).toBe('Rate limit exceeded');
      expect(errors[0].error.code).toBe('PROVIDER_ERROR');
      expect(errors[0].error.recoverable).toBe(true);
    });

    it('fires onError with data.message fallback on stream error event', async () => {
      await connectProvider(provider);

      const errors: Array<{ sessionId: string; error: ProviderError }> = [];
      provider.onError((sessionId, error) => errors.push({ sessionId, error }));

      emitAgentEvent({
        runId: 'run-stream-err-msg', stream: 'error',
        data: { message: 'Connection timeout' },
        key: 'sess-sem',
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].error.message).toBe('Connection timeout');
    });

    it('fires onError with generic fallback when stream error has no message fields', async () => {
      await connectProvider(provider);

      const errors: Array<{ sessionId: string; error: ProviderError }> = [];
      provider.onError((sessionId, error) => errors.push({ sessionId, error }));

      emitAgentEvent({
        runId: 'run-stream-err-none', stream: 'error',
        data: {},
        key: 'sess-sen',
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].error.message).toBe('Unknown agent error');
    });

    it('uses accumulator sessionId when available for stream error', async () => {
      await connectProvider(provider);

      const errors: Array<{ sessionId: string; error: ProviderError }> = [];
      provider.onError((sessionId, error) => errors.push({ sessionId, error }));

      const runId = 'run-stream-err-acc';

      // Start a run first (creates accumulator)
      emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'start' }, key: 'sess-acc-err' });

      // Stream error arrives — should use the accumulator's sessionId
      emitAgentEvent({ runId, stream: 'error', data: { error: 'Internal failure' }, key: 'different-key' });

      expect(errors).toHaveLength(1);
      // Should use the sessionId from the accumulator (from lifecycle start), not the event's key
      expect(errors[0].sessionId).toBe('sess-acc-err');
      expect(errors[0].error.message).toBe('Internal failure');
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
          { key: 'sess-b', label: 'Beta', updatedAt: 2000 },
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

    it('normalizes discord display names to only keep the #suffix', async () => {
      await connectProvider(provider);

      const listPromise = provider.listSessions();

      replyToLastRpc({
        sessions: [
          { key: 'agent:main:discord:channel:111', displayName: 'discord:1476187408042033309#videos', updatedAt: 1000 },
          { key: 'agent:main:discord:channel:222', displayName: 'discord:#general', updatedAt: 1001 },
        ],
      });

      const sessions = await listPromise;
      expect(sessions.map((s) => s.displayName)).toEqual(['#videos', '#general']);
    });
  });
});
