import { describe, expect, it } from 'vitest';
import {
  PROCESS_SESSION_AGENT_TYPES,
  SESSION_AGENT_TYPES,
  TRANSPORT_SESSION_AGENT_TYPES,
} from '../../shared/agent-types.js';
import {
  MCP_TOOL_DISCOVERY_REFRESH_INSTRUCTIONS,
  MCP_TOOL_DISTRIBUTION_CONTRACT_VERSION,
  MCP_TOOL_RUNTIME_BOUNDARIES,
  getMcpToolDistributionContract,
} from '../../shared/mcp-tool-distribution.js';
import { getDefaultMcpServers } from '../../src/agent/providers/getDefaultMcpServers.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';

describe('shared MCP tool distribution contract', () => {
  it('classifies every runtime without making provider activity an activation gate', () => {
    const contracts = SESSION_AGENT_TYPES.map(getMcpToolDistributionContract);
    expect(MCP_TOOL_DISTRIBUTION_CONTRACT_VERSION).toBe(1);
    expect(contracts.map(({ agentType }) => agentType)).toEqual([...SESSION_AGENT_TYPES]);
    expect(Object.keys(MCP_TOOL_RUNTIME_BOUNDARIES).sort()).toEqual([...SESSION_AGENT_TYPES].sort());
    expect(contracts.every((contract) => (
      contract.backendToolsAlreadyActive
      && contract.boundedPublication
      && contract.directCallRequiresPublishedSchema
    ))).toBe(true);

    const notApplicable = contracts
      .filter(({ delivery }) => delivery === 'not_applicable')
      .map(({ agentType }) => agentType)
      .sort();
    // OpenClaw uses its gateway-native tools, while raw shell/script sessions
    // have no MCP host. Every other IM.codes runtime either mounts managed MCP
    // or can consume the same server through its external CLI configuration.
    expect(notApplicable).toEqual(['openclaw', 'script', 'shell']);
    expect(getMcpToolDistributionContract('openclaw')).toMatchObject({
      boundary: 'gateway_native', managedMcp: false, exactFallback: false,
    });
    expect(contracts.filter(({ delivery }) => delivery !== 'not_applicable').every((contract) => (
      contract.exactFallback && contract.reconnectColdHydration
    ))).toBe(true);
  });

  it('uses the shared live-catalog adapter only where the host exposes mutation and the same exact fallback everywhere else', () => {
    expect(getMcpToolDistributionContract('pi')).toMatchObject({
      delivery: 'shared_catalog_with_exact_fallback',
      managedMcp: true,
    });
    for (const agentType of TRANSPORT_SESSION_AGENT_TYPES) {
      if (agentType === 'pi' || agentType === 'openclaw') continue;
      expect(getMcpToolDistributionContract(agentType)).toMatchObject({
        delivery: 'host_refresh_with_exact_fallback',
        managedMcp: true,
        exactFallback: true,
      });
    }
    for (const agentType of PROCESS_SESSION_AGENT_TYPES) {
      if (agentType === 'shell' || agentType === 'script') continue;
      expect(getMcpToolDistributionContract(agentType)).toMatchObject({
        delivery: 'external_config_with_exact_fallback',
        managedMcp: false,
        exactFallback: true,
      });
    }
  });

  it('routes all managed adapters to the same bounded daemon MCP and persists the same-turn fallback guidance', () => {
    for (const { agentType, managedMcp } of SESSION_AGENT_TYPES.map(getMcpToolDistributionContract)) {
      if (!managedMcp) continue;
      const server = getDefaultMcpServers({
        sessionKey: `route-${agentType}`,
        sessionName: `deck_sub_${agentType}`,
        projectName: 'contract',
        providerId: agentType,
        cwd: '/tmp/contract',
      })[IMCODES_MEMORY_MCP_SERVER_NAME];
      expect(server, agentType).toMatchObject({ type: 'stdio', command: 'imcodes', args: ['memory', 'mcp'] });
    }
    expect(MCP_TOOL_DISCOVERY_REFRESH_INSTRUCTIONS).toContain('already backend-active');
    expect(MCP_TOOL_DISCOVERY_REFRESH_INSTRUCTIONS).toContain('complete paginated tools/list');
    expect(MCP_TOOL_DISCOVERY_REFRESH_INSTRUCTIONS).toContain('current model turn');
    expect(MCP_TOOL_DISCOVERY_REFRESH_INSTRUCTIONS).toContain('fallbackCall { name, arguments }');
    expect(MCP_TOOL_DISCOVERY_REFRESH_INSTRUCTIONS).toContain('search the exact alias ocu');
    expect(MCP_TOOL_DISCOVERY_REFRESH_INSTRUCTIONS).toContain('computer_use_docs or computer_use_call');
    expect(MCP_TOOL_DISCOVERY_REFRESH_INSTRUCTIONS).toContain('never infer unavailability from the initial callable list');
    expect(MCP_TOOL_DISCOVERY_REFRESH_INSTRUCTIONS).toContain('wildcard/prefix fallback');
    expect(MCP_TOOL_DISCOVERY_REFRESH_INSTRUCTIONS).toContain('full long-tail publication must fail closed');
  });
});
