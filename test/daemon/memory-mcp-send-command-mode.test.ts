/**
 * The `send_message` MCP tool's `command` parameter: published in the tool
 * schema, forwarded by the handler, and delivering exactly the trimmed text.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import type { SessionRecord } from '../../src/store/session-store.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import * as contracts from '../../shared/memory-mcp-contracts.js';
import { AGENT_DELEGATION_SENDER_MARKER } from '../../shared/agent-delegation.js';
import { SEND_COMMAND_DESCRIPTION, SEND_COMMAND_ERRORS } from '../../shared/send-command-mode.js';

const BRAIN = 'deck_mcpcmd_brain';
const WORKER = 'deck_sub_mcpcmdw';

const session = (name: string, role: SessionRecord['role'], extra: Partial<SessionRecord> = {}): SessionRecord => ({
  name, projectName: 'mcpcmd', role, agentType: 'claude-code-sdk', runtimeType: 'transport', projectDir: '/work/mcpcmd',
  state: 'idle', sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
  restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 2, ...extra,
} as SessionRecord);

const sessions = [session(BRAIN, 'brain'), session(WORKER, 'w1', { parentSession: BRAIN })];
const caller: McpRuntimeCaller = {
  userId: 'user-1',
  namespace: { scope: 'user_private', userId: 'user-1', projectId: 'repo-1' },
  sessionName: BRAIN,
  projectName: 'mcpcmd',
  projectRoot: '/work/mcpcmd',
  serverId: 'srv-1',
  transport: 'in_process',
};

function handlers() {
  const dispatchMessage = vi.fn(async () => 'sent' as const);
  const tools = createMemoryMcpToolHandlers(caller, {
    sendDeps: { listSessions: () => sessions, getSession: (name: string) => sessions.find((s) => s.name === name), dispatchMessage },
    isMemoryFeatureEnabled: () => true,
  });
  return { dispatchMessage, send: tools[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE] };
}

describe('send_message command parameter', () => {
  it('is published in the tool schema with its description', () => {
    const catalog = (contracts as unknown as Record<string, unknown>);
    const definitions = Object.values(catalog).find((value) => (
      value && typeof value === 'object' && MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE in (value as object)
      && (value as Record<string, { inputSchema?: unknown }>)[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]?.inputSchema
    )) as Record<string, { inputSchema: { properties: Record<string, { type?: string; description?: string }> } }> | undefined;
    const command = definitions?.[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]?.inputSchema.properties.command;
    expect(command).toMatchObject({ type: 'boolean', description: SEND_COMMAND_DESCRIPTION });
  });

  it('command=true delivers exactly message.trim() to the target', async () => {
    const { send, dispatchMessage } = handlers();
    const raw = '  \n第一行\n  second — ✓ \n';
    const result = await send({ target: WORKER, message: raw, command: true });
    expect(result).toMatchObject({ status: 'accepted', deliveries: [{ target: WORKER, status: 'delivered' }] });
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    const [, delivered, options] = dispatchMessage.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];
    expect(Buffer.from(delivered).equals(Buffer.from(raw.trim()))).toBe(true);
    expect(options).toMatchObject({ command: true });
  });

  it('counterexample: without command (or with command=false) the message is wrapped', async () => {
    const { send, dispatchMessage } = handlers();
    await send({ target: WORKER, message: 'hello' });
    await send({ target: WORKER, message: 'hello', command: false });
    for (const call of dispatchMessage.mock.calls) {
      expect((call as unknown as [unknown, string])[1]).toContain(AGENT_DELEGATION_SENDER_MARKER);
    }
  });

  it.each([
    [{ reply: true }, SEND_COMMAND_ERRORS.WITH_REPLY],
    [{ files: ['a.ts'] }, SEND_COMMAND_ERRORS.WITH_FILES],
    [{ task: { objective: 'x' } }, SEND_COMMAND_ERRORS.WITH_METADATA],
  ])('rejects %j through the tool with a clear error', async (extra, error) => {
    const { send, dispatchMessage } = handlers();
    const result = await send({ target: WORKER, message: '/compact', command: true, ...extra });
    expect(result).toMatchObject({ status: 'error', reason: 'validation_failed', error });
    expect(dispatchMessage).not.toHaveBeenCalled();
  });
});
