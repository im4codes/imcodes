// Production wiring for the FULL-node machine MCP tools (list_machines /
// exec_remote). The stdio MCP process has no ServerLink; it relays through the
// daemon's own bound credential (~/.imcodes/server.json) using the source-side
// machine-exec-client. Name→serverId resolution is FAIL-CLOSED: an unknown,
// ambiguous or exec-disabled target returns a typed shared MCP error. DB-backed
// Canonical nodeId resolves first; deprecated noncanonical ref_name resolution
// remains explicit and ambiguity-fail-closed. `online` is advisory and MUST NOT block dispatch; each target route performs
// the authoritative live-socket check. All I/O is injectable so the resolution
// logic is unit-testable without disk or network.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveImcodesHome } from '../util/windows-daemon-lock.js';
import { MCP_ERROR_REASONS, type MCPErrorReason } from '../../shared/memory-mcp-errors.js';
import { OWNER_MACHINE_AUTHORITY_TYPE } from '../../shared/shared-machine-authority.js';
import { machineActionForComputerUseTool, machineActionRequiresExecute } from '../../shared/machine-access-policy.js';
import { NODE_ROLE, type MachineExecHttpReason } from '../../shared/remote-exec.js';
import type { ComputerUseHttpReason } from '../../shared/computer-use.js';
import { FS_GENERIC_ERROR_CODES } from '../../shared/fs-error-codes.js';
import { FILE_PATH_HANDLE_ERROR } from '../../shared/transport/file-transfer.js';
import { execRemote as clientExecRemote, listMachines as clientListMachines, MachineControlPlaneError } from './machine-exec-client.js';
import { computerUseCall as clientComputerUseCall } from './computer-use-client.js';
import { fetchFileFromMachine as clientFetchFileFromMachine, sendFileToMachine as clientSendFileToMachine } from './machine-file-client.js';
import {
  closePortForward as clientClosePortForward,
  listPortForwards as clientListPortForwards,
  openPortForward as clientOpenPortForward,
} from './port-forward-client.js';
import { PORT_FORWARD_ERRORS, type PortForwardErrorCode } from '../../shared/port-forward.js';
import { runComputerUseTool } from '../node/computer-use-runner.js';
import type { SessionResourceOwnerIdentity } from '../../shared/session-resource-lifecycle.js';
import type { ComputerUseToolResult, MachineFileToolResult, MachineToolDeps, MachineSummaryForTool, MachineExecToolResult } from './memory-mcp-tools.js';
import { classifyMachineTarget, isLocalComputerUseAlias } from '../../shared/machine-reference.js';
import type { MachineListItem } from './machine-exec-client.js';

export interface DaemonCredential {
  serverUrl: string;
  serverId: string;
  token: string;
}

/** Read the daemon's own bound credential; null when unbound/unreadable. */
export async function loadDaemonCredential(): Promise<DaemonCredential | null> {
  try {
    const raw = await readFile(join(resolveImcodesHome(), 'server.json'), 'utf8');
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
  sendFileToMachine?: typeof clientSendFileToMachine;
  fetchFileFromMachine?: typeof clientFetchFileFromMachine;
  computerUseCall?: typeof clientComputerUseCall;
  openPortForward?: typeof clientOpenPortForward;
  listPortForwards?: typeof clientListPortForwards;
  closePortForward?: typeof clientClosePortForward;
  localComputerUseCall?: (input: { tool: Parameters<NonNullable<MachineToolDeps['computerUseCall']>>[0]['tool']; arguments?: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal }) => Promise<ComputerUseToolResult> | ComputerUseToolResult;
  resourceOwner?: SessionResourceOwnerIdentity | null;
  loadSharedMachineAuthority?: () => Promise<string | null>;
  participantTurnRequired?: () => Promise<boolean>;
  isOwnerTurnAuthority?: () => Promise<boolean>;
}

function isOwnerMachineAuthorityToken(token: string | null): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { type?: unknown };
    return payload?.type === OWNER_MACHINE_AUTHORITY_TYPE;
  } catch {
    return false;
  }
}

