import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Connection, spawnMspConnection, type DuplexTransport } from '@muse-code/sdk';
import { MuseCodeSdkProvider } from '../../src/agent/providers/muse-code-sdk.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type { ProviderError } from '../../src/agent/transport-provider.js';
import { MEMORY_MCP_ENV_KEYS as E } from '../../shared/memory-mcp-env.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';
import { MUSE_SESSION_MCP_CAPABILITY } from '../../shared/muse-mcp.js';

// Keep the real Connection, MuseClient, Session and Turn; only replace process startup.
vi.mock('@muse-code/sdk', async (original) => ({
  ...await original<typeof import('@muse-code/sdk')>(),
  spawnMspConnection: vi.fn(),
}));
vi.mock('../../src/daemon/muse-mcp-config.js', () => ({
  museMcpEnsureOptionsFromConfig: () => ({}),
  prepareMuseSessionMcp: async () => ({ degraded: false }),
}));

function peer() {
  const chunks: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let serial = 0;
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const push = (frame: unknown) => { chunks.push(`${JSON.stringify(frame)}\n`); wake?.(); };
  const transport: DuplexTransport = {
    incoming: {
      async *[Symbol.asyncIterator]() {
        while (!ended || chunks.length) {
          if (chunks.length) yield chunks.shift()!;
          else await new Promise<void>((resolve) => { wake = resolve; });
        }
      },
    },
    async write(chunk) {
      const frame = JSON.parse(chunk);
      requests.push(frame);
      if (frame.id === undefined) return;
      let result: Record<string, unknown> = {};
      if (frame.method === 'session/start' || frame.method === 'session/resume') {
        result = { session: { sessionId: frame.params.sessionId ?? `session-${++serial}` } };
      } else if (frame.method === 'turn/start') {
        result = { disposition: 'started', turnId: `turn-${++serial}` };
      } else if (frame.method === 'usage/read') {
        result = { usage: { window: { usedPercent: 12, windowDurationMins: 300, resetsAtMs: Date.now() + 10000 } } };
      } else if (frame.method === 'turn/interrupt') {
        push({ jsonrpc: '2.0', method: 'turn/completed', params: {
          sessionId: frame.params.sessionId, turnId: frame.params.turnId, terminal: 'cancelled',
        } });
      }
      push({ jsonrpc: '2.0', id: frame.id, result });
    },
    close() { ended = true; wake?.(); },
  };
  const connection = new Connection(transport);
  return {
    connection, requests,
    notify(method: string, params: Record<string, unknown>) { push({ jsonrpc: '2.0', method, params }); },
    answer(sessionId: string, turnId: string, text: string) {
      const itemId = `${turnId}-answer`;
      this.notify('turn/started', { sessionId, turnId });
      this.notify('item/started', { sessionId, item: { itemId, turnId, kind: 'agentMessage', status: 'inProgress', revision: 1, text: '' } });
      this.notify('item/delta', { sessionId, itemId, delta: text, field: 'text' });
      this.notify('item/completed', { sessionId, item: { itemId, turnId, kind: 'agentMessage', status: 'completed', revision: 2, text } });
      this.notify('turn/completed', { sessionId, turnId, terminal: 'succeeded', durationMs: 1 });
    },
  };
}

