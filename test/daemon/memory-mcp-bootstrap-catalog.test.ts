import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import catalog from '../../src/daemon/memory-mcp-bootstrap-catalog.json';
import { createMemoryMcpServerFromEnv } from '../../src/daemon/memory-mcp-server.js';
import { mcpToolSurfaceBytes, MCP_TOOL_SURFACE_BOOTSTRAP_BUDGET_BYTES } from '../../shared/mcp-tool-surface-budget.js';
import { MCP_TOOL_GROUPS } from '../../shared/mcp-tool-discovery.js';
import { MEMORY_MCP_TOOL_CONTRACTS, MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';

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

  it('keeps the Computer Use request and result tool enums aligned', () => {
    for (const mode of ['dynamic', 'static_full'] as const) {
      const tool = catalog[mode].find((entry) => entry.name === 'computer_use_call') as {
        inputSchema?: { properties?: { tool?: { enum?: unknown[] } } };
        outputSchema?: { properties?: { result?: { properties?: { tool?: { enum?: unknown[] } } } } };
      } | undefined;
      if (!tool) continue;
      expect(tool.outputSchema?.properties?.result?.properties?.tool?.enum)
        .toEqual(tool.inputSchema?.properties?.tool?.enum);
    }
  });

  it('keeps pair decision tools in the supervision discovery path and static-full catalog', () => {
    const pairDecisionTools = [
      MEMORY_MCP_TOOL_NAMES.PAIR_DECISION_RECORD,
      MEMORY_MCP_TOOL_NAMES.PAIR_DECISION_HISTORY,
    ];
    const supervisionTools = MCP_TOOL_GROUPS.find((group) => group.id === 'supervision')?.tools ?? [];

    expect(supervisionTools).toEqual(expect.arrayContaining(pairDecisionTools));
    expect(catalog.static_full.map((tool) => tool.name)).toEqual(expect.arrayContaining(pairDecisionTools));
  });

  it('requires direct pair creation after a quick read-only check and a required non-empty title in pair_create', () => {
    const pairCreate = catalog.static_full.find((entry) => entry.name === MEMORY_MCP_TOOL_NAMES.PAIR_CREATE) as {
      description?: string;
      inputSchema?: { required?: string[]; properties?: { title?: { minLength?: number } } };
    } | undefined;
    const expectedLead = 'do a quick read-only root-cause check and create a task pair directly without asking routine confirmation (short title required)';
    expect(pairCreate?.description).toContain(expectedLead);
    expect(pairCreate?.inputSchema?.required).toEqual(expect.arrayContaining(['title', 'brief']));
    const contract = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE];
    const brief = (contract.inputSchema as { properties?: { brief?: { description?: string } } }).properties?.brief;
    const title = (contract.inputSchema as { properties?: { title?: { minLength?: number } } }).properties?.title;
    expect(contract.description).toContain(expectedLead);
    expect(contract.inputSchema.required).toEqual(['title', 'brief']);
    expect(title?.minLength).toBe(1);
    expect(brief?.description).toContain('verified Proven files/logs, step-by-step Plan');
    expect(brief?.description).toContain('"- [ ][ ]"');
    expect(brief?.description).toContain('required when audited');
  });
});
