import { describe, it, expect, vi } from 'vitest';
import { createDaemonMachineToolDeps } from '../../src/daemon/machine-mcp-deps.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';

const creds = { serverUrl: 'https://relay.example', serverId: 's1', token: 't1' };
type ClientMachine = { serverId: string; name: string; refName: string; displayName: string; os?: string; online: boolean; nodeRole: 'controlled'; execEnabled: boolean };
const m = (over: Partial<ClientMachine>): ClientMachine => ({ serverId: 'x', name: 'x', refName: 'x', displayName: 'X', online: true, nodeRole: 'controlled', execEnabled: true, ...over });

describe('daemon machine tool deps — fail-closed resolution (10.12 / 10.11)', () => {
  it('unbound daemon: exec → FEATURE_DISABLED, list throws an unbound-kind control-plane error (not an empty list)', async () => {
    const { MachineControlPlaneError } = await import('../../src/daemon/machine-exec-client.js');
    const deps = createDaemonMachineToolDeps({ loadCredential: async () => null });
    expect(await deps.execRemote({ machine: 'a', command: 'x' })).toMatchObject({ outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.FEATURE_DISABLED });
    expect(await deps.computerUseCall?.({ machine: 'a', tool: 'list_apps' })).toMatchObject({ outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.FEATURE_DISABLED });
    await expect(deps.listMachines({})).rejects.toMatchObject({ name: 'MachineControlPlaneError', kind: 'unbound' });
    void MachineControlPlaneError;
  });

  it('maps client machines to ref_name-keyed summaries', async () => {
    const deps = createDaemonMachineToolDeps({
      loadCredential: async () => creds,
      listMachines: async () => [m({ serverId: 'srvA', refName: 'mac-a1b2', displayName: 'My Mac', os: 'darwin' })],
      execRemote: async () => ({ outcome: 'completed' }),
    });
    expect(await deps.listMachines({ includeOffline: true })).toEqual([{ name: 'mac-a1b2', displayName: 'My Mac', os: 'darwin', online: true, execEnabled: true, role: 'controlled' }]);
  });

  it('a control-plane failure during exec name-resolution surfaces as control_plane_unavailable, NOT machine_not_found', async () => {
    const { MachineControlPlaneError } = await import('../../src/daemon/machine-exec-client.js');
    const exec = vi.fn(async () => ({ outcome: 'completed' as const }));
    const deps = createDaemonMachineToolDeps({
      loadCredential: async () => creds,
      listMachines: async () => { throw new MachineControlPlaneError('http_status', 'machines API returned http_503'); },
      execRemote: exec,
    });
    expect(await deps.execRemote({ machine: 'anything', command: 'x' })).toMatchObject({ outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE });
    expect(exec).not.toHaveBeenCalled();
  });

  it('a control-plane failure during computer-use name-resolution surfaces as control_plane_unavailable', async () => {
    const { MachineControlPlaneError } = await import('../../src/daemon/machine-exec-client.js');
    const computerUse = vi.fn(async () => ({ outcome: 'completed' as const }));
    const deps = createDaemonMachineToolDeps({
      loadCredential: async () => creds,
      listMachines: async () => { throw new MachineControlPlaneError('http_status', 'machines API returned http_503'); },
      execRemote: async () => ({ outcome: 'completed' }),
      computerUseCall: computerUse as never,
    });
    expect(await deps.computerUseCall?.({ machine: 'anything', tool: 'list_apps' })).toMatchObject({ outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE });
    expect(computerUse).not.toHaveBeenCalled();
  });

  it('unknown ref_name → machine_not_found (never a silent retarget)', async () => {
    const deps = createDaemonMachineToolDeps({ loadCredential: async () => creds, listMachines: async () => [m({ refName: 'other' })], execRemote: async () => ({ outcome: 'completed' }) });
    expect(await deps.execRemote({ machine: 'missing', command: 'x' })).toMatchObject({ outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.MACHINE_NOT_FOUND });
  });

  it('duplicate ref_name → machine_ambiguous', async () => {
    const deps = createDaemonMachineToolDeps({ loadCredential: async () => creds, listMachines: async () => [m({ serverId: 'a', refName: 'dup' }), m({ serverId: 'b', refName: 'dup' })], execRemote: async () => ({ outcome: 'completed' }) });
    expect(await deps.execRemote({ machine: 'dup', command: 'x' })).toMatchObject({ outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.MACHINE_AMBIGUOUS });
  });

  it('exec-disabled target → exec_disabled (before dispatch)', async () => {
    const exec = vi.fn(async () => ({ outcome: 'completed' as const }));
    const deps = createDaemonMachineToolDeps({ loadCredential: async () => creds, listMachines: async () => [m({ refName: 'off', execEnabled: false })], execRemote: exec });
    expect(await deps.execRemote({ machine: 'off', command: 'x' })).toMatchObject({ outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.EXEC_DISABLED });
    expect(exec).not.toHaveBeenCalled();
  });

  it('computer-use resolves ref_name → serverId and forwards to the client, preserving the outcome', async () => {
    const computerUse = vi.fn(async (opts: { targetServerId: string; tool: string }) => ({
      outcome: 'completed' as const,
      result: {
        correlationId: 'cu-12345678',
        ok: true,
        tool: opts.tool,
        content: [{ type: 'text' as const, text: `ran:${opts.tool}@${opts.targetServerId}` }],
        durationMs: 9,
      },
    }));
    const deps = createDaemonMachineToolDeps({
      loadCredential: async () => creds,
      listMachines: async () => [m({ serverId: 'srv-win', refName: 'win-1' })],
      execRemote: async () => ({ outcome: 'completed' }),
      computerUseCall: computerUse as never,
    });
    const r = await deps.computerUseCall?.({
      machine: 'win-1',
      tool: 'get_app_state',
      arguments: { app: 'msedge' },
      timeoutMs: 3000,
    });
    expect(computerUse).toHaveBeenCalledWith(expect.objectContaining({
      targetServerId: 'srv-win',
      tool: 'get_app_state',
      arguments: { app: 'msedge' },
      timeoutMs: 3000,
      sourceServerId: 's1',
    }));
    expect(r).toMatchObject({ outcome: 'completed', result: { ok: true, content: [{ text: 'ran:get_app_state@srv-win' }] } });
  });


  it('computer-use local target runs on the imcodes daemon host even when unbound', async () => {
    const localComputerUse = vi.fn(async ({ tool }: { tool: string }) => ({
      outcome: 'completed' as const,
      result: {
        correlationId: 'local-cu-12345678',
        ok: true,
        tool,
        content: [{ type: 'text' as const, text: `local:${tool}` }],
        durationMs: 4,
      },
    }));
    const remoteComputerUse = vi.fn(async () => ({ outcome: 'completed' as const }));
    const deps = createDaemonMachineToolDeps({
      loadCredential: async () => null,
      computerUseCall: remoteComputerUse as never,
      localComputerUseCall: localComputerUse as never,
    });
    const r = await deps.computerUseCall?.({ machine: 'local', tool: 'list_apps' });
    expect(localComputerUse).toHaveBeenCalledWith(expect.objectContaining({ tool: 'list_apps' }));
    expect(remoteComputerUse).not.toHaveBeenCalled();
    expect(r).toMatchObject({ outcome: 'completed', result: { content: [{ text: 'local:list_apps' }] } });
  });

  it('computer-use local aliases include the daemon serverId and do not resolve through remote machines', async () => {
    const localComputerUse = vi.fn(async ({ tool, arguments: args }: { tool: string; arguments?: Record<string, unknown> }) => ({
      outcome: 'completed' as const,
      result: {
        correlationId: 'local-cu-abcdefgh',
        ok: true,
        tool,
        content: [{ type: 'text' as const, text: `local:${String(args?.app ?? '')}` }],
        durationMs: 5,
      },
    }));
    const listMachines = vi.fn(async () => [m({ serverId: 'remote', refName: 'remote' })]);
    const remoteComputerUse = vi.fn(async () => ({ outcome: 'completed' as const }));
    const deps = createDaemonMachineToolDeps({
      loadCredential: async () => creds,
      listMachines,
      execRemote: async () => ({ outcome: 'completed' }),
      computerUseCall: remoteComputerUse as never,
      localComputerUseCall: localComputerUse as never,
    });
    const r = await deps.computerUseCall?.({ machine: creds.serverId, tool: 'get_app_state', arguments: { app: 'chrome' } });
    expect(localComputerUse).toHaveBeenCalledWith(expect.objectContaining({ tool: 'get_app_state', arguments: { app: 'chrome' } }));
    expect(listMachines).not.toHaveBeenCalled();
    expect(remoteComputerUse).not.toHaveBeenCalled();
    expect(r).toMatchObject({ outcome: 'completed', result: { content: [{ text: 'local:chrome' }] } });
  });

  it('offline target → exec_offline (retry-safe, not confused with a command failure)', async () => {
    const exec = vi.fn(async () => ({ outcome: 'completed' as const }));
    const deps = createDaemonMachineToolDeps({ loadCredential: async () => creds, listMachines: async () => [m({ refName: 'sleepy', online: false })], execRemote: exec });
    expect(await deps.execRemote({ machine: 'sleepy', command: 'x' })).toMatchObject({ outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.EXEC_OFFLINE });
    expect(exec).not.toHaveBeenCalled();
  });

  it('resolves ref_name → serverId and forwards to the client, preserving the outcome', async () => {
    const exec = vi.fn(async (opts: { targetServerId: string; command: string }) => ({ outcome: 'completed' as const, ok: true, exitCode: 0, stdout: `ran:${opts.command}@${opts.targetServerId}` }));
    const deps = createDaemonMachineToolDeps({
      loadCredential: async () => creds,
      listMachines: async () => [m({ serverId: 'srv-win', refName: 'win-1' })],
      execRemote: exec as never,
    });
    const r = await deps.execRemote({ machine: 'win-1', command: 'whoami', shell: 'powershell', timeoutMs: 3000 });
    expect(exec).toHaveBeenCalledWith(expect.objectContaining({ targetServerId: 'srv-win', command: 'whoami', shell: 'powershell', timeoutMs: 3000, sourceServerId: 's1' }));
    expect(r).toMatchObject({ outcome: 'completed', ok: true, stdout: 'ran:whoami@srv-win' });
  });
});
