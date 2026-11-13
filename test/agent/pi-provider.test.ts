import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
import { buildPiRpcArgs, piSessionDir, resolvePiBinary, resolvePiExtensionEntry } from '../../src/agent/providers/pi/runtime.js';
import {
  PI_MCP_CONFIG_ENV,
  PI_PROVIDER_API_KEY_ENV,
  PI_RPC_COMMAND,
  PI_RPC_FRAME,
} from '../../shared/pi-agent.js';
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../shared/agent-message.js';
import { IMCODES_MCP_TOOL_CATALOG_MODE_ENV } from '../../shared/memory-mcp-env.js';
import { MCP_TOOL_CATALOG_MODES } from '../../shared/mcp-tool-discovery.js';

class FakePiChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  written: Array<Record<string, unknown>> = [];
  stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    write: (chunk: string) => {
      const command = JSON.parse(chunk.trim()) as Record<string, unknown>;
      this.written.push(command);
      setImmediate(() => this.respond(command));
      return true;
    },
  });

  private respond(command: Record<string, unknown>): void {
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
});
