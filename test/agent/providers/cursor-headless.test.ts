import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CursorHeadlessProvider,
  cursorHeadlessRuntimeHooks,
} from '../../../src/agent/providers/cursor-headless.js';
import { createCursorHeadlessHarness } from '../../cursor-headless-fixture.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import {
  IMCODES_DAEMON_NAMESPACE_ENV,
  IMCODES_DAEMON_PROJECT_NAME_ENV,
  IMCODES_DAEMON_PROJECT_ROOT_ENV,
  IMCODES_DAEMON_SERVER_ID_ENV,
  IMCODES_DAEMON_SESSION_NAME_ENV,
  IMCODES_DAEMON_USER_ID_ENV,
} from '../../../shared/memory-mcp-env.js';
import { MEMORY_MCP_STATUS } from '../../../shared/memory-ws.js';

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
  let tempDirs: string[] = [];

  beforeEach(() => {
    harness = createCursorHeadlessHarness();
    cursorHeadlessRuntimeHooks.loadChildProcess = async () => ({
      execFile: harness.execFile,
      spawn: harness.spawn,
    } as typeof import('node:child_process'));
  });

  afterEach(() => {
    cursorHeadlessRuntimeHooks.loadChildProcess = originalLoadChildProcess;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  it('connects by probing version and authentication status', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-cursor-provider-mcp-'));
    tempDirs.push(dir);
    const provider = new CursorHeadlessProvider();
    await provider.connect({ binaryPath: 'cursor-agent', cursorMcpConfigPath: join(dir, 'mcp.json') });

    expect(harness.execFile.mock.calls.some((call) => Array.isArray(call[1]) && (call[1] as string[]).includes('--version'))).toBe(true);
    expect(harness.execFile.mock.calls.some((call) => Array.isArray(call[1]) && (call[1] as string[]).includes('status'))).toBe(true);
    expect(provider.getMemoryMcpStatus()).toMatchObject({
      providerId: 'cursor-headless',
      status: MEMORY_MCP_STATUS.READY,
      connected: true,
      degradedReasons: [],
    });
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

  it('does not reuse Cursor display labels as the model id on the next turn', async () => {
    const provider = new CursorHeadlessProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const sessionId = await provider.createSession({
      sessionKey: 'route-cursor-model-label',
      cwd: '/tmp/project',
      agentId: 'gpt-5.3-codex',
      resumeId: 'cursor-chat-model-label',
    });

    await provider.send(sessionId, 'first turn');
    const first = harness.lastSpawn();
    expect(first.args).toContainEqual('--model');
    expect(first.args[first.args.indexOf('--model') + 1]).toBe('gpt-5.3-codex');
    first.child.stdout.write(`${JSON.stringify({
      type: 'system.init',
      session_id: 'cursor-chat-model-label',
      // Cursor reports a display label here, not an id accepted by --model.
      model: 'Claude Sonnet 5 300K Medium No Thinking',
    })}\n`);
    first.child.stdout.write(`${JSON.stringify({
      type: 'result.success',
      session_id: 'cursor-chat-model-label',
      result: 'first response',
      model: 'Claude Sonnet 5 300K Medium No Thinking',
    })}\n`);
    first.child.emit('close', 0, null);
    await harness.flush();

    // The second turn is the user-reported failure boundary.  It must retain
    // the canonical id instead of passing the display label back to Cursor.
    await provider.send(sessionId, 'second turn');
    const second = harness.lastSpawn();
    expect(second.args[second.args.indexOf('--model') + 1]).toBe('gpt-5.3-codex');
    second.child.emit('close', 0, null);
    await harness.flush();
  });

  it('refuses a display label as a configured or live model id', async () => {
    const provider = new CursorHeadlessProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const sessionId = await provider.createSession({
      sessionKey: 'route-cursor-invalid-model',
      cwd: '/tmp/project',
      agentId: 'Claude Sonnet 5 300K Medium No Thinking',
      resumeId: 'cursor-chat-invalid-model',
    });

    await provider.send(sessionId, 'use the safe default');
    const spawned = harness.lastSpawn();
    expect(spawned.args).not.toContain('--model');
    spawned.child.emit('close', 0, null);
    await harness.flush();
    provider.setSessionAgentId(sessionId, 'Claude Sonnet 5 300K Medium No Thinking');
    await provider.send(sessionId, 'still use the safe default');
    expect(harness.lastSpawn().args).not.toContain('--model');
    harness.lastSpawn().child.emit('close', 0, null);
    await harness.flush();
  });

  it('passes per-session Memory MCP identity env to the cursor-agent process', async () => {
    harness.state.createChatOutput = 'cursor-chat-mcp\n';
    const provider = new CursorHeadlessProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const sessionId = await provider.createSession({
      sessionKey: 'route-mcp',
      sessionName: 'deck_repo_w1',
      projectName: 'repo',
      serverId: 'srv-bound',
      cwd: '/tmp/project',
      contextNamespace: {
        scope: 'user_private',
        userId: 'user-secret-ish',
        projectId: 'github.com/acme/project',
      },
    });

    await provider.send(sessionId, 'hello');
    const spawned = harness.lastSpawn();

    expect(spawned.args).toContain('--approve-mcps');
    expect(spawned.env).toMatchObject({
      [IMCODES_DAEMON_USER_ID_ENV]: 'user-secret-ish',
      [IMCODES_DAEMON_SESSION_NAME_ENV]: 'deck_repo_w1',
      [IMCODES_DAEMON_PROJECT_NAME_ENV]: 'repo',
      [IMCODES_DAEMON_PROJECT_ROOT_ENV]: '/tmp/project',
      [IMCODES_DAEMON_SERVER_ID_ENV]: 'srv-bound',
    });
    expect(JSON.parse(String(spawned.env?.[IMCODES_DAEMON_NAMESPACE_ENV]))).toEqual({
      scope: 'user_private',
      userId: 'user-secret-ish',
      projectId: 'github.com/acme/project',
    });
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

  it('passes --workspace and -- separator, handles 2026.x nested tool_call and thinking status lifecycle', async () => {
    harness.state.versionOutput = '2026.06.15-03-48-54-da23e37\n';
    const provider = new CursorHeadlessProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const sessionId = await provider.createSession({
      sessionKey: 'route-2026',
      cwd: '/tmp/ws-project',
      agentId: 'anthropic/claude-opus-4.6',
      resumeId: 'cursor-chat-2026',
    });

    const statuses: Array<string | null> = [];
    const tools: Array<{ id: string; name: string; status: string; output?: string }> = [];
    const completed: string[] = [];
    provider.onStatus((_sid, update) => statuses.push(update.status));
    provider.onToolCall((_sid, tc) => tools.push({ id: tc.id, name: tc.name, status: tc.status, output: tc.output }));
    provider.onComplete((_sid, msg) => completed.push(msg.content));

    await provider.send(sessionId, '- leading dash prompt');
    const spawned = harness.lastSpawn();
    const wsIdx = spawned.args.indexOf('--workspace');
    expect(wsIdx).toBeGreaterThanOrEqual(0);
    expect(spawned.args[wsIdx + 1]).toBe('/tmp/ws-project');
    expect(spawned.args.slice(-2)).toEqual(['--', '- leading dash prompt']);
    expect(spawned.args).toContain('anthropic/claude-opus-4.6');

    spawned.child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cursor-chat-2026', model: 'Composer 2.5' })}\n`);
    spawned.child.stdout.write(`${JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'step 1' })}\n`);
    spawned.child.stdout.write(`${JSON.stringify({ type: 'tool_call', subtype: 'started', call_id: 'call_1', tool_call: { shellToolCall: { args: { command: 'ls' } } } })}\n`);
    spawned.child.stdout.write(`${JSON.stringify({ type: 'tool_call', subtype: 'completed', call_id: 'call_1', tool_call: { shellToolCall: { args: { command: 'ls' }, result: { error: { message: 'denied' } } } } })}\n`);
    spawned.child.stdout.write(`${JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'step 2' })}\n`);
    spawned.child.stdout.write(`${JSON.stringify({ type: 'assistant', timestamp_ms: 100, message: { id: 'm1', content: [{ type: 'text', text: 'Done' }] } })}\n`);
    spawned.child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', session_id: 'cursor-chat-2026', result: 'Done' })}\n`);
    spawned.child.emit('close', 0, null);
    await harness.flush();

    expect(tools).toEqual([
      { id: 'call_1', name: 'shell', status: 'running', output: undefined },
      { id: 'call_1', name: 'shell', status: 'error', output: JSON.stringify({ message: 'denied' }) },
    ]);
    expect(completed).toEqual(['Done']);
    expect(statuses).toContain('thinking');
    expect(statuses.at(-1)).toBeNull();
  });

  it('forwards verified fallback model ids cleanly to --model on start and model switch', async () => {
    const provider = new CursorHeadlessProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const sessionId = await provider.createSession({
      sessionKey: 'route-fallback-model',
      cwd: '/tmp/project',
      agentId: 'composer-2.5-fast',
      resumeId: 'cursor-chat-fallback-model',
    });

    await provider.send(sessionId, 'start with fast');
    const first = harness.lastSpawn();
    expect(first.args[first.args.indexOf('--model') + 1]).toBe('composer-2.5-fast');
    first.child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', session_id: 'cursor-chat-fallback-model', result: 'ok' })}\n`);
    first.child.emit('close', 0, null);
    await harness.flush();

    provider.setSessionAgentId(sessionId, 'composer-2.5');
    await provider.send(sessionId, 'switch to composer 2.5');
    const second = harness.lastSpawn();
    expect(second.args[second.args.indexOf('--model') + 1]).toBe('composer-2.5');
    second.child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', session_id: 'cursor-chat-fallback-model', result: 'ok2' })}\n`);
    second.child.emit('close', 0, null);
    await harness.flush();
  });

  it('skips broken Windows PATH cursor-agent and launches downstream valid agent.cmd entrypoint with fixed flags', async () => {
    const origPlatform = process.platform;
    const origPath = process.env.PATH;
    const origPathExt = process.env.PATHEXT;
    const origLocalAppData = process.env.LOCALAPPDATA;
    const origUserProfile = process.env.USERPROFILE;
    const tmpRoot = mkdtempSync(join(tmpdir(), 'cursor-provider-win-'));
    tempDirs.push(tmpRoot);

    try {
      const badDir = join(tmpRoot, 'bad');
      const goodDir = join(tmpRoot, 'good');
      const verDir = join(goodDir, 'versions', '2026.11.22-e9042b2');
      mkdirSync(badDir, { recursive: true });
      mkdirSync(verDir, { recursive: true });

      writeFileSync(join(badDir, 'cursor-agent'), '#!/bin/sh\n');
      writeFileSync(join(badDir, 'cursor-agent.cmd'), '@echo off\r\necho broken\r\n');

      const fakeNode = join(verDir, 'node.exe');
      const fakeIndex = join(verDir, 'index.js');
      writeFileSync(fakeNode, 'node');
      writeFileSync(fakeIndex, 'console.log("ok");\n');
      writeFileSync(
        join(goodDir, 'agent.cmd'),
        '"%~dp0versions\\2026.11.22-e9042b2\\node.exe" --use-system-ca "%~dp0versions\\2026.11.22-e9042b2\\index.js" %*\r\n',
      );

      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.env.PATH = `${badDir};${goodDir}`;
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
      process.env.LOCALAPPDATA = tmpRoot;
      process.env.USERPROFILE = tmpRoot;

      const execCalls: Array<{ file: string; args: string[] }> = [];
      cursorHeadlessRuntimeHooks.loadChildProcess = async () => ({
        execFile: vi.fn((file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
          execCalls.push({ file, args });
          if (args.includes('--version')) cb(null, '2026.11.22-e9042b2\n', '');
          else if (args.includes('status')) cb(null, 'Logged in\n', '');
          else if (args.includes('create-chat')) cb(null, 'cursor-chat-win\n', '');
          else cb(null, '', '');
          return { stdin: { end: vi.fn() } } as never;
        }),
        spawn: harness.spawn,
      } as unknown as typeof import('node:child_process'));

      const provider = new CursorHeadlessProvider();
      await provider.connect({});
      const sessionId = await provider.createSession({ sessionKey: 'route-win', cwd: tmpRoot });
      await provider.send(sessionId, 'hello windows');

      expect(execCalls.every((c) => c.file === fakeNode && c.args[0] === '--use-system-ca' && c.args[1] === fakeIndex)).toBe(true);
      const spawned = harness.lastSpawn();
      expect(spawned.file).toBe(fakeNode);
      expect(spawned.args.slice(0, 2)).toEqual(['--use-system-ca', fakeIndex]);
      expect(spawned.args.slice(-2)).toEqual(['--', 'hello windows']);

      // Official .cmd -> .ps1 delegation runs fixed `--version` via system powershell.exe to promote `.new`,
      // then re-resolves direct bundled node.exe + index.js so create-chat/send pass prompts via native argv.
      const psDir = join(tmpRoot, 'official-ps');
      const psVerOld = join(psDir, 'versions', '2026.05.05-a1b2c3d');
      const psVerNewStaged = join(psDir, 'versions', '2026.11.22-e9042b2.new');
      const psVerNewPromoted = join(psDir, 'versions', '2026.11.22-e9042b2');
      const promotedNode = join(psVerNewPromoted, 'node.exe');
      const promotedIndex = join(psVerNewPromoted, 'index.js');
      mkdirSync(psVerOld, { recursive: true });
      mkdirSync(psVerNewStaged, { recursive: true });
      writeFileSync(join(psVerOld, 'node.exe'), 'old node');
      writeFileSync(join(psVerOld, 'index.js'), 'ok');
      writeFileSync(join(psVerNewStaged, 'node.exe'), 'new node');
      writeFileSync(join(psVerNewStaged, 'index.js'), 'ok');
      writeFileSync(join(psDir, 'versions', 'promote-staged.cmd'), '@echo off\r\nexit /b 0\r\n');
      const ps1File = join(psDir, 'cursor-agent.ps1');
      writeFileSync(ps1File, [
        '# cursor-agent-promote-staged',
        '$promoteStaged = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Definition) "versions\\promote-staged.cmd"',
        'if (Test-Path -LiteralPath $promoteStaged) { & $promoteStaged }',
        '$scriptPath = Split-Path -parent $MyInvocation.MyCommand.Definition',
        'function Parse-VersionString { param([string]$versionString) $p = $versionString.Split("-")[0].Split("."); return [int]($p[0] + $p[1].PadLeft(2,"0") + $p[2].PadLeft(2,"0")) }',
        '$versionDir = Get-ChildItem -Path "$scriptPath\\versions"',
        '& "$nodePath" "$scriptPath\\versions\\$versionName\\index.js" $args',
      ].join('\n'));
      writeFileSync(join(psDir, 'cursor-agent.cmd'), [
        '@echo off',
        'set "SCRIPT_DIR=%~dp0"',
        'if "%SCRIPT_DIR:~-1%"=="\\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"',
        '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*',
      ].join('\r\n'));

      const brokenNodeDir = join(tmpRoot, 'broken-node');
      mkdirSync(brokenNodeDir, { recursive: true });
      writeFileSync(join(brokenNodeDir, 'index.js'), 'console.log("x");\n');
      writeFileSync(join(brokenNodeDir, 'cursor-agent.cmd'), '"%~dp0missing\\node.exe" "%~dp0index.js" %*\r\n');

      const expectedPsExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      const psExecCalls: Array<{ file: string; args: string[] }> = [];
      cursorHeadlessRuntimeHooks.loadChildProcess = async () => ({
        execFile: vi.fn((file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
          psExecCalls.push({ file, args });
          if (args.includes('--version')) {
            // Simulate official powershell.exe promote hook moving `.new` -> active directory
            if (file === expectedPsExe) {
              renameSync(psVerNewStaged, psVerNewPromoted);
            }
            cb(null, '2026.11.22-e9042b2\n', '');
          } else if (args.includes('status')) cb(null, 'Logged in\n', '');
          else if (args.includes('create-chat')) cb(null, 'cursor-chat-win\n', '');
          else cb(null, '', '');
          return { stdin: { end: vi.fn() } } as never;
        }),
        spawn: harness.spawn,
      } as unknown as typeof import('node:child_process'));

      process.env.PATH = `${brokenNodeDir};${psDir}`;
      const provider2 = new CursorHeadlessProvider();
      await provider2.connect({});
      const sid2 = await provider2.createSession({ sessionKey: 'route-win-ps1', cwd: tmpRoot });
      await provider2.send(sid2, 'run after promote without ps1 second hop');

      // Version check used official PowerShell hook; subsequent create-chat + send invoked promoted node.exe directly
      expect(psExecCalls[0]).toEqual({
        file: expectedPsExe,
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1File, '--version'],
      });
      expect(psExecCalls.slice(1).every((c) => c.file === promotedNode && c.args[0] === promotedIndex)).toBe(true);
      const directSpawn = harness.lastSpawn();
      expect(directSpawn.file).toBe(promotedNode);
      expect(directSpawn.args[0]).toBe(promotedIndex);
      expect(directSpawn.args.slice(-2)).toEqual(['--', 'run after promote without ps1 second hop']);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      process.env.PATH = origPath;
      if (origPathExt === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = origPathExt;
      if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = origLocalAppData;
      if (origUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserProfile;
    }
  });

  it('delivers quoted spaces, JSON, multiline quotes, and trailing backslashes byte-for-byte to a real Node receiver via Windows direct launch', async () => {
    const origPlatform = process.platform;
    const origPath = process.env.PATH;
    const origPathExt = process.env.PATHEXT;
    const origLocalAppData = process.env.LOCALAPPDATA;
    const origUserProfile = process.env.USERPROFILE;
    const tmpRoot = mkdtempSync(join(tmpdir(), 'cursor-real-argv-'));
    tempDirs.push(tmpRoot);

    try {
      const cmdDir = join(tmpRoot, 'cmd-bin');
      mkdirSync(cmdDir, { recursive: true });
      const receiverJs = join(tmpRoot, 'receiver.mjs');
      // Real Node entrypoint: prints received argv after `--` inside result.success
      writeFileSync(receiverJs, [
        'const sep = process.argv.indexOf("--");',
        'const wsIdx = process.argv.indexOf("--workspace");',
        'const receivedPrompt = sep >= 0 ? process.argv[sep + 1] : null;',
        'const receivedWs = wsIdx >= 0 ? process.argv[wsIdx + 1] : null;',
        'if (process.argv.includes("--version")) { console.log("2026.11.22-e9042b2"); process.exit(0); }',
        'if (process.argv.includes("status")) { console.log("Logged in"); process.exit(0); }',
        'if (process.argv.includes("create-chat")) { console.log("chat-real-1"); process.exit(0); }',
        'console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "chat-real-1" }));',
        'console.log(JSON.stringify({ type: "result", subtype: "success", session_id: "chat-real-1", result: JSON.stringify({ prompt: receivedPrompt, workspace: receivedWs }) }));',
      ].join('\n'));

      const wrapperCmd = join(cmdDir, 'cursor-agent.cmd');
      writeFileSync(wrapperCmd, `"${process.execPath}" "${receiverJs}" %*\r\n`);

      // Switch to real child_process with platform='win32' resolution
      const realCp = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      cursorHeadlessRuntimeHooks.loadChildProcess = async () => realCp;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.env.PATH = cmdDir;
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
      process.env.LOCALAPPDATA = tmpRoot;
      process.env.USERPROFILE = tmpRoot;

      const provider = new CursorHeadlessProvider();
      await provider.connect({ binaryPath: wrapperCmd });
      const wsDir = join(tmpRoot, 'ws dir with spaces');
      mkdirSync(wsDir, { recursive: true });
      const sessionId = await provider.createSession({ sessionKey: 'route-real-argv', cwd: wsDir, resumeId: 'chat-real-1' });

      const adversarialPrompts = [
        'say "hello world" and \'single quotes\'',
        '{"key":"val with spaces","nested":{"n":1},"arr":["a","b"]}',
        'line 1 "quoted"\nline 2 "more \\"escaped\\""\n{"ok":true}',
        'C:\\dir with spaces\\sub\\',
      ];

      const results: string[] = [];
      provider.onComplete((_sid, msg) => results.push(msg.content));
      for (const prompt of adversarialPrompts) {
        const donePromise = new Promise<void>((resolve) => {
          const prevLen = results.length;
          const poll = setInterval(() => {
            if (results.length > prevLen) {
              clearInterval(poll);
              resolve();
            }
          }, 10);
        });
        await provider.send(sessionId, prompt);
        await donePromise;
      }

      expect(results.map((r) => JSON.parse(r))).toEqual(
        adversarialPrompts.map((prompt) => ({ prompt, workspace: wsDir })),
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      process.env.PATH = origPath;
      if (origPathExt === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = origPathExt;
      if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = origLocalAppData;
      if (origUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserProfile;
    }
  });

  it('never executes unpromoted .new when promotion fails or exits zero without activating, and falls back safely to healthy old version', async () => {
    const origPlatform = process.platform;
    const origPath = process.env.PATH;
    const origPathExt = process.env.PATHEXT;
    const origLocalAppData = process.env.LOCALAPPDATA;
    const origUserProfile = process.env.USERPROFILE;
    const tmpRoot = mkdtempSync(join(tmpdir(), 'cursor-staged-fail-'));
    tempDirs.push(tmpRoot);

    try {
      const stagedOnlyDir = join(tmpRoot, 'staged-only');
      const stagedOnlyVerNew = join(stagedOnlyDir, 'versions', '2026.12.01-f1e2d3c.new');
      const stagedNewNode = join(stagedOnlyVerNew, 'node.exe');
      mkdirSync(stagedOnlyVerNew, { recursive: true });
      writeFileSync(stagedNewNode, 'staged node');
      writeFileSync(join(stagedOnlyVerNew, 'index.js'), 'ok');
      writeFileSync(join(stagedOnlyDir, 'versions', 'promote-staged.cmd'), '@echo off\r\nexit /b 1\r\n');
      const stagedOnlyPs1 = join(stagedOnlyDir, 'cursor-agent.ps1');
      writeFileSync(stagedOnlyPs1, [
        '# cursor-agent-promote-staged',
        '$promoteStaged = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Definition) "versions\\promote-staged.cmd"',
        'if (Test-Path -LiteralPath $promoteStaged) { & $promoteStaged }',
        '$scriptPath = Split-Path -parent $MyInvocation.MyCommand.Definition',
        'function Parse-VersionString { param([string]$versionString) $p = $versionString.Split("-")[0].Split("."); return [int]($p[0] + $p[1].PadLeft(2,"0") + $p[2].PadLeft(2,"0")) }',
        '$versionDir = Get-ChildItem -Path "$scriptPath\\versions"',
        '& "$nodePath" "$scriptPath\\versions\\$versionName\\index.js" $args',
      ].join('\n'));
      const stagedOnlyCmd = join(stagedOnlyDir, 'cursor-agent.cmd');
      writeFileSync(stagedOnlyCmd, [
        '@echo off',
        '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0cursor-agent.ps1" %*',
      ].join('\r\n'));

      const psExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.env.PATH = stagedOnlyDir;
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
      process.env.LOCALAPPDATA = tmpRoot;
      process.env.USERPROFILE = tmpRoot;

      // Case 1: promoteStep exits non-zero when only `.new` exists -> connect & send both fail without touching `.new/node.exe`
      const calls1: Array<{ file: string; args: string[] }> = [];
      cursorHeadlessRuntimeHooks.loadChildProcess = async () => ({
        execFile: vi.fn((file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
          calls1.push({ file, args });
          cb(new Error('promote failed (exit 1)'), '', 'promote failed');
          return { stdin: { end: vi.fn() } } as never;
        }),
        spawn: harness.spawn,
      } as unknown as typeof import('node:child_process'));

      const provider1 = new CursorHeadlessProvider();
      await expect(provider1.connect({ binaryPath: stagedOnlyCmd })).rejects.toThrow();
      expect(calls1.some((c) => c.file === stagedNewNode)).toBe(false);

      // Even if promotion exits 0 without activating `.new` into an active non-`.new` directory,
      // connect(), createSession(), and send() must NEVER run `.new/node.exe`.
      const calls2: Array<{ file: string; args: string[] }> = [];
      cursorHeadlessRuntimeHooks.loadChildProcess = async () => ({
        execFile: vi.fn((file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
          calls2.push({ file, args });
          if (args.includes('--version')) cb(null, '2026.12.01-f1e2d3c\n', '');
          else cb(null, 'Logged in\n', '');
          return { stdin: { end: vi.fn() } } as never;
        }),
        spawn: harness.spawn,
      } as unknown as typeof import('node:child_process'));

      const provider2 = new CursorHeadlessProvider();
      await expect(provider2.connect({ binaryPath: stagedOnlyCmd })).rejects.toThrow(/staged update did not activate/i);
      expect(calls2).toEqual([{ file: psExe, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stagedOnlyPs1, '--version'] }]);
      expect(calls2.some((c) => c.file === stagedNewNode)).toBe(false);

      // Direct send() / createSession() with staged-only failing promote also never runs `.new/node.exe`
      (provider2 as unknown as { config: Record<string, unknown> }).config = { binaryPath: stagedOnlyCmd };
      const sidStagedOnly = await provider2.createSession({ sessionKey: 'staged-fail-send', cwd: tmpRoot, resumeId: 'chat-staged' });
      await expect(provider2.send(sidStagedOnly, 'should not hit .new')).rejects.toThrow(/did not activate/i);
      expect(calls2.some((c) => c.file === stagedNewNode)).toBe(false);
      expect(harness.spawn).not.toHaveBeenCalled();

      // Even with a `.new` pin written into `versions/active.txt` or root `active.txt`,
      // promote failure OR zero-exit unpromoted hook STILL leaves direct=null and never touches `.new/node.exe`.
      for (const activePinPath of [join(stagedOnlyDir, 'versions', 'active.txt'), join(stagedOnlyDir, 'active.txt')]) {
        writeFileSync(activePinPath, '2026.12.01-f1e2d3c.new\n');
        calls1.length = 0;
        cursorHeadlessRuntimeHooks.loadChildProcess = async () => ({
          execFile: vi.fn((file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
            calls1.push({ file, args });
            cb(new Error('promote failed (exit 1)'), '', 'promote failed');
            return { stdin: { end: vi.fn() } } as never;
          }),
          spawn: harness.spawn,
        } as unknown as typeof import('node:child_process'));
        await expect(new CursorHeadlessProvider().connect({ binaryPath: stagedOnlyCmd })).rejects.toThrow();
        expect(calls1.some((c) => c.file === stagedNewNode)).toBe(false);

        calls2.length = 0;
        cursorHeadlessRuntimeHooks.loadChildProcess = async () => ({
          execFile: vi.fn((file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
            calls2.push({ file, args });
            if (args.includes('--version')) cb(null, '2026.12.01-f1e2d3c\n', '');
            else cb(null, 'Logged in\n', '');
            return { stdin: { end: vi.fn() } } as never;
          }),
          spawn: harness.spawn,
        } as unknown as typeof import('node:child_process'));
        const providerPinned = new CursorHeadlessProvider();
        await expect(providerPinned.connect({ binaryPath: stagedOnlyCmd })).rejects.toThrow(/staged update did not activate/i);
        expect(calls2).toEqual([{ file: psExe, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stagedOnlyPs1, '--version'] }]);
        expect(calls2.some((c) => c.file === stagedNewNode)).toBe(false);

        (providerPinned as unknown as { config: Record<string, unknown> }).config = { binaryPath: stagedOnlyCmd };
        const sidPinned = await providerPinned.createSession({ sessionKey: 'staged-pinned-fail', cwd: tmpRoot, resumeId: 'chat-pinned' });
        await expect(providerPinned.send(sidPinned, 'must not run .new via active.txt')).rejects.toThrow(/did not activate/i);
        expect(calls2.some((c) => c.file === stagedNewNode)).toBe(false);
        expect(harness.spawn).not.toHaveBeenCalled();
        rmSync(activePinPath);
      }

      // Case 2: Old healthy active version + `.new` where promote fails non-zero -> safely falls back to old active version
      const fallbackDir = join(tmpRoot, 'with-old-active');
      const oldVerDir = join(fallbackDir, 'versions', '2026.05.05-a1b2c3d');
      const newVerStagedDir = join(fallbackDir, 'versions', '2026.12.01-f1e2d3c.new');
      const oldNode = join(oldVerDir, 'node.exe');
      const oldIndex = join(oldVerDir, 'index.js');
      const newStagedNode = join(newVerStagedDir, 'node.exe');
      mkdirSync(oldVerDir, { recursive: true });
      mkdirSync(newVerStagedDir, { recursive: true });
      writeFileSync(oldNode, 'old node');
      writeFileSync(oldIndex, 'ok');
      writeFileSync(newStagedNode, 'new node');
      writeFileSync(join(newVerStagedDir, 'index.js'), 'ok');
      writeFileSync(join(fallbackDir, 'versions', 'promote-staged.cmd'), '@echo off\r\nexit /b 1\r\n');
      const fallbackPs1 = join(fallbackDir, 'cursor-agent.ps1');
      writeFileSync(fallbackPs1, [
        '# cursor-agent-promote-staged',
        '$promoteStaged = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Definition) "versions\\promote-staged.cmd"',
        'if (Test-Path -LiteralPath $promoteStaged) { & $promoteStaged }',
        '$scriptPath = Split-Path -parent $MyInvocation.MyCommand.Definition',
        'function Parse-VersionString { param([string]$versionString) $p = $versionString.Split("-")[0].Split("."); return [int]($p[0] + $p[1].PadLeft(2,"0") + $p[2].PadLeft(2,"0")) }',
        '$versionDir = Get-ChildItem -Path "$scriptPath\\versions"',
        '& "$nodePath" "$scriptPath\\versions\\$versionName\\index.js" $args',
      ].join('\n'));
      const fallbackCmd = join(fallbackDir, 'cursor-agent.cmd');
      writeFileSync(fallbackCmd, [
        '@echo off',
        '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0cursor-agent.ps1" %*',
      ].join('\r\n'));

      const fallbackCalls: Array<{ file: string; args: string[] }> = [];
      cursorHeadlessRuntimeHooks.loadChildProcess = async () => ({
        execFile: vi.fn((file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
          fallbackCalls.push({ file, args });
          if (file === psExe) {
            cb(new Error('promote failed (exit 1)'), '', 'promote failed');
          } else if (args.includes('--version')) {
            cb(null, '2026.05.05-a1b2c3d\n', '');
          } else if (args.includes('status')) {
            cb(null, 'Logged in\n', '');
          } else if (args.includes('create-chat')) {
            cb(null, 'cursor-chat-fallback\n', '');
          } else {
            cb(null, '', '');
          }
          return { stdin: { end: vi.fn() } } as never;
        }),
        spawn: harness.spawn,
      } as unknown as typeof import('node:child_process'));

      const providerFallback = new CursorHeadlessProvider();
      await providerFallback.connect({ binaryPath: fallbackCmd });
      const sidFallback = await providerFallback.createSession({ sessionKey: 'fallback-old', cwd: tmpRoot });
      await providerFallback.send(sidFallback, 'fallback to healthy active version');

      expect(fallbackCalls.some((c) => c.file === newStagedNode)).toBe(false);
      expect(fallbackCalls.some((c) => c.file === oldNode && c.args[0] === oldIndex && c.args.includes('create-chat'))).toBe(true);
      expect(harness.lastSpawn().file).toBe(oldNode);
      expect(harness.lastSpawn().args[0]).toBe(oldIndex);
      expect(harness.lastSpawn().args.slice(-2)).toEqual(['--', 'fallback to healthy active version']);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      process.env.PATH = origPath;
      if (origPathExt === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = origPathExt;
      if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = origLocalAppData;
      if (origUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserProfile;
    }
  });
});
