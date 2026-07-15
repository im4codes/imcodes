import { describe, it, expect, vi } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { createMemoryMcpToolHandlers, type MachineToolDeps } from '../../src/daemon/memory-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';

function caller(): McpRuntimeCaller {
  const namespace: ContextNamespace = { scope: 'user_private', userId: 'user-1', projectId: 'repo-1' };
  return { userId: 'user-1', namespace, sessionName: 'deck_proj_brain', projectName: 'proj', projectRoot: '/tmp/proj', serverId: 'srv-1', transport: 'in_process' };
}

const listMachines = MEMORY_MCP_TOOL_NAMES.LIST_MACHINES;
const execRemote = MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE;
const sendFile = MEMORY_MCP_TOOL_NAMES.SEND_FILE_TO_MACHINE;
const fetchFile = MEMORY_MCP_TOOL_NAMES.FETCH_FILE_FROM_MACHINE;
const computerUseDocs = MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_DOCS;
const computerUseCall = MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL;

describe('exec_remote / list_machines handlers (10.12)', () => {
  it('returns feature_disabled when the node cannot control machines (no machineDeps)', async () => {
    const handlers = createMemoryMcpToolHandlers(caller(), {});
    expect(await handlers[execRemote]({ machine: 'm', command: 'x' })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.FEATURE_DISABLED });
    expect(await handlers[listMachines]({})).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.FEATURE_DISABLED });
    expect(await handlers[computerUseCall]({ machine: 'm', tool: 'list_apps' })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.FEATURE_DISABLED });
    expect(await handlers[sendFile]({ machine: 'm', sourcePath: '/tmp/a' })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.FEATURE_DISABLED });
    expect(await handlers[fetchFile]({ machine: 'm', sourcePath: '/tmp/a', destinationPath: '/tmp/b' })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.FEATURE_DISABLED });
  });

  it('validates and returns metadata for explicit machine file transfers', async () => {
    const send = vi.fn(async () => ({ ok: true as const, remotePath: '/staging/a.txt', attachmentId: 'a'.repeat(32), size: 5 }));
    const fetch = vi.fn(async ({ destinationPath }: { destinationPath: string }) => ({ ok: true as const, destinationPath, attachmentId: 'b'.repeat(32), size: 7 }));
    const machineDeps: MachineToolDeps = {
      listMachines: async () => [],
      execRemote: async () => ({ outcome: 'completed' as const }),
      sendFileToMachine: send,
      fetchFileFromMachine: fetch,
    };
    const handlers = createMemoryMcpToolHandlers(caller(), { machineDeps });
    expect(await handlers[sendFile]({ machine: 'win', sourcePath: '' })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(await handlers[fetchFile]({ machine: 'win', sourcePath: '/remote/a' })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    expect(await handlers[sendFile]({ machine: 'win', sourcePath: '/tmp/a' })).toMatchObject({ status: 'ok', remotePath: '/staging/a.txt', size: 5 });
    expect(await handlers[fetchFile]({ machine: 'win', sourcePath: '/remote/a', destinationPath: '/tmp/a', overwrite: true })).toMatchObject({ status: 'ok', destinationPath: '/tmp/a', size: 7 });
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ overwrite: true }));
  });

  it('validates required + typed fields before dispatching', async () => {
    const machineDeps: MachineToolDeps = { listMachines: async () => [], execRemote: vi.fn(async () => ({ outcome: 'completed' as const })) };
    const handlers = createMemoryMcpToolHandlers(caller(), { machineDeps });
    expect(await handlers[execRemote]({ command: 'x' })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(await handlers[execRemote]({ machine: 'm' })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(await handlers[execRemote]({ machine: 'm', command: 'x', shell: 'zsh' })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(await handlers[execRemote]({ machine: 'm', command: 'x', timeoutMs: -5 })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(await handlers[execRemote]({ machine: 'm', command: 'x', timeoutMs: 999_999_999 })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(await handlers[execRemote]({ machine: 'bad target', command: 'x' })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(machineDeps.execRemote).not.toHaveBeenCalled();
  });

  it('maps a typed reason from the dep to a shared MCP error (offline is not a command failure)', async () => {
    const machineDeps: MachineToolDeps = {
      listMachines: async () => [],
      execRemote: async () => ({ outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.EXEC_OFFLINE, error: 'machine "m" is offline' }),
    };
    const handlers = createMemoryMcpToolHandlers(caller(), { machineDeps });
    const r = await handlers[execRemote]({ machine: 'm', command: 'x' });
    expect(r).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.EXEC_OFFLINE });
  });

  it('passes a completed outcome through untouched (discriminated union preserved)', async () => {
    const machineDeps: MachineToolDeps = {
      listMachines: async () => [],
      execRemote: async ({ machine, command, shell, timeoutMs }) => {
        expect({ machine, command, shell, timeoutMs }).toEqual({ machine: 'win', command: 'echo hi', shell: 'powershell', timeoutMs: 5000 });
        return {
          outcome: 'completed',
          ok: true,
          exitCode: 0,
          stdout: 'hi',
          stderr: '',
          timedOut: false,
          truncated: false,
          durationMs: 12,
        };
      },
    };
    const handlers = createMemoryMcpToolHandlers(caller(), { machineDeps });
    const r = await handlers[execRemote]({ machine: 'win', command: 'echo hi', shell: 'powershell', timeoutMs: 5000 });
    expect(r).toMatchObject({ status: 'ok', outcome: 'completed', ok: true, exitCode: 0, stdout: 'hi' });
  });

  it('list_machines returns the machines from the dep', async () => {
    const machineDeps: MachineToolDeps = {
      listMachines: async ({ includeOffline }) => (includeOffline ? [
        { name: 'a', os: 'win', online: true, execEnabled: true, role: 'controlled' },
        { name: 'b', os: 'linux', online: false, execEnabled: true, role: 'controlled' },
      ] : [{ name: 'a', os: 'win', online: true, execEnabled: true, role: 'controlled' }]),
      execRemote: async () => ({ outcome: 'completed' as const }),
    };
    const handlers = createMemoryMcpToolHandlers(caller(), { machineDeps });
    expect(await handlers[listMachines]({})).toMatchObject({ status: 'ok', machines: [{ name: 'a' }] });
    expect(await handlers[listMachines]({ includeOffline: true })).toMatchObject({ status: 'ok', machines: [{ name: 'a' }, { name: 'b' }] });
  });

  it('computer_use_docs returns focused documentation without machine deps', async () => {
    const handlers = createMemoryMcpToolHandlers(caller(), {});
    const r = await handlers[computerUseDocs]({ topic: 'workflow' });
    expect(r).toMatchObject({ status: 'ok', topic: 'workflow' });
    expect((r as { text: string }).text).toContain('get_app_state');
  });

  it('computer_use_call validates input before dispatching', async () => {
    const computerUse = vi.fn(async ({ tool }: { tool: 'shell_session1' | 'list_apps' }) => ({
      outcome: 'completed' as const,
      result: {
        correlationId: 'cu-12345678',
        ok: true,
        tool,
        content: [{ type: 'text' as const, text: 'ok' }],
        durationMs: 1,
      },
    }));
    const machineDeps: MachineToolDeps = {
      listMachines: async () => [],
      execRemote: async () => ({ outcome: 'completed' as const }),
      computerUseCall: computerUse,
    };
    const handlers = createMemoryMcpToolHandlers(caller(), { machineDeps });
    expect(await handlers[computerUseCall]({ tool: 'list_apps' })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(await handlers[computerUseCall]({ machine: 'm' })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(await handlers[computerUseCall]({ machine: 'm', tool: 'nope' })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(await handlers[computerUseCall]({ machine: 'm', tool: 'list_apps', arguments: [] })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(await handlers[computerUseCall]({ machine: 'm', tool: 'list_apps', timeoutMs: -1 })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(await handlers[computerUseCall]({ machine: 'm', tool: 'list_apps', timeoutMs: 120_001 })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(computerUse).not.toHaveBeenCalled();

    expect(await handlers[computerUseCall]({ machine: 'm', tool: 'shell_session1', timeoutMs: 900_000 })).toMatchObject({ status: 'ok', outcome: 'completed' });
    expect(computerUse).toHaveBeenCalledWith(expect.objectContaining({ machine: 'm', tool: 'shell_session1', timeoutMs: 900_000 }));
    expect(await handlers[computerUseCall]({ machine: 'm', tool: 'shell_session1', timeoutMs: 900_001 })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(computerUse).toHaveBeenCalledTimes(1);
  });

  it('computer_use_call maps typed pre-dispatch reasons to MCP errors and passes completed results through', async () => {
    const machineDeps: MachineToolDeps = {
      listMachines: async () => [],
      execRemote: async () => ({ outcome: 'completed' as const }),
      computerUseCall: vi.fn(async ({ machine, tool, arguments: args, timeoutMs }) => {
        if (machine === 'offline') return { outcome: 'not_dispatched' as const, reason: MCP_ERROR_REASONS.EXEC_OFFLINE, error: 'offline' };
        expect({ machine, tool, args, timeoutMs }).toEqual({ machine: 'win', tool: 'list_apps', args: {}, timeoutMs: 5000 });
        return {
          outcome: 'completed' as const,
          result: {
            correlationId: 'cu-12345678',
            ok: true,
            tool,
            content: [{ type: 'text' as const, text: 'apps' }],
            durationMs: 7,
          },
        };
      }),
    };
    const handlers = createMemoryMcpToolHandlers(caller(), { machineDeps });
    expect(await handlers[computerUseCall]({ machine: 'offline', tool: 'list_apps' })).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.EXEC_OFFLINE });
    const r = await handlers[computerUseCall]({ machine: 'win', tool: 'list_apps', arguments: {}, timeoutMs: 5000 });
    expect(r).toMatchObject({ status: 'ok', outcome: 'completed', result: { ok: true, content: [{ text: 'apps' }] } });
  });
});
