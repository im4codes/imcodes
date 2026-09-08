import type { Database } from '../db/client.js';
import {
  NODE_ROLE,
  type MachineAccessRole,
} from '../../../shared/remote-exec.js';
import type { ControlledNodeCapability } from '../../../shared/controlled-node-capabilities.js';

export interface ControlledMachineAccessRow {
  id: string;
  node_id: string | null;
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
  /** Canonical physical-host identity for remote-desktop presentation/management. */
  remote_desktop_host_id: string | null;
}

export type ControlledMachineOperatorAccessRow = ControlledMachineAccessRow & {
  access_role: Extract<MachineAccessRole, 'owner' | 'participant'>;
};

const CONTROLLED_MACHINE_ACCESS_SELECT = `
  SELECT s.id, s.user_id, s.node_id, s.ref_name, s.display_name, s.status, s.node_role, s.host_server_id,
         s.last_heartbeat_at, s.exec_enabled, s.os, s.daemon_version, s.revoked_at,
         s.auto_unlock_configured, s.controlled_capabilities,
         rdhe.host_id AS remote_desktop_host_id,
         CASE WHEN s.user_id = $1 THEN 'owner' ELSE sh.role END AS access_role,
         sh.expires_at AS access_expires_at
    FROM servers s
    LEFT JOIN remote_desktop_host_endpoints rdhe
      ON rdhe.server_id = s.id
    LEFT JOIN server_shares sh
      ON sh.server_id = s.id
     AND s.user_id <> $1
     AND sh.target_user_id = $1
     AND sh.revoked_at IS NULL
     AND (sh.expires_at IS NULL OR sh.expires_at > $2)
     -- Desk scope. A controlled node is a personal, SYSTEM-capable machine, so
     -- a share row alone is not authority: the grantee must also be a current
     -- member of the Desk the machine is bound to. Three consequences, all
     -- intended and all fail-closed:
     --   * an unbound (legacy team_id IS NULL) controlled node admits nobody
     --     but its owner, no matter what share rows exist;
     --   * a share written before the machine was bound, or to someone outside
     --     the bound Desk, is inert without being deleted;
     --   * losing Desk membership revokes access on the next request, because
     --     membership is read here rather than cached into the share row.
     -- The owner arm of the WHERE clause is untouched: owners keep access to
     -- their own machine even while it is unbound, which is what makes the
     -- explicit bind step reachable at all.
     -- FULL daemons are deliberately excluded. Their sharing is the ordinary
     -- Tab model, they have always carried team_id NULL, and applying the Desk
     -- requirement here would silently revoke every existing daemon share.
     AND (
       s.node_role IS DISTINCT FROM '${NODE_ROLE.CONTROLLED}'
       OR (
         s.team_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM team_members tm
            WHERE tm.team_id = s.team_id AND tm.user_id = $1
         )
       )
     )`;

/**
 * Desk authority for EVERY actor on a bound controlled node, owner included.
 *
 * R4 audit P0: the membership test above lives inside the share JOIN, so it
 * only ever constrained grantees. The admission predicate separately admitted
 * `s.user_id = $1`, which meant an admin who enrolled a machine and was later
 * removed from the Desk kept owner-level exec, remote-desktop, file and device
 * authority forever -- the exact opposite of "only users currently authorized
 * in that Desk", and the more dangerous half, because that actor holds the
 * strongest role.
 *
 * The bootstrap exception is deliberately narrow and applies only to a machine
 * with NO Desk (legacy `team_id IS NULL`): its owner keeps access precisely so
 * the explicit bind step remains reachable. Once bound, the owner is subject to
 * the same current-membership test as everyone else. A FULL daemon is untouched.
 */