describe('Muse provider over real SDK notification pump', () => {
  let host: ReturnType<typeof peer>;
  let provider: MuseCodeSdkProvider;
  const completed: AgentMessage[] = [];
  const deltas: MessageDelta[] = [];
  const errors: ProviderError[] = [];
  beforeEach(async () => {
    host = peer(); completed.length = 0; deltas.length = 0; errors.length = 0;
    vi.mocked(spawnMspConnection).mockReturnValue({ initialize: async () => ({
      connection: host.connection, initializeResult: { serverInfo: { name: 'scripted-muse', version: '1.4.6' }, grantedCapabilities: [MUSE_SESSION_MCP_CAPABILITY] },
    }) } as never);
    provider = new MuseCodeSdkProvider();
    provider.onComplete((_sid, message) => completed.push(message));
    provider.onDelta((_sid, delta) => deltas.push(delta));
    provider.onError((_sid, error) => errors.push(error));
    await provider.connect({ cliPath: process.execPath });
  });
  afterEach(async () => {
    // Abnormal EOF settles even an old broken provider's SDK waiter; no orphan test timers.
    await host.connection.close();
    await provider.disconnect();
  });

  it('sends isolated runtime-bound MCP configuration on concurrent managed session starts through the real SDK facade', async () => {
    await Promise.all(['a', 'b'].map((id) => provider.createSession({ sessionKey: id, sessionName: `deck_sub_muse_${id}`, sessionInstanceId: `instance-${id}`, runtimeEpoch: `epoch-${id}`, cwd: process.cwd() })));
    const opens = host.requests.filter((r) => r.method === 'session/start');
    expect(opens).toHaveLength(2);
    for (const [i, id] of ['a', 'b'].entries()) {
      expect(opens[i].params).toMatchObject({ config: { mcpServers: { [IMCODES_MEMORY_MCP_SERVER_NAME]: {
        transport: 'stdio', env: { [E.SESSION_NAME]: `deck_sub_muse_${id}`, [E.SESSION_INSTANCE_ID]: `instance-${id}`, [E.RUNTIME_EPOCH]: `epoch-${id}` },
      } } } });
    }
  });

  it('rebinds a resumed managed session instead of inheriting the global anonymous MCP server', async () => {
    await provider.createSession({ sessionName: 'deck_sub_muse_resume', sessionInstanceId: 'same-instance', runtimeEpoch: 'new-epoch', resumeId: 'native-resume', cwd: process.cwd() });
    expect(host.requests.find((r) => r.method === 'session/resume')?.params).toMatchObject({ sessionId: 'native-resume', config: { mcpServers: { [IMCODES_MEMORY_MCP_SERVER_NAME]: {
      env: { [E.SESSION_NAME]: 'deck_sub_muse_resume', [E.SESSION_INSTANCE_ID]: 'same-instance', [E.RUNTIME_EPOCH]: 'new-epoch' },
    } } } });
  });

  it('refuses managed MCP binding without the native sessionMcp grant', async () => {
    await provider.disconnect();
    await host.connection.close();
    host = peer();
    vi.mocked(spawnMspConnection).mockReturnValue({ initialize: async () => ({ connection: host.connection, initializeResult: { grantedCapabilities: [] } }) } as never);
    await provider.connect({ cliPath: process.execPath });
    await expect(provider.createSession({ sessionName: 'deck_sub_muse_denied', cwd: process.cwd() })).rejects.toMatchObject({ message: expect.stringContaining('did not grant sessionMcp') });
    expect(host.requests.filter((r) => r.method === 'session/start')).toHaveLength(0);
  });

  it('preserves the SDK pump: live text and completion arrive despite quota telemetry', async () => {
    const sid = await provider.createSession({ sessionKey: 'muse-pump', cwd: process.cwd() });
    const sending = provider.send(sid, 'hello');
    await vi.waitFor(() => expect(host.requests.some((r) => r.method === 'turn/start')).toBe(true));
    // Let native admission finish before delivering the live-only delta.
    await new Promise((resolve) => setImmediate(resolve));
    host.notify('usage/changed', { usage: { window: { usedPercent: 12 } } });
    host.answer('session-1', 'turn-2', 'hello from model');
    await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 300 });
    await sending;
    expect(deltas.map((d) => d.delta)).toContain('hello from model');
    expect(completed[0].content).toBe('hello from model');
    expect(errors).toEqual([]);
    expect(host.requests.some((r) => r.method === 'usage/read')).toBe(true);
  });

  it('routes resumed sessions independently and preserves a follow-up started by the completion callback', async () => {
    const sid = await provider.createSession({ sessionKey: 'resume', cwd: process.cwd(), resumeId: 'persisted-session' });
    let next: Promise<void> | undefined;
    provider.onComplete(() => { if (completed.length === 1) next = provider.send(sid, 'follow-up'); });
    await provider.send(sid, 'first');
    host.answer('foreign-session', 'turn-1', 'must not route');
    host.answer('persisted-session', 'turn-1', 'first answer');
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    await next;
    expect(provider.getSessionDiagnostics(sid)).toMatchObject({ inFlight: true, activeTurnId: 'turn-2' });
    host.answer('persisted-session', 'turn-2', 'second answer');
    await vi.waitFor(() => expect(completed).toHaveLength(2));
    expect(completed.map((m) => m.content)).toEqual(['first answer', 'second answer']);
    expect(host.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it('keeps stop responsive while a natively admitted turn is waiting for the model', async () => {
    const sid = await provider.createSession({ sessionKey: 'stop', cwd: process.cwd() });
    await provider.send(sid, 'waiting');
    await provider.cancelAndWait(sid);
    expect(host.requests.filter((r) => r.method === 'turn/interrupt')).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ sessionId: 'session-1', turnId: 'turn-2' }) }),
    ]);
    expect(provider.getActiveWorkSnapshot(sid)?.activeWorkCount).toBe(0);
    expect(completed).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('reports a genuine terminal failure after admission instead of inventing success', async () => {
    const sid = await provider.createSession({ sessionKey: 'failed', cwd: process.cwd() });
    await provider.send(sid, 'will fail');
    host.notify('turn/completed', { sessionId: 'session-1', turnId: 'turn-2', terminal: 'failed', error: { message: 'real model failure', retryable: false } });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({ message: 'real model failure', recoverable: false });
    expect(completed).toEqual([]);
    expect(provider.getActiveWorkSnapshot(sid)?.activeWorkCount).toBe(0);
  });

  it('reports host EOF promptly without waiting for the first-activity watchdog', async () => {
    const sid = await provider.createSession({ sessionKey: 'host-death', cwd: process.cwd() });
    await provider.send(sid, 'waiting');
    await host.connection.close();
    await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 500 });
    expect(errors[0].message).toContain('MSP host died');
    expect(completed).toEqual([]);
    expect(provider.getActiveWorkSnapshot(sid)?.activeWorkCount).toBe(0);
  });

  it('returns native admission without waiting for model completion, and remains busy', async () => {
    const sid = await provider.createSession({ sessionKey: 'muse-admission', cwd: process.cwd() });
    const sending = provider.send(sid, 'slow model');
    const outcome = await Promise.race([
      sending.then(() => 'admitted'),
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 100)),
    ]);
    expect(outcome).toBe('admitted');
    expect(completed).toEqual([]);
    expect(provider.getActiveWorkSnapshot(sid)?.activeWorkCount).toBeGreaterThan(0);
    host.answer('session-1', 'turn-2', 'later response');
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    expect(provider.getActiveWorkSnapshot(sid)?.activeWorkCount).toBe(0);
  });
});
