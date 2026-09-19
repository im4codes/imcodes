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
  /** Every group this machine is in, as parallel id/name arrays. */
  team_ids: string[] | null;
  team_names: string[] | null;
}

export type ControlledMachineOperatorAccessRow = ControlledMachineAccessRow & {
  access_role: Extract<MachineAccessRole, 'owner' | 'participant'>;
};

/**
 * Does this caller run any group this machine is in?
 *
 * EXISTS rather than a join: a machine can be in several groups, and joining
 * would return it once per matching membership -- a list that repeats a machine
 * is not a machine list, and the GROUP BY needed to undo that is one more place
 * to get wrong.
 */
const MANAGES_A_GROUP_OF = `EXISTS (
           SELECT 1 FROM machine_groups mg
             JOIN team_members tm ON tm.team_id = mg.team_id
            WHERE mg.server_id = s.id
              AND tm.user_id = $1
              AND tm.role IN ('owner', 'admin')
              -- A short-circuit, not a guard: the owner is answered by the
              -- first CASE arm and by the first term of every WHERE that uses
              -- this, so removing it changes no result. Verified by mutation:
              -- taking it out leaves all tests green, which is why it is
              -- described as what it is.
              AND s.user_id <> $1
         )`;

const CONTROLLED_MACHINE_ACCESS_SELECT = `
  SELECT s.id, s.user_id, s.node_id, s.ref_name, s.display_name, s.status, s.node_role, s.host_server_id,
         s.last_heartbeat_at, s.exec_enabled, s.os, s.daemon_version, s.revoked_at,
         s.auto_unlock_configured, s.controlled_capabilities,
         rdhe.host_id AS remote_desktop_host_id,
         (
           SELECT COALESCE(array_agg(g.team_id ORDER BY gt.name), '{}')
             FROM machine_groups g JOIN teams gt ON gt.id = g.team_id
            WHERE g.server_id = s.id
         ) AS team_ids,
         (
           SELECT COALESCE(array_agg(gt.name ORDER BY gt.name), '{}')
             FROM machine_groups g JOIN teams gt ON gt.id = g.team_id
            WHERE g.server_id = s.id
         ) AS team_names,
         CASE
           WHEN s.user_id = $1 THEN 'owner'
           -- An explicit per-machine grant wins over the team default, in both
           -- directions. It is the more specific statement of intent, so a
           -- deliberate downgrade to viewer is not silently undone by the
           -- grantee also being in the team.
           WHEN sh.role IS NOT NULL THEN sh.role
           WHEN ${MANAGES_A_GROUP_OF} THEN 'participant'
         END AS access_role,
         sh.expires_at AS access_expires_at
    FROM servers s
    LEFT JOIN remote_desktop_host_endpoints rdhe
      ON rdhe.server_id = s.id
    -- Sharing one machine with one person, and sharing a group of machines with
    -- a team, are two separate grants. Either is sufficient on its own.
    --
    -- They were briefly collapsed: the share JOIN additionally required the
    -- grantee to be a current member of the machine's team, so on a machine
    -- with no team -- which is now every machine at install -- share rows
    -- granted nothing at all while the UI still listed them as 有效/active. A
    -- grant that is displayed as active and enforced as absent is the worst of
    -- the two possible answers.
    LEFT JOIN server_shares sh
      ON sh.server_id = s.id
     AND s.user_id <> $1
     AND sh.target_user_id = $1
     AND sh.revoked_at IS NULL
     AND (sh.expires_at IS NULL OR sh.expires_at > $2)
    -- The group path, and only for those who manage the group.
    --
    -- A machine can be in several groups, so this is a join through the
    -- membership table rather than a single column: one matching group is
    -- enough, and being in one group does not remove it from another.
    --
    -- A group has three roles. An ordinary member manages the machines they
    -- added themselves and nothing else -- they reach those as the owner, not
    -- through the group -- while the owner and admins manage every machine in
    -- it. So putting a machine in a group means the people running that group
    -- can manage it; it does not hand you everyone else's.
    --
    -- Membership and role are read here rather than copied into a row, so a
    -- demotion, a removal, or taking the machine out all take effect on the
    -- next request.
`;

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
        AND (s.user_id = $1 OR sh.id IS NOT NULL OR ${MANAGES_A_GROUP_OF})
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
        AND (s.user_id = $1 OR sh.id IS NOT NULL OR ${MANAGES_A_GROUP_OF})
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
        AND (s.user_id = $1 OR sh.id IS NOT NULL OR ${MANAGES_A_GROUP_OF})
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
