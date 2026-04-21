import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CursorHeadlessProvider,
  cursorHeadlessRuntimeHooks,
} from '../../../src/agent/providers/cursor-headless.js';
import { createCursorHeadlessHarness } from '../../cursor-headless-fixture.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';

vi.mock('../../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('CursorHeadlessProvider', () => {
  const originalLoadChildProcess = cursorHeadlessRuntimeHooks.loadChildProcess;
  let harness = createCursorHeadlessHarness();

  beforeEach(() => {
    harness = createCursorHeadlessHarness();
    cursorHeadlessRuntimeHooks.loadChildProcess = async () => ({
      execFile: harness.execFile,
      spawn: harness.spawn,
    } as typeof import('node:child_process'));
  });

  afterEach(() => {
    cursorHeadlessRuntimeHooks.loadChildProcess = originalLoadChildProcess;
  });

  it('connects by probing version and authentication status', async () => {
    const provider = new CursorHeadlessProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });

    expect(harness.execFile.mock.calls.some((call) => Array.isArray(call[1]) && (call[1] as string[]).includes('--version'))).toBe(true);
    expect(harness.execFile.mock.calls.some((call) => Array.isArray(call[1]) && (call[1] as string[]).includes('status'))).toBe(true);
  });

  it('rejects when the status probe reports a logged-out account', async () => {
    harness.state.statusOutput = 'Not logged in\n';
    const provider = new CursorHeadlessProvider();
    await expect(provider.connect({ binaryPath: 'cursor-agent' })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('rejects unsupported versions and ambiguous auth probe output', async () => {
    harness.state.versionOutput = 'Cursor Agent 0.9.9\n';
    const oldVersionProvider = new CursorHeadlessProvider();
    await expect(oldVersionProvider.connect({ binaryPath: 'cursor-agent' })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });

    harness = createCursorHeadlessHarness({
      versionOutput: 'Cursor Agent 1.0.0\n',
      statusOutput: 'status probe returned something unexpected\n',
    });
    cursorHeadlessRuntimeHooks.loadChildProcess = async () => ({
      execFile: harness.execFile,
      spawn: harness.spawn,
    } as typeof import('node:child_process'));

    const ambiguousAuthProvider = new CursorHeadlessProvider();
    await expect(ambiguousAuthProvider.connect({ binaryPath: 'cursor-agent' })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

  it('maps version probe failures to provider-not-found and status failures to config errors', async () => {
    harness.state.versionError = new Error('cursor-agent not found');
    const missingBinaryProvider = new CursorHeadlessProvider();
    await expect(missingBinaryProvider.connect({ binaryPath: 'cursor-agent' })).rejects.toMatchObject({
      code: 'PROVIDER_NOT_FOUND',
    });

    harness.state.versionError = null;
    harness.state.statusError = new Error('status probe failed unexpectedly');
    const statusFailureProvider = new CursorHeadlessProvider();
    await expect(statusFailureProvider.connect({ binaryPath: 'cursor-agent' })).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
    });
  });

  it('creates a route id, emits durable session info, and restores by either route or resume id', async () => {
    harness.state.createChatOutput = 'cursor-chat-9\n';
    const provider = new CursorHeadlessProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });

    const sessionInfo: Array<Record<string, unknown>> = [];
    provider.onSessionInfo((_, info) => sessionInfo.push(info as Record<string, unknown>));

    const routeId = await provider.createSession({
      sessionKey: 'route-1',
      cwd: '/tmp/project',
      agentId: 'gpt-5.2',
    });

    expect(routeId).toBe('route-1');
    expect(sessionInfo).toContainEqual({ resumeId: 'cursor-chat-9', model: 'gpt-5.2' });
    expect(provider.capabilities).toMatchObject({
      streaming: true,
      toolCalling: true,
      approval: false,
      sessionRestore: true,
      multiTurn: true,
      attachments: false,
    });
    expect(provider.connectionMode).toBe('local-sdk');
    expect((provider as { listSessions?: unknown }).listSessions).toBeUndefined();
    await expect(provider.restoreSession(routeId)).resolves.toBe(true);
    await expect(provider.restoreSession('cursor-chat-9')).resolves.toBe(true);
    await expect(provider.restoreSession('missing-session')).resolves.toBe(false);
  });

  it('streams cumulative deltas, tool events, and completion from stream-json output', async () => {
    harness.state.createChatOutput = 'cursor-chat-2\n';
    const provider = new CursorHeadlessProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const sessionId = await provider.createSession({
      sessionKey: 'route-2',
      cwd: '/tmp/project',
      agentId: 'gpt-5.2',
    });

    const deltas: string[] = [];
    const completed: string[] = [];
    const tools: Array<{ name: string; status: string; output?: string }> = [];
    const infos: Array<Record<string, unknown>> = [];
    provider.onDelta((_sid, delta) => deltas.push(delta.delta));
    provider.onComplete((_sid, msg) => completed.push(String(msg.content)));
    provider.onToolCall((_sid, tool) => tools.push({ name: tool.name, status: tool.status, output: tool.output }));
    provider.onSessionInfo((_, info) => infos.push(info as Record<string, unknown>));

    await provider.send(sessionId, {
      userMessage: 'ship it',
      assembledMessage: 'Relevant context\n\nship it',
      systemText: 'Normalized system text',
      messagePreamble: 'Relevant context',
      attachments: [],
      context: {
        systemText: 'Normalized system text',
        messagePreamble: 'Relevant context',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'route-2' },
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: true,
        retryScheduled: false,
        diagnostics: [],
      },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    } satisfies ProviderContextPayload);

    const spawned = harness.lastSpawn();
    expect(spawned.file).toBe('cursor-agent');
    expect(spawned.args).toContain('-p');
    expect(spawned.args).toContain('--trust');
    expect(spawned.args).toContain('--force');
    expect(spawned.args).toContain('--output-format');
    expect(spawned.args).toContain('stream-json');
    expect(spawned.args).toContain('--stream-partial-output');
    expect(spawned.args).toContain('--resume');
    expect(spawned.args).toContain('cursor-chat-2');
    expect(spawned.args).toContain('--model');
    expect(spawned.args).toContain('gpt-5.2');
    expect(spawned.args.at(-1)).toBe('Normalized system text\n\nRelevant context\n\nship it');

    spawned.child.stdout.write(`${JSON.stringify({ type: 'system.init', session_id: 'cursor-chat-2', model: 'gpt-5.2', permissionMode: 'default' })}\n`);
    spawned.child.stdout.write(`${JSON.stringify({ type: 'stream_event', session_id: 'cursor-chat-2', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } })}\n`);
    spawned.child.stdout.write(`${JSON.stringify({ type: 'stream_event', session_id: 'cursor-chat-2', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } })}\n`);
    spawned.child.stdout.write(`${JSON.stringify({ type: 'tool_call.started', session_id: 'cursor-chat-2', id: 'tool-1', name: 'shell', input: { command: 'printf hello' } })}\n`);
    spawned.child.stdout.write(`${JSON.stringify({ type: 'tool_call.completed', session_id: 'cursor-chat-2', id: 'tool-1', name: 'shell', output: 'hello' })}\n`);
    spawned.child.stdout.write(`${JSON.stringify({ type: 'assistant', session_id: 'cursor-chat-2', message: { id: 'msg-1', content: [{ type: 'text', text: 'Hello' }] } })}\n`);
    spawned.child.stdout.write(`${JSON.stringify({ type: 'result.success', session_id: 'cursor-chat-2', result: 'Hello', usage: { input_tokens: 3, output_tokens: 2 } })}\n`);
    spawned.child.emit('close', 0, null);
    await harness.flush();

    expect(deltas).toEqual(['Hel', 'Hello']);
    expect(completed).toEqual(['Hello']);
    expect(tools).toEqual([
      { name: 'shell', status: 'running', output: undefined },
      { name: 'shell', status: 'complete', output: 'hello' },
    ]);
    expect(infos).toContainEqual({ resumeId: 'cursor-chat-2', model: 'gpt-5.2' });
  });

  it('cancels the active child process and emits a recoverable cancelled error', async () => {
    const provider = new CursorHeadlessProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const sessionId = await provider.createSession({ sessionKey: 'route-cancel', cwd: '/tmp/project' });

    const errors: Array<Record<string, unknown>> = [];
    provider.onError((_sid, error) => errors.push(error as Record<string, unknown>));

    const sendPromise = provider.send(sessionId, 'reply with nothing');
    await harness.flush();
    await provider.cancel(sessionId);
    await sendPromise;
    await harness.flush();

    expect(harness.lastSpawn().child.killed).toBe(true);
    expect(errors.some((error) => error.code === 'CANCELLED')).toBe(true);
  });
});
