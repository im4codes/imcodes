import { describe, it, expect } from 'vitest';
import { ALIAS_MCP_TOOLS } from '../../shared/alias-types.js';
import { MEMORY_MCP_TOOL_NAME_LIST } from '../../shared/memory-mcp-contracts.js';

// Task 12.10: the alias store (server-side `user_aliases`) is a distinct store that is
// NOT indexed by, ingested into, or surfaced through the memory system. The alias MCP
// read tools are deliberately kept off the memory MCP tool surface. This guards that
// separation at the contract level so a regression that folds aliases into memory fails here.
//
// Documented behavior (not a defect): once a resolved alias value is substituted into an
// AGENT-BOUND message and the agent executes/echoes or restates it, that agent turn is
// ordinary conversation content and MAY be recorded by the memory pipeline. Isolation only
// guarantees the alias STORE itself is never memory-indexed.
describe('alias <-> memory isolation (12.10)', () => {
  it('alias MCP tool names are disjoint from the memory MCP tool surface', () => {
    const memoryTools = new Set<string>(MEMORY_MCP_TOOL_NAME_LIST as readonly string[]);
    for (const name of Object.values(ALIAS_MCP_TOOLS)) {
      expect(memoryTools.has(name)).toBe(false);
    }
  });

  it('the memory tool surface exposes no alias write tool', () => {
    const names = new Set<string>(MEMORY_MCP_TOOL_NAME_LIST as readonly string[]);
    expect(names.has('save_alias')).toBe(false);
    expect(names.has('delete_alias')).toBe(false);
    expect(names.has('resolve_alias')).toBe(false);
    expect(names.has('list_aliases')).toBe(false);
  });
});