const CONTROLLED_DESK_AUTHORITY = `
  AND (
    s.node_role IS DISTINCT FROM '${NODE_ROLE.CONTROLLED}'
    OR s.team_id IS NULL
    OR EXISTS (
      SELECT 1 FROM team_members tm
       WHERE tm.team_id = s.team_id AND tm.user_id = $1
    )
  )`;

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
        ${CONTROLLED_DESK_AUTHORITY}
      LIMIT 1`,
    [userId, now, serverId, NODE_ROLE.CONTROLLED],
  );
}

/**
 * The single operational authority boundary for a controlled device.
 *
 * Every device capability must enter through this helper rather than spelling
 * an owner-only predicate in its own route.  The share row is read on every
 * action, so revocation, expiry, and a Participant -> Viewer downgrade take
 * effect without copying an owner credential into the participant's daemon.
 * Sharing-management routes deliberately do not use this helper: they remain
 * owner-only.
 */
export async function resolveControlledMachineOperatorAccess(
  db: Database,
  userId: string,
  serverId: string,
  now: number,
): Promise<ControlledMachineOperatorAccessRow | null> {
  const access = await resolveControlledMachineAccess(db, userId, serverId, now);
  return access && canOperateControlledMachine(access.access_role)
    ? access as ControlledMachineOperatorAccessRow
    : null;
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
        ${CONTROLLED_DESK_AUTHORITY}
      LIMIT 1`,
    [userId, now, serverId],
  );
}

/** Owner/active-Participant authority for the remote-control capability. */
export async function resolveRemoteDesktopHostOperatorAccess(
  db: Database,
  userId: string,
  serverId: string,
  now: number,
): Promise<ControlledMachineOperatorAccessRow | null> {
  const access = await resolveRemoteDesktopHostAccess(db, userId, serverId, now);
  return access && canOperateControlledMachine(access.access_role)
    ? access as ControlledMachineOperatorAccessRow
    : null;
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
        ${CONTROLLED_DESK_AUTHORITY}
      ORDER BY s.display_name NULLS LAST, s.id
      LIMIT $4`,
    [userId, now, NODE_ROLE.CONTROLLED, limit],
  );
}

/**
 * Live Desk authority for MANAGEMENT of a controlled node, as a SQL predicate.
 *
 * R5 audit P0: Desk membership was enforced only in the admission resolver, so
 * reads were fenced while every owner-management mutation still authorized on
 * `servers.user_id` alone. An owner removed from the Desk could therefore no
 * longer SEE the machine yet could still rename it, revoke it, toggle SYSTEM
 * exec, set the Windows auto-unlock secret, install the remote-desktop worker,
 * and grant/revoke other people's access. Hiding a machine from someone who can
 * still hand out control of it is the worst of both worlds.
 *
 * Returned as a predicate rather than a pre-flight check so it is evaluated
 * inside the same statement as the mutation: a separate SELECT would leave a
 * window where membership is dropped between the check and the write.
 *
 * `table` is the table or alias the predicate is applied to, and `userParam`
 * the placeholder holding the actor. Both are compile-time literals at every
 * call site; neither carries user input.
 *
 * The only exception is the legacy bootstrap: a machine with no Desk
 * (`team_id IS NULL`) is still managed by its owner alone, because otherwise
 * the explicit bind step could never be reached.
 */
export function controlledDeskManagementFence(table: string, userParam: string): string {
  return `(${table}.team_id IS NULL OR EXISTS (
    SELECT 1 FROM team_members tm
     WHERE tm.team_id = ${table}.team_id AND tm.user_id = ${userParam}
  ))`;
}

/**
 * Runtime form of the same rule, for callers that must decide before running a
 * statement (share management). Returns false for an unknown or revoked node.
 */
export async function holdsControlledDeskAuthority(
  db: Database,
  serverId: string,
  userId: string,
): Promise<boolean> {
  const row = await db.queryOne<{ present: number }>(
    `SELECT 1 AS present FROM servers s
      WHERE s.id = $1 AND s.revoked_at IS NULL
        AND ${controlledDeskManagementFence('s', '$2')}`,
    [serverId, userId],
  );
  return Boolean(row);
}

export function canOperateControlledMachine(
  accessRole: MachineAccessRole,
): accessRole is Extract<MachineAccessRole, 'owner' | 'participant'> {
  return accessRole === 'owner' || accessRole === 'participant';
}
