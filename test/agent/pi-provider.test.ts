import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, killProcessTreeMock, actualSpawnRef } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  killProcessTreeMock: vi.fn(async (child: { kill?: () => void }) => { child.kill?.(); }),
  actualSpawnRef: { current: null as typeof import('node:child_process').spawn | null },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  actualSpawnRef.current = actual.spawn;
  return { ...actual, spawn: spawnMock };
});

vi.mock('../../src/util/kill-process-tree.js', () => ({
  killProcessTree: killProcessTreeMock,
}));

import { PiProvider } from '../../src/agent/providers/pi.js';
import {
  PI_SUPPORTED_PACKAGE,
  buildPiRpcArgs,
  piSessionDir,
  resolvePiBinary,
  resolvePiExtensionEntry,
} from '../../src/agent/providers/pi/runtime.js';
import {
  PI_ASSISTANT_EVENT,
  PI_MCP_CONFIG_ENV,
  PI_PROVIDER_API_KEY_ENV,
  PI_RPC_COMMAND,
  PI_RPC_FRAME,
} from '../../shared/pi-agent.js';
import type { AgentMessage, MessageDelta, ProviderError, ProviderStatusUpdate, SessionInfoUpdate, ToolCallEvent } from '../../shared/agent-message.js';
import { INTERACTIVE_QUESTION_TOOL_NAME } from '../../shared/codex-user-input.js';
import { SESSION_CONTROL_METADATA_COMMAND_FIELD } from '../../shared/session-control-commands.js';
import { IMCODES_MCP_TOOL_CATALOG_MODE_ENV } from '../../shared/memory-mcp-env.js';
import { MCP_TOOL_CATALOG_MODES } from '../../shared/mcp-tool-discovery.js';

class FakePiChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  written: Array<Record<string, unknown>> = [];
  onCommand?: (command: Record<string, unknown>) => { success?: boolean; data?: unknown; error?: string } | void;
  stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    write: (chunk: string) => {
      const command = JSON.parse(chunk.trim()) as Record<string, unknown>;
      this.written.push(command);
      if (command.type === PI_RPC_FRAME.EXTENSION_UI_RESPONSE) {
        return true;
      }
      setImmediate(() => this.respond(command));
      return true;
    },
  });

  private respond(command: Record<string, unknown>): void {
    const custom = this.onCommand?.(command);
    if (custom) {
      this.emitFrame({
        type: PI_RPC_FRAME.RESPONSE,
        id: command.id,
        command: command.type,
        success: custom.success ?? true,
        ...(custom.data !== undefined ? { data: custom.data } : {}),
        ...(custom.error !== undefined ? { error: custom.error } : {}),
      });
      return;
    }
    const data = command.type === PI_RPC_COMMAND.GET_STATE
      ? {
          sessionId: 'pi-session-1',
          model: { id: 'MiniMax-M2.7', provider: 'minimax' },
          thinkingLevel: 'medium',
        }
      : undefined;
    this.emitFrame({
      type: PI_RPC_FRAME.RESPONSE,
      id: command.id,
      command: command.type,
      success: true,
      ...(data ? { data } : {}),
    });
  }

  emitFrame(frame: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  kill(): boolean {
    this.emit('exit', 0, null);
    this.emit('close', 0, null);
    return true;
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('PiProvider', () => {
  let provider: PiProvider;
  let child: FakePiChild;
  let deltas: MessageDelta[];
  let completions: AgentMessage[];
  let tools: ToolCallEvent[];

  beforeEach(() => {
    child = new FakePiChild();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);
    killProcessTreeMock.mockClear();
    provider = new PiProvider();
    deltas = [];
    completions = [];
    tools = [];
    provider.onDelta((_sessionId, delta) => deltas.push(delta));
    provider.onComplete((_sessionId, message) => completions.push(message));
    provider.onToolCall((_sessionId, tool) => tools.push(tool));
  });

  afterEach(async () => {
    await provider.disconnect().catch(() => {});
    vi.unstubAllEnvs();
  });

  async function start(): Promise<string> {
    await provider.connect({});
    return provider.createSession({
      sessionKey: 'route-1',
      sessionName: 'deck_test_brain',
      projectName: 'test',
      cwd: '/tmp',
      resumeId: 'pi-session-1',
      agentId: 'MiniMax-M2.7',
      effort: 'medium',
      piLlm: {
        provider: 'minimax',
        model: 'MiniMax-M2.7',
        baseUrl: 'https://api.minimax.io/anthropic',
        apiKey: 'sk-child-only',
      },
    });
  }

  it('confirms Stop only after the captured child agent terminal, not abort ACK', async () => {
    const sessionId = await start();
    await provider.send(sessionId, 'foreground');
    let settled = false;
    const stopping = provider.cancelAndWait(sessionId).then(() => { settled = true; });
    await flush();
    expect(child.written.some((command) => command.type === PI_RPC_COMMAND.ABORT)).toBe(true);
    expect(settled).toBe(false);
    child.emitFrame({ type: PI_RPC_FRAME.AGENT_SETTLED });
    await stopping;
    expect(settled).toBe(true);
  });

  it('streams strict LF JSONL, tool lifecycle, usage and final completion', async () => {
    const sessionId = await start();
    await provider.send(sessionId, 'inspect this');

    child.emitFrame({
      type: PI_RPC_FRAME.MESSAGE_UPDATE,
      assistantMessageEvent: { type: 'text_delta', delta: 'first\u2028second' },
    });
    child.emitFrame({ type: PI_RPC_FRAME.TOOL_EXECUTION_START, toolCallId: 'tool-1', toolName: 'read', args: { path: 'a.ts' } });
    child.emitFrame({ type: PI_RPC_FRAME.TOOL_EXECUTION_END, toolCallId: 'tool-1', toolName: 'read', result: { content: [{ type: 'text', text: 'ok' }] } });
    child.emitFrame({
      type: PI_RPC_FRAME.MESSAGE_END,
      message: {
        role: 'assistant',
        model: 'MiniMax-M2.7',
        content: [{ type: 'text', text: 'first\u2028second' }],
        usage: { input: 12, output: 3, cacheRead: 4 },
        stopReason: 'stop',
      },
    });
    child.emitFrame({ type: PI_RPC_FRAME.AGENT_SETTLED });
    await flush();

    expect(deltas.at(-1)?.delta).toBe('first\u2028second');
    expect(tools).toEqual([
      expect.objectContaining({ id: 'tool-1', name: 'read', status: 'running' }),
      expect.objectContaining({ id: 'tool-1', name: 'read', status: 'complete', output: 'ok' }),
    ]);
    expect(completions[0]).toMatchObject({
      content: 'first\u2028second',
      metadata: { usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4 } },
    });
  });

  it('uses native steer for an active append without abort or follow-up', async () => {
    const sessionId = await start();
    await provider.send(sessionId, 'first task');
    await expect(provider.notifyActiveDelegation(sessionId, {
      text: 'append now',
      sourceSession: 'deck_sub_source',
    })).resolves.toBe('delivered');
    await flush();

    expect(child.written.filter((command) => command.type === PI_RPC_COMMAND.STEER)).toEqual([
      expect.objectContaining({ type: PI_RPC_COMMAND.STEER, message: 'append now' }),
    ]);
    expect(child.written.some((command) => command.type === PI_RPC_COMMAND.ABORT)).toBe(false);
    expect(child.written.some((command) => command.type === PI_RPC_COMMAND.FOLLOW_UP)).toBe(false);
  });

  it('keeps credentials out of argv and restores the durable Pi session id', async () => {
    const sessionId = await start();
    await provider.send(sessionId, 'hello');
    await flush();

    const [, args, options] = spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(args).toEqual(expect.arrayContaining(['--mode', 'rpc', '--session-id', 'pi-session-1', '--provider', 'minimax', '--model', 'MiniMax-M2.7']));
    expect(args.join(' ')).not.toContain('sk-child-only');
    expect(options.env[PI_PROVIDER_API_KEY_ENV]).toBe('sk-child-only');
    const memoryMcp = JSON.parse(options.env[PI_MCP_CONFIG_ENV]) as { env: Record<string, string> };
    expect(memoryMcp.env[IMCODES_MCP_TOOL_CATALOG_MODE_ENV]).toBe(MCP_TOOL_CATALOG_MODES.DYNAMIC);
  });

  it('builds incognito RPC args with --no-session and omits --session-id, --session-dir, and --name', () => {
    const incognitoArgs = buildPiRpcArgs({
      sessionId: 'should-not-appear',
      sessionName: 'deck_secret_brain',
      requestedModel: 'MiniMax-M2.7',
      effort: 'medium',
      llm: { provider: 'minimax', model: 'MiniMax-M2.7' },
      incognito: true,
    });
    expect(incognitoArgs).toContain('--no-session');
    expect(incognitoArgs).toEqual(expect.arrayContaining(['--mode', 'rpc', '--no-session', '--provider', 'minimax', '--model', 'MiniMax-M2.7', '--thinking', 'medium']));
    expect(incognitoArgs).not.toContain('--session-id');
    expect(incognitoArgs).not.toContain('--session-dir');
    expect(incognitoArgs).not.toContain('--name');
    expect(incognitoArgs).not.toContain('should-not-appear');
    expect(incognitoArgs).not.toContain('deck_secret_brain');

    const normalArgs = buildPiRpcArgs({
      sessionId: 'norm-sid',
      sessionName: 'deck_norm_brain',
      incognito: false,
    });
    expect(normalArgs).not.toContain('--no-session');
    expect(normalArgs).toEqual(expect.arrayContaining(['--session-id', 'norm-sid', '--session-dir', '--name', 'deck_norm_brain']));
  });

  it('isolates incognito sessions: omits MCP memory/env, keeps live child across turns, refuses resume/post-exit respawn, and writes nothing to piSessionDir', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'pi-priv-test-'));
    const tempImcodes = join(tempHome, '.imcodes');
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('IMCODES_HOME', tempImcodes);
    // Simulate inherited PI_MCP_CONFIG_ENV in parent environment to ensure it is stripped for incognito
    vi.stubEnv(PI_MCP_CONFIG_ENV, JSON.stringify({ command: 'node', args: ['leaked.js'], env: {} }));

    try {
      const infoUpdates: Array<Record<string, unknown>> = [];
      provider.onSessionInfo((_id, info) => infoUpdates.push(info as unknown as Record<string, unknown>));

      await provider.connect({});
      await expect(provider.createSession({
        sessionKey: 'priv-bad-resume',
        sessionName: 'deck_priv_bad',
        cwd: '/tmp',
        incognito: true,
        resumeId: 'old-sid',
      })).rejects.toThrow('Incognito conversation cannot be resumed');

      const sessionId = await provider.createSession({
        sessionKey: 'priv-route',
        sessionName: 'deck_priv_brain',
        projectName: 'priv',
        cwd: '/tmp',
        fresh: true,
        incognito: true,
        agentId: 'MiniMax-M2.7',
        effort: 'medium',
        piLlm: {
          provider: 'minimax',
          model: 'MiniMax-M2.7',
          baseUrl: 'https://api.minimax.io/anthropic',
          apiKey: 'sk-priv-only',
        },
      });

      expect(await provider.restoreSession(sessionId)).toBe(false);
      expect(provider.getSessionDiagnostics(sessionId)).toMatchObject({
        incognito: true,
        memoryMcpMounted: false,
      });
      expect(provider.getSessionDiagnostics(sessionId)).not.toHaveProperty('piSessionId');

      await provider.send(sessionId, 'secret turn 1');
      child.emitFrame({ type: PI_RPC_FRAME.MESSAGE_UPDATE, assistantMessageEvent: { type: 'text_delta', delta: 'priv-reply-1' } });
      child.emitFrame({ type: PI_RPC_FRAME.AGENT_SETTLED });
      await flush();

      const [, args, options] = spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string | undefined> }];
      expect(args).toContain('--no-session');
      expect(args).not.toContain('--session-id');
      expect(args).not.toContain('--session-dir');
      expect(args).not.toContain('--name');
      expect(options.env[PI_MCP_CONFIG_ENV]).toBeUndefined();
      expect(infoUpdates.some((u) => 'resumeId' in u && u.resumeId !== undefined)).toBe(false);

      // Multi-turn keeps same in-memory child alive
      await provider.send(sessionId, 'secret turn 2');
      expect(spawnMock).toHaveBeenCalledTimes(1);
      child.emitFrame({ type: PI_RPC_FRAME.MESSAGE_UPDATE, assistantMessageEvent: { type: 'text_delta', delta: 'priv-reply-2' } });
      child.emitFrame({ type: PI_RPC_FRAME.AGENT_SETTLED });
      await flush();
      expect(completions.map((c) => c.content)).toEqual(['priv-reply-1', 'priv-reply-2']);

      // In-place model switch uses SET_MODEL RPC without killing incognito child
      provider.setSessionAgentId(sessionId, 'minimax/MiniMax-M2.8');
      await flush();
      expect(killProcessTreeMock).not.toHaveBeenCalled();
      expect(child.written.some((c) => c.type === PI_RPC_COMMAND.SET_MODEL && c.provider === 'minimax' && c.modelId === 'MiniMax-M2.8')).toBe(true);

      // Once child exits unexpectedly, subsequent sends must fail closed instead of respawning
      child.kill();
      await flush();
      await expect(provider.send(sessionId, 'turn after exit')).rejects.toThrow('Incognito conversation ended');
      expect(spawnMock).toHaveBeenCalledTimes(1);

      expect(existsSync(piSessionDir())).toBe(false);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('smoke-tests real pi --mode rpc --no-session when pi binary is available and writes zero session files', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'pi-real-smoke-'));
    const tempImcodes = join(tempHome, '.imcodes');
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('IMCODES_HOME', tempImcodes);
    const bin = resolvePiBinary();
    const spawnReal = actualSpawnRef.current;
    if (!spawnReal) return;

    try {
      const response = await new Promise<{ skipped?: boolean; success?: boolean; sessionId?: string }>((resolve, reject) => {
        const proc = spawnReal(bin, [
          '--mode', 'rpc',
          '--no-session',
          '--extension', resolvePiExtensionEntry(),
        ], {
          cwd: '/tmp',
          env: {
            ...process.env,
            HOME: tempHome,
            IMCODES_HOME: tempImcodes,
            PI_OFFLINE: '1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        const timer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
          reject(new Error(`Timed out waiting for pi --mode rpc --no-session response; stdout=${out}`));
        }, 10_000);
        proc.on('error', (err: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          if (err.code === 'ENOENT') resolve({ skipped: true });
          else reject(err);
        });
        proc.stdout?.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8');
          for (const line of out.split('\n')) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line) as { type?: string; id?: string; command?: string; success?: boolean; data?: { sessionId?: string } };
              if (parsed.type === 'response' && parsed.id === 'smoke-1') {
                clearTimeout(timer);
                try { proc.kill('SIGTERM'); } catch {}
                resolve({ success: parsed.success, sessionId: parsed.data?.sessionId });
              }
            } catch {
              // ignore non-JSON lines
            }
          }
        });
        proc.stdin?.write(`${JSON.stringify({ id: 'smoke-1', type: PI_RPC_COMMAND.GET_STATE })}\n`);
      });

      if (response.skipped) return;
      expect(response.success).toBe(true);
      expect(typeof response.sessionId).toBe('string');
      expect(existsSync(piSessionDir())).toBe(false);
      const piAgentSessionsDir = join(tempHome, '.pi', 'agent', 'sessions');
      if (existsSync(piAgentSessionsDir)) {
        expect(readdirSync(piAgentSessionsDir)).toEqual([]);
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('targets Pi 1.7.0, dynamically lists/caches models, hot-switches idle models, and clamps unsupported thinking levels', async () => {
    expect(PI_SUPPORTED_PACKAGE).toBe('@earendil-works/pi-coding-agent@1.7.0');
    expect(await provider.listModels()).toEqual({ models: [] });

    let availableModels = [
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', provider: 'minimax', reasoning: true, contextWindow: 128_000 },
      { id: 'gpt-6.2', name: 'GPT 6.2', provider: 'openai', reasoning: true, contextWindow: 400_000 },
    ];
    child.onCommand = (cmd) => {
      if (cmd.type === PI_RPC_COMMAND.GET_STATE) {
        return {
          success: true,
          data: {
            sessionId: 'pi-session-1',
            model: { id: 'MiniMax-M2.7', provider: 'minimax' },
            thinkingLevel: 'off',
          },
        };
      }
      if (cmd.type === PI_RPC_COMMAND.GET_AVAILABLE_MODELS) {
        return { success: true, data: { models: availableModels } };
      }
      if (cmd.type === PI_RPC_COMMAND.GET_AVAILABLE_THINKING_LEVELS) {
        return { success: true, data: { levels: ['minimal', 'low', 'medium', 'high'] } };
      }
      return undefined;
    };

    const infos: SessionInfoUpdate[] = [];
    provider.onSessionInfo((_id, info) => infos.push(info));
    const sessionId = await start();
    provider.setSessionEffort(sessionId, 'off');
    await provider.send(sessionId, 'boot');
    child.emitFrame({ type: PI_RPC_FRAME.AGENT_SETTLED });
    await flush();

    // Unsupported 'off' is clamped to nearest supported level ('minimal')
    expect(infos.some((info) => info.effort === 'minimal')).toBe(true);

    // listModels queries get_available_models and caches with TTL; force bypasses cache
    const firstList = await provider.listModels();
    expect(firstList).toEqual({
      isAuthenticated: true,
      models: [
        { id: 'minimax/MiniMax-M2.7', name: 'minimax · MiniMax M2.7', supportsReasoningEffort: true },
        { id: 'openai/gpt-6.2', name: 'openai · GPT 6.2', supportsReasoningEffort: true },
      ],
    });
    availableModels = [
      { id: 'gpt-6.2', name: 'GPT 6.2', provider: 'openai', reasoning: true, contextWindow: 400_000 },
    ];
    expect((await provider.listModels()).models).toHaveLength(2);
    expect((await provider.listModels(true)).models).toHaveLength(1);

    // Idle hot-switch uses SET_MODEL without restarting non-incognito child
    provider.setSessionAgentId(sessionId, 'openai/gpt-6.2');
    await flush();
    expect(killProcessTreeMock).not.toHaveBeenCalled();
    expect(child.written).toContainEqual(expect.objectContaining({
      type: PI_RPC_COMMAND.SET_MODEL,
      provider: 'openai',
      modelId: 'gpt-6.2',
    }));

    // Usage frame picks up learned contextWindow for the active model
    const usageUpdates: Array<{ usage?: Record<string, unknown>; model?: string }> = [];
    provider.onUsage((_id, u) => usageUpdates.push(u as { usage?: Record<string, unknown>; model?: string }));
    await provider.send(sessionId, 'usage turn');
    child.emitFrame({
      type: PI_RPC_FRAME.MESSAGE_END,
      message: { role: 'assistant', model: 'gpt-6.2', content: [{ type: 'text', text: 'ok' }], usage: { input: 10, output: 2 } },
    });
    child.emitFrame({ type: PI_RPC_FRAME.AGENT_SETTLED });
    await flush();
    expect(usageUpdates.at(-1)?.usage).toMatchObject({ model_context_window: 400_000 });
  });

  it('supports sdk-rpc /compact and re-injects session system text after compaction', async () => {
    expect(provider.capabilities.compact).toEqual({
      execution: 'sdk-rpc',
      verified: true,
      completion: 'rpc-result-or-provider-event',
      cancellation: 'provider-cancel',
      reassertsSessionSystemText: true,
    });

    child.onCommand = (cmd) => {
      if (cmd.type === PI_RPC_COMMAND.COMPACT) {
        child.emitFrame({ type: PI_RPC_FRAME.COMPACTION_START });
        child.emitFrame({ type: PI_RPC_FRAME.COMPACTION_END });
        return { success: true, data: { summary: 'trimmed summary', firstKeptEntryId: 'entry-42' } };
      }
      return undefined;
    };

    const sessionId = await start();
    await provider.send(sessionId, {
      userMessage: 'hello',
      assembledMessage: 'hello',
      sessionSystemText: 'SYS_CONTRACT_ALPHA',
      turnSystemText: undefined,
      systemText: 'SYS_CONTRACT_ALPHA',
      messagePreamble: undefined,
      context: {
        sessionSystemText: 'SYS_CONTRACT_ALPHA',
        turnSystemText: undefined,
        systemText: 'SYS_CONTRACT_ALPHA',
        messagePreamble: undefined,
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: { namespace: { scope: 'personal', projectId: 'p1' }, authoritySource: 'none', freshness: 'missing', fallbackAllowed: true, retryScheduled: false, providerPolicyOutcome: 'allowed', diagnostics: [] },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    });
    child.emitFrame({ type: PI_RPC_FRAME.AGENT_SETTLED });
    await flush();

    // Run /compact through send() control path
    await provider.send(sessionId, '/compact');
    await flush();

    expect(child.written.some((c) => c.type === PI_RPC_COMMAND.COMPACT)).toBe(true);
    expect(completions.at(-1)).toMatchObject({
      kind: 'system',
      role: 'system',
      metadata: expect.objectContaining({
        [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact',
        summary: 'trimmed summary',
        firstKeptEntryId: 'entry-42',
      }),
    });

    // Next turn re-sends SYS_CONTRACT_ALPHA after compaction cleared sessionSystemTextInjected
    await provider.send(sessionId, {
      userMessage: 'after compact',
      assembledMessage: 'after compact',
      sessionSystemText: 'SYS_CONTRACT_ALPHA',
      turnSystemText: undefined,
      systemText: 'SYS_CONTRACT_ALPHA',
      messagePreamble: undefined,
      context: {
        sessionSystemText: 'SYS_CONTRACT_ALPHA',
        turnSystemText: undefined,
        systemText: 'SYS_CONTRACT_ALPHA',
        messagePreamble: undefined,
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: { namespace: { scope: 'personal', projectId: 'p1' }, authoritySource: 'none', freshness: 'missing', fallbackAllowed: true, retryScheduled: false, providerPolicyOutcome: 'allowed', diagnostics: [] },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    });
    const prompts = child.written.filter((c) => c.type === PI_RPC_COMMAND.PROMPT);
    expect(String(prompts.at(-1)?.message)).toContain('SYS_CONTRACT_ALPHA');
  });

  it('forwards valid image attachments as base64 images and skips unsupported/unreadable files safely', async () => {
    expect(provider.capabilities.attachments).toBe(true);
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-attach-test-'));
    try {
      const pngPath = join(tempDir, 'shot.png');
      const txtPath = join(tempDir, 'notes.txt');
      const missingPath = join(tempDir, 'missing.jpg');
      writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      writeFileSync(txtPath, 'plain text');

      const sessionId = await start();
      await provider.send(sessionId, 'inspect image', [
        { id: 'img-1', daemonPath: pngPath, originalName: 'shot.png', mime: 'image/png', type: 'image' },
        { id: 'doc-1', daemonPath: txtPath, originalName: 'notes.txt', mime: 'text/plain', type: 'file' },
        { id: 'img-missing', daemonPath: missingPath, originalName: 'missing.jpg', mime: 'image/jpeg', type: 'image' },
      ]);

      const promptCmd = child.written.find((c) => c.type === PI_RPC_COMMAND.PROMPT);
      expect(promptCmd?.images).toEqual([
        { type: 'image', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), mimeType: 'image/png' },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('bridges extension_ui_request (select/confirm/input/editor/notify/setStatus) to AskUserQuestion and cancels cleanly on abort/teardown', async () => {
    const statuses: ProviderStatusUpdate[] = [];
    provider.onStatus((_id, s) => statuses.push(s));

    const sessionId = await start();
    await provider.send(sessionId, 'run extension');

    // Non-blocking setStatus & notify emit status/log without extension_ui_response
    child.emitFrame({ type: PI_RPC_FRAME.EXTENSION_UI_REQUEST, method: 'setStatus', statusKey: 'ext', statusText: 'Validating...' });
    child.emitFrame({ type: PI_RPC_FRAME.EXTENSION_UI_REQUEST, method: 'notify', notifyType: 'info', message: 'Extension ready' });
    await flush();
    expect(statuses.some((s) => s.label === 'Validating...')).toBe(true);
    expect(child.written.some((c) => c.type === PI_RPC_FRAME.EXTENSION_UI_RESPONSE)).toBe(false);

    // 1. select
    child.emitFrame({
      type: PI_RPC_FRAME.EXTENSION_UI_REQUEST,
      id: 'ui-select-1',
      method: 'select',
      title: 'Pick target',
      options: ['staging', 'prod'],
    });
    await flush();
    expect(tools.at(-1)).toMatchObject({
      id: 'ui-select-1',
      name: INTERACTIVE_QUESTION_TOOL_NAME,
      input: { questions: [{ question: 'Pick target', options: [{ label: 'staging' }, { label: 'prod' }] }] },
    });
    expect(provider.answerPendingQuestion('deck_test_brain', 'prod')).toBe(true);
    await flush();
    expect(child.written).toContainEqual({
      type: PI_RPC_FRAME.EXTENSION_UI_RESPONSE,
      id: 'ui-select-1',
      value: 'prod',
    });

    // 2. confirm
    child.emitFrame({
      type: PI_RPC_FRAME.EXTENSION_UI_REQUEST,
      id: 'ui-confirm-1',
      method: 'confirm',
      title: 'Deploy now?',
      message: 'All checks passed',
    });
    await flush();
    expect(provider.answerPendingQuestion('deck_test_brain', 'Yes')).toBe(true);
    await flush();
    expect(child.written).toContainEqual({
      type: PI_RPC_FRAME.EXTENSION_UI_RESPONSE,
      id: 'ui-confirm-1',
      confirmed: true,
    });

    // 3. input answered in-place
    child.emitFrame({
      type: PI_RPC_FRAME.EXTENSION_UI_REQUEST,
      id: 'ui-input-answer',
      method: 'input',
      title: 'Tag name',
    });
    await flush();
    expect(provider.answerPendingQuestion('deck_test_brain', 'v1.6.0')).toBe(true);
    await flush();
    expect(child.written).toContainEqual({
      type: PI_RPC_FRAME.EXTENSION_UI_RESPONSE,
      id: 'ui-input-answer',
      value: 'v1.6.0',
    });

    // 4. editor -> cancelled on cancel()
    child.emitFrame({
      type: PI_RPC_FRAME.EXTENSION_UI_REQUEST,
      id: 'ui-input-1',
      method: 'editor',
      title: 'Release notes',
    });
    await flush();
    await provider.cancel(sessionId);
    await flush();
    expect(child.written).toContainEqual({
      type: PI_RPC_FRAME.EXTENSION_UI_RESPONSE,
      id: 'ui-input-1',
      cancelled: true,
    });
    // Subsequent answer returns false (no stuck PendingQuestionRegistry entry)
    expect(provider.answerPendingQuestion('deck_test_brain', 'late')).toBe(false);

    // 5. pending dialog cancelled on endSession()
    child.emitFrame({
      type: PI_RPC_FRAME.EXTENSION_UI_REQUEST,
      id: 'ui-end-1',
      method: 'select',
      title: 'Cleanup check',
      options: ['A', 'B'],
    });
    await flush();
    await provider.endSession(sessionId);
    await flush();
    expect(child.written).toContainEqual({
      type: PI_RPC_FRAME.EXTENSION_UI_RESPONSE,
      id: 'ui-end-1',
      cancelled: true,
    });
    expect(provider.answerPendingQuestion('deck_test_brain', 'A')).toBe(false);
  });

  it('settles prompt when disposition is handled and sends clear_queue before abort compatibly with Pi 0.84.2', async () => {
    const errors: ProviderError[] = [];
    const statuses: ProviderStatusUpdate[] = [];
    provider.onError((_id, err) => errors.push(err));
    provider.onStatus((_id, s) => statuses.push(s));

    child.onCommand = (cmd) => {
      if (cmd.type === PI_RPC_COMMAND.PROMPT && String(cmd.message) === '/ext-cmd') {
        return { success: true, data: { disposition: 'handled' } };
      }
      if (cmd.type === PI_RPC_COMMAND.CLEAR_QUEUE) {
        // Simulate Pi 0.84.2 rejecting unsupported clear_queue command
        return { success: false, error: 'Unknown command: clear_queue' };
      }
      if (cmd.type === PI_RPC_COMMAND.GET_AVAILABLE_THINKING_LEVELS) {
        return { success: false, error: 'Unknown command: get_available_thinking_levels' };
      }
      return undefined;
    };

    const sessionId = await start();
    await provider.send(sessionId, '/ext-cmd');
    await flush();

    // Must complete cleanly without waiting for agent_settled
    expect(provider.getSessionDiagnostics(sessionId)?.turnActive).toBe(false);
    expect(completions).toHaveLength(1);
    expect(statuses.at(-1)).toEqual({ status: null, label: null });

    // On active turn cancel, clear_queue failure must NOT block abort
    await provider.send(sessionId, 'regular prompt');
    await provider.cancel(sessionId);
    await flush();

    const clearIdx = child.written.findIndex((c) => c.type === PI_RPC_COMMAND.CLEAR_QUEUE);
    const abortIdx = child.written.findIndex((c) => c.type === PI_RPC_COMMAND.ABORT);
    expect(clearIdx).toBeGreaterThan(-1);
    expect(abortIdx).toBeGreaterThan(clearIdx);
    expect(errors).toHaveLength(0);
  });

  it('populates contextWindow from get_state/set_model for Pi 1.7.0 exact usage and handles threshold compaction', async () => {
    const usageUpdates: Array<{ usage?: Record<string, unknown>; model?: string }> = [];
    const statuses: ProviderStatusUpdate[] = [];
    provider.onUsage((_id, u) => usageUpdates.push(u as { usage?: Record<string, unknown>; model?: string }));
    provider.onStatus((_id, s) => statuses.push(s));

    child.onCommand = (cmd) => {
      if (cmd.type === PI_RPC_COMMAND.GET_STATE) {
        return {
          success: true,
          data: {
            sessionId: 'pi-170-session',
            model: { id: 'claude-sonnet-4', provider: 'anthropic', contextWindow: 200_000 },
            thinkingLevel: 'medium',
          },
        };
      }
      if (cmd.type === PI_RPC_COMMAND.SET_MODEL) {
        return {
          success: true,
          data: { id: 'gpt-6.2', provider: 'openai', contextWindow: 400_000 },
        };
      }
      return undefined;
    };

    const sessionId = await start();
    await provider.send(sessionId, {
      userMessage: 'usage check',
      assembledMessage: 'usage check',
      sessionSystemText: 'SYS_CONTRACT_170',
      turnSystemText: undefined,
      systemText: 'SYS_CONTRACT_170',
      messagePreamble: undefined,
      context: {
        sessionSystemText: 'SYS_CONTRACT_170',
        turnSystemText: undefined,
        systemText: 'SYS_CONTRACT_170',
        messagePreamble: undefined,
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: { namespace: { scope: 'personal', projectId: 'p1' }, authoritySource: 'none', freshness: 'missing', fallbackAllowed: true, retryScheduled: false, providerPolicyOutcome: 'allowed', diagnostics: [] },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    });

    // Streaming message_update picks up contextWindow learned from get_state without listModels()
    child.emitFrame({
      type: PI_RPC_FRAME.MESSAGE_UPDATE,
      usage: {
        input: 1200,
        output: 45,
        cacheRead: 300,
        cacheWrite: 150,
        cacheWrite1h: 50,
        reasoning: 10,
        totalTokens: 1695,
      },
      assistantMessageEvent: { type: PI_ASSISTANT_EVENT.TEXT_DELTA, contentIndex: 0, delta: 'Hi' },
    });
    expect(usageUpdates.at(-1)).toMatchObject({
      model: 'claude-sonnet-4',
      usage: {
        input_tokens: 1200,
        output_tokens: 45,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 150,
        model_context_window: 200_000,
      },
    });

    // Threshold auto-compaction updates status cleanly during active turn and clears injected contract
    child.emitFrame({ type: PI_RPC_FRAME.COMPACTION_START, reason: 'threshold' });
    expect(statuses.at(-1)).toEqual({ status: 'working', label: 'Compacting...' });
    child.emitFrame({
      type: PI_RPC_FRAME.COMPACTION_END,
      reason: 'threshold',
      result: {
        summary: 'auto compacted',
        firstKeptEntryId: 'entry-99',
        tokensBefore: 160_000,
        estimatedTokensAfter: 24_000,
      },
      aborted: false,
      willRetry: false,
    });
    expect(statuses.at(-1)).toEqual({ status: 'working', label: null });

    child.emitFrame({ type: PI_RPC_FRAME.AGENT_SETTLED });
    await flush();

    // Switching model while idle records the new model's contextWindow from SET_MODEL response
    provider.setSessionAgentId(sessionId, 'openai/gpt-6.2');
    await flush();

    await provider.send(sessionId, {
      userMessage: 'after auto-compact',
      assembledMessage: 'after auto-compact',
      sessionSystemText: 'SYS_CONTRACT_170',
      turnSystemText: undefined,
      systemText: 'SYS_CONTRACT_170',
      messagePreamble: undefined,
      context: {
        sessionSystemText: 'SYS_CONTRACT_170',
        turnSystemText: undefined,
        systemText: 'SYS_CONTRACT_170',
        messagePreamble: undefined,
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: { namespace: { scope: 'personal', projectId: 'p1' }, authoritySource: 'none', freshness: 'missing', fallbackAllowed: true, retryScheduled: false, providerPolicyOutcome: 'allowed', diagnostics: [] },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    });

    const promptsAfterCompaction = child.written.filter((c) => c.type === PI_RPC_COMMAND.PROMPT);
    expect(String(promptsAfterCompaction.at(-1)?.message)).toContain('SYS_CONTRACT_170');

    child.emitFrame({
      type: PI_RPC_FRAME.MESSAGE_END,
      message: {
        role: 'assistant',
        model: 'gpt-6.2',
        content: [{ type: 'text', text: 'done' }],
        usage: { input: 500, output: 20, cacheRead: 100, cacheWrite: 0, totalTokens: 620 },
      },
    });
    child.emitFrame({ type: PI_RPC_FRAME.AGENT_SETTLED });
    await flush();

    expect(usageUpdates.at(-1)).toMatchObject({
      model: 'gpt-6.2',
      usage: {
        input_tokens: 500,
        output_tokens: 20,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
        model_context_window: 400_000,
      },
    });
  });

  it('isolates contextWindow per session and (provider, rawModelId) across interleaved sessions, slash IDs, and 1.6.x fallback', async () => {
    const childA = new FakePiChild();
    const childB = new FakePiChild();
    let spawnIndex = 0;
    spawnMock.mockImplementation(() => {
      spawnIndex += 1;
      return spawnIndex === 1 ? childA : childB;
    });

    childA.onCommand = (cmd) => {
      if (cmd.type === PI_RPC_COMMAND.GET_STATE) {
        return {
          success: true,
          data: {
            sessionId: 'pi-a',
            model: { id: 'shared-preset', provider: 'custom-llm', contextWindow: 100_000 },
            thinkingLevel: 'medium',
          },
        };
      }
      if (cmd.type === PI_RPC_COMMAND.SET_MODEL) {
        // Switching to a legacy Pi 1.6.x model with no contextWindow reported
        return { success: true };
      }
      if (cmd.type === PI_RPC_COMMAND.GET_AVAILABLE_MODELS) {
        return {
          success: true,
          data: {
            models: [
              { id: 'a', provider: 'direct', contextWindow: 111_000 },
              { id: 'direct/a', provider: 'router', contextWindow: 222_000 },
              { id: 'shared-bare', provider: 'alpha', contextWindow: 333_000 },
            ],
          },
        };
      }
      return undefined;
    };
    childB.onCommand = (cmd) => {
      if (cmd.type === PI_RPC_COMMAND.GET_STATE) {
        return {
          success: true,
          data: {
            sessionId: 'pi-b',
            model: { id: 'shared-preset', provider: 'custom-llm', contextWindow: 200_000 },
            thinkingLevel: 'medium',
          },
        };
      }
      return undefined;
    };

    const usageBySession: Record<string, Array<{ usage?: Record<string, unknown>; model?: string }>> = {};
    provider.onUsage((sid, u) => {
      (usageBySession[sid] ??= []).push(u as { usage?: Record<string, unknown>; model?: string });
    });

    const sessionA = await provider.createSession({ sessionKey: 'route-a', sessionName: 'deck_a', cwd: '/tmp' });
    await provider.send(sessionA, 'turn A1');
    childA.emitFrame({
      type: PI_RPC_FRAME.MESSAGE_END,
      message: {
        role: 'assistant',
        model: 'shared-preset',
        content: [{ type: 'text', text: 'a1' }],
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      },
    });
    expect(usageBySession[sessionA]?.at(-1)?.usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 10,
      model_context_window: 100_000,
    });

    // Start Session B with same (provider, modelId) but different contextWindow (200_000)
    const sessionB = await provider.createSession({ sessionKey: 'route-b', sessionName: 'deck_b', cwd: '/tmp' });
    await provider.send(sessionB, 'turn B1');
    childB.emitFrame({
      type: PI_RPC_FRAME.MESSAGE_END,
      message: {
        role: 'assistant',
        model: 'shared-preset',
        content: [{ type: 'text', text: 'b1' }],
        usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 },
      },
    });
    expect(usageBySession[sessionB]?.at(-1)?.usage).toMatchObject({
      input_tokens: 200,
      output_tokens: 20,
      model_context_window: 200_000,
    });

    // Session A's subsequent usage must remain bound to 100_000 (not overwritten by B's 200_000)
    childA.emitFrame({
      type: PI_RPC_FRAME.MESSAGE_UPDATE,
      usage: { input: 150, output: 15, cacheRead: 0, cacheWrite: 0 },
      assistantMessageEvent: { type: PI_ASSISTANT_EVENT.TEXT_DELTA, contentIndex: 0, delta: 'still A' },
    });
    expect(usageBySession[sessionA]?.at(-1)?.usage).toMatchObject({
      input_tokens: 150,
      output_tokens: 15,
      model_context_window: 100_000,
    });
    childA.emitFrame({ type: PI_RPC_FRAME.AGENT_SETTLED });
    childB.emitFrame({ type: PI_RPC_FRAME.AGENT_SETTLED });
    await flush();

    // Switching Session A to a Pi 1.6.x model without contextWindow clears old 100_000 window
    // while still reporting actual token usage
    provider.setSessionAgentId(sessionA, 'legacy/old-model');
    await flush();
    await provider.send(sessionA, 'turn A2');
    childA.emitFrame({
      type: PI_RPC_FRAME.MESSAGE_END,
      message: {
        role: 'assistant',
        model: 'old-model',
        content: [{ type: 'text', text: 'a2' }],
        usage: { input: 300, output: 30, cacheRead: 5, cacheWrite: 2 },
      },
    });
    const legacyUsage = usageBySession[sessionA]?.at(-1)?.usage;
    expect(legacyUsage).toEqual({
      input_tokens: 300,
      output_tokens: 30,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 2,
    });
    expect(legacyUsage).not.toHaveProperty('model_context_window');
    childA.emitFrame({ type: PI_RPC_FRAME.AGENT_SETTLED });
    await flush();

    // Probe catalog via Session A (first live session): disambiguate direct/a vs router/direct/a and block cross-provider bare-ID fallback
    await provider.listModels(true);
    await provider.send(sessionA, 'turn A3');
    // Update A to router + direct/a via message_end (clear old snapshot, fall back to A's catalog tuple)
    childA.emitFrame({
      type: PI_RPC_FRAME.MESSAGE_END,
      message: {
        role: 'assistant',
        provider: 'router',
        model: 'direct/a',
        content: [{ type: 'text', text: 'a3' }],
        usage: { input: 400, output: 40 },
      },
    });
    expect(usageBySession[sessionA]?.at(-1)?.usage).toMatchObject({
      input_tokens: 400,
      output_tokens: 40,
      model_context_window: 222_000,
    });

    // direct + a resolves its own 111_000 tuple on Session A
    childA.emitFrame({
      type: PI_RPC_FRAME.MESSAGE_END,
      message: {
        role: 'assistant',
        provider: 'direct',
        model: 'a',
        content: [{ type: 'text', text: 'a4' }],
        usage: { input: 410, output: 41 },
      },
    });
    expect(usageBySession[sessionA]?.at(-1)?.usage).toMatchObject({
      input_tokens: 410,
      output_tokens: 41,
      model_context_window: 111_000,
    });

    // Different provider (beta) with same bare ID (shared-bare) must NOT borrow alpha's 333_000
    childA.emitFrame({
      type: PI_RPC_FRAME.MESSAGE_END,
      message: {
        role: 'assistant',
        provider: 'beta',
        model: 'shared-bare',
        content: [{ type: 'text', text: 'a5' }],
        usage: { input: 420, output: 42 },
      },
    });
    const crossProviderUsage = usageBySession[sessionA]?.at(-1)?.usage;
    expect(crossProviderUsage).toEqual({ input_tokens: 420, output_tokens: 42 });
    expect(crossProviderUsage).not.toHaveProperty('model_context_window');

    // Session B must NOT borrow Session A's probed catalog either
    await provider.send(sessionB, 'turn B2');
    childB.emitFrame({
      type: PI_RPC_FRAME.MESSAGE_END,
      message: {
        role: 'assistant',
        provider: 'direct',
        model: 'a',
        content: [{ type: 'text', text: 'b2' }],
        usage: { input: 500, output: 50 },
      },
    });
    const sessionBUsingACatalog = usageBySession[sessionB]?.at(-1)?.usage;
    expect(sessionBUsingACatalog).toEqual({ input_tokens: 500, output_tokens: 50 });
    expect(sessionBUsingACatalog).not.toHaveProperty('model_context_window');
  });
});
