import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, killProcessTreeMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  killProcessTreeMock: vi.fn(async (child: { kill?: () => void }) => { child.kill?.(); }),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

vi.mock('../../src/util/kill-process-tree.js', () => ({
  killProcessTree: killProcessTreeMock,
}));

import { PiProvider } from '../../src/agent/providers/pi.js';
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
});
