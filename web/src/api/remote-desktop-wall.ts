import {
  REMOTE_DESKTOP_ACCESS_LIMITS,
  type RemoteDesktopWallMutation,
} from '@shared/remote-desktop-access.js';
import { ApiError, apiFetch } from '../api.js';
import { validateControlledNodeCapabilities } from '@shared/controlled-node-capabilities.js';
import { isMachineAccessRole } from '@shared/remote-exec.js';
import type { RemoteDesktopWorkspaceMachine } from '../remote-desktop-workspace-state.js';
import { isControlledNodeId } from '@shared/controlled-node-identity.js';

export interface RemoteDesktopWallHost extends RemoteDesktopWorkspaceMachine {
  hostId: string;
  remoteDesktopHostId: string;
}

export interface RemoteDesktopWallSnapshot {
  revision: number;
  layout: 'grid';
  hostIds: string[];
  hosts: RemoteDesktopWallHost[];
}

export class RemoteDesktopWallRequestError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly snapshot: RemoteDesktopWallSnapshot | null,
  ) { super(reason); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeHost(value: unknown): RemoteDesktopWallHost | null {
  if (!isRecord(value)
    || typeof value.hostId !== 'string'
    || typeof value.serverId !== 'string'
    || (value.nodeId !== undefined && !isControlledNodeId(value.nodeId))
    || typeof value.refName !== 'string'
    || typeof value.displayName !== 'string'
    || typeof value.online !== 'boolean'
    || typeof value.execEnabled !== 'boolean') return null;
  const capabilities = validateControlledNodeCapabilities(value.capabilities ?? []);
  if (!capabilities.ok
    || (value.accessRole !== undefined
      && (typeof value.accessRole !== 'string' || !isMachineAccessRole(value.accessRole)))) return null;
  return {
    hostId: value.hostId,
    remoteDesktopHostId: value.hostId,
    serverId: value.serverId,
    ...(isControlledNodeId(value.nodeId) ? { nodeId: value.nodeId } : {}),
    refName: value.refName,
    displayName: value.displayName,
    online: value.online,
    execEnabled: value.execEnabled,
    ...(typeof value.accessRole === 'string' ? { accessRole: value.accessRole } : {}),
    ...(typeof value.os === 'string' ? { os: value.os } : {}),
    ...(capabilities.value.length > 0 ? { capabilities: capabilities.value } : {}),
  };
}

export function decodeRemoteDesktopWallSnapshot(value: unknown): RemoteDesktopWallSnapshot {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || value.layout !== 'grid'
    || !Array.isArray(value.hostIds)
    || value.hostIds.length > REMOTE_DESKTOP_ACCESS_LIMITS.WALL_MAX_HOSTS
    || !value.hostIds.every((id) => typeof id === 'string')
    || new Set(value.hostIds).size !== value.hostIds.length
    || !Array.isArray(value.hosts)) throw new Error('invalid_remote_desktop_wall_snapshot');
  const hostIds = value.hostIds as string[];
  const hosts = value.hosts.map(decodeHost);
  if (hosts.some((host) => host === null)) throw new Error('invalid_remote_desktop_wall_snapshot');
  const typedHosts = hosts as RemoteDesktopWallHost[];
  if (typedHosts.length !== value.hostIds.length
    || typedHosts.some((host, index) => host.hostId !== hostIds[index])) {
    throw new Error('invalid_remote_desktop_wall_snapshot');
  }
  return { revision: value.revision as number, layout: 'grid', hostIds: [...hostIds], hosts: typedHosts };
}

function parseFailure(error: ApiError): RemoteDesktopWallRequestError {
  try {
    const body = JSON.parse(error.body) as { error?: unknown; snapshot?: unknown };
    const reason = typeof body.error === 'string' ? body.error : 'remote_desktop_wall_failed';
    const snapshot = body.snapshot === undefined ? null : decodeRemoteDesktopWallSnapshot(body.snapshot);
    return new RemoteDesktopWallRequestError(error.status, reason, snapshot);
  } catch {
    return new RemoteDesktopWallRequestError(error.status, 'remote_desktop_wall_failed', null);
  }
}

export async function getRemoteDesktopWall(): Promise<RemoteDesktopWallSnapshot> {
  return decodeRemoteDesktopWallSnapshot(await apiFetch('/api/remote-desktop/wall'));
}

export async function mutateRemoteDesktopWall(
  mutation: RemoteDesktopWallMutation,
): Promise<RemoteDesktopWallSnapshot> {
  try {
    return decodeRemoteDesktopWallSnapshot(await apiFetch('/api/remote-desktop/wall', {
      method: 'POST',
      body: JSON.stringify(mutation),
    }));
  } catch (error) {
    if (error instanceof ApiError) throw parseFailure(error);
    throw error;
  }
}
