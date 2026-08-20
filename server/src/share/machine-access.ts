import type { Database } from '../db/client.js';
import {
  NODE_ROLE,
  type MachineAccessRole,
} from '../../../shared/remote-exec.js';
import type { ControlledNodeCapability } from '../../../shared/controlled-node-capabilities.js';

export interface ControlledMachineAccessRow {
  id: string;
  user_id: string;
  ref_name: string | null;
  display_name: string | null;
  status: string | null;
  last_heartbeat_at: number | null;
  exec_enabled: boolean;
  os: string | null;
  daemon_version: string | null;
  auto_unlock_configured: boolean;
  revoked_at: number | null;
  access_role: MachineAccessRole;
  access_expires_at: number | null;
  controlled_capabilities: ControlledNodeCapability[] | null;
  /** `controlled` for a controlled node; `full`/NULL for a normal daemon. */
  node_role: string | null;
  /** The daemon this node was enrolled from, when it shares that machine. */
  host_server_id: string | null;
}

const CONTROLLED_MACHINE_ACCESS_SELECT = `
  SELECT s.id, s.user_id, s.ref_name, s.display_name, s.status, s.node_role, s.host_server_id,
         s.last_heartbeat_at, s.exec_enabled, s.os, s.daemon_version, s.revoked_at,
         s.auto_unlock_configured, s.controlled_capabilities,
         CASE WHEN s.user_id = $1 THEN 'owner' ELSE sh.role END AS access_role,
         sh.expires_at AS access_expires_at
    FROM servers s
    LEFT JOIN server_shares sh
      ON sh.server_id = s.id
     AND s.user_id <> $1
     AND sh.target_user_id = $1
     AND sh.revoked_at IS NULL
     AND (sh.expires_at IS NULL OR sh.expires_at > $2)`;

/**
 * Resolve current DB-authoritative access to one controlled node.
 *
 * A grant is deliberately read at action admission rather than cached: expiry,
 * revocation, downgrade, target revocation and role replacement all take effect
 * on the next request. The controlled node's own credential is never involved.
 */
export async function resolveControlledMachineAccess(
  db: Database,
  userId: string,
  serverId: string,
  now: number,
): Promise<ControlledMachineAccessRow | null> {
  return db.queryOne<ControlledMachineAccessRow>(
    `${CONTROLLED_MACHINE_ACCESS_SELECT}
      WHERE s.id = $3
        AND s.node_role = $4
        AND s.revoked_at IS NULL
        AND (s.user_id = $1 OR sh.id IS NOT NULL)
      LIMIT 1`,
    [userId, now, serverId, NODE_ROLE.CONTROLLED],
  );
}

/**
 * Resolve current DB-authoritative access to a remote-desktop host, which may
 * be a controlled node OR a normal (FULL) daemon: on Windows a daemon serves
 * remote control with the same native worker. Node role is returned rather than
 * filtered so admission can apply the checks that belong to each role — the
 * grant read itself (ownership, share, expiry, revocation) is identical.
 */
export async function resolveRemoteDesktopHostAccess(
  db: Database,
  userId: string,
  serverId: string,
  now: number,
): Promise<ControlledMachineAccessRow | null> {
  return db.queryOne<ControlledMachineAccessRow>(
    `${CONTROLLED_MACHINE_ACCESS_SELECT}
      WHERE s.id = $3
        AND s.revoked_at IS NULL
        AND (s.user_id = $1 OR sh.id IS NOT NULL)
      LIMIT 1`,
    [userId, now, serverId],
  );
}

/** One bounded query for owned + actively shared controlled-node discovery. */
export async function listAccessibleControlledMachines(
  db: Database,
  userId: string,
  now: number,
  limit: number,
): Promise<ControlledMachineAccessRow[]> {
  return db.query<ControlledMachineAccessRow>(
    `${CONTROLLED_MACHINE_ACCESS_SELECT}
      WHERE s.node_role = $3
        AND s.revoked_at IS NULL
        AND (s.user_id = $1 OR sh.id IS NOT NULL)
      ORDER BY s.display_name NULLS LAST, s.id
      LIMIT $4`,
    [userId, now, NODE_ROLE.CONTROLLED, limit],
  );
}

export function canOperateControlledMachine(
  accessRole: MachineAccessRole,
): accessRole is Extract<MachineAccessRole, 'owner' | 'participant'> {
  return accessRole === 'owner' || accessRole === 'participant';
}
