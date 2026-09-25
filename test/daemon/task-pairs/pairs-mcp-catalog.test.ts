/**
 * A `pairs` project carries no legacy supervision tools: the MCP child asks the
 * daemon at startup and, on pairs, never publishes supervision_* or
 * peer_audit_reply (not listed, not discoverable, not callable).
 */
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMemoryMcpServer, resolveTaskPairWithheldMcpTools } from '../../../src/daemon/memory-mcp-server.js';
import { TASK_PAIR_LEGACY_TOOL_NAMES } from '../../../src/daemon/task-pairs/legacy-tools.js';
import { MCP_TOOL_CATALOG_MODES, MCP_TOOL_DISCOVERY_NAME } from '../../../shared/mcp-tool-discovery.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../../shared/memory-mcp-contracts.js';
import { TASK_PAIR_ENGINE_HOOK_PATH } from '../../../shared/task-pair.js';
import type { McpRuntimeCaller } from '../../../src/daemon/memory-mcp-caller.js';

vi.mock('../../../src/util/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const CALLER = {
  userId: 'u1', serverId: 's1', projectName: 'cd', sessionName: 'deck_cd_brain', transport: 'stdio',
} as unknown as McpRuntimeCaller;

async function connect(withheldTools?: readonly string[]) {
  const server = createMemoryMcpServer(CALLER, {}, {}, {}, {
    toolCatalogMode: MCP_TOOL_CATALOG_MODES.STATIC_FULL,
    ...(withheldTools ? { withheldTools } : {}),
  });
  const client = new Client({ name: 'pairs-catalog-test', version: '0.1.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  return client;
}

describe('pairs MCP catalog', () => {
  it('publishes no supervision_* or peer_audit_reply tool on a pairs session, and all of them otherwise', async () => {
    const legacy = await connect();
    const legacyNames = (await legacy.listTools()).tools.map((tool) => tool.name);
    for (const name of TASK_PAIR_LEGACY_TOOL_NAMES) expect(legacyNames, name).toContain(name);

    const pairs = await connect(TASK_PAIR_LEGACY_TOOL_NAMES);
    const pairsNames = (await pairs.listTools()).tools.map((tool) => tool.name);
    expect(pairsNames.filter((name) => name.startsWith('supervision_'))).toEqual([]);
    expect(pairsNames).not.toContain(MEMORY_MCP_TOOL_NAMES.PEER_AUDIT_REPLY);
    // Everything else stays.
    expect(pairsNames).toContain(MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE);
    expect(pairsNames).toContain(MCP_TOOL_DISCOVERY_NAME);
    expect(pairsNames.length).toBe(legacyNames.length - TASK_PAIR_LEGACY_TOOL_NAMES.length);
  });

  it('keeps withheld tools out of discovery and its fallback call', async () => {
    const pairs = await connect(TASK_PAIR_LEGACY_TOOL_NAMES);
    const search = await pairs.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: 'supervision_task_get' } }) as { structuredContent: { matches: Array<{ name: string }> } };
    expect(search.structuredContent.matches.map((match) => match.name).filter((name) => name.startsWith('supervision_'))).toEqual([]);
    const fallback = await pairs.callTool({
      name: MCP_TOOL_DISCOVERY_NAME,
      arguments: { query: 'supervision_task_get', fallbackCall: { name: 'supervision_task_get', arguments: { taskId: 't' } } },
    }) as { isError?: boolean };
    expect(fallback.isError).toBe(true);
    const direct = await pairs.callTool({ name: 'supervision_task_get', arguments: { taskId: 't' } }) as { isError?: boolean; content: Array<{ text?: string }> };
    expect(direct.isError).toBe(true);
    expect(direct.content[0]?.text).toMatch(/not found/i);
  });

  it('withholds the legacy tools only when the daemon says the session is on pairs', async () => {
    const postHook = vi.fn(async () => ({ ok: true, pairs: true }));
    const resolveHookPort = vi.fn(async () => 4321);
    expect(await resolveTaskPairWithheldMcpTools(CALLER, { resolveHookPort, postHook })).toEqual(TASK_PAIR_LEGACY_TOOL_NAMES);
    expect(postHook).toHaveBeenCalledWith(4321, { from: 'deck_cd_brain' }, TASK_PAIR_ENGINE_HOOK_PATH, 'deck_cd_brain', 2_000);

    postHook.mockResolvedValueOnce({ ok: true, pairs: false });
    expect(await resolveTaskPairWithheldMcpTools(CALLER, { resolveHookPort, postHook })).toEqual([]);
    // Daemon unreachable or no session: nothing withheld (the daemon shim still answers on pairs).
    postHook.mockRejectedValueOnce(new Error('down'));
    expect(await resolveTaskPairWithheldMcpTools(CALLER, { resolveHookPort, postHook })).toEqual([]);
    expect(await resolveTaskPairWithheldMcpTools(CALLER, { resolveHookPort: async () => null, postHook })).toEqual([]);
    expect(await resolveTaskPairWithheldMcpTools({ ...CALLER, sessionName: undefined } as unknown as McpRuntimeCaller, { resolveHookPort, postHook })).toEqual([]);
  });
});
