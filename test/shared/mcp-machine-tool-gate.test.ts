import { describe, it, expect } from 'vitest';
import {
  MEMORY_MCP_TOOL_NAMES,
  MEMORY_MCP_TOOL_NAME_LIST,
  MEMORY_MCP_TOOL_CONTRACTS,
  FULL_ONLY_MCP_TOOLS,
  isToolAvailableForRole,
  advertisedMcpToolNames,
} from '../../shared/memory-mcp-contracts.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { NODE_ROLE, REMOTE_EXEC_SHELLS, REMOTE_EXEC_MAX_TIMEOUT_MS } from '../../shared/remote-exec.js';

describe('machine MCP tools join the contract surface (10.12)', () => {
  it('both tools are in the name list and have contracts', () => {
    expect(MEMORY_MCP_TOOL_NAME_LIST).toContain(MEMORY_MCP_TOOL_NAMES.LIST_MACHINES);
    expect(MEMORY_MCP_TOOL_NAME_LIST).toContain(MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE);
    expect(MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.LIST_MACHINES].name).toBe('list_machines');
    expect(MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE].name).toBe('exec_remote');
  });

  it('exec_remote schema derives its limits from the named shared/remote-exec constants (no duplicate literals)', () => {
    const c = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE];
    const shell = c.inputSchema.properties?.shell;
    const timeout = c.inputSchema.properties?.timeoutMs;
    expect(shell?.enum).toEqual([...REMOTE_EXEC_SHELLS]);
    expect(timeout?.maximum).toBe(REMOTE_EXEC_MAX_TIMEOUT_MS);
  });

  it('the shared error enum carries the machine reasons', () => {
    expect(MCP_ERROR_REASONS.MACHINE_NOT_FOUND).toBe('machine_not_found');
    expect(MCP_ERROR_REASONS.MACHINE_AMBIGUOUS).toBe('machine_ambiguous');
    expect(MCP_ERROR_REASONS.EXEC_OFFLINE).toBe('exec_offline');
    expect(MCP_ERROR_REASONS.EXEC_DISABLED).toBe('exec_disabled');
  });
});

describe('FULL-only role gate (10.12)', () => {
  it('both machine tools are marked FULL-only', () => {
    expect(FULL_ONLY_MCP_TOOLS.has(MEMORY_MCP_TOOL_NAMES.LIST_MACHINES)).toBe(true);
    expect(FULL_ONLY_MCP_TOOLS.has(MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE)).toBe(true);
  });

  it('a controlled node cannot access the machine tools but can access ordinary tools', () => {
    expect(isToolAvailableForRole(MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE, NODE_ROLE.CONTROLLED)).toBe(false);
    expect(isToolAvailableForRole(MEMORY_MCP_TOOL_NAMES.LIST_MACHINES, NODE_ROLE.CONTROLLED)).toBe(false);
    expect(isToolAvailableForRole(MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY, NODE_ROLE.CONTROLLED)).toBe(true);
  });

  it('a FULL node can access the machine tools', () => {
    expect(isToolAvailableForRole(MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE, NODE_ROLE.FULL)).toBe(true);
    expect(isToolAvailableForRole(MEMORY_MCP_TOOL_NAMES.LIST_MACHINES, NODE_ROLE.FULL)).toBe(true);
  });

  it("a controlled node's advertised tool list excludes both machine tools", () => {
    const controlled = advertisedMcpToolNames(NODE_ROLE.CONTROLLED);
    expect(controlled).not.toContain(MEMORY_MCP_TOOL_NAMES.LIST_MACHINES);
    expect(controlled).not.toContain(MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE);
    // and still advertises the rest
    expect(controlled).toContain(MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY);
  });

  it('a FULL node advertises the complete list including both machine tools', () => {
    const full = advertisedMcpToolNames(NODE_ROLE.FULL);
    expect(full).toEqual([...MEMORY_MCP_TOOL_NAME_LIST]);
  });
});
