import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import catalog from '../../src/daemon/memory-mcp-bootstrap-catalog.json';
import { createMemoryMcpServerFromEnv } from '../../src/daemon/memory-mcp-server.js';
import { mcpToolSurfaceBytes, MCP_TOOL_SURFACE_BOOTSTRAP_BUDGET_BYTES } from '../../shared/mcp-tool-surface-budget.js';

async function liveCatalog(mode?: 'static_full') {
  const server = createMemoryMcpServerFromEnv({
    env: mode ? { IMCODES_MCP_TOOL_CATALOG_MODE: mode } : {},
  });
  const client = new Client({ name: 'catalog-parity-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

describe('memory MCP bootstrap catalog', () => {
  it('is byte-for-byte generated from the authoritative dynamic and static-full catalogs', async () => {
    const dynamic = await liveCatalog();
    const staticFull = await liveCatalog('static_full');
    expect(catalog.dynamic).toEqual(dynamic);
    expect(catalog.static_full).toEqual(staticFull);
    expect(mcpToolSurfaceBytes(catalog.dynamic)).toBeLessThanOrEqual(MCP_TOOL_SURFACE_BOOTSTRAP_BUDGET_BYTES);
  });
});
