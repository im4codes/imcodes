// Production wiring for the FULL-node machine MCP tools (list_machines /
// exec_remote). The stdio MCP process has no ServerLink; it relays through the
// daemon's own bound credential (~/.imcodes/server.json) using the source-side
// machine-exec-client. Name→serverId resolution is FAIL-CLOSED: an unknown,
// ambiguous, exec-disabled, or offline target returns a typed shared MCP error
// reason (never a hang, never a silent retarget). All I/O is injectable so the
// resolution logic is unit-testable without disk or network.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { execRemote as clientExecRemote, listMachines as clientListMachines } from './machine-exec-client.js';
import type { MachineToolDeps, MachineSummaryForTool, MachineExecToolResult } from './memory-mcp-tools.js';

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
}

/** Build the FULL-node machine tool deps from the daemon's own credential. */
export function createDaemonMachineToolDeps(overrides: DaemonMachineToolDepsOverrides = {}): MachineToolDeps {
  const load = overrides.loadCredential ?? loadDaemonCredential;
  const list = overrides.listMachines ?? clientListMachines;
  const exec = overrides.execRemote ?? clientExecRemote;

  const toSummary = (m: Awaited<ReturnType<typeof clientListMachines>>[number]): MachineSummaryForTool => ({
    name: m.refName,
    displayName: m.displayName,
    ...(m.os ? { os: m.os } : {}),
    online: m.online,
    execEnabled: m.execEnabled,
  });

  return {
    async listMachines({ includeOffline }): Promise<MachineSummaryForTool[]> {
      const creds = await load();
      if (!creds) return [];
      const machines = await list({ serverUrl: creds.serverUrl, sourceServerId: creds.serverId, sourceToken: creds.token, ...(includeOffline ? { includeOffline } : {}) });
      return machines.map(toSummary);
    },

    async execRemote({ machine, command, shell, timeoutMs, idempotencyKey }): Promise<MachineExecToolResult> {
      const creds = await load();
      if (!creds) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.FEATURE_DISABLED, error: 'daemon is not bound to a server' };
      // Resolve the ref_name against the FULL machine list (offline included) so
      // "unknown" is distinguished from "offline".
      const all = await list({ serverUrl: creds.serverUrl, sourceServerId: creds.serverId, sourceToken: creds.token, includeOffline: true });
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
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    },
  };
}
