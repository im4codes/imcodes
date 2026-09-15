import { describe, expect, it, vi } from 'vitest';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import type { VerificationMachineProfile } from '../../shared/verification-machine.js';

const caller: McpRuntimeCaller = {
  userId: 'u1', sessionName: 'deck_demo_brain', projectName: 'demo', projectRoot: '/tmp/demo', serverId: 'srv',
  providerId: null, transport: 'in_process', namespace: { scope: 'personal', userId: 'u1', projectId: 'repo-1' },
};
const base: VerificationMachineProfile = {
  id: 'a'.repeat(32), scope: 'project', scopeKey: 'repo-1', alias: 'Windows rig', kind: 'controlled_node',
  target: '1234567890', enabled: true, revision: 1, createdAt: 1, updatedAt: 1,
  lastVerificationStatus: 'unverified', source: 'mcp',
};

describe('verification machine MCP', () => {
  it('uses the stable id while allowing alias changes and resolving current project scope', async () => {
    const setVerificationMachine = vi.fn(async (input) => ({ status: 'ok' as const, profile: { ...base, ...input } }));
    const handlers = createMemoryMcpToolHandlers(caller, { setVerificationMachine });
    const result = await handlers[MEMORY_MCP_TOOL_NAMES.VERIFICATION_MACHINE_SET]({
      id: base.id, verificationScope: 'project', alias: 'Renamed rig', kind: 'controlled_node', target: base.target,
    });
    expect(result.status).toBe('ok');
    expect(setVerificationMachine).toHaveBeenCalledWith(expect.objectContaining({
      id: base.id, scopeKey: 'repo-1', alias: 'Renamed rig', target: base.target,
    }));
  });

  it('verifies an SSH alias association without probing connectivity', async () => {
    const aliasId = 'b'.repeat(32);
    const recordVerificationMachineStatus = vi.fn(async (_id, status) => ({
      status: 'ok' as const, profile: { ...base, kind: 'ssh' as const, target: aliasId, lastVerificationStatus: status },
    }));
    const handlers = createMemoryMcpToolHandlers(caller, {
      listVerificationMachines: async () => ({ status: 'ok', profiles: [{ ...base, kind: 'ssh', target: aliasId }] }),
      listVerificationAliases: async () => ({ status: 'ok', aliases: [{
        id: aliasId, name: '211', value: 'ssh k@172.16.253.211', tags: [], createdAt: '', updatedAt: '', source: 'web',
      }] }),
      recordVerificationMachineStatus,
    });
    const result = await handlers[MEMORY_MCP_TOOL_NAMES.VERIFICATION_MACHINE_VERIFY]({ id: base.id });
    expect(result).toMatchObject({ status: 'ok', verificationStatus: 'verified' });
    expect(recordVerificationMachineStatus).toHaveBeenCalledWith(base.id, 'verified');
  });

  it('rechecks controlled-node access and never treats a stale stored record as authority', async () => {
    const recordVerificationMachineStatus = vi.fn(async (_id, status) => ({ status: 'ok' as const, profile: { ...base, lastVerificationStatus: status } }));
    const handlers = createMemoryMcpToolHandlers(caller, {
      listVerificationMachines: async () => ({ status: 'ok', profiles: [base] }),
      machineDeps: { listMachines: async () => [], execRemote: async () => ({ outcome: 'completed' }) },
      recordVerificationMachineStatus,
    });
    const result = await handlers[MEMORY_MCP_TOOL_NAMES.VERIFICATION_MACHINE_VERIFY]({ id: base.id });
    expect(result).toMatchObject({ status: 'ok', verificationStatus: 'unauthorized' });
  });

  it('executes a bounded non-destructive probe before marking a controlled node verified', async () => {
    const execRemote = vi.fn(async () => ({ outcome: 'completed' as const, exitCode: 0 }));
    const handlers = createMemoryMcpToolHandlers(caller, {
      listVerificationMachines: async () => ({ status: 'ok', profiles: [base] }),
      machineDeps: {
        listMachines: async () => [{ name: base.target, online: true, execEnabled: true, role: 'controlled' }],
        execRemote,
      },
      recordVerificationMachineStatus: async (_id, status) => ({ status: 'ok', profile: { ...base, lastVerificationStatus: status } }),
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.VERIFICATION_MACHINE_VERIFY]({ id: base.id }))
      .resolves.toMatchObject({ status: 'ok', verificationStatus: 'verified' });
    expect(execRemote).toHaveBeenCalledWith({ machine: base.target, command: 'echo imcodes-verification', timeoutMs: 10_000 });
  });
});
