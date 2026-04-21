import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CopilotSdkProvider,
  copilotSdkRuntimeHooks,
} from '../../../src/agent/providers/copilot-sdk.js';
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
  onPermissionRequest?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
};

function createCopilotHarness(options?: {
  version?: string;
  protocolVersion?: number;
  authenticated?: boolean;
}) {
  const sessions = new Map<string, FakeSession>();
  const createdConfigs: FakeSessionConfig[] = [];
  const resumedConfigs: Array<{ sessionId: string; config: FakeSessionConfig }> = [];
  const deletedSessions: string[] = [];
  let nextSessionId = 1;

  class FakeSession {
    readonly handlers = new Set<(event: Record<string, unknown>) => void>();
    readonly send = vi.fn(async () => {});
    readonly abort = vi.fn(async () => {});
    readonly setModel = vi.fn(async () => {});
    readonly disconnect = vi.fn(async () => {});
    constructor(readonly sessionId: string) {}
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
      version: options?.version ?? '1.0.31',
      protocolVersion: options?.protocolVersion ?? 3,
    }));
    getAuthStatus = vi.fn(async () => ({
      isAuthenticated: options?.authenticated ?? true,
      statusMessage: options?.authenticated === false ? 'sign in required' : 'authenticated',
    }));
    listModels = vi.fn(async () => [{ id: 'gpt-5.4' }]);
    createSession = vi.fn(async (config: FakeSessionConfig) => {
      createdConfigs.push(config);
      const session = new FakeSession(`session-${nextSessionId++}`);
      sessions.set(session.sessionId, session);
      return session;
    });
    resumeSession = vi.fn(async (sessionId: string, config: FakeSessionConfig) => {
      resumedConfigs.push({ sessionId, config });
      const session = sessions.get(sessionId) ?? new FakeSession(sessionId);
      sessions.set(session.sessionId, session);
      return session;
    });
    listSessions = vi.fn(async () => [...sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      summary: `summary:${session.sessionId}`,
      modifiedTime: new Date('2026-01-01T00:00:00Z'),
    })));
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

  it('bridges SDK permission requests into approval callbacks and resolves responses', async () => {
    const harness = createCopilotHarness();
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@github/copilot-sdk');

    const approvals: Array<Record<string, unknown>> = [];
    provider.onApprovalRequest((_, req) => approvals.push(req as Record<string, unknown>));
    await provider.connect({ binaryPath: 'copilot', approvalTimeoutMs: 250 });
    const routeId = await provider.createSession({ sessionKey: 'route-1', cwd: '/tmp/project', agentId: 'gpt-5.4' });

    const client = (provider as unknown as { client?: InstanceType<typeof harness.FakeClient> }).client;
    const permissionHandler = harness.createdConfigs[0]?.onPermissionRequest as ((request: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
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
    }) as typeof import('@github/copilot-sdk');

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
    }) as typeof import('@github/copilot-sdk');

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

  it('rotates poisoned sessions after background-tainted abort and suppresses stale callbacks', async () => {
    const harness = createCopilotHarness();
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@github/copilot-sdk');

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

  it('waits for idle before completing a tool-driven turn with an initially empty assistant message', async () => {
    const harness = createCopilotHarness();
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@github/copilot-sdk');

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

  it('uses normalized payload attachments instead of the raw legacy attachments argument', async () => {
    const harness = createCopilotHarness();
    const provider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: harness.FakeClient,
    }) as typeof import('@github/copilot-sdk');

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
    }) as typeof import('@github/copilot-sdk');

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
    }) as typeof import('@github/copilot-sdk');

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

  it('rejects incompatible versions and unauthenticated clients at connect time', async () => {
    const incompatibleHarness = createCopilotHarness({ version: '0.9.0' });
    const incompatibleProvider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: incompatibleHarness.FakeClient,
    }) as typeof import('@github/copilot-sdk');
    await expect(incompatibleProvider.connect({ binaryPath: 'copilot' })).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
    });

    const authHarness = createCopilotHarness({ authenticated: false });
    const authProvider = new CopilotSdkProvider();
    copilotSdkRuntimeHooks.loadSdk = async () => ({
      CopilotClient: authHarness.FakeClient,
    }) as typeof import('@github/copilot-sdk');
    await expect(authProvider.connect({ binaryPath: 'copilot' })).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });
});