function isLocalComputerUseTarget(machine: string, creds: DaemonCredential | null): boolean {
  return isLocalComputerUseAlias(machine) || Boolean(creds?.serverId && machine === creds.serverId);
}

function matchingMachines(all: readonly MachineListItem[], machine: string): MachineListItem[] {
  const target = classifyMachineTarget(machine);
  if (!target) return [];
  return target.kind === 'node_id'
    ? all.filter((candidate) => candidate.nodeId === target.value)
    : all.filter((candidate) => candidate.refName === target.value);
}

/** Translate the server's route-level denial into the stable MCP vocabulary. */
function machineDispatchFailureReason(
  reason: MachineExecHttpReason | ComputerUseHttpReason | undefined,
): MCPErrorReason {
  if (reason === 'target_unavailable' || (reason as string | undefined) === MCP_ERROR_REASONS.EXEC_OFFLINE) {
    return MCP_ERROR_REASONS.EXEC_OFFLINE;
  }
  if (reason === 'exec_disabled') return MCP_ERROR_REASONS.EXEC_DISABLED;
  if (reason === 'target_forbidden') return MCP_ERROR_REASONS.SCOPE_FORBIDDEN;
  if (reason === 'scoped_auth') return MCP_ERROR_REASONS.IDENTITY_REJECTED;
  if (reason === FS_GENERIC_ERROR_CODES.INVALID_REQUEST) return MCP_ERROR_REASONS.VALIDATION_FAILED;
  return MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE;
}

async function defaultLocalComputerUseCall(input: { tool: Parameters<NonNullable<MachineToolDeps['computerUseCall']>>[0]['tool']; arguments?: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal; resourceOwner?: SessionResourceOwnerIdentity }): Promise<ComputerUseToolResult> {
  if (input.signal?.aborted) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE, error: 'computer use call aborted' };
  const result = await runComputerUseTool({
    correlationId: `local-${randomBytes(12).toString('hex')}`,
    tool: input.tool,
    ...(input.arguments ? { arguments: input.arguments } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.resourceOwner ? { resourceOwner: input.resourceOwner } : {}),
  });
  return { outcome: result.ok ? 'completed' : 'tool_error', result };
}

function portForwardFailureReason(reason: PortForwardErrorCode): MCPErrorReason {
  switch (reason) {
    case PORT_FORWARD_ERRORS.EXEC_DISABLED:
      return MCP_ERROR_REASONS.EXEC_DISABLED;
    case PORT_FORWARD_ERRORS.TARGET_FORBIDDEN:
      return MCP_ERROR_REASONS.SCOPE_FORBIDDEN;
    case PORT_FORWARD_ERRORS.SCOPED_AUTH:
      return MCP_ERROR_REASONS.IDENTITY_REJECTED;
    case PORT_FORWARD_ERRORS.RATE_LIMITED:
    case PORT_FORWARD_ERRORS.LIMIT_EXCEEDED:
      return MCP_ERROR_REASONS.RATE_LIMITED;
    case PORT_FORWARD_ERRORS.NODE_NOT_FOUND:
      return MCP_ERROR_REASONS.MACHINE_NOT_FOUND;
    case PORT_FORWARD_ERRORS.NODE_AMBIGUOUS:
      return MCP_ERROR_REASONS.MACHINE_AMBIGUOUS;
    case PORT_FORWARD_ERRORS.NODE_OFFLINE:
      return MCP_ERROR_REASONS.EXEC_OFFLINE;
    case PORT_FORWARD_ERRORS.INVALID_REQUEST:
      return MCP_ERROR_REASONS.VALIDATION_FAILED;
    case PORT_FORWARD_ERRORS.LISTEN_PORT_IN_USE:
    case PORT_FORWARD_ERRORS.TARGET_UNSUPPORTED:
    case PORT_FORWARD_ERRORS.P2P_FAILED:
    case PORT_FORWARD_ERRORS.TIMEOUT:
    case PORT_FORWARD_ERRORS.TUNNEL_NOT_FOUND:
      return MCP_ERROR_REASONS.TARGET_UNAVAILABLE;
    default:
      return MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE;
  }
}

