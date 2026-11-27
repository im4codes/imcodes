import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CopilotSdkProvider,
  copilotSdkRuntimeHooks,
} from '../../../src/agent/providers/copilot-sdk.js';
import { resolveCopilotExplicitBinaryPathSync } from '../../../src/agent/copilot-runtime-config.js';
import { __testing__ as transportRelayTesting } from '../../../src/daemon/transport-relay.js';
import { SESSION_CONTROL_METADATA_COMMAND_FIELD } from '../../../shared/session-control-commands.js';
import { MEMORY_MCP_STATUS } from '../../../shared/memory-ws.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';

vi.mock('../../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

type FakeSessionConfig = Record<string, unknown> & {
  permissions?: {
    onRequest?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  };
  interaction?: {
    onUserInputRequest?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  };
  hooks?: {
    handlers?: {
      onPreToolUse?: (input: Record<string, unknown>) => unknown;
    };
  };
  mcp?: {
    servers?: Record<string, unknown>;
  };
  inference?: {
    reasoningEffort?: string;
  };
  events?: {
    streaming?: boolean;
  };
  onPermissionRequest?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createCopilotHarness(options?: {
  version?: string;
  protocolVersion?: number;
  authenticated?: boolean;
  compact?: () => Promise<Record<string, unknown>>;
}) {
  const sessions = new Map<string, FakeSession>();
  const createdConfigs: FakeSessionConfig[] = [];
  const resumedConfigs: Array<{ sessionId: string; config: FakeSessionConfig }> = [];
  const deletedSessions: string[] = [];
  const listSessionFilters: Array<Record<string, unknown> | undefined> = [];
  let nextSessionId = 1;

  class FakeSession {
    readonly handlers = new Set<(event: Record<string, unknown>) => void>();
    readonly send = vi.fn(async () => {});
    readonly abort = vi.fn(async () => {});
    readonly setModel = vi.fn(async () => {});
    readonly disconnect = vi.fn(async () => {});
    readonly rpc = {
      history: {
        compact: vi.fn(options?.compact ?? (async () => ({
          success: true,
          tokensRemoved: 1234,
          messagesRemoved: 5,
        }))),
      },
    };
    constructor(readonly sessionId: string, readonly config: FakeSessionConfig = {}) {}
    on(handler: (event: Record<string, unknown>) => void): () => void {
      this.handlers.add(handler);
      return () => this.handlers.delete(handler);
    }
    emit(event: Record<string, unknown>): void {
      for (const handler of this.handlers) handler(event);
    }
  }

  class FakeClient {
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    getStatus = vi.fn(async () => ({
      version: options?.version ?? '1.0.117',
      protocolVersion: options?.protocolVersion ?? 4,
    }));
    getAuthStatus = vi.fn(async () => ({
      isAuthenticated: options?.authenticated ?? true,
      statusMessage: options?.authenticated === false ? 'sign in required' : 'authenticated',
    }));
    listModels = vi.fn(async () => [{ id: 'gpt-5.4' }]);
    createSession = vi.fn(async (config: FakeSessionConfig) => {
      createdConfigs.push(config);
      const session = new FakeSession(`session-${nextSessionId++}`, config);
      sessions.set(session.sessionId, session);
      return session;
    });
    resumeSession = vi.fn(async (sessionId: string, config: FakeSessionConfig) => {
      resumedConfigs.push({ sessionId, config });
      const session = sessions.get(sessionId) ?? new FakeSession(sessionId, config);
      sessions.set(session.sessionId, session);
      return session;
    });
    listSessions = vi.fn(async (filter?: Record<string, unknown>) => {
      listSessionFilters.push(filter);
      return [...sessions.values()]
        .filter((session) => (
          typeof filter?.workingDirectory !== 'string'
          || session.config.workingDirectory === filter.workingDirectory
        ))
        .map((session) => ({
          sessionId: session.sessionId,
          summary: `summary:${session.sessionId}`,
          modifiedTime: new Date('2026-01-01T00:00:00Z'),
          context: {
            workingDirectory: String(session.config.workingDirectory ?? ''),
          },
        }));
    });
    deleteSession = vi.fn(async (sessionId: string) => {
      deletedSessions.push(sessionId);
      sessions.delete(sessionId);
    });
  }

  return {
    FakeClient,
    sessions,
    createdConfigs,
    resumedConfigs,
    deletedSessions,
    listSessionFilters,
  };
}

describe('CopilotSdkProvider', () => {
  const originalLoadSdk = copilotSdkRuntimeHooks.loadSdk;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    copilotSdkRuntimeHooks.loadSdk = originalLoadSdk;
    vi.useRealTimers();
  });

  it('reports managed MCP ready after the SDK client connects', async () => {
    const harness = createCopilotHarness();
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@microsoft/copilot-sdk');

    expect(provider.getMemoryMcpStatus()).toMatchObject({
      providerId: 'copilot-sdk',
      status: MEMORY_MCP_STATUS.UNKNOWN,
      connected: false,
    });

    await provider.connect({ binaryPath: 'copilot' });

    expect(provider.getMemoryMcpStatus()).toMatchObject({
      providerId: 'copilot-sdk',
      status: MEMORY_MCP_STATUS.READY,
      connected: true,
      degradedReasons: [],
    });
  });

  it('detaches a stale route without disconnecting or silencing its replacement attachment', async () => {
    const harness = createCopilotHarness();
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@microsoft/copilot-sdk');
    const deltas: Array<{ sessionId: string; text: string }> = [];
    provider.onDelta((sessionId, delta) => deltas.push({ sessionId, text: delta.delta }));
    await provider.connect({ binaryPath: 'copilot' });
    await provider.createSession({
      sessionKey: 'route-stale',
      sessionName: 'Stale route',
      cwd: '/tmp/project',
    });
    await provider.createSession({
      sessionKey: 'route-replacement',
      sessionName: 'Replacement route',
      cwd: '/tmp/project',
      resumeId: 'session-1',
      skipCreate: true,
    });
    const sharedSession = harness.sessions.get('session-1');

    await provider.detachSession('route-stale');

    expect(sharedSession?.disconnect).not.toHaveBeenCalled();
    expect((provider as any).sessions.has('route-stale')).toBe(false);
    expect((provider as any).sessions.has('route-replacement')).toBe(true);
    sharedSession?.emit({
      type: 'assistant.message_delta',
      data: {
        messageId: 'replacement-message',
        deltaContent: 'replacement still streams',
      },
    });
    expect(deltas).toEqual([{
      sessionId: 'route-replacement',
      text: 'replacement still streams',
    }]);
    await provider.disconnect();
  });

  it('bridges SDK permission requests into approval callbacks and resolves responses', async () => {
    const harness = createCopilotHarness();
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@microsoft/copilot-sdk');

    const approvals: Array<Record<string, unknown>> = [];
    provider.onApprovalRequest((_, req) => approvals.push(req as Record<string, unknown>));
    await provider.connect({ binaryPath: 'copilot', approvalTimeoutMs: 250 });
    const routeId = await provider.createSession({ sessionKey: 'route-1', cwd: '/tmp/project', agentId: 'gpt-5.4' });

    const client = (provider as unknown as { client?: InstanceType<typeof harness.FakeClient> }).client;
    const permissionHandler = harness.createdConfigs[0]?.permissions?.onRequest;
    expect(permissionHandler).toBeTypeOf('function');

    const pending = permissionHandler?.({ kind: 'shell', fullCommandText: 'printf hello' });
    await vi.advanceTimersByTimeAsync(0);
    expect(approvals).toEqual([
      expect.objectContaining({
        description: 'Allow shell command: printf hello',
        tool: 'shell',
      }),
    ]);

    const approvalRequestId = String(approvals[0]?.id ?? '');
    await provider.respondApproval(routeId, approvalRequestId, true);
    await expect(pending).resolves.toEqual({ kind: 'approved' });
    expect(client?.getStatus).toHaveBeenCalled();
  });

  it('denies permission requests immediately when no approval callbacks are registered', async () => {
    const harness = createCopilotHarness();
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@microsoft/copilot-sdk');

    await provider.connect({ binaryPath: 'copilot' });
    await provider.createSession({ sessionKey: 'route-2', cwd: '/tmp/project' });

    const denied = await (provider as unknown as {
      handlePermissionRequest(routeId: string, request: Record<string, unknown>): Promise<Record<string, unknown>>;
    }).handlePermissionRequest('route-2', { kind: 'shell', command: 'rm -rf /' });

    expect(denied).toEqual({ kind: 'denied-no-approval-rule-and-could-not-request-from-user' });
  });

  it('fails safe when approval callbacks never answer by timing out and denying the request', async () => {
    const harness = createCopilotHarness();
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@microsoft/copilot-sdk');

    provider.onApprovalRequest(() => {});
    await provider.connect({ binaryPath: 'copilot', approvalTimeoutMs: 50 });
    await provider.createSession({ sessionKey: 'route-3', cwd: '/tmp/project' });

    const pending = (provider as unknown as {
      handlePermissionRequest(routeId: string, request: Record<string, unknown>): Promise<Record<string, unknown>>;
    }).handlePermissionRequest('route-3', { kind: 'shell', command: 'sleep 1' });
    await vi.advanceTimersByTimeAsync(49);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ kind: 'denied-no-approval-rule-and-could-not-request-from-user' });
  });

  it('uses Copilot native history.compact for /compact instead of sending it as a prompt', async () => {
    const harness = createCopilotHarness();
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@microsoft/copilot-sdk');

    const statuses: Array<Record<string, unknown>> = [];
    const completions: Array<Record<string, unknown>> = [];
    provider.onStatus((_, status) => statuses.push(status as Record<string, unknown>));
    provider.onComplete((_, message) => completions.push(message as Record<string, unknown>));
    await provider.connect({ binaryPath: 'copilot' });
    const routeId = await provider.createSession({ sessionKey: 'route-compact', cwd: '/tmp/project' });
    const session = harness.sessions.get('session-1');
    expect(session).toBeTruthy();

    await provider.send(routeId, '/compact');

    expect(session?.send).not.toHaveBeenCalled();
    expect(session?.rpc.history.compact).toHaveBeenCalledWith({ trigger: 'manual' });
    expect(statuses).toEqual([
      { status: 'compacting', label: 'Compacting conversation...' },
      { status: null, label: null },
    ]);
    expect(completions).toEqual([
      expect.objectContaining({
        kind: 'system',
        role: 'system',
        content: 'Copilot context compacted.',
        metadata: expect.objectContaining({
          provider: 'copilot-sdk',
          event: 'session.history.compact',
          [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact',
          resumeId: 'session-1',
          tokensRemoved: 1234,
          messagesRemoved: 5,
        }),
      }),
    ]);
  });

  it('deduplicates Copilot compaction_complete events against the history.compact RPC result', async () => {
    const compact = deferred<Record<string, unknown>>();
    const harness = createCopilotHarness({ compact: () => compact.promise });
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@microsoft/copilot-sdk');

    const completions: Array<Record<string, unknown>> = [];
    provider.onComplete((_, message) => completions.push(message as Record<string, unknown>));
    await provider.connect({ binaryPath: 'copilot' });
    const routeId = await provider.createSession({ sessionKey: 'route-compact-event', cwd: '/tmp/project' });
    const session = harness.sessions.get('session-1');
    expect(session).toBeTruthy();

    const sendPromise = provider.send(routeId, '/compact');
    await Promise.resolve();
    session?.emit({
      type: 'session.compaction_complete',
      data: {
        success: true,
        tokensRemoved: 2000,
        messagesRemoved: 7,
        summaryContent: 'summary from sdk event',
        checkpointPath: '/tmp/checkpoint.json',
      },
    });
    compact.resolve({ success: true, tokensRemoved: 1234, messagesRemoved: 5 });
    await sendPromise;

    expect(completions).toHaveLength(1);
    expect(completions[0]).toEqual(expect.objectContaining({
      kind: 'system',
      metadata: expect.objectContaining({
        event: 'session.compaction_complete',
        [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact',
        tokensRemoved: 2000,
        messagesRemoved: 7,
        summaryContent: 'summary from sdk event',
        checkpointPath: '/tmp/checkpoint.json',
      }),
    }));
  });

  it('surfaces a visible provider error when Copilot history.compact is unavailable', async () => {
    const harness = createCopilotHarness();
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@microsoft/copilot-sdk');

    const errors: string[] = [];
    provider.onError((_, error) => errors.push(error.message));
    await provider.connect({ binaryPath: 'copilot' });
    const routeId = await provider.createSession({ sessionKey: 'route-compact-missing', cwd: '/tmp/project' });
    const session = harness.sessions.get('session-1');
    expect(session).toBeTruthy();
    delete (session!.rpc.history as { compact?: unknown }).compact;

    await expect(provider.send(routeId, '/compact')).rejects.toMatchObject({
      message: 'Copilot compact failed: SDK history.compact is unavailable',
    });

    expect(session?.send).not.toHaveBeenCalled();
    expect(errors).toEqual(['Copilot compact failed: SDK history.compact is unavailable']);
  });

  it('cancels an in-flight Copilot compact without later emitting success', async () => {
    const compact = deferred<Record<string, unknown>>();
    const harness = createCopilotHarness({ compact: () => compact.promise });
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@microsoft/copilot-sdk');

    const completions: string[] = [];
    const errors: string[] = [];
    provider.onComplete((_, message) => completions.push(message.content));
    provider.onError((_, error) => errors.push(error.message));
    await provider.connect({ binaryPath: 'copilot' });
    const routeId = await provider.createSession({ sessionKey: 'route-compact-cancel', cwd: '/tmp/project' });
    const session = harness.sessions.get('session-1');
    expect(session).toBeTruthy();

    const sendPromise = provider.send(routeId, '/compact');
    await Promise.resolve();
    await provider.cancel(routeId);
    compact.resolve({ success: true, tokensRemoved: 10, messagesRemoved: 1 });
    await sendPromise;

    expect(session?.abort).toHaveBeenCalledOnce();
    expect(errors).toEqual(['Copilot compact cancelled']);
    expect(completions).toEqual([]);
    await provider.send(routeId, 'after compact cancel');
    expect(session?.send).toHaveBeenCalledOnce();
  });

  it('rotates poisoned sessions after background-tainted abort and suppresses stale callbacks', async () => {
    const harness = createCopilotHarness();
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@microsoft/copilot-sdk');

    await provider.connect({ binaryPath: 'copilot' });
    const routeId = await provider.createSession({ sessionKey: 'route-4', cwd: '/tmp/project', agentId: 'gpt-5.4' });

    const completeEvents: Array<Record<string, unknown>> = [];
    const sessionInfos: Array<Record<string, unknown>> = [];
    provider.onComplete((_, message) => completeEvents.push(message as Record<string, unknown>));
    provider.onSessionInfo((_, info) => sessionInfos.push(info as Record<string, unknown>));

    const session = harness.sessions.get('session-1');
    expect(session).toBeTruthy();
    session?.emit({ type: 'session.background_tasks_changed', data: { backgroundTasks: [{ state: 'running' }] } });

    await provider.cancel(routeId);
    await vi.runAllTimersAsync();

    expect(harness.deletedSessions).toContain('session-1');
    expect(harness.createdConfigs).toHaveLength(2);
    expect(sessionInfos.some((info) => info.resumeId === 'session-2')).toBe(true);

    session?.emit({
      type: 'assistant.message',
      data: { messageId: 'old-msg', content: 'stale content' },
    });
    expect(completeEvents).toHaveLength(0);

    await expect(provider.restoreSession('session-1')).resolves.toBe(false);
    await expect(provider.restoreSession('session-2')).resolves.toBe(true);
    const sessions = await provider.listSessions();
    expect(sessions.some((item) => item.key === 'session-1')).toBe(false);
    expect(sessions.some((item) => item.key === 'session-2')).toBe(true);
  });

  it('scopes session discovery by cwd and returns directory metadata', async () => {
    const harness = createCopilotHarness();
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@microsoft/copilot-sdk');

    await provider.connect({ binaryPath: 'copilot' });
    await provider.createSession({ sessionKey: 'route-a', cwd: '/tmp/project-a' });
    await provider.createSession({ sessionKey: 'route-b', cwd: '/tmp/project-b' });

    await expect(provider.listSessions({ directory: '/tmp/project-b' })).resolves.toEqual([
      expect.objectContaining({
        key: 'session-2',
        directory: '/tmp/project-b',
      }),
    ]);
    expect(harness.listSessionFilters).toEqual([{ workingDirectory: '/tmp/project-b' }]);
  });

  it('waits for idle before completing a tool-driven turn with an initially empty assistant message', async () => {
    const harness = createCopilotHarness();
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@microsoft/copilot-sdk');

    await provider.connect({ binaryPath: 'copilot' });
    const routeId = await provider.createSession({ sessionKey: 'route-5', cwd: '/tmp/project', agentId: 'gpt-5.4' });

    const completions: string[] = [];
    provider.onComplete((sid, message) => {
      if (sid === routeId) completions.push(String(message.content ?? ''));
    });

    await provider.send(routeId, 'Read the attachment and answer');

    const session = Array.from(harness.sessions.values())[0];
    expect(session).toBeTruthy();
    session.emit({
      type: 'assistant.message',
      data: {
        messageId: 'msg-1',
        content: '',
        toolRequests: [{ toolCallId: 'tool-1', name: 'view' }],
      },
    });
    expect(completions).toEqual([]);

    session.emit({
      type: 'assistant.message',
      data: {
        messageId: 'msg-2',
        content: 'COPILOT_ATTACHMENT_OK',
        toolRequests: [],
      },
    });
    expect(completions).toEqual([]);

    session.emit({ type: 'session.idle', data: {} });
    expect(completions).toEqual(['COPILOT_ATTACHMENT_OK']);
  });

  it('converts inclusive v2 assistant.usage into Anthropic-split usage so relay/compaction do not double-count cache writes or reads', async () => {
    const harness = createCopilotHarness();
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@microsoft/copilot-sdk');

    await provider.connect({});
    const routeId = await provider.createSession({ sessionKey: 'route-usage', cwd: '/tmp/project', agentId: 'gpt-5.4' });

    const messages: Array<{ sid: string; metadata: Record<string, unknown> }> = [];
    provider.onComplete((sid, message) => {
      if (sid === routeId) messages.push({ sid, metadata: (message.metadata ?? {}) as Record<string, unknown> });
    });

    await provider.send(routeId, 'Hello');
    const session = Array.from(harness.sessions.values())[0];
    expect(session).toBeTruthy();

    // Case 1: full breakdown (1500 total = 500 uncached + 800 cacheRead + 200 cacheWrite)
    session.emit({
      type: 'assistant.usage',
      data: {
        model: 'gpt-5.4',
        inputTokens: 1500,
        outputTokens: 320,
        cacheReadTokens: 800,
        cacheWriteTokens: 200,
        cost: 0.045,
      },
    });
    session.emit({
      type: 'assistant.message',
      data: { messageId: 'msg-usage', content: 'reply', toolRequests: [] },
    });
    session.emit({ type: 'session.idle', data: {} });

    expect(messages).toHaveLength(1);
    const usage1 = (messages[0].metadata.usage ?? {}) as Record<string, number>;
    expect(usage1).toEqual({
      input_tokens: 500,
      output_tokens: 320,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 200,
    });
    expect(messages[0].metadata.costUsd).toBe(0.045);
    const relayed1 = transportRelayTesting.normalizeUsageUpdatePayload('deck_copilot_usage', usage1, 'gpt-5.4');
    expect(relayed1).toMatchObject({
      inputTokens: 700, // 500 uncached + 200 cacheWrite (not 1700)
      cacheTokens: 800,
      outputTokens: 320,
    });
    expect(Number(relayed1!.inputTokens) + Number(relayed1!.cacheTokens)).toBe(1500);

    // Case 2: cacheWrite only (100 total inclusive of 20 cacheWrite -> relay inputTokens stays 100, not 120)
    await provider.send(routeId, 'Second');
    session.emit({
      type: 'assistant.usage',
      data: {
        model: 'gpt-5.4',
        inputTokens: 100,
        cacheWriteTokens: 20,
      },
    });
    session.emit({
      type: 'assistant.message',
      data: { messageId: 'msg-usage-2', content: 'reply 2', toolRequests: [] },
    });
    session.emit({ type: 'session.idle', data: {} });

    expect(messages).toHaveLength(2);
    const usage2 = (messages[1].metadata.usage ?? {}) as Record<string, number>;
    expect(usage2).toEqual({
      input_tokens: 80,
      cache_creation_input_tokens: 20,
    });
    const relayed2 = transportRelayTesting.normalizeUsageUpdatePayload('deck_copilot_usage', usage2, 'gpt-5.4');
    expect(relayed2?.inputTokens).toBe(100);
    expect('cacheTokens' in relayed2!).toBe(false);
  });

  it('uses normalized payload attachments instead of the raw legacy attachments argument', async () => {
    const harness = createCopilotHarness();
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@microsoft/copilot-sdk');

    await provider.connect({ binaryPath: 'copilot' });
    const routeId = await provider.createSession({ sessionKey: 'route-attachments', cwd: '/tmp/project' });
    const normalizedAttachment: TransportAttachment = {
      daemonPath: '/tmp/project/attached.txt',
      originalName: 'attached.txt',
    };
    const rawAttachment: TransportAttachment = {
      daemonPath: '/tmp/project/legacy.txt',
      originalName: 'legacy.txt',
    };

    await provider.send(routeId, {
      userMessage: 'Read the attachment',
      assembledMessage: 'Read the attachment',
      systemText: undefined,
      messagePreamble: undefined,
      attachments: [normalizedAttachment],
      context: {
        systemText: undefined,
        messagePreamble: undefined,
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: undefined,
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: true,
        retryScheduled: false,
        diagnostics: [],
      },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    }, [rawAttachment]);

    const sendPayload = harness.sessions.get('session-1')?.send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sendPayload.attachments).toEqual([
      { type: 'file', path: '/tmp/project/attached.txt', displayName: 'attached.txt' },
    ]);
  });

  it('rotates even when background taint arrives after cancel', async () => {
    const harness = createCopilotHarness();
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@microsoft/copilot-sdk');

    await provider.connect({ binaryPath: 'copilot' });
    const routeId = await provider.createSession({ sessionKey: 'route-late-taint', cwd: '/tmp/project', agentId: 'gpt-5.4' });

    const infos: Array<Record<string, unknown>> = [];
    provider.onSessionInfo((_, info) => infos.push(info as Record<string, unknown>));

    const session = harness.sessions.get('session-1');
    expect(session).toBeTruthy();
    session!.abort.mockImplementation(async () => {
      queueMicrotask(() => {
        session!.emit({ type: 'session.background_tasks_changed', data: { backgroundTasks: [{ state: 'running' }] } });
      });
    });

    await provider.cancel(routeId);
    await vi.runAllTimersAsync();

    expect(harness.deletedSessions).toContain('session-1');
    expect(infos.some((info) => info.resumeId === 'session-2')).toBe(true);
  });

  it('retains output token and interaction metadata when completing on idle', async () => {
    const harness = createCopilotHarness();
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@microsoft/copilot-sdk');

    await provider.connect({ binaryPath: 'copilot' });
    const routeId = await provider.createSession({ sessionKey: 'route-metadata', cwd: '/tmp/project', agentId: 'gpt-5.4' });

    const completions: Array<Record<string, unknown>> = [];
    provider.onComplete((sid, message) => {
      if (sid === routeId) completions.push(message as Record<string, unknown>);
    });

    await provider.send(routeId, 'reply');
    const session = harness.sessions.get('session-1')!;
    session.emit({ type: 'assistant.message_delta', data: { messageId: 'msg-meta', deltaContent: 'Hello there' } });
    session.emit({ type: 'assistant.message', data: { messageId: 'msg-meta', content: 'Hi', interactionId: 'ix-1' } });
    session.emit({ type: 'assistant.usage', data: { outputTokens: 42, interactionId: 'ix-1' } });
    session.emit({ type: 'session.idle', data: {} });

    expect(completions).toHaveLength(1);
    expect(completions[0].content).toBe('Hello there');
    expect(completions[0].metadata).toMatchObject({
      interactionId: 'ix-1',
      usage: { output_tokens: 42 },
      resumeId: 'session-1',
      model: 'gpt-5.4',
    });
  });

  it('rejects incompatible versions, protocol v3, and unauthenticated clients at connect time', async () => {
    const incompatibleHarness = createCopilotHarness({ version: '0.9.0' });
    const incompatibleProvider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: incompatibleHarness.FakeClient,
    }) as unknown as typeof import('@microsoft/copilot-sdk');
    await expect(incompatibleProvider.connect({ binaryPath: 'copilot' })).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
    });

    const oldProtocolHarness = createCopilotHarness({ version: '1.0.117', protocolVersion: 3 });
    const oldProtocolProvider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: oldProtocolHarness.FakeClient,
    }) as unknown as typeof import('@microsoft/copilot-sdk');
    await expect(oldProtocolProvider.connect({ binaryPath: 'copilot' })).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
    });

    const authHarness = createCopilotHarness({ authenticated: false });
    const authProvider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: authHarness.FakeClient,
    }) as unknown as typeof import('@microsoft/copilot-sdk');
    await expect(authProvider.connect({ binaryPath: 'copilot' })).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });

  it('passes xhigh for max effort inside v2 inference options on createSession, resumeSession, and setModel/setSessionEffort', async () => {
    const harness = createCopilotHarness({ version: '1.0.117', protocolVersion: 4 });
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as unknown as typeof import('@microsoft/copilot-sdk');

    await provider.connect({ binaryPath: 'copilot' });
    const routeId = await provider.createSession({
      sessionKey: 'route-effort',
      cwd: '/tmp/project',
      agentId: 'gpt-5.4',
      effort: 'max',
    });
    expect(harness.createdConfigs[0]).toMatchObject({
      model: 'gpt-5.4',
      inference: { reasoningEffort: 'xhigh' },
      events: { streaming: true },
    });

    provider.setSessionEffort(routeId, 'high');
    const session = harness.sessions.get('session-1');
    expect(session?.setModel).toHaveBeenCalledWith('gpt-5.4', { reasoningEffort: 'high' });

    await provider.createSession({
      sessionKey: 'route-effort-resumed',
      cwd: '/tmp/project',
      agentId: 'gpt-5.4',
      effort: 'max',
      resumeId: 'session-1',
      skipCreate: true,
    });
    expect(harness.resumedConfigs[0]?.config).toMatchObject({
      model: 'gpt-5.4',
      inference: { reasoningEffort: 'xhigh' },
      events: { streaming: true },
    });
  });

  it('uses mode=coding-agent by default and RuntimeConnection.forSpawnedStdio when an explicit absolute binaryPath is given', async () => {
    const harness = createCopilotHarness({ version: '1.0.117', protocolVersion: 4 });
    const clientCtors: unknown[] = [];
    const CapturingClient = class extends harness.FakeClient {
      constructor(opts?: unknown) {
        super();
        clientCtors.push(opts);
      }
    };
    const forSpawnedStdio = vi.fn((opts: { path?: string }) => ({ kind: 'spawned-stdio', path: opts.path }));
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: CapturingClient,
      RuntimeConnection: { forSpawnedStdio },
    }) as unknown as typeof import('@microsoft/copilot-sdk');

    // Without an external binary on PATH/config, falls back to v2 in-process runtime (`mode: 'coding-agent'` only).
    await provider.connect({ binaryPath: 'copilot' });
    expect(clientCtors[0]).toEqual({ mode: 'coding-agent' });
    await provider.disconnect();

    // Explicit existing binary path routes through RuntimeConnection.forSpawnedStdio.
    await provider.connect({ binaryPath: process.execPath });
    expect(forSpawnedStdio).toHaveBeenCalledWith({ path: process.execPath });
    expect(clientCtors[1]).toEqual({
      mode: 'coding-agent',
      runtime: { kind: 'spawned-stdio', path: process.execPath },
    });
    await provider.disconnect();

    // COPILOT_CLI_PATH with valid absolute executable flows into forSpawnedStdio even when config={}.
    const tempDir = await mkdtemp(path.join(tmpdir(), 'copilot-cli-env-'));
    const customCli = path.join(tempDir, 'copilot-v4');
    const origCopilotCliPath = process.env.COPILOT_CLI_PATH;
    try {
      await writeFile(customCli, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(customCli, 0o755);
      process.env.COPILOT_CLI_PATH = customCli;
      await provider.connect({});
      expect(forSpawnedStdio).toHaveBeenCalledWith({ path: customCli });
      expect(clientCtors[2]).toEqual({
        mode: 'coding-agent',
        runtime: { kind: 'spawned-stdio', path: customCli },
      });
      await provider.disconnect();
    } finally {
      if (origCopilotCliPath === undefined) delete process.env.COPILOT_CLI_PATH;
      else process.env.COPILOT_CLI_PATH = origCopilotCliPath;
      await rm(tempDir, { recursive: true, force: true });
    }

    // Even on Windows with legacy copilot on PATH, {} defaults to bundled v2 runtime (never PATH).
    expect(resolveCopilotExplicitBinaryPathSync({
      env: { PATH: 'C:\\legacy-copilot' },
      platform: 'win32',
      isValidFile: () => true,
    })).toBeUndefined();
    expect(resolveCopilotExplicitBinaryPathSync({
      env: { COPILOT_CLI_PATH: 'C:\\v4\\copilot.exe' },
      platform: 'win32',
      isValidFile: (p) => p === 'C:\\v4\\copilot.exe',
    })).toBe('C:\\v4\\copilot.exe');
  });

  it('isolates Stop confirmation, active-turn completion, and tool callbacks across two concurrent sessions', async () => {
    const harness = createCopilotHarness({ version: '1.0.117', protocolVersion: 4 });
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as unknown as typeof import('@microsoft/copilot-sdk');

    const completions: Array<{ sid: string; content: string }> = [];
    const errors: Array<{ sid: string; code: string }> = [];
    const tools: Array<{ sid: string; id: string; name: string; status: string }> = [];
    provider.onComplete((sid, msg) => completions.push({ sid, content: msg.content }));
    provider.onError((sid, err) => errors.push({ sid, code: err.code }));
    provider.onToolCall((sid, tool) => tools.push({ sid, id: tool.id, name: tool.name, status: tool.status }));

    await provider.connect({});
    await provider.createSession({ sessionKey: 'route-stop-a', cwd: '/tmp/pA' });
    await provider.createSession({ sessionKey: 'route-stop-b', cwd: '/tmp/pB' });

    const sA = harness.sessions.get('session-1')!;
    const sB = harness.sessions.get('session-2')!;
    await provider.send('route-stop-a', 'task A');
    await provider.send('route-stop-b', 'task B');

    sA.emit({ type: 'tool.execution_start', data: { toolCallId: 'tool-a', toolName: 'grep' } });
    sB.emit({ type: 'tool.execution_start', data: { toolCallId: 'tool-b-1', toolName: 'view' } });
    sB.emit({ type: 'assistant.message_delta', data: { messageId: 'm-b', deltaContent: 'B working... ' } });

    let aStopSettled = false;
    const stopA = provider.cancelAndWait('route-stop-a').then(() => {
      aStopSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sA.abort).toHaveBeenCalledTimes(1);
    expect(sB.abort).not.toHaveBeenCalled();
    expect(aStopSettled).toBe(false);

    // Session B continues, runs another tool, and goes idle while A's Stop is still pending.
    sB.emit({ type: 'tool.execution_complete', data: { toolCallId: 'tool-b-1', toolName: 'view', success: true } });
    sB.emit({ type: 'tool.execution_start', data: { toolCallId: 'tool-b-2', toolName: 'edit' } });
    sB.emit({ type: 'tool.execution_complete', data: { toolCallId: 'tool-b-2', toolName: 'edit', success: true } });
    sB.emit({ type: 'assistant.message', data: { messageId: 'm-b', content: 'B done cleanly', toolRequests: [] } });
    sB.emit({ type: 'session.idle', data: {} });
    await vi.advanceTimersByTimeAsync(0);

    // B's idle must NOT settle A's Stop, and B completes normally.
    expect(aStopSettled).toBe(false);
    expect(completions).toEqual([{ sid: 'route-stop-b', content: 'B done cleanly' }]);

    // Now A emits its own terminal idle -> only A settles.
    sA.emit({ type: 'session.idle', data: {} });
    await stopA;
    expect(aStopSettled).toBe(true);
    expect(errors).toEqual([{ sid: 'route-stop-a', code: 'CANCELLED' }]);
    expect(completions).toEqual([{ sid: 'route-stop-b', content: 'B done cleanly' }]);
    expect(tools.filter((t) => t.sid === 'route-stop-a').map((t) => t.id)).toEqual(['tool-a']);
    expect(tools.filter((t) => t.sid === 'route-stop-b').map((t) => t.id)).toEqual([
      'tool-b-1',
      'tool-b-1',
      'tool-b-2',
      'tool-b-2',
    ]);
    await provider.disconnect();
  });

  it('wires v2 mcp.servers, hooks.handlers.onPreToolUse native-agent gate, v2 write/read approval labels, and isolates concurrent sessions', async () => {
    const harness = createCopilotHarness({ version: '1.0.117', protocolVersion: 4 });
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as unknown as typeof import('@microsoft/copilot-sdk');

    const gateEvents: Array<{ sessionId: string; toolName: string; requestText: string }> = [];
    provider.setNativeCollaborationGate((sessionId, event) => {
      gateEvents.push({ sessionId, toolName: event.toolName, requestText: event.requestText });
    });

    const deltas: Array<{ sid: string; text: string }> = [];
    const approvals: Array<{ sid: string; id: string; desc: string; tool?: string }> = [];
    provider.onDelta((sid, delta) => deltas.push({ sid, text: delta.delta }));
    provider.onApprovalRequest((sid, req) => approvals.push({ sid, id: req.id, desc: req.description, tool: req.tool }));

    await provider.connect({ binaryPath: 'copilot' });
    const r1 = await provider.createSession({ sessionKey: 'route-iso-1', cwd: '/tmp/p1' });
    const r2 = await provider.createSession({ sessionKey: 'route-iso-2', cwd: '/tmp/p2' });
    expect(r1).toBe('route-iso-1');
    expect(r2).toBe('route-iso-2');

    // v2 MCP + hook wiring
    expect(harness.createdConfigs[0]?.mcp?.servers).toHaveProperty('imcodes-memory');
    const preHook1 = harness.createdConfigs[0]?.hooks?.handlers?.onPreToolUse;
    expect(preHook1).toBeTypeOf('function');
    preHook1?.({ toolName: 'task', toolArgs: { prompt: 'delegate work' } });
    expect(gateEvents).toEqual([
      { sessionId: 'route-iso-1', toolName: 'task', requestText: 'delegate work' },
    ]);

    // Concurrent session delta & approval isolation
    const s1 = harness.sessions.get('session-1')!;
    const s2 = harness.sessions.get('session-2')!;
    s1.emit({ type: 'assistant.message_delta', data: { messageId: 'm-s1', deltaContent: 'from-s1' } });
    s2.emit({ type: 'assistant.message_delta', data: { messageId: 'm-s2', deltaContent: 'from-s2' } });
    expect(deltas).toEqual([
      { sid: 'route-iso-1', text: 'from-s1' },
      { sid: 'route-iso-2', text: 'from-s2' },
    ]);

    const pWrite = harness.createdConfigs[0]!.permissions!.onRequest!({ kind: 'write', fileName: 'src/a.ts' });
    const pRead = harness.createdConfigs[1]!.permissions!.onRequest!({ kind: 'read', path: 'README.md' });
    await vi.advanceTimersByTimeAsync(0);
    expect(approvals).toHaveLength(2);
    expect(approvals[0]).toMatchObject({ sid: 'route-iso-1', desc: 'Allow file write: src/a.ts', tool: 'write' });
    expect(approvals[1]).toMatchObject({ sid: 'route-iso-2', desc: 'Allow file read: README.md', tool: 'read' });

    // Responding on wrong route rejects cleanly without settling the other session's pending approval.
    await expect(provider.respondApproval('route-iso-2', approvals[0].id, true)).rejects.toMatchObject({
      message: expect.stringContaining('Unknown approval request'),
    });
    await provider.respondApproval('route-iso-1', approvals[0].id, true);
    await provider.respondApproval('route-iso-2', approvals[1].id, false);
    await expect(pWrite).resolves.toEqual({ kind: 'approved' });
    await expect(pRead).resolves.toEqual({ kind: 'denied-interactively-by-user' });
    await provider.disconnect();
  });
});
