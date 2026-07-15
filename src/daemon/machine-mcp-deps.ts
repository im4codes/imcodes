// Production wiring for the FULL-node machine MCP tools (list_machines /
// exec_remote). The stdio MCP process has no ServerLink; it relays through the
// daemon's own bound credential (~/.imcodes/server.json) using the source-side
// machine-exec-client. Name→serverId resolution is FAIL-CLOSED: an unknown,
// ambiguous, exec-disabled, or offline target returns a typed shared MCP error
// reason (never a hang, never a silent retarget). All I/O is injectable so the
// resolution logic is unit-testable without disk or network.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { execRemote as clientExecRemote, listMachines as clientListMachines, MachineControlPlaneError } from './machine-exec-client.js';
import { computerUseCall as clientComputerUseCall } from './computer-use-client.js';
import { runComputerUseTool } from '../node/computer-use-runner.js';
import type { ComputerUseToolResult, MachineToolDeps, MachineSummaryForTool, MachineExecToolResult } from './memory-mcp-tools.js';

export interface DaemonCredential {
  serverUrl: string;
  serverId: string;
  token: string;
}

/** Read the daemon's own bound credential; null when unbound/unreadable. */
async function loadDaemonCredential(): Promise<DaemonCredential | null> {
  try {
    const raw = await readFile(join(homedir(), '.imcodes', 'server.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<{ serverId: string; token: string; workerUrl: string }>;
    if (!parsed.serverId || !parsed.token || !parsed.workerUrl) return null;
    return { serverUrl: parsed.workerUrl, serverId: parsed.serverId, token: parsed.token };
  } catch {
    return null;
  }
}

export interface DaemonMachineToolDepsOverrides {
  loadCredential?: () => Promise<DaemonCredential | null>;
  listMachines?: typeof clientListMachines;
  execRemote?: typeof clientExecRemote;
  computerUseCall?: typeof clientComputerUseCall;
  localComputerUseCall?: (input: { tool: Parameters<NonNullable<MachineToolDeps['computerUseCall']>>[0]['tool']; arguments?: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal }) => Promise<ComputerUseToolResult> | ComputerUseToolResult;
}

const LOCAL_COMPUTER_USE_ALIASES = new Set(['local', 'localhost', 'self', 'this']);

function isLocalComputerUseTarget(machine: string, creds: DaemonCredential | null): boolean {
  const normalized = machine.trim().toLowerCase();
  return LOCAL_COMPUTER_USE_ALIASES.has(normalized) || Boolean(creds?.serverId && machine === creds.serverId);
}

async function defaultLocalComputerUseCall(input: { tool: Parameters<NonNullable<MachineToolDeps['computerUseCall']>>[0]['tool']; arguments?: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal }): Promise<ComputerUseToolResult> {
  if (input.signal?.aborted) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE, error: 'computer use call aborted' };
  const result = await runComputerUseTool({
    correlationId: `local-${randomBytes(12).toString('hex')}`,
    tool: input.tool,
    ...(input.arguments ? { arguments: input.arguments } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  return { outcome: result.ok ? 'completed' : 'tool_error', result };
}

/** Build the FULL-node machine tool deps from the daemon's own credential. */
export function createDaemonMachineToolDeps(overrides: DaemonMachineToolDepsOverrides = {}): MachineToolDeps {
  const load = overrides.loadCredential ?? loadDaemonCredential;
  const list = overrides.listMachines ?? clientListMachines;
  const exec = overrides.execRemote ?? clientExecRemote;
  const computerUse = overrides.computerUseCall ?? clientComputerUseCall;
  const localComputerUse = overrides.localComputerUseCall ?? defaultLocalComputerUseCall;

  const toSummary = (m: Awaited<ReturnType<typeof clientListMachines>>[number]): MachineSummaryForTool => ({
    name: m.refName,
    displayName: m.displayName,
    ...(m.os ? { os: m.os } : {}),
    online: m.online,
    execEnabled: m.execEnabled,
    // /api/machines returns only controlled nodes by definition; publish the
    // literal role the spec/output-schema require.
    role: NODE_ROLE.CONTROLLED,
  });

  return {
    // Both failure kinds propagate as `MachineControlPlaneError` so the tool
    // surface maps them consistently with the exec path: `unbound` →
    // FEATURE_DISABLED, a real control-plane failure (transport/http/malformed) →
    // CONTROL_PLANE_UNAVAILABLE — never a silent empty "no machines" list.
    async listMachines({ includeOffline }): Promise<MachineSummaryForTool[]> {
      const creds = await load();
      if (!creds) throw new MachineControlPlaneError('unbound', 'daemon is not bound to a server');
      const machines = await list({ serverUrl: creds.serverUrl, sourceServerId: creds.serverId, sourceToken: creds.token, ...(includeOffline ? { includeOffline } : {}) });
      return machines.map(toSummary);
    },

    async execRemote({ machine, command, shell, timeoutMs, signal, onOutput }): Promise<MachineExecToolResult> {
      const creds = await load();
      if (!creds) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.FEATURE_DISABLED, error: 'daemon is not bound to a server' };
      // Resolve the ref_name against the FULL machine list (offline included) so
      // "unknown" is distinguished from "offline". A control-plane failure here
      // must surface as CONTROL_PLANE_UNAVAILABLE, never as MACHINE_NOT_FOUND.
      let all: Awaited<ReturnType<typeof list>>;
      try {
        all = await list({ serverUrl: creds.serverUrl, sourceServerId: creds.serverId, sourceToken: creds.token, includeOffline: true });
      } catch (err) {
        if (err instanceof MachineControlPlaneError) {
          const reason = err.kind === 'unbound' ? MCP_ERROR_REASONS.FEATURE_DISABLED : MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE;
          return { outcome: 'not_dispatched', reason, error: `machine control plane: ${err.kind}` };
        }
        throw err;
      }
      const matches = all.filter((m) => m.refName === machine);
      if (matches.length === 0) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.MACHINE_NOT_FOUND, error: `no controllable machine named "${machine}"` };
      if (matches.length > 1) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.MACHINE_AMBIGUOUS, error: `more than one machine named "${machine}"` };
      const target = matches[0]!;
      if (!target.execEnabled) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.EXEC_DISABLED, error: `remote exec is disabled for "${machine}"` };
      if (!target.online) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.EXEC_OFFLINE, error: `machine "${machine}" is offline` };
      return exec({
        serverUrl: creds.serverUrl,
        sourceServerId: creds.serverId,
        sourceToken: creds.token,
        targetServerId: target.serverId,
        command,
        ...(shell ? { shell } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(signal ? { signal } : {}),
        ...(onOutput ? { onOutput } : {}),
      });
    },

    async computerUseCall({ machine, tool, arguments: args, timeoutMs, signal }) {
      const creds = await load();
      if (isLocalComputerUseTarget(machine, creds)) {
        return localComputerUse({
          tool,
          ...(args ? { arguments: args } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(signal ? { signal } : {}),
        });
      }
      if (!creds) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.FEATURE_DISABLED, error: 'daemon is not bound to a server' };
      let all: Awaited<ReturnType<typeof list>>;
      try {
        all = await list({ serverUrl: creds.serverUrl, sourceServerId: creds.serverId, sourceToken: creds.token, includeOffline: true });
      } catch (err) {
        if (err instanceof MachineControlPlaneError) {
          const reason = err.kind === 'unbound' ? MCP_ERROR_REASONS.FEATURE_DISABLED : MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE;
          return { outcome: 'not_dispatched', reason, error: `machine control plane: ${err.kind}` };
        }
        throw err;
      }
      const matches = all.filter((m) => m.refName === machine);
      if (matches.length === 0) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.MACHINE_NOT_FOUND, error: `no controllable machine named "${machine}"` };
      if (matches.length > 1) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.MACHINE_AMBIGUOUS, error: `more than one machine named "${machine}"` };
      const target = matches[0]!;
      if (!target.execEnabled) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.EXEC_DISABLED, error: `machine control is disabled for "${machine}"` };
      if (!target.online) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.EXEC_OFFLINE, error: `machine "${machine}" is offline` };
      return computerUse({
        serverUrl: creds.serverUrl,
        sourceServerId: creds.serverId,
        sourceToken: creds.token,
        targetServerId: target.serverId,
        tool,
        ...(args ? { arguments: args } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(signal ? { signal } : {}),
      });
    },
  };
}
