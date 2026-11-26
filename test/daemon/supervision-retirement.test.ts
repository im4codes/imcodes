import { describe, expect, it } from 'vitest';
import catalog from '../../src/daemon/memory-mcp-bootstrap-catalog.json';
import {
  advertisedMcpToolNames,
  MEMORY_MCP_TOOL_NAMES,
  RETIRED_SUPERVISION_MCP_TOOL_NAMES,
} from '../../shared/memory-mcp-contracts.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { MCP_TOOL_GROUPS } from '../../shared/mcp-tool-discovery.js';

describe('legacy supervision retirement', () => {
  it('removes every retired name from catalogs, discovery groups, and bootstrap snapshots', () => {
    const published = new Set(advertisedMcpToolNames(NODE_ROLE.FULL));
    const grouped = MCP_TOOL_GROUPS.flatMap((group) => group.tools ?? []);
    for (const name of RETIRED_SUPERVISION_MCP_TOOL_NAMES) {
      expect(published, name).not.toContain(name);
      expect(grouped, name).not.toContain(name);
      expect(catalog.dynamic.map((tool) => tool.name), name).not.toContain(name);
      expect(catalog.static_full.map((tool) => tool.name), name).not.toContain(name);
    }
    expect(published).toContain(MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE);
  });
});
