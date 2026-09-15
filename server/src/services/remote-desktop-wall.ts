import {
  REMOTE_DESKTOP_ACCESS_LIMITS,
  REMOTE_DESKTOP_WALL_OPERATION,
  validateRemoteDesktopWallMutation,
  type RemoteDesktopWallMutation,
} from '../../../shared/remote-desktop-access.js';
import { NODE_ROLE, MACHINE_PRESENCE_STALENESS_MS, type MachineAccessRole } from '../../../shared/remote-exec.js';
import { validateControlledNodeCapabilities, type ControlledNodeCapability } from '../../../shared/controlled-node-capabilities.js';
import type { Database } from '../db/client.js';
import { isControlledNodeId } from '../../../shared/controlled-node-identity.js';
import { MACHINE_IDENTITY_UNAVAILABLE } from '../../../shared/machine-reference.js';

export interface RemoteDesktopWallHost {
  hostId: string;
  serverId: string;
  nodeId?: string;
  refName: string;
  displayName: string;
  online: boolean;
  execEnabled: boolean;
  accessRole: MachineAccessRole;
  os?: string;
  capabilities?: ControlledNodeCapability[];
}

export interface RemoteDesktopWallSnapshot {
  revision: number;
  layout: 'grid';
  hostIds: string[];
  hosts: RemoteDesktopWallHost[];
}

interface WallRow { host_ids: unknown; revision: number; }
interface HostRow {
  host_id: string;
  server_id: string;
  node_id: string | null;
  node_role: string | null;
  ref_name: string | null;
  display_name: string | null;
  status: string | null;
  last_heartbeat_at: number | null;
  exec_enabled: boolean;
  os: string | null;
  access_role: MachineAccessRole;
  controlled_capabilities: unknown;
}

export class RemoteDesktopWallConflictError extends Error {
  constructor(readonly snapshot: RemoteDesktopWallSnapshot) { super('wall_revision_conflict'); }
}

export class RemoteDesktopWallAuthorizationError extends Error {
  constructor(readonly snapshot: RemoteDesktopWallSnapshot) { super('wall_host_unavailable'); }
}

export class RemoteDesktopWallMutationError extends Error {}

function storedHostIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  return [...new Set(ids)].slice(0, REMOTE_DESKTOP_ACCESS_LIMITS.WALL_MAX_HOSTS);
}

async function resolveHost(
  db: Database,
  userId: string,
  identity: string,
  now: number,
): Promise<RemoteDesktopWallHost | null> {
  const row = await db.queryOne<HostRow>(
    `SELECT h.id AS host_id, endpoint.server_id, s.node_id, s.ref_name, s.display_name,
            s.status, s.last_heartbeat_at, s.exec_enabled, s.os, s.node_role,
            s.controlled_capabilities,
            CASE WHEN s.user_id = $1 THEN 'owner' ELSE sh.role END AS access_role
       FROM remote_desktop_hosts h
       JOIN remote_desktop_host_endpoints requested ON requested.host_id = h.id
       JOIN remote_desktop_host_endpoints endpoint ON endpoint.host_id = h.id
       JOIN servers s ON s.id = endpoint.server_id
       LEFT JOIN server_shares sh
         ON sh.server_id = s.id
        AND s.user_id <> $1
        AND sh.target_user_id = $1
        AND sh.revoked_at IS NULL
        AND (sh.expires_at IS NULL OR sh.expires_at > $3)
      WHERE (h.id = $2 OR requested.server_id = $2)
        AND h.merge_state = 'resolved'
        AND s.revoked_at IS NULL
        AND (s.user_id = $1 OR sh.id IS NOT NULL)
      ORDER BY CASE WHEN s.node_role = $4 THEN 0 ELSE 1 END, endpoint.server_id
      LIMIT 1`,
    [userId, identity, now, NODE_ROLE.CONTROLLED],
  );
  if (!row || (row.node_role === NODE_ROLE.CONTROLLED && !isControlledNodeId(row.node_id))) return null;
  const capabilities = validateControlledNodeCapabilities(row.controlled_capabilities);
  return {
    hostId: row.host_id,
    serverId: row.server_id,
    ...(isControlledNodeId(row.node_id) ? { nodeId: row.node_id } : {}),
    refName: row.ref_name ?? '',
    displayName: row.display_name
      ?? (isControlledNodeId(row.node_id) ? row.node_id : MACHINE_IDENTITY_UNAVAILABLE),
    online: row.status === 'online'
      && typeof row.last_heartbeat_at === 'number'
      && now - row.last_heartbeat_at < MACHINE_PRESENCE_STALENESS_MS,
    execEnabled: row.exec_enabled === true && row.access_role !== 'viewer',
    accessRole: row.access_role,
    ...(row.os ? { os: row.os } : {}),
    ...(capabilities.ok && capabilities.value.length > 0 ? { capabilities: capabilities.value } : {}),
  };
}

