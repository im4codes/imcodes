import { describe, expect, it, vi } from 'vitest';
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Stream,
} from '@agentclientprotocol/sdk/unstable';
import { createAcpClientConnection } from '../../src/agent/providers/acp-client-adapter.js';
import { KimiSdkProvider } from '../../src/agent/providers/kimi-sdk.js';

function createDuplexStreams(): { clientStream: Stream; agentStream: Stream } {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  return {
    clientStream: ndJsonStream(clientToAgent.writable, agentToClient.readable),
    agentStream: ndJsonStream(agentToClient.writable, clientToAgent.readable),
  };
}

describe('acp-client-adapter (@agentclientprotocol/sdk 2.9.1 /unstable)', () => {
  it('bridges client requests, wildcard extension notifications, and write tracking over App API', async () => {
    const { clientStream, agentStream } = createDuplexStreams();
    const seenMethods: string[] = [];
    let agentPeer!: Parameters<Parameters<ReturnType<typeof agent>['onRequest']>[1]>[0]['client'];

    const serverConn = agent()
      .onRequest(methods.agent.initialize, ({ client: peer }) => {
        agentPeer = peer;
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { loadSession: true },
        };
      })
      .onRequest(methods.agent.session.new, () => ({ sessionId: 'sess-1' }))
      .onRequest('*', async ({ method, params }) => {
        seenMethods.push(method);
        if (method === 'session/set_model') return { ok: true, modelId: (params as { modelId?: string }).modelId };
        throw RequestError.methodNotFound(method);
      })
      .onRequest(methods.agent.session.prompt, async ({ client: peer }) => {
        await peer.notify('_imcodes/session/update', {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'usage_update',
            used: 100,
            size: 1000,
            tokens: { inputTokens: 12, outputTokens: 8 },
          },
        });
        await peer.notify('_x.ai/session/update', {
          sessionId: 'sess-1',
          update: { sessionUpdate: 'turn_completed' },
        });
        return {
          stopReason: 'end_turn',
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        };
      })
      .onNotification(methods.agent.session.cancel, () => {
        seenMethods.push('session/cancel');
      })
      .onRequest(methods.agent.session.close, () => ({}))
      .connect(agentStream);

    const extNotifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const clientConn = createAcpClientConnection({
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: async () => {},
      extNotification: async (method, params) => {
        extNotifications.push({ method, params });
      },
      readTextFile: async () => {
        throw RequestError.methodNotFound('fs/read_text_file');
      },
      writeTextFile: async () => {
        throw RequestError.methodNotFound('fs/write_text_file');
      },
    }, clientStream);

    const init = await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);

    const session = await clientConn.newSession({ cwd: '/tmp', mcpServers: [] });
    expect(session.sessionId).toBe('sess-1');

    const modelRes = await clientConn.unstable_setSessionModel?.({
      sessionId: 'sess-1',
      modelId: 'model-next',
    });
    expect(modelRes).toEqual({ ok: true, modelId: 'model-next' });
    expect(seenMethods).toContain('session/set_model');

    await expect(agentPeer.request('unknown/ext_method', { test: true })).rejects.toMatchObject({
      code: -32601,
    });
    await expect(agentPeer.request(methods.client.fs.readTextFile, { sessionId: 'sess-1', path: '/tmp/a' })).rejects.toMatchObject({
      code: -32601,
    });

    const promptRes = await clientConn.prompt({
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'hello' }],
    });
    expect(promptRes.stopReason).toBe('end_turn');
    expect(promptRes.usage).toEqual({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
    expect(clientConn.connection?.writeQueue).toBeInstanceOf(Promise);
    await clientConn.connection?.writeQueue;

    await vi.waitFor(() => {
      expect(extNotifications).toHaveLength(2);
    });
    expect(extNotifications[0]).toEqual({
      method: '_imcodes/session/update',
      params: {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'usage_update',
          used: 100,
          size: 1000,
          tokens: { inputTokens: 12, outputTokens: 8 },
        },
      },
    });
    expect(extNotifications[1].method).toBe('_x.ai/session/update');

    await clientConn.cancel({ sessionId: 'sess-1' });
    await vi.waitFor(() => expect(seenMethods).toContain('session/cancel'));
    await clientConn.closeSession?.({ sessionId: 'sess-1' });

    serverConn.close();
    clientConn.close?.();
    await clientConn.closed;
    expect(clientConn.signal?.aborted).toBe(true);
  });

  it('resolves closed and rejects in-flight prompt cleanly when underlying transport ends', async () => {
    const { PassThrough } = await import('node:stream');
    const { Readable, Writable } = await import('node:stream');
    const clientToAgent = new PassThrough();
    const agentToClient = new PassThrough();
    const clientStream = ndJsonStream(
      Writable.toWeb(clientToAgent) as WritableStream<Uint8Array>,
      Readable.toWeb(agentToClient) as ReadableStream<Uint8Array>,
    );
    const agentStream = ndJsonStream(
      Writable.toWeb(agentToClient) as WritableStream<Uint8Array>,
      Readable.toWeb(clientToAgent) as ReadableStream<Uint8Array>,
    );

    const serverConn = agent()
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
      }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: 'sess-eof' }))
      .onRequest(methods.agent.session.prompt, () => new Promise(() => {}))
      .connect(agentStream);

    const clientConn = createAcpClientConnection({
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: async () => {},
      readTextFile: async () => {
        throw RequestError.methodNotFound('fs/read_text_file');
      },
      writeTextFile: async () => {
        throw RequestError.methodNotFound('fs/write_text_file');
      },
    }, clientStream);

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    await clientConn.newSession({ cwd: '/tmp', mcpServers: [] });

    const inflightPrompt = clientConn.prompt({
      sessionId: 'sess-eof',
      prompt: [{ type: 'text', text: 'hung' }],
    });

    agentToClient.end();
    await expect(inflightPrompt).rejects.toThrow();
    await clientConn.closed;
    serverConn.close();
  });

  it('handles 2.9.1 plan_update (items/markdown), plan_removed, and subagent_update smoothly', () => {
    const provider = new KimiSdkProvider();
    const tools: Array<unknown> = [];
    provider.onToolCall((_sid, evt) => tools.push(evt));

    const routeId = 'route-plan-test';
    const state = {
      routeId,
      acpSessionId: 'acp-plan-1',
      cwd: '/tmp',
      modelRevision: 0,
      sessionLoadEpoch: 0,
      loaded: true,
      modeApplied: true,
      promptInFlight: true,
      promptSubmittedGeneration: 1,
      activePromptAdmissions: new Map(),
      turnGeneration: 1,
      settledGeneration: 0,
      replaying: false,
      cancelled: false,
      currentMessageId: null,
      currentText: '',
      toolCalls: new Map(),
      emittedToolSignatures: new Map(),
      lastStatusSignature: null,
    };
    (provider as any).sessions.set(routeId, state);
    (provider as any).acpToRoute.set('acp-plan-1', routeId);

    (provider as any).handleSessionUpdate({
      sessionId: 'acp-plan-1',
      update: {
        sessionUpdate: 'plan_update',
        plan: {
          type: 'items',
          planId: 'p1',
          entries: [{ content: 'Step 1', priority: 'high', status: 'in_progress' }],
        },
      },
    });
    (provider as any).handleSessionUpdate({
      sessionId: 'acp-plan-1',
      update: {
        sessionUpdate: 'plan_update',
        plan: {
          type: 'markdown',
          planId: 'p1',
          markdown: 'Plan markdown summary',
        },
      },
    });
    (provider as any).handleSessionUpdate({
      sessionId: 'acp-plan-1',
      update: { sessionUpdate: 'plan_removed', planId: 'p1' },
    });
    (provider as any).handleSessionUpdate({
      sessionId: 'acp-plan-1',
      update: { sessionUpdate: 'subagent_update', sessionId: 'child-1', title: 'Helper' },
    });

    expect(tools).toHaveLength(2);
    expect((tools[0] as any).input).toEqual({ plan: [{ content: 'Step 1', status: 'in_progress' }] });
    expect((tools[1] as any).input).toEqual({ plan: [{ content: 'Plan markdown summary', status: 'in_progress' }] });
  });
});
