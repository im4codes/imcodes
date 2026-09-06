import { describe, expect, it, vi } from 'vitest';
import {
  MEMORY_MCP_DAEMON_TOOL_NAMES,
} from '../../shared/memory-mcp-daemon-rpc.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';

const localContextStoreClient = vi.hoisted(() => vi.fn(() => {
  throw new Error('MCP must not create a local context-store worker');
}));
const localSemanticSearch = vi.hoisted(() => vi.fn(() => {
  throw new Error('MCP must not create a local embedding worker');
}));
const localSummaryList = vi.hoisted(() => vi.fn(() => {
  throw new Error('MCP must not query a local context-store worker');
}));

vi.mock('../../src/store/context-store-worker-client.js', () => ({
  getContextStoreClient: localContextStoreClient,
}));

vi.mock('../../src/daemon/memory-mcp-search.js', () => ({
  searchMcpMemoryRecall: localSemanticSearch,
  listMcpMemorySummaries: localSummaryList,
}));

const caller: McpRuntimeCaller = {
  userId: 'user-1',
  namespace: { scope: 'user_private', userId: 'user-1', projectId: 'repo-1' },
  sessionName: 'deck_proxy_brain',
  projectName: 'proxy',
  projectRoot: '/tmp/proxy',
  serverId: 'server-1',
  providerId: 'codex-sdk',
  transport: 'stdio',
};

describe('memory MCP daemon worker proxy', () => {
  it('routes every context/embedding-owning tool through the daemon seam', async () => {
    const invokeDaemonMemoryTool = vi.fn(async (name: string, input?: unknown) => ({
      status: 'ok',
      proxied: name,
      input,
    }));
    const handlers = createMemoryMcpToolHandlers(caller, { invokeDaemonMemoryTool });

    for (const name of MEMORY_MCP_DAEMON_TOOL_NAMES) {
      await expect(handlers[name]({ marker: name })).resolves.toMatchObject({
        status: 'ok',
        proxied: name,
      });
    }

    expect(invokeDaemonMemoryTool).toHaveBeenCalledTimes(MEMORY_MCP_DAEMON_TOOL_NAMES.length);
    expect(invokeDaemonMemoryTool.mock.calls.map(([name]) => name)).toEqual(MEMORY_MCP_DAEMON_TOOL_NAMES);
    expect(localContextStoreClient).not.toHaveBeenCalled();
    expect(localSemanticSearch).not.toHaveBeenCalled();
    expect(localSummaryList).not.toHaveBeenCalled();
  });
});