async function resolveSnapshotHosts(
  db: Database,
  userId: string,
  identities: readonly string[],
  now: number,
): Promise<{ hostIds: string[]; hosts: RemoteDesktopWallHost[]; unavailable: boolean }> {
  const hosts: RemoteDesktopWallHost[] = [];
  const seen = new Set<string>();
  let unavailable = false;
  for (const identity of identities) {
    const host = await resolveHost(db, userId, identity, now);
    if (!host) {
      unavailable = true;
      continue;
    }
    if (seen.has(host.hostId)) continue;
    seen.add(host.hostId);
    hosts.push(host);
  }
  return { hostIds: hosts.map((host) => host.hostId), hosts, unavailable };
}

async function loadAndCompact(
  db: Database,
  userId: string,
  now: number,
): Promise<RemoteDesktopWallSnapshot> {
  let row = await db.queryOne<WallRow>(
    `SELECT host_ids, revision FROM remote_desktop_walls WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  if (!row) {
    await db.execute(
      `INSERT INTO remote_desktop_walls (user_id, host_ids, layout, revision, updated_at)
       VALUES ($1, '[]'::jsonb, 'grid', 0, $2) ON CONFLICT (user_id) DO NOTHING`,
      [userId, now],
    );
    row = await db.queryOne<WallRow>(
      `SELECT host_ids, revision FROM remote_desktop_walls WHERE user_id = $1 FOR UPDATE`,
      [userId],
    ) ?? { host_ids: [], revision: 0 };
  }
  const persisted = storedHostIds(row.host_ids);
  const resolved = await resolveSnapshotHosts(db, userId, persisted, now);
  let revision = row.revision;
  if (JSON.stringify(resolved.hostIds) !== JSON.stringify(persisted)) {
    const updated = await db.queryOne<{ revision: number }>(
      `UPDATE remote_desktop_walls
          SET host_ids = $3::jsonb, revision = revision + 1, updated_at = $4
        WHERE user_id = $1 AND revision = $2
        RETURNING revision`,
      [userId, row.revision, JSON.stringify(resolved.hostIds), now],
    );
    if (!updated) throw new RemoteDesktopWallMutationError('wall_compaction_conflict');
    revision = updated.revision;
  }
  return { revision, layout: 'grid', hostIds: resolved.hostIds, hosts: resolved.hosts };
}

export function getRemoteDesktopWall(
  db: Database,
  userId: string,
  now = Date.now(),
): Promise<RemoteDesktopWallSnapshot> {
  return db.transaction((tx) => loadAndCompact(tx, userId, now));
}

function exactOperation(
  operation: RemoteDesktopWallMutation['operation'],
  before: readonly string[],
  after: readonly string[],
): boolean {
  if (operation === REMOTE_DESKTOP_WALL_OPERATION.ADD) {
    return after.length === before.length + 1
      && before.every((id, index) => after[index] === id);
  }
  if (operation === REMOTE_DESKTOP_WALL_OPERATION.REMOVE) {
    return after.length === before.length - 1
      && before.filter((id) => after.includes(id)).every((id, index) => after[index] === id);
  }
  return operation === REMOTE_DESKTOP_WALL_OPERATION.REORDER
    && after.length === before.length
    && after.some((id, index) => id !== before[index])
    && after.every((id) => before.includes(id));
}

export function mutateRemoteDesktopWall(
  db: Database,
  userId: string,
  mutation: RemoteDesktopWallMutation,
  now = Date.now(),
): Promise<RemoteDesktopWallSnapshot> {
  if (!validateRemoteDesktopWallMutation(mutation).ok) {
    return Promise.reject(new RemoteDesktopWallMutationError('wall_invalid_operation'));
  }
  return db.transaction(async (tx) => {
    const current = await loadAndCompact(tx, userId, now);
    if (current.revision !== mutation.expectedRevision) {
      throw new RemoteDesktopWallConflictError(current);
    }
    const resolved = await resolveSnapshotHosts(tx, userId, mutation.hostIds, now);
    if (resolved.unavailable) {
      throw new RemoteDesktopWallAuthorizationError(current);
    }
    if (resolved.hostIds.length !== mutation.hostIds.length
      && resolved.hostIds.length === current.hostIds.length
      && resolved.hostIds.every((id, index) => id === current.hostIds[index])) {
      return current;
    }
    if (!exactOperation(mutation.operation, current.hostIds, resolved.hostIds)) {
      throw new RemoteDesktopWallMutationError('wall_invalid_operation');
    }
    const updated = await tx.queryOne<{ revision: number }>(
      `UPDATE remote_desktop_walls
          SET host_ids = $3::jsonb, revision = revision + 1, updated_at = $4
        WHERE user_id = $1 AND revision = $2
        RETURNING revision`,
      [userId, current.revision, JSON.stringify(resolved.hostIds), now],
    );
    if (!updated) {
      throw new RemoteDesktopWallConflictError(await loadAndCompact(tx, userId, now));
    }
    return { revision: updated.revision, layout: 'grid', hostIds: resolved.hostIds, hosts: resolved.hosts };
  });
}