/** Build the FULL-node machine tool deps from the daemon's own credential. */
export function createDaemonMachineToolDeps(overrides: DaemonMachineToolDepsOverrides = {}): MachineToolDeps {
  const load = overrides.loadCredential ?? loadDaemonCredential;
  const list = overrides.listMachines ?? clientListMachines;
  const exec = overrides.execRemote ?? clientExecRemote;
  const computerUse = overrides.computerUseCall ?? clientComputerUseCall;
  const sendFile = overrides.sendFileToMachine ?? clientSendFileToMachine;
  const fetchFile = overrides.fetchFileFromMachine ?? clientFetchFileFromMachine;
  const pfOpen = overrides.openPortForward ?? clientOpenPortForward;
  const pfList = overrides.listPortForwards ?? clientListPortForwards;
  const pfClose = overrides.closePortForward ?? clientClosePortForward;
  const localComputerUse = overrides.localComputerUseCall ?? defaultLocalComputerUseCall;
  const resourceOwner = overrides.resourceOwner ?? undefined;
  const loadSharedMachineAuthority = overrides.loadSharedMachineAuthority ?? (async () => null);

  const listWithAuthority = async (
    creds: DaemonCredential,
    includeOffline: boolean,
    sharedMachineAuthority: string | null,
  ): Promise<Awaited<ReturnType<typeof list>>> => {
    const machines = await list({
      serverUrl: creds.serverUrl,
      sourceServerId: creds.serverId,
      sourceToken: creds.token,
      ...(sharedMachineAuthority ? { sharedMachineAuthority } : {}),
      ...(includeOffline ? { includeOffline: true } : {}),
    });
    return machines;
  };

  const listWithActiveAuthority = async (
    creds: DaemonCredential,
    includeOffline: boolean,
  ): Promise<{ machines: Awaited<ReturnType<typeof list>>; sharedMachineAuthority: string | null }> => {
    // Read the private turn context before discovery. A participant turn whose
    // authority hand-off is unavailable must fail here rather than listing the
    // owner's devices and later falling back to an owner-authored action.
    const sharedMachineAuthority = await loadSharedMachineAuthority();
    return {
      machines: await listWithAuthority(creds, includeOffline, sharedMachineAuthority),
      sharedMachineAuthority,
    };
  };

  const toSummary = (m: Awaited<ReturnType<typeof clientListMachines>>[number]): MachineSummaryForTool => ({
    name: m.nodeId,
    displayName: m.displayName,
    ...(m.os ? { os: m.os } : {}),
    online: m.online,
    execEnabled: m.execEnabled,
    // /api/machines returns only controlled nodes by definition; publish the
    // literal role the spec/output-schema require.
    role: NODE_ROLE.CONTROLLED,
  });

  const resolveFileTarget = async (machine: string): Promise<
    | { ok: true; creds: DaemonCredential; targetServerId: string; sharedMachineAuthority: string | null }
    | { ok: false; result: MachineFileToolResult }
  > => {
    const creds = await load();
    if (!creds) return { ok: false, result: { ok: false, reason: MCP_ERROR_REASONS.FEATURE_DISABLED, error: 'daemon is not bound to a server' } };
    let all: Awaited<ReturnType<typeof list>>;
    let sharedMachineAuthority: string | null;
    try {
      ({ machines: all, sharedMachineAuthority } = await listWithActiveAuthority(creds, true));
    } catch (err) {
      const reason = err instanceof MachineControlPlaneError && err.kind === 'unbound'
        ? MCP_ERROR_REASONS.FEATURE_DISABLED
        : MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE;
      return { ok: false, result: { ok: false, reason, error: 'machine control plane unavailable' } };
    }
    const matches = matchingMachines(all, machine);
    if (matches.length === 0) return { ok: false, result: { ok: false, reason: MCP_ERROR_REASONS.MACHINE_NOT_FOUND, error: `no controllable machine named "${machine}"` } };
    if (matches.length > 1) return { ok: false, result: { ok: false, reason: MCP_ERROR_REASONS.MACHINE_AMBIGUOUS, error: `more than one machine named "${machine}"` } };
    const target = matches[0]!;
    if (!target.execEnabled) return { ok: false, result: { ok: false, reason: MCP_ERROR_REASONS.EXEC_DISABLED, error: `machine control is disabled for "${machine}"` } };
    return { ok: true, creds, targetServerId: target.serverId, sharedMachineAuthority };
  };

  const fileFailure = (err: unknown): MachineFileToolResult => {
    if (err instanceof MachineControlPlaneError) {
      if (err.message === 'daemon_offline') {
        return { ok: false, reason: MCP_ERROR_REASONS.EXEC_OFFLINE, error: 'machine is offline' };
      }
      if (err.message === 'exec_disabled') {
        return { ok: false, reason: MCP_ERROR_REASONS.EXEC_DISABLED, error: 'machine control is disabled' };
      }
      const validationErrors = new Set([
        FS_GENERIC_ERROR_CODES.INVALID_REQUEST,
        FILE_PATH_HANDLE_ERROR.INVALID_PATH,
        FILE_PATH_HANDLE_ERROR.NOT_FOUND,
        FILE_PATH_HANDLE_ERROR.FORBIDDEN_PATH,
        FILE_PATH_HANDLE_ERROR.NOT_REGULAR_FILE,
        FILE_PATH_HANDLE_ERROR.FILE_TOO_LARGE,
        'source file is unavailable', 'source must be a regular file',
        'source path is forbidden', 'source file is too large', 'destination already exists',
        'destination must be a regular file path', 'destination directory is unavailable or forbidden',
      ]);
      return {
        ok: false,
        reason: err.kind === 'malformed' || validationErrors.has(err.message)
          ? MCP_ERROR_REASONS.VALIDATION_FAILED
          : MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE,
        error: err.message,
      };
    }
    return { ok: false, reason: MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE, error: 'machine file transfer failed' };
  };

  return {
    // Both failure kinds propagate as `MachineControlPlaneError` so the tool
    // surface maps them consistently with the exec path: `unbound` →
    // FEATURE_DISABLED, a real control-plane failure (transport/http/malformed) →
    // CONTROL_PLANE_UNAVAILABLE — never a silent empty "no machines" list.
    async listMachines({ includeOffline }): Promise<MachineSummaryForTool[]> {
      const creds = await load();
      if (!creds) throw new MachineControlPlaneError('unbound', 'daemon is not bound to a server');
      const { machines } = await listWithActiveAuthority(creds, includeOffline === true);
      return machines.map(toSummary);
    },

    async execRemote({ machine, command, shell, timeoutMs, signal, onOutput }): Promise<MachineExecToolResult> {
      const creds = await load();
      if (!creds) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.FEATURE_DISABLED, error: 'daemon is not bound to a server' };
      // Resolve the canonical nodeId or deprecated alias against the FULL list so
      // "unknown" is distinguished from "offline". A control-plane failure here
      // must surface as CONTROL_PLANE_UNAVAILABLE, never as MACHINE_NOT_FOUND.
      let all: Awaited<ReturnType<typeof list>>;
      let sharedMachineAuthority: string | null;
      try {
        ({ machines: all, sharedMachineAuthority } = await listWithActiveAuthority(creds, true));
      } catch (err) {
        if (err instanceof MachineControlPlaneError) {
          const reason = err.kind === 'unbound' ? MCP_ERROR_REASONS.FEATURE_DISABLED : MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE;
          return { outcome: 'not_dispatched', reason, error: `machine control plane: ${err.kind}` };
        }
        throw err;
      }
      const matches = matchingMachines(all, machine);
      if (matches.length === 0) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.MACHINE_NOT_FOUND, error: `no controllable machine named "${machine}"` };
      if (matches.length > 1) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.MACHINE_AMBIGUOUS, error: `more than one machine named "${machine}"` };
      const target = matches[0]!;
      if (!target.execEnabled) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.EXEC_DISABLED, error: `remote exec is disabled for "${machine}"` };
      const remote = await exec({
        serverUrl: creds.serverUrl,
        sourceServerId: creds.serverId,
        sourceToken: creds.token,
        ...(sharedMachineAuthority ? { sharedMachineAuthority } : {}),
        targetServerId: target.serverId,
        command,
        ...(shell ? { shell } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(signal ? { signal } : {}),
        ...(onOutput ? { onOutput } : {}),
      });
      const { reason: httpReason, ...result } = remote;
      return result.outcome === 'not_dispatched'
        ? {
            ...result,
            reason: machineDispatchFailureReason(httpReason),
            error: `machine dispatch refused: ${httpReason ?? 'unknown'}`,
          }
        : result;
    },

    async sendFileToMachine({ machine, sourcePath, signal }): Promise<MachineFileToolResult> {
      const resolved = await resolveFileTarget(machine);
      if (!resolved.ok) return resolved.result;
      try {
        const result = await sendFile({
          serverUrl: resolved.creds.serverUrl,
          sourceServerId: resolved.creds.serverId,
          sourceToken: resolved.creds.token,
          ...(resolved.sharedMachineAuthority ? { sharedMachineAuthority: resolved.sharedMachineAuthority } : {}),
          targetServerId: resolved.targetServerId,
          sourcePath,
          ...(signal ? { signal } : {}),
        });
        return { ok: true, ...result };
      } catch (err) {
        return fileFailure(err);
      }
    },

    async fetchFileFromMachine({ machine, sourcePath, destinationPath, overwrite, signal }): Promise<MachineFileToolResult> {
      const resolved = await resolveFileTarget(machine);
      if (!resolved.ok) return resolved.result;
      try {
        const result = await fetchFile({
          serverUrl: resolved.creds.serverUrl,
          sourceServerId: resolved.creds.serverId,
          sourceToken: resolved.creds.token,
          ...(resolved.sharedMachineAuthority ? { sharedMachineAuthority: resolved.sharedMachineAuthority } : {}),
          targetServerId: resolved.targetServerId,
          sourcePath,
          destinationPath,
          ...(overwrite !== undefined ? { overwrite } : {}),
          ...(signal ? { signal } : {}),
        });
        return { ok: true, ...result };
      } catch (err) {
        return fileFailure(err);
      }
    },

    async computerUseCall({ machine, tool, arguments: args, timeoutMs, signal }) {
      const creds = await load();
      // Resolve the private turn context before classifying any target as
      // local. A participant turn executes inside the owner's daemon, so
      // local/localhost/self/this/sourceServerId would otherwise bypass the
      // server boundary that re-reads the current session/project share role,
      // expiry and revocation state. A required context that cannot be loaded
      // throws here and MUST NOT degrade into an owner-authored local call.
      const sharedMachineAuthority = await loadSharedMachineAuthority();
      const participantTurn = await (async () => {
        if (!overrides.participantTurnRequired) return false;
        try {
          return (await overrides.participantTurnRequired()) === true;
        } catch {
          return true;
        }
      })();
      // Owner local tools remain local (even when an owner-turn tree grant is active).
      // A participant turn or non-owner authority NEVER falls back to the owner's local backend.
      const isOwnerTurn = overrides.isOwnerTurnAuthority
        ? await (async () => {
            try {
              return (await overrides.isOwnerTurnAuthority!()) === true;
            } catch {
              return false;
            }
          })()
        : isOwnerMachineAuthorityToken(sharedMachineAuthority);
      const allowLocalByAuthority = !sharedMachineAuthority || isOwnerTurn;
      if (isLocalComputerUseTarget(machine, creds) && allowLocalByAuthority && !participantTurn) {
        return localComputerUse({
          tool,
          ...(args ? { arguments: args } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(signal ? { signal } : {}),
          ...(resourceOwner ? { resourceOwner } : {}),
        });
      }
      if (!creds) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.FEATURE_DISABLED, error: 'daemon is not bound to a server' };
      let all: Awaited<ReturnType<typeof list>>;
      try {
        all = await listWithAuthority(creds, true, sharedMachineAuthority);
      } catch (err) {
        if (err instanceof MachineControlPlaneError) {
          const reason = err.kind === 'unbound' ? MCP_ERROR_REASONS.FEATURE_DISABLED : MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE;
          return { outcome: 'not_dispatched', reason, error: `machine control plane: ${err.kind}` };
        }
        throw err;
      }
      const matches = isLocalComputerUseTarget(machine, creds)
        ? all.filter((candidate) => candidate.serverId === creds.serverId)
        : matchingMachines(all, machine);
      if (matches.length === 0) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.MACHINE_NOT_FOUND, error: `no controllable machine named "${machine}"` };
      if (matches.length > 1) return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.MACHINE_AMBIGUOUS, error: `more than one machine named "${machine}"` };
      const target = matches[0]!;
      if (machineActionRequiresExecute(machineActionForComputerUseTool(tool)) && !target.execEnabled) {
        return { outcome: 'not_dispatched', reason: MCP_ERROR_REASONS.EXEC_DISABLED, error: `machine control is disabled for "${machine}"` };
      }
      const remote = await computerUse({
        serverUrl: creds.serverUrl,
        sourceServerId: creds.serverId,
        sourceToken: creds.token,
        ...(sharedMachineAuthority ? { sharedMachineAuthority } : {}),
        targetServerId: target.serverId,
        tool,
        ...(args ? { arguments: args } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(signal ? { signal } : {}),
        ...(resourceOwner ? { resourceOwner } : {}),
      });
      const { reason: httpReason, ...result } = remote;
      return result.outcome === 'not_dispatched'
        ? {
            ...result,
            reason: machineDispatchFailureReason(httpReason),
            error: `machine dispatch refused: ${httpReason ?? 'unknown'}`,
          }
        : result;
    },

    async portForwardOpen(input) {
      const creds = await load();
      if (!creds) return { ok: false, reason: MCP_ERROR_REASONS.FEATURE_DISABLED, error: 'daemon is not bound to a server' };
      const sharedMachineAuthority = await loadSharedMachineAuthority();
      const res = await pfOpen({
        serverUrl: creds.serverUrl,
        sourceServerId: creds.serverId,
        sourceToken: creds.token,
        ...(sharedMachineAuthority ? { sharedMachineAuthority } : {}),
        ...input,
      });
      if (!res.ok) {
        return { ok: false, reason: portForwardFailureReason(res.reason), error: `[${res.reason}] ${res.error}` };
      }
      return { ok: true, tunnel: res.tunnel };
    },

    async portForwardList(input) {
      const creds = await load();
      if (!creds) return { ok: false, reason: MCP_ERROR_REASONS.FEATURE_DISABLED, error: 'daemon is not bound to a server' };
      const sharedMachineAuthority = await loadSharedMachineAuthority();
      const res = await pfList({
        serverUrl: creds.serverUrl,
        sourceServerId: creds.serverId,
        sourceToken: creds.token,
        ...(sharedMachineAuthority ? { sharedMachineAuthority } : {}),
        ...(input?.node ? { node: input.node } : {}),
        ...(input?.signal ? { signal: input.signal } : {}),
      });
      if (!res.ok) {
        return { ok: false, reason: portForwardFailureReason(res.reason), error: `[${res.reason}] ${res.error}` };
      }
      return { ok: true, tunnels: res.tunnels };
    },

    async portForwardClose(input) {
      const creds = await load();
      if (!creds) return { ok: false, reason: MCP_ERROR_REASONS.FEATURE_DISABLED, error: 'daemon is not bound to a server' };
      const sharedMachineAuthority = await loadSharedMachineAuthority();
      const res = await pfClose({
        serverUrl: creds.serverUrl,
        sourceServerId: creds.serverId,
        sourceToken: creds.token,
        ...(sharedMachineAuthority ? { sharedMachineAuthority } : {}),
        ...(input.tunnelId ? { tunnelId: input.tunnelId } : {}),
        ...(input.all ? { all: input.all } : {}),
        ...(input.node ? { node: input.node } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!res.ok) {
        return { ok: false, reason: portForwardFailureReason(res.reason), error: `[${res.reason}] ${res.error}` };
      }
      return { ok: true, closedCount: res.closedCount, closedTunnelIds: res.closedTunnelIds };
    },
  };
}
