import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerMemoryMcpTools, type MachineToolDeps } from '../../src/daemon/memory-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import { MEMORY_MCP_TOOL_CONTRACTS, MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { MACHINE_LIST_MAX_ITEMS, NODE_ROLE, REMOTE_EXEC_MAX_COMMAND_BYTES } from '../../shared/remote-exec.js';

// Machine tool handlers never touch the runtime caller; a bare stub is enough.
const stubCaller = {} as unknown as McpRuntimeCaller;

async function connect(machineDeps: MachineToolDeps): Promise<Client> {
  const server = new McpServer({ name: 'test-machine-mcp', version: '0.0.0' });
  registerMemoryMcpTools(server, stubCaller, { machineDeps, nodeRole: NODE_ROLE.FULL });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const okDeps: MachineToolDeps = {
  listMachines: () => [{ name: 'win-1', displayName: 'Win Box', os: 'win', online: true, execEnabled: true, role: NODE_ROLE.CONTROLLED }],
  execRemote: () => ({ outcome: 'completed', ok: true, exitCode: 7, stdout: 'ok', stderr: '', timedOut: false, truncated: false, durationMs: 3 }),
};

type PublishedSchema = {
  properties?: Record<string, PublishedSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: PublishedSchema;
  maxItems?: number;
};

function requiredKeys(schema: PublishedSchema | undefined): string[] {
  return [...(schema?.required ?? [])].sort();
}

function optionalKeys(schema: PublishedSchema | undefined): string[] {
  const required = new Set(schema?.required ?? []);
  return Object.keys(schema?.properties ?? {}).filter((key) => !required.has(key)).sort();
}

describe('machine MCP tools — in-process discovery + call parity', () => {
  it('tools/list advertises both tools WITH output schemas and no caller idempotencyKey', async () => {
    const client = await connect(okDeps);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const exec = byName.get(MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE);
    const list = byName.get(MEMORY_MCP_TOOL_NAMES.LIST_MACHINES);
    expect(exec).toBeTruthy();
    expect(list).toBeTruthy();
    expect(Object.keys(exec!.inputSchema.properties ?? {})).not.toContain('idempotencyKey');
    expect(exec!.outputSchema).toBeTruthy();
    expect(list!.outputSchema).toBeTruthy();
    // Published input schema enforces the single-source minimum timeout (1000ms).
    const timeoutMs = (exec!.inputSchema.properties as Record<string, { minimum?: number }>).timeoutMs;
    expect(timeoutMs?.minimum).toBe(1000);
    await client.close();
  });

  it('published input/output required and optional fields match the shared JSON contracts', async () => {
    const client = await connect(okDeps);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const name of [MEMORY_MCP_TOOL_NAMES.LIST_MACHINES, MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE] as const) {
      const published = byName.get(name)!;
      const shared = MEMORY_MCP_TOOL_CONTRACTS[name];
      for (const key of ['inputSchema', 'outputSchema'] as const) {
        const publishedSchema = published[key] as PublishedSchema;
        const sharedSchema = shared[key] as PublishedSchema;
        expect(requiredKeys(publishedSchema), `${name} ${key} required`).toEqual(requiredKeys(sharedSchema));
        expect(optionalKeys(publishedSchema), `${name} ${key} optional`).toEqual(optionalKeys(sharedSchema));
        expect(publishedSchema.additionalProperties, `${name} ${key} additionalProperties`).toBe(sharedSchema.additionalProperties);
      }
    }

    const publishedList = byName.get(MEMORY_MCP_TOOL_NAMES.LIST_MACHINES)!.outputSchema as PublishedSchema;
    const sharedList = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.LIST_MACHINES].outputSchema as PublishedSchema;
    const publishedItems = publishedList.properties!.machines!.items;
    const sharedItems = sharedList.properties!.machines!.items;
    expect(requiredKeys(publishedItems)).toEqual(requiredKeys(sharedItems));
    expect(optionalKeys(publishedItems)).toEqual(optionalKeys(sharedItems));
    expect(publishedList.properties!.machines!.maxItems).toBe(MACHINE_LIST_MAX_ITEMS);
    expect(publishedList.properties!.machines!.maxItems).toBe(sharedList.properties!.machines!.maxItems);
    await client.close();
  });

  it('an unbound daemon surfaces list_machines as FEATURE_DISABLED (not control_plane_unavailable)', async () => {
    const client = await connect({
      listMachines: () => { const e = new Error('daemon is not bound to a server'); (e as unknown as { kind: string }).kind = 'unbound'; throw e; },
      execRemote: okDeps.execRemote,
    });
    const res = await client.callTool({ name: MEMORY_MCP_TOOL_NAMES.LIST_MACHINES, arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { reason?: string }).reason).toBe('feature_disabled');
    await client.close();
  });

  it('tools/call exec_remote returns SDK-validated structuredContent (nonzero exit is still completed/ok)', async () => {
    const client = await connect(okDeps);
    const res = await client.callTool({ name: MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE, arguments: { machine: 'win-1', command: 'whoami' } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ status: 'ok', outcome: 'completed', ok: true, exitCode: 7 });
    await client.close();
  });

  it('streams ordered stdout/stderr through standard MCP progress notifications', async () => {
    const client = await connect({
      listMachines: okDeps.listMachines,
      execRemote: async ({ onOutput }) => {
        await onOutput?.({ seq: 0, stream: 'stdout', chunk: 'first' });
        await onOutput?.({ seq: 1, stream: 'stderr', chunk: 'warn' });
        return {
          outcome: 'completed', ok: true, exitCode: 0,
          stdout: 'first', stderr: 'warn', timedOut: false, truncated: false, durationMs: 3,
        };
      },
    });
    const progress: Array<{ progress: number; message?: string }> = [];
    const res = await client.callTool(
      { name: MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE, arguments: { machine: 'win-1', command: 'long task' } },
      undefined,
      { onprogress: (update) => progress.push({ progress: update.progress, message: update.message }) },
    );

    expect(progress).toEqual([
      { progress: 1, message: '[stdout] first' },
      { progress: 2, message: '[stderr] warn' },
    ]);
    expect(res.structuredContent).toMatchObject({ status: 'ok', outcome: 'completed', stdout: 'first', stderr: 'warn' });
    await client.close();
  });

  it('exec_remote output schema accepts a null exitCode (signal/spawn failure)', async () => {
    const client = await connect({
      listMachines: okDeps.listMachines,
      execRemote: () => ({ outcome: 'spawn_error', ok: false, exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false, error: 'shell not found', durationMs: 1 }),
    });
    const res = await client.callTool({ name: MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE, arguments: { machine: 'win-1', command: 'x' } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ status: 'ok', outcome: 'spawn_error', ok: false, exitCode: null });
    await client.close();
  });

  it('rejects an over-limit UTF-8 command before calling machine deps', async () => {
    const execRemote = vi.fn(okDeps.execRemote);
    const client = await connect({ listMachines: okDeps.listMachines, execRemote });
    const command = '界'.repeat(Math.floor(REMOTE_EXEC_MAX_COMMAND_BYTES / 3) + 1);
    const res = await client.callTool({ name: MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE, arguments: { machine: 'win-1', command } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ status: 'error', reason: 'validation_failed' });
    expect(execRemote).not.toHaveBeenCalled();
    await client.close();
  });

  it('rejects an over-limit injected machine list instead of publishing or truncating it', async () => {
    const machines = Array.from({ length: MACHINE_LIST_MAX_ITEMS + 1 }, (_, index) => ({
      name: `machine-${index}`,
      online: true,
      execEnabled: true,
      role: NODE_ROLE.CONTROLLED,
    }));
    const client = await connect({ listMachines: () => machines, execRemote: okDeps.execRemote });
    const res = await client.callTool({ name: MEMORY_MCP_TOOL_NAMES.LIST_MACHINES, arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ status: 'error', reason: 'control_plane_unavailable' });
    await client.close();
  });

  it('rejects malformed injected list items and does not leak their fields', async () => {
    const client = await connect({
      listMachines: () => [{ name: 'bad', online: true, role: NODE_ROLE.CONTROLLED, injected: 'secret' } as never],
      execRemote: okDeps.execRemote,
    });
    const res = await client.callTool({ name: MEMORY_MCP_TOOL_NAMES.LIST_MACHINES, arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.structuredContent)).not.toContain('secret');
    await client.close();
  });

  it('maps every malformed injected outcome/result combination to indeterminate without leaking it', async () => {
    const invalidResults = [
      { outcome: 'completed', ok: 'forged', injected: 'secret' },
      { outcome: 'completed', ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 1, error: '' },
      { outcome: 'completed', ok: true, exitCode: 0, timedOut: false, truncated: false, durationMs: 1 },
      { outcome: 'node_timeout', ok: false, exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 1, error: 'timeout' },
      { outcome: 'spawn_error', ok: false, exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 1, error: '' },
      { outcome: 'not_dispatched', error: 'untyped failure' },
      { outcome: 'dispatched_no_result', stdout: 'forbidden' },
    ];
    for (const injected of invalidResults) {
      const client = await connect({
        listMachines: okDeps.listMachines,
        execRemote: () => injected as never,
      });
      const res = await client.callTool({ name: MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE, arguments: { machine: 'win-1', command: 'whoami' } });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toEqual({ status: 'ok', outcome: 'dispatched_no_result' });
      expect(JSON.stringify(res.structuredContent)).not.toContain('secret');
      await client.close();
    }
  });

  it('tools/call list_machines returns machines carrying role + os', async () => {
    const client = await connect(okDeps);
    const res = await client.callTool({ name: MEMORY_MCP_TOOL_NAMES.LIST_MACHINES, arguments: {} });
    expect(res.isError).toBeFalsy();
    const machines = (res.structuredContent as { machines: Array<Record<string, unknown>> }).machines;
    expect(machines[0]).toMatchObject({ name: 'win-1', role: 'controlled', os: 'win', online: true });
    await client.close();
  });

  it('a control-plane failure surfaces as an error result, not an empty machine list', async () => {
    const client = await connect({
      listMachines: () => { throw new Error('machines API returned http_503'); },
      execRemote: okDeps.execRemote,
    });
    const res = await client.callTool({ name: MEMORY_MCP_TOOL_NAMES.LIST_MACHINES, arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { reason?: string }).reason).toBe('control_plane_unavailable');
    await client.close();
  });
});
