import { describe, expect, it } from 'vitest';
import { CAPABILITY_LIMITS, CAPABILITY_MCP_TRANSPORT } from '@shared/capability-management.js';
import { parseCapabilityMcpImport } from '../src/capability-import.js';

describe('capability MCP import', () => {
  it('parses bounded JSONC with comments and trailing commas', () => {
    const result = parseCapabilityMcpImport(`{
      // the endpoint is normalized by the shared contract
      "name": "docs",
      "url": "https://mcp.example.test/tools",
    }`, 'mcp.jsonc');
    expect(result).toEqual({
      definitions: [{
        name: 'docs',
        transport: CAPABILITY_MCP_TRANSPORT.STREAMABLE_HTTP,
        url: 'https://mcp.example.test/tools',
      }],
      invalidEntries: 0,
    });
  });

  it('normalizes Codex TOML stdio entries without executing them', () => {
    const result = parseCapabilityMcpImport(`
      [mcp_servers.review]
      command = "npx"
      args = ["-y", "review-mcp"]
      tool_allowlist = ["review"]
    `, 'config.toml');
    expect(result.definitions).toEqual([{
      name: 'review',
      transport: CAPABILITY_MCP_TRANSPORT.STDIO,
      command: 'npx',
      args: ['-y', 'review-mcp'],
      toolAllowlist: ['review'],
    }]);
  });

  it('keeps valid batch entries independent and rejects raw credentials', () => {
    const result = parseCapabilityMcpImport(JSON.stringify({
      mcpServers: {
        valid: { url: 'https://mcp.example.test' },
        secret: { command: 'node', args: ['server.js', '--api-key=sk-live-abcdefghijklmnop'] },
      },
    }));
    expect(result.definitions.map((definition) => definition.name)).toEqual(['valid']);
    expect(result.invalidEntries).toBe(1);
  });

  it.each([
    '[mcp_servers.__proto__]\nurl = "https://mcp.example.test"',
    '[mcp_servers.constructor]\nurl = "https://mcp.example.test"',
  ])('rejects prototype-polluting TOML identities: %s', (input) => {
    expect(() => parseCapabilityMcpImport(input, 'config.toml')).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects prototype-polluting JSONC identities without mutating globals', () => {
    const result = parseCapabilityMcpImport('{"mcpServers":{"__proto__":{"url":"https://mcp.example.test"}}}', 'config.jsonc');
    expect(result).toEqual({ definitions: [], invalidEntries: 1 });
    expect(({} as Record<string, unknown>).url).toBeUndefined();
  });

  it('rejects input beyond the shared audit-envelope bound', () => {
    expect(() => parseCapabilityMcpImport(' '.repeat(CAPABILITY_LIMITS.AUDIT_ENVELOPE_BYTES + 1)))
      .toThrow('capability_import_too_large');
  });

  it('rejects a batch above the shared entry bound before starting operations', () => {
    const mcpServers = Object.fromEntries(Array.from(
      { length: CAPABILITY_LIMITS.MCP_IMPORT_ENTRIES + 1 },
      (_, index) => [`server-${index}`, { url: `https://mcp-${index}.example.test` }],
    ));
    expect(() => parseCapabilityMcpImport(JSON.stringify({ mcpServers })))
      .toThrow('capability_import_too_many_entries');
  });
});
